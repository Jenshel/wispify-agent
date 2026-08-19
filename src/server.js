'use strict';
// src/server.js — production entry point. Opens the real DB, seeds any
// env-configured integration credentials once, builds the app, and listens.
// Test code never requires this file — it uses src/app.js's createApp()
// factory directly against an isolated :memory: db (see test/helper.js).

const { getDb } = require('./db');
const { createApp } = require('./app');
const store = require('./config/store');
const { startAppointmentReminderJob } = require('./jobs/appointment-reminders');
const { startNudgeJob } = require('./jobs/nudges');

const db = getDb();
store.seedIntegrationsFromEnv(db);

const app = createApp({ db });
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`wispify-agent listening on :${port}`);
});

// Phase 8 (tasks.md 8.4) — periodic scan for upcoming appointments; no-ops
// internally on every scan until Meta credentials are configured, so it is
// always safe to start unconditionally at boot (same precedent as
// store.seedIntegrationsFromEnv() above never assuming anything is
// configured yet).
startAppointmentReminderJob(db);

// Phase 10 (tasks.md 10.1) — periodic scan for stalled conversations; same
// unconditional-at-boot precedent as the appointment reminder job above —
// scanAndFollowup() no-ops internally until BOTH meta and gemini are
// configured (Gemini-only, no OpenRouter fallback).
startNudgeJob(db);
