# Wispify Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Hosted version](https://img.shields.io/badge/hosted%20version-wispify.app-25D366)](https://wispify.app)

A self-hostable WhatsApp AI sales/support agent — one Node process, one WhatsApp number, one business.

> **Don't want to run your own server?** [wispify.app](https://wispify.app) is the managed version of this same engine — multi-business, Stripe/PayPal, guided onboarding, and support, without touching a terminal.

## What it is

Wispify Agent connects Meta's WhatsApp Cloud API to Google Gemini to answer customers automatically, and adds the pieces a real small business running a WhatsApp sales/support line actually needs:

- **Conversation memory** — recent turns feed back into every Gemini reply, so the bot keeps context across messages instead of answering each one in isolation.
- **Appointment booking** — Google Calendar is the sole backend. Double-booking and past-time requests are rejected before they ever reach Calendar, and the timezone used for those checks is configurable per deployment.
- **Checkout** — a generic Stripe Checkout Session is built per order (dynamic line items, no fixed pricing tiers), with an on-brand payment-result page instead of a bare success/cancel redirect.
- **Automated follow-ups** — a 4-stage nudge job re-engages customers whose conversation has stalled, with per-stage dedupe so nobody gets the same nudge twice.
- **Admin panel** — login, a guided integration setup wizard (each provider is validated live against the real API before it's trusted), a soul-docs/personality editor, a live chat view with inline image/audio playback, and a bot pause toggle — served from the same process as the API, no separate deploy.

All of it is capability-gated: only Meta and Gemini are required for the bot to run at all. Calendar and Stripe stay inert — not broken, just silently unoffered — until you configure and validate them.

## Quick start

Requires **Node.js >=22** (matches `better-sqlite3`'s own native-module requirement).

```bash
git clone https://github.com/Jenshel/wispify-agent.git
cd wispify-agent
npm install
cp .env.example .env   # then edit .env — see below
npm run build:panel
npm start
```

At minimum, `.env` needs a real `ADMIN_USERNAME`/`ADMIN_PASSWORD` — the server refuses to start if the password is still the `.env.example` placeholder or under 12 characters. Nothing else is strictly required to boot, but **the bot will not reply to anyone until you configure at least Meta WhatsApp Cloud API and Google Gemini** from the admin panel's guided setup screen (Settings -> Integrations) after your first boot. Google Calendar and Stripe are optional and capability-gated — leave them unconfigured and booking/checkout simply stay off.

Every credential `.env.example` lists (Meta, Gemini, Google Calendar, Stripe, plus `PUBLIC_BASE_URL` and `CONFIG_ENCRYPTION_KEY`) can also be set as an env var as a one-time seed for headless or Docker deployments — once a credential is saved through the panel, the database value takes precedence.

Then open `http://localhost:3000` and log in with your admin credentials.

## Deploy

**Docker**

```bash
cp .env.example .env   # edit it first
docker compose up -d --build
```

or plain `docker build -t wispify-agent .` followed by `docker run --env-file .env -p 3000:3000 -v wispify-data:/app/data wispify-agent`. The image is a 3-stage build: panel build, backend production dependencies (the native compile toolchain `better-sqlite3` needs never ships in the final layer), and a slim runtime image running as a non-root user.

**Bare VPS (systemd)**

```bash
sudo cp deploy/wispify-agent.service /etc/systemd/system/wispify-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now wispify-agent
```

Assumes the repo is already checked out, `npm ci --omit=dev` and `npm run build:panel` have already run, and a real `.env` exists — adjust `User`/`WorkingDirectory` in the unit file to your setup first.

Either way, the server refuses to boot if `ADMIN_PASSWORD` is left at the `.env.example` placeholder or shorter than 12 characters — a boot-time safety net against accidentally exposing a live, internet-facing, WhatsApp-connected admin panel behind a guessable, publicly-documented default.

The `data/` directory (the `wispify-data` volume in Docker) holds the SQLite database and the auto-generated encryption keyfile used to seal integration credentials at rest. It must persist across restarts and redeploys — losing the keyfile makes every previously-saved credential unrecoverable.

Not interested in managing a VPS or Docker yourself? [wispify.app](https://wispify.app) runs this for you.

## Architecture, briefly

Wispify Agent is mono-tenant by design: one deployment runs one business, one WhatsApp number, one admin login — there's no multi-tenant slot system to reason about. Everything lives in a single SQLite database, with integration credentials sealed at rest using AES-256-GCM. Capability gating (what the bot is allowed to offer) is enforced twice: at the prompt level, the system prompt simply never instructs the model to promise booking or payments that aren't configured; at the pipeline level, a control-tag parser strips and drops any tag whose capability is off before it can trigger a real effect — that second layer is the actual guarantee, since prompt compliance alone is only ever probabilistic. The AI brain is Gemini-only; there is no multi-provider abstraction layer.

## What's real vs. not yet built

| Capability | Status |
|---|---|
| Conversation memory (context across turns) | Real |
| Appointment booking (Calendar, double-booking/past-time guards) | Real |
| Configurable timezone for booking | Real |
| Stripe checkout (generic, per-order) | Real |
| Automated 4-stage follow-ups | Real |
| Contact-data capture (`[DATOS_CONTACTO]`) | Real |
| Admin panel (setup wizard, soul-docs editor, chat view, pause) | Real |
| Sending product photos (`[ENVIAR_FOTO]`) | Not built — no catalog table exists |
| Per-conversation pause/archive affecting bot replies | Not built — only one global pause switch exists |
| Multi-language | Not built — the AI system prompt and control-tag protocol are Spanish-only |

One caveat inside "configurable timezone": the appointment-reminder job's own timing math is still hardcoded to Mexico City regardless of the configured value — only booking creation itself and the follow-up job use it today.

## Before you go live

The automated test suite runs entirely against mocked/injectable providers (fake Graph API, fake Gemini, fake Stripe, fake Calendar) — that's what keeps it fast and deterministic, but it also means it cannot certify a real deployment. Before handling real customers, smoke-test by hand against:

- A real Meta test number — send and receive text, image, and audio
- A real Google OAuth consent round-trip against your own Calendar
- Stripe test mode end to end — checkout, webhook, WhatsApp confirmation

This is manual verification only you can do; the codebase can't self-certify it.

## License

MIT — see [LICENSE](./LICENSE).

---

Built and maintained by [Wispify](https://wispify.app) — this repo is the open-source core of the same agent we run as a managed, multi-business service.
