FROM node:16-alpine as builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY ./src ./tsconfig.json ./
RUN ./node_modules/.bin/tsc -p .

FROM node:16-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN chown -R node:0 ./ && chmod -R g=u ./
COPY --chown=node:0 package.json package-lock.json ./
RUN npm install --production
COPY --chown=node:0 --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/app.js"]