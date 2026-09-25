---
name: gcloud-commands-that-leak-secrets-into-transcripts
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Two gcloud commands print live secret values to stdout even with a restrictive --format: `run services describe --format=json` and `services api-keys create`. Both caused real exposures on 2026-07-31. Use the safe forms here."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2701071e-097f-4d4e-889e-9ca1be40a17f
  modified: 2026-07-31T20:53:00.709Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

Two separate credential exposures happened in one session (2026-07-31) from `gcloud` commands
whose output could not be constrained the way I expected. Both were my error, both are avoidable.

## 1. `gcloud run services describe --format=json` dumps every env var VALUE

Running it to inspect *how* secrets were wired printed live values into the transcript, including a
full unredacted `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` JWT, `LOCATIONIQ_API_KEY`, and
`HEALTHCHECKS_PING_KEY`.

**Safe form** — project only the fields you need; values are never in these paths:
```
gcloud run services describe <svc> --region <r> --project <p> \
  --format="table[no-heading](spec.template.spec.containers[0].env[].name, spec.template.spec.containers[0].env[].valueFrom.secretKeyRef.name)"
```
That yields `name → secretKeyRef.name` pairs (blank secretRef = a literal `value` env var, which is
itself a finding worth flagging), with no secret material.

## 2. `gcloud services api-keys create` prints `keyString` REGARDLESS of `--format`

`--format="value(name)"` does **not** suppress it: the command echoes the whole completed Operation
JSON — including `"keyString":"AIza..."` — as progress output before `--format` is ever applied.
The new key was exposed the instant it was created. (`--format` also mis-captured the *operation*
name rather than the key name, so a follow-up `get-key-string` 404'd.)

**There is no safe automated form of this command.** Recovery used: immediately
`gcloud services api-keys delete <full-key-resource-name> --quiet` (the key had never been stored or
used, so it died inert), then confirm via `api-keys list`. **Create API keys in the GCP Console
instead**, or have the owner do it — this is a legitimate case where manual is correct.

## Rules that did work and should be reused

- **Pipe-never-print for writing secrets:** `openssl rand -hex 32 | gcloud secrets versions add
  <NAME> --data-file=- --project=<p>` — the value is generated and consumed without ever being
  displayed or passed via argv. Used successfully for `NOTIFICATION_WEBHOOK_SECRET` and
  `BREVO_WEBHOOK_SECRET`.
- **Env-var indirection for scripts needing secrets:** `export X=$(gcloud secrets versions access
  latest --secret=X ...)` inside a single Bash call, run the script, then `unset`. Command
  substitution assigns without echoing. Used to re-provision the Telegram webhook via
  `scripts/setup-telegram-bot.mjs`.
- **Guard before writing a secret version:** check the captured value is non-empty and plausibly
  long before piping it to `secrets versions add`. This guard fired correctly and prevented writing
  an empty `GOOGLE_CALENDAR_API_KEY` version when `get-key-string` failed.

**How to apply:** before ANY `gcloud` command in a session that touches secrets, ask "can this print
a value?" Prefer `--format` projections over `json`/default output, prefer piping over capturing,
and never create API keys from the CLI. Related: [[disk-hygiene-sweep-2026-07-31-94-orphans-pending-approval]],
[[ai-unavailable-openai-key-rotation]] (the proven rotation runbook), [[claude-config-audit-2026-07-31]].
