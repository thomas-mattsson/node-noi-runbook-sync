import request from 'superagent';
import parseArgs from 'minimist';
import * as fs from 'fs';
import * as path from 'path';
import dedent from 'dedent';
import filenamify from 'filenamify';
import pretty from 'pretty';
import _ from 'underscore';

type Step = {
  number: number,
  description?: string,
  automationId?: string
}

type Automation = {
  name: string
}

type Runbook = {
  _runbookId: string,
  name: string,
  description: string,
  steps: Step[],
  automations: { [id: string]: Automation[] },
  parameters: [],
  tags: []
};

const argv = parseArgs(process.argv.slice(2));

const host = argv.host || process.env.NOI_HOST;
const apiKeyUser = argv.user || process.env.NOI_API_KEY_USER;
const apiKeyPw = argv.password || process.env.NOI_API_KEY_PW;

if (!host || !apiKeyUser || !apiKeyPw) {
  console.error('Environment variables NOI_HOST, NOI_API_KEY_USER and NOI_API_KEY_PW needs to be set');
  process.exit(1);
}

(async() => {
  let runbookPath = process.cwd();
  if (argv._[1] !== undefined) {
    runbookPath = path.resolve(runbookPath, argv._[1]);
    await fs.promises.access(runbookPath, fs.constants.F_OK)
      .then(() => fs.promises.stat(runbookPath))
      .then(stat => { return stat.isDirectory() ? Promise.resolve() : Promise.reject()})
      .catch(() => {
        console.error(`${runbookPath} is not a directory`);
        process.exit(1);
      });
  }
  
  if (argv._[0] === 'export') {
    exportRunbooks(runbookPath, !!argv.splithtml).then(() => {
      console.log('Export operation completed');
    }).catch((e) => {
      console.error(e);
      process.exit(1)
    });
  } else if (argv._[0] === 'import') {
    importRunbooks(runbookPath, !!argv.publish).then(() => {
      console.log('Import operation completed');
    }).catch((e) => {
      console.error(e);
      process.exit(1)
    });
  } else {
    printUsage();
    process.exit(1);
  }
})();

function areRunbooksEqual (runbook1: Runbook, runbook2: Runbook) {
  // checking for differences on some of the fields
  return _.isEqual(runbook1.steps, runbook2.steps)
    && _.isEqual(runbook1.parameters, runbook2.parameters)
    && _.isEqual(runbook1.tags, runbook2.tags)
    && runbook1.name === runbook2.name
    && runbook1.description === runbook2.description;
}

async function importRunbooks (runbookPath: string, publish: boolean) {
  const [currentRunbooks, runbookFiles]: [Runbook[], { filename: string; json: Runbook; }[]] = await Promise.all([
    getRunbooks(false),
    loadRunbookFiles(runbookPath, true)
  ]);
  const currentRunbooksById = currentRunbooks.reduce((map, runbook) => {
    map[runbook._runbookId] = runbook;
    return map;
  }, {});
  const runbooks = runbookFiles.map(rbf => rbf.json);
  const runbooksToImport = runbooks.filter(runbook => !currentRunbooksById[runbook._runbookId]);
  const response = await request.post(`https://${host}/api/v1/rba/runbooks/import?publish=${publish}&verbose=true`)
      .auth(apiKeyUser, apiKeyPw)
      .send(runbooksToImport);
  console.log(response.body);
  const runbooksToPatch = runbooks.filter(runbook => !!currentRunbooksById[runbook._runbookId]
    && !areRunbooksEqual(runbook, currentRunbooksById[runbook._runbookId]));
  await Promise.all(runbooksToPatch.map(runbook => {
    const p = request.patch(`https://${host}/api/v1/rba/runbooks/${runbook._runbookId}?publish=${publish}`)
      .auth(apiKeyUser, apiKeyPw)
      .send(runbook);
    return p.catch(e => console.error(`Runbook ${runbook._runbookId} patch failed due to ${e.response?.res?.text}`));
  }));
  console.log(`${runbooksToPatch.length} runbook(s) patched`);
}

async function getRunbooks (exportFormat: boolean) {
  const runbooksResponse = await request.get(`https://${host}/api/v1/rba/runbooks?version=latest&exportFormat=${exportFormat ? 'keepId' : 'false'}`)
    .auth(apiKeyUser, apiKeyPw);
  return runbooksResponse.body;
}

async function changeAutomationIds (runbooks: Runbook[]) {
  const runbooksWithAutomations = runbooks.filter(runbook => Object.keys(runbook.automations).length !== 0);
  await Promise.all(runbooksWithAutomations.map(async exportedrunbook => {
    // get runbook in standard format to get the internal automation id
    return request.get(`https://${host}/api/v1/rba/runbooks/${exportedrunbook._runbookId}`)
      .auth(apiKeyUser, apiKeyPw)
      .then(response => {
        const runbook: Runbook = response.body[0];
        const idMap = {};
        exportedrunbook.steps.forEach((step, ix) => {
          if (step.automationId) {
            idMap[step.automationId] = runbook.steps[ix].automationId;
          }
        });
        Object.keys(idMap).forEach(id => {
          const re = new RegExp(id, 'g');
          const merged = JSON.parse(JSON.stringify(exportedrunbook).replace(re, idMap[id]));
          exportedrunbook.steps = merged.steps;
          exportedrunbook.automations = merged.automations;
        });
      });
  }));
}

async function  exportRunbooks (runbookPath: string, splithtml: boolean) {
  const [files, runbooks]: [{ filename: string; json: Runbook; }[], Runbook[]] = await Promise.all([
    loadRunbookFiles(runbookPath, false),
    getRunbooks(true)
  ]);
  // Use the real automation IDs to keep track of them in case of patching
  await changeAutomationIds(runbooks);
  const fileNamesByRunbookId = files.reduce((map, file) => {
    map[file.json._runbookId] = file.filename;
    return map;
  }, {});
  return await Promise.all(runbooks.map((async runbook => {
    const fileName = fileNamesByRunbookId[runbook._runbookId]
      || `${filenamify(runbook.name.replace(/\s/g, '_'), { replacement: '' })}.json`;
    if (splithtml) {
      const stepsWithDescription = (runbook.steps || [])
      .filter(step => !!step.description);
      const stepsPath = path.join(runbookPath, getStepDirectoryName(fileName));
      await fs.promises.rm(stepsPath, { recursive: true, force: true });
      if (stepsWithDescription.length > 0) {
        await fs.promises.mkdir(path.join(runbookPath, fileName.replace('.json', '_steps')), { recursive: true });
        await Promise.all(stepsWithDescription.map(step => {
          const stepFile = getStepFileName(step);
          const stepPath = path.join(stepsPath, stepFile);
          const html = pretty(step.description, { ocd: true });
          step.description = `Exported into ${stepFile}`;
          console.log(`Writing ${stepFile} for runbook ${fileName}.`);
          return fs.promises.writeFile(stepPath, html);
        }));
      }
    }
    console.log(`Writing ${fileName} with runbook id ${runbook._runbookId}.`);
    return fs.promises.writeFile(path.join(runbookPath, fileName), JSON.stringify(runbook, null, 2))
      .catch((e) => {
        console.error(`Failed to write file ${fileName} due to ${e}`);
        throw e;
      });
  })));
}

async function  loadRunbookFiles (runbookPath: string, mergeStepFiles: boolean): Promise<{ filename: string; json: Runbook; }[]> {
  const files = await fs.promises.readdir(runbookPath);
  return await Promise.all(files.filter(file => file.endsWith('.json'))
    .map(async (file) => {
      try {
        const filePath = path.join(runbookPath, file);
        const buf = await fs.promises.readFile(filePath);
        const runbook: Runbook = JSON.parse(buf.toString());
        const stepDir = getStepDirectoryName(filePath);
        if (mergeStepFiles) {
          await mergeStepFilesIfExist(runbook, stepDir);
        }
        return {
          filename: file,
          json: runbook
        };
      } catch (e) {
        console.error(`Failed to read file ${file} due to ${e}`);
        throw e;
      }
  }));
}

function getStepDirectoryName (filePath: string): string {
  return filePath.replace('.json', '_steps');
}

async function mergeStepFiles (steps: Step[], stepDir: string, stepFiles: string[]) {
  const stepsByNumber = steps.reduce((map, step) => {
    map[step.number] = step;
    return map;
  }, {});
  return Promise.all(stepFiles.map(async (stepFile) => {
    const stepnumber = getStepNumberFromFile(stepFile);
    return fs.promises.readFile(path.join(stepDir, stepFile)).then(buf => {
      const step = stepsByNumber[stepnumber];
      if (step) {
        step.description = buf.toString();
      }
    })
  }));
}

async function mergeStepFilesIfExist (runbook: Runbook, stepDir: string){
  try {
    if ((await fs.promises.stat(stepDir)).isDirectory()) {
      const stepFiles = await fs.promises.readdir(stepDir);
      await mergeStepFiles(runbook.steps, stepDir, stepFiles);
    }
  } catch { /* ignore */ }
}

function getStepFileName (step: Step) {
  return `step${step.number.toString().padStart(3, '0')}.html`;
}

function getStepNumberFromFile (filename: string) {
  return parseInt(filename.substring(4, 7), 10);
}

function  printUsage () {
  console.log(dedent`Usage: 
                       export [path] [--splithtml] -- exports the runbooks into the provided path (default current working directory)
                       import [path] [--publish] -- imports the runbooks from the provided path (default current working directory)
                     Common options:
                      --host=<host and port> -- host and port to RBA API. If not provided will attempt to use NOI_HOST env var
                      --user=<api key user> -- the API key user. If not provided will attempt to use NOI_API_KEY_USER env var
                      --password=<api key password> -- the API key password. If not provided will attemp to use NOI_API_KEY_PW env var`);
}
