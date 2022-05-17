# node-noi-runbook-sync

## Introduction

Simple application that will work against the [Netcool Operations Insight Runbook API](https://www.ibm.com/docs/en/noi/1.6.4?topic=apis-runbooks-api) that will allow export and import of runbooks and separate them into files.

## Prerequisite

- Netcool Operations Insight [API key](https://www.ibm.com/docs/en/noi/1.6.4?topic=api-keys)
- Node.js - tested with Node.js 16

## Build

```bash
npm install
npm run build
```

## Usage

Application is executed with `node dist/app.js` with the following arguments also provided by the applications output when no arguments are provided.

```text
export [path] [--splithtml] -- exports the runbooks into the provided path (default current working directory)
import [path] [--publish] -- imports the runbooks from the provided path (default current working directory)

Common options:
  --host=<host and port> -- host and port to RBA API. If not provided will attempt to use NOI_HOST env var
  --user=<api key user> -- the API key user. If not provided will attempt to use NOI_API_KEY_USER env var
  --password=<api key password> -- the API key password. If not provided will attemp to use NOI_API_KEY_PW env var
```

## Tekton

There are two tekton tasks provided in /tekton directory that can be used in a pipeline for exporting and importing runbooks when for example are maintaining them in git.
