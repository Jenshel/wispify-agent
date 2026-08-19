'use strict';
// src/server.js — production entry point. Opens the real DB, seeds any
// env-configured integration credentials once, builds the app, and listens.
// Test code never requires this file — it uses src/app.js's createApp()
// factory directly against an isolated :memory: db (see test/helper.js).

const { getDb } = require('./db');
const { createApp } = require('./app');
const store = require('./config/store');

const db = getDb();
store.seedIntegrationsFromEnv(db);

const app = createApp({ db });
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`wispify-agent listening on :${port}`);
});
