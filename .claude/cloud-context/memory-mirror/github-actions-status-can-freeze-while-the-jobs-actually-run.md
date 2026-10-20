---
name: github-actions-status-can-freeze-while-the-jobs-actually-run
description: "During a GitHub Actions incident (19 Oct 2026, 15:18Z on, official post 15:49Z) PR checks sat pending/queued for 30+ min although every job had run to its last log line on hosted runners — read job logs and run artifacts to learn what really happened, never merge on logs, and never blame the account, billing or the retired box."
metadata:
  node_type: memory
  type: reference
  originSessionId: 972237fc-5fa0-4625-9335-4116607ef38b
  modified: 2026-10-19T16:42:55.642Z
---

2026-10-19, PR 6163: the PR showed `validate`/`checks` pending for 30+ minutes while `gh api repos/<repo>/actions/jobs/<id>/logs` returned complete logs for all six jobs (each ending "Cleaning up orphan processes", zero `##[error]`), `unit-coverage-N` artifacts existed from 15:41-15:43Z and the `checks` log read "ran 2500 of 2500 tests — every test exactly once". The job API still said `queued`, `runner_name` null. GitHub's control plane had stopped recording progress; its status page opened "Degraded availability for GitHub Actions, GitHub Pages and Webhooks" at 15:49Z, but start-to-job lag was already 60 s at 15:18Z (normal is 1-5 s).

**Why:** a run that is "completed/success" at run level can hold jobs `in_progress` with no steps (run 39277322184), and then `gh run rerun` and force-cancel both refuse — only a new commit gives a fresh run.
**How to apply:** to tell a platform stall from the account — check githubstatus.com, then job logs and run artifacts (proof the jobs ran), then the repo-wide count of `in_progress` runs (0 = not a concurrency cap) and `lag = first job started_at - run created_at` for the day's runs; a billing stop is a startup failure with empty steps, not a queue. Logs prove a job ran; only recorded statuses unlock the merge and the Railway deploy gate, so wait for them, and re-trigger with a new commit only after the status page is green again. See [[the-hetzner-ci-box-is-retired-ci-is-github-hosted-and-parallel]].

**What actually cleared it (PR 6163, 19 Oct 16:22-16:41Z, status page still "degraded" the whole time):** both `gh run rerun` forms (one job, whole run) ended `startup_failure` and wiped the recorded results — never rerun a stuck run. A fresh empty commit got a run GitHub accepted: jobs really started at once, but the API showed them queued for ~9 min and recorded `validate` at 16:35, `checks` only at 16:40; one non-required job (`unit (3)`) stayed `in_progress` after the run read `completed/success`. The `checks` gate job logs `UNIT_RESULT: success` for the whole matrix, so a lagging listing of one `unit` job beside a recorded `checks` success is proof, and the merge went through on the two required checks.
