---
name: a-new-cron-auto-arms-on-deploy-via-cron-autoarm
description: "A new cron auto-arms on deploy — cron-autoarm.yml runs cronjob-sync --job <key> --apply for each JOBS key a push ADDS; don't arm by hand, and never \"fix\" it into a bulk sweep."
metadata:
  node_type: memory
  type: project
  originSessionId: 6f97a14b-4527-4412-8664-721074edd3d3
  modified: 2026-10-05T01:53:00.386Z
---

Shipped #5329, 2026-10-05. `.github/workflows/cron-autoarm.yml` fires on a push to `main` that
touches `scripts/cronjob-sync.mjs`; `scripts/cron-autoarm.mjs` diffs that file, takes only the JOBS
keys the push **ADDED** (never a removed, reordered, field-edited or deeper-indented one), and runs
the sanctioned `cronjob-sync.mjs --job <key> --apply` once per new key.

**How to apply:** declaring a new cron in the JOBS map is now enough — do NOT run the manual arm step
and do NOT re-add it as a reminder; the territory-restamp gap (merged 2026-08-29, never armed) is
closed. A changed schedule or a hand-disabled job is left alone on purpose, so never widen this into a
`--all` sweep — that breaks `cronjob-sync`'s 100-requests/day rule.

**Secrets:** it needs both repo Actions secrets — `CRON_SECRET` (already present, upstream of Railway)
and `CRONJOB_API_KEY` (added by the owner 2026-10-05). A push that adds a new job with
`CRONJOB_API_KEY` missing fails the workflow loudly; a push adding none stays green. Creating a repo
Actions secret stays the OWNER's hand — hand him the `gh secret set` command, never set it yourself.

It is NOT a required check and NOT the deploy gate — a red run never blocks a merge or a deploy.

Related: [[cronjob-sync-from-a-stale-primary-runs-the-old-jobs-map]].
