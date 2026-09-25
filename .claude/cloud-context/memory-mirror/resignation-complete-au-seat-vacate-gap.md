---
name: resignation-complete-au-seat-vacate-gap
description: "phx_vacate_au_seats_for_employee is LIVE in prod+staging but its calling code is unmerged — the seat gap is still open in production"
metadata: 
  node_type: memory
  type: project
  originSessionId: 47410f72-bfc3-4cf6-a736-f2f1cf5080e1
  modified: 2026-08-01T18:08:22.657Z
---

**As of 2026-08-01 18:07 UTC: DB applied, code MERGED, NOT YET DEPLOYED.**
`public.phx_vacate_au_seats_for_employee(p_actor, p_effective_date, p_employee_hr_id, p_reason)`
is applied to BOTH `ozucdzovmcqvepbozvqf` (prod) and `cifwmndunmlxjhyjugxa` (staging), ACL
`postgres=X/postgres;service_role=X/postgres`. The `runResignationWorkflow` "complete" call site
merged as **`ea404043` (PR #1601)**.

**Why this is still not "live":** ~~prod deploys on a 2h cron, not on merge.~~ **[CORRECTED 2026-08-27: true on 2026-08-01, false now — a merge ships to production immediately via Railway. The rest of this paragraph is a dated record of that day and is left exactly as written.]** At merge time the
in-flight deploy run was building `85c2cda1` — the commit BEFORE the merge — and the serving
revision was `phoenix-hr-00806-zoj`. Verified by `git merge-base --is-ancestor`, not by comparing
timestamps, which would have been off by 14 seconds and read as "already deployed". Until a deploy
whose headSha CONTAINS `ea404043` promotes, an Approvals-Hub resignation-complete still leaves the
departed person on their au seat. The Employees-page path was never affected.

**How to check it shipped:** `gh run view <id> --json headSha` then
`git merge-base --is-ancestor ea404043 <sha>`, plus
~~`gcloud run revisions list --service phoenix-hr --region europe-west3`~~ **[RETARGETED 2026-08-27: GCP is dead (`BILLING_DISABLED` since 2026-08-01). Read `revision` from `https://phoenix-hr.satopharma.com/api/healthz` instead — it returns the running commit SHA.]** Rollback is
`drop function if exists public.phx_vacate_au_seats_for_employee(text,date,text,text);` +
`notify pgrst, 'reload schema';`.

**Migration timestamp churn:** this file was renamed twice in one session — `20260801170000` was
taken by merged #1597, then `20260801180000` by open #1600. With ~30 commits/day and many parallel
sessions, pick the timestamp LAST, right before pushing, and check open PRs' migrations too — not
just `origin/main`. See [[migration-timestamp-collision-hazard]] and
[[parallel-session-pr-collision-1506-1508]].

**Two things worth reusing:**

1. **The brief I was given quoted a superseded guard.** It cited step 5 of
   `20260718210000` (`occupant_hr_id = X`, `limit 1`). Live prod runs the
   `20260728100000` rewrite: `occupant_canonical_hr_id = lower(btrim(X))` and a LOOP.
   Mirroring the quoted version would have reintroduced both defects. Always read the object out
   of `pg_proc`, not out of the oldest migration that defines it — see
   [[list-migrations-reports-ledger-not-reality]].
2. **To prove a plpgsql function actually RUNS (not just parses) without mutating anything:**
   call it inside `do $$ ... raise exception 'PROBE_OK %', result; end $$;`. The RAISE aborts the
   statement's transaction so every write rolls back, and the result comes back in the error
   message. `create function` only syntax-checks the body, so this is the only cheap way to catch
   a runtime/semantic error before real data hits it. Used on both DBs here; it caught nothing,
   but it did prove the loop vacates BOTH of B-1's seats (`vacated_count: 2`) — the single case
   in the data that can expose a `limit 1` regression.
