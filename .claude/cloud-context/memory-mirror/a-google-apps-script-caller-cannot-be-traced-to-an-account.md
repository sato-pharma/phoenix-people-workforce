---
name: a-google-apps-script-caller-cannot-be-traced-to-an-account
description: "a ghost Google Sheet's owning account is NOT derivable from Phoenix — the UA id is obfuscated and 35-36 chars where a script id is 57, the egress IP is shared with the live sheet, the `UAEmdDd` prefix is on all five callers, and the Apps Script grant is a write-only Actions secret; the one positive id is the dead token inside the copy's own Code.gs."
metadata:
  node_type: memory
  type: reference
  originSessionId: 616e06ae-05b6-4b54-978f-eb856fad2690
  modified: 2026-10-03T06:01:55.644Z
---

Asked on 2026-10-03 which Google account owns the copy of the Direct Orders sheet that has polled
a revoked feed token once a minute since 2026-08-05 (~84,500 refusals). **The answer is: not from
Phoenix, and three things that look like evidence are not.**

- **The User-Agent `id:` is not a script id.** `Mozilla/5.0 (compatible; Google-Apps-Script;
  beanserver; +https://script.google.com; id: UAEmdDd-ww0d96vY8iUi2qkqtUWEC_Q4xMQ)` — **35
  characters**; the live sheet's is 36. A real Apps Script project id is **57**
  (`docs/environment.md`, "Finding a sheet's script id"). So it feeds neither `projects.get`, the
  one Google call that returns `creator.email`, nor Drive. There is no account, name or email
  anywhere in the request.
- **The source IP is a shared pool.** In one 15-minute window the ghost and the real sheet were
  both served from `107.178.193.70` and `107.178.193.71`.
- **The `UAEmdDd` prefix is not an account fingerprint.** All five Apps Script projects that call
  Phoenix carry it — the two direct-orders ones, CV lifecycle, marketing requests and master map —
  including the three whose owner is known.
- **And the credential is not on the laptop.** `GOOGLE_APPS_SCRIPT_REFRESH_TOKEN`,
  `GOOGLE_APPS_SCRIPT_CLIENT_*` and all three `*_APPS_SCRIPT_ID`s are **write-only GitHub Actions
  secrets**, unset in `.env.local` (`gh secret list` names them; `gh variable list` has none).

**What DOES identify it, and it is his hands not a session's:** `script.google.com` → Triggers in
each Google account in turn (the live direct-orders project is owned by a different account and
only shared with `achieverrr303@gmail.com`, so it sits under *Shared with me*), then open the
candidate's `Code.gs` and search for the dead token — the ghost runs pre-#1792 code with it written
in, where the live sheet keeps `FEED_TOKEN` in Script Properties. Failing that, the spreadsheet's
Drive Activity around **11:45–15:25 Cairo on 2026-08-05**: the dead token recorded **470** reads in
its 260-minute life, ≈1.8/min, so two pollers existed that morning and the copy was taken within
about an hour of the sheet going live.

Same shape as [[pg-stat-statements-times-precisely-and-attributes-never]] and git's single identity
on this machine: an instrument precise about WHAT or WHEN is not evidence about WHO. Related:
[[a-refused-request-left-no-trace-phoenix-could-see]].
