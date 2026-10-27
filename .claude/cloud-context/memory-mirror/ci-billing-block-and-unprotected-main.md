---
name: ci-billing-block-and-unprotected-main
description: "CI \"validate\" job dies in ~1s with a GitHub billing message; root cause was the notification-drain cron at */5. WARNING: this file's own filename and its old merge advice are WRONG — main IS branch-protected now, see the correction at the bottom"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4a28bccd-8c4c-4ae1-9469-ae8313a0317a
  modified: 2026-10-01T00:00:00.000Z
---

On 2026-06-14 the `validate` CI job on PRs failed in 1-2s with **zero steps run** and the annotation: *"The job was not started because recent account payments have failed or your spending limit needs to be increased."* This is GitHub's **billing gate firing before any code executes** — it is NOT a code error. Signature: job duration ~1s, no steps, annotation path `.github`.

**Root cause:** `.github/workflows/notification-drain.yml` ran `cron: "*/5 * * * *"` = ~8,640 runs/month, burning ~4,300+ Actions minutes/month — exceeds even GitHub Pro's 3,000 included private-repo minutes. Once included minutes are gone and the spending limit is $0 (the default), GitHub blocks ALL new Actions jobs. PR #170 first cut it to `*/30`; **PR #172 (2026-06-14) eliminated the root cause entirely** by moving the drain OFF GitHub Actions to a Vercel cron (`/api/notifications/process?limit=50` at `*/30` in vercel.json) and DELETING the workflow. GitHub Actions now only runs the PR test gate (`ci.yml`). The drain only lived on GH Actions because the project used to be Vercel Hobby (daily-cron-only); it's now **Vercel Pro** (team account `Phoenix-HR-Workspace`, id `team_MF9h6hXmL5sA5i1m1iAs8ueb`), so sub-daily crons are allowed — CONFIRMED because the PR #172 Vercel preview build accepted the `*/30` cron (Hobby would reject it at build time). No new secrets: `CRON_SECRET` is already in Vercel prod (the daily cron uses the same `Bearer ${CRON_SECRET}` pattern; Vercel auto-attaches it). NOTE: CLAUDE.md still says "Vercel Hobby ... two daily crons" — that is now STALE; the project is on Pro. *(Doubly stale as of 2026-08-23: CLAUDE.md contains **zero** Vercel mentions today — verified with `git grep -ic vercel -- CLAUDE.md` → 0 — so this note points at text that no longer exists. Vercel itself is fully decommissioned; production is Railway and the live scheduler is the third-party cron-job.org, not a Vercel cron.)*

**The billing fix itself is owner-only** (no CLI/API token can pay a bill or raise a limit; the gh token here lacks `user`/billing scope). Account `Phoenix-HR` is a **User account on Pro**, not an org. Since they're on Pro, the realistic causes are a **failed payment (declined card)** or a **$0 spending limit** — BOTH fixable immediately in Settings → Billing, NOT "wait until next month."

**~~Key unblock:~~ RETRACTED 2026-08-23 — do not act on the paragraph below.** It read: *"`main` has **NO branch protection** … So a red/blocked CI check does NOT prevent merge … When CI is billing-blocked but code passed the full local gate (`npm run check:harden`), it is safe to `gh pr merge --squash`."* Kept verbatim only so a future session recognises it and stops.

🔴 **Every clause of that is now false, and following it would ship broken code to production.** Verified live 2026-08-23 against `gh api repos/it-gawish-hr/phoenix-people-workforce/branches/main/protection`:

- **`main` IS branch-protected.** `enforce_admins: true`, two **required** status checks — `validate`, `checks`. *(Corrected 2026-10-01 — the gate is TWO, `validate` and `checks`; read the protection API, never this line.)* A red check now genuinely blocks the merge, for the owner too. (`strict` is `false`, so behind-`main` alone does not block — that part is deliberate, see AGENTS.md §2.)
- **The local gate it defers to no longer exists.** `check:harden` was retired 2026-08-18 at the owner's instruction and is gone from `package.json`. There is no local run that can stand in for CI, and AGENTS.md §7 forbids inventing one. See [[local-validation-gates-are-gone-ci-is-the-gate]].
- **"Safe to `gh pr merge --squash`" was never this file's call to make.** Merging to `main` is a PROTECTED ACTION needing the owner's separate explicit approval (AGENTS.md §6), and since 2026-08-01 a merge to `main` **ships to production immediately** — no cron wait, no staged rollout. When this was written the merge was harmless-ish; today it is a live deploy.

**What survives:** the billing-signature diagnosis in the first two paragraphs. A `validate` job that dies in ~1s with zero steps run is a **billing gate, not a code failure** — that is still the fastest way to tell the two apart, and it is worth keeping this file for. See [[ci-jobs-failing-in-seconds-means-billing-not-code]].

**The filename is now a misnomer.** It is kept only because renaming it would break the pointer in `MEMORY-ARCHIVE.md`; read it as *"ci-billing-block-and-main-WAS-unprotected"*. Related: [[ai-tool-damage-prevention]], [[github-personal-account-no-ghas-oss-scanning]] (why `secret-scan` is one of the four).
