---
name: csv-files-are-gitignored-and-never-reach-main
description: ".gitignore excludes every *.csv, so a CSV written as part of a report or audit folder is silently left out of the commit and the PR; the owner's decision is that they stay local."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 10ba1c01-8641-48a5-97e7-a15f406ecef1
  modified: 2026-11-13T13:44:02.777Z
---

`.gitignore` line 50 is `*.csv` ("Data files (store in cloud, not git)") and no CSV is tracked anywhere in the repository. `git add <folder>` skips them with no error, so a report folder that includes CSV deliverables reaches `main` without them.

It bit the integration audit (PR 308 in sato-pharma/phoenix-people-workforce, merged 13 Nov 2026): the summary report and the PR description both said the folder held 5 CSV files, and `main` holds none. The copies live only in the primary checkout, `docs/audits/phoenix-crm-integration-audit/`, as ignored files, and all 5 are regenerable from tracked files (`scripts/dump-sidebar.ts`, then `scripts/build-reports.mjs`).

**Owner's decision, 13 Nov 2026 ~15:42 Cairo, his words:** "keep the audit CSVs local". They are not to be force-added.

**Why:** his ignore rule is deliberate (data files stay out of git), and a report that claims files the repository does not hold is a false claim about `main`.

**How to apply:** before committing a folder of deliverables, run `git status --short --ignored <folder>` and read what was skipped. Never `git add -f` a CSV. Say in the report and the PR description that the CSVs are local only, with the path and the command that regenerates them. The wrong "5 CSV files" wording in the audit's `00_EXECUTIVE_SUMMARY.md` is a docs-only correction: fold it into the next PR that touches that folder, never a PR of its own (my reading of the small-PR rule, AGENTS.md §6).
