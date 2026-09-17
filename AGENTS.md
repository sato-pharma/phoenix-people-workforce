# Phoenix Workforce — Agent Rules

Operating rules for every AI agent and automation tool in this repository. Codebase reference
(layout, auth, API conventions, cron, env) lives in [docs/architecture.md](docs/architecture.md);
daily commands and the protected-file gate live in [CLAUDE.md](CLAUDE.md). Higher-priority platform
or system instructions take precedence. When instructions conflict or scope is unclear, stop before
the risky action and explain the conflict plainly.

**This file auto-loads in full on every request, so it holds hooks only** — a hook is the rule plus
the one detail needed to obey it, never the evidence. **Adding a rule? Put the hook here and the
account in `docs/` — never the account here.** A section is the half that regrows and nothing gates
one: measure it before you add to it (`docs/memory-index-budget.md`). 🔴 **A session-level trap now
goes in [docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md), under its
cluster — never back into §2.1**, which the 2026-09-12 trim reduced to a pointer and a slug roster;
writing one here re-charges every request for it and the hook will never deliver it.

**The accounts are read on demand — before working in an area, search its account for the hook's
wording.** Payroll, sales/closing, recruitment, CRM, exports → `docs/agents-owner-rules.md`. Deploy,
cron, production data → `docs/agents-production-hooks.md`, `docs/environment.md`. Worktrees and
machine limits → `docs/agents-worktree-and-machine-limits.md`. Shell, git, CI, validation →
`docs/agents-session-traps.md`. Memory index → `docs/memory-index-budget.md`. AUTORUN →
`docs/agents-autorun.md`. Why a §2 rule exists → `docs/agents-incident-history.md`.

**Memory slugs live in `docs/agents-memory-map.md`, not here — except the ones that map marks
`(inline — load-bearing)`.** `scripts/memory-index-reachability.mjs` scans `AGENTS.md` only and
matches the **backticked** form, so a slug removed from here orphans that memory **unless `MEMORY.md`
also links it**. **Re-run the classifier before removing any slug**
(`node scripts/memory-index-reachability.mjs`; `pnpm run repo:doctor` for the live scan).

## 0. How this repo is actually run (calibrate to this)

One owner runs everything. He is **not a career engineer** — he is the business owner of a live HR
platform a real pharmaceutical company runs payroll, attendance and sales on. Real employees are
paid from this data. Over the last 90 days:

- **~30 commits/day, 4.7 files per commit.** Small, focused changes, shipped constantly.
- **1,244 fix commits vs 903 feature commits.** More than half of all work repairs work.
- **Shipping is the main activity** — a fifth of all instructions are merge/deploy/verify-prod.
- **Sessions run for hours or days**, often **after midnight**. Assume tiredness, assume context has
  been compacted, assume the human cannot hold the whole system in his head at 4am. That is your job.
- **Almost nothing prompts** (rule 1.5) — you are the last line of defense.

He writes short, terse instructions and expects you to work out the scope. Explain like a smart
non-engineer: what happened, what it costs, what to do next.

## 1. The five rules that prevent the rework

1. **Show the proof, never the claim.** "Tests pass", "it is deployed", "the migration applied" are
   worthless without the output that shows it. Paste the count, the revision id, the row, the HTTP
   status. If you did not run it, say so. **Being wrong is recoverable; being confidently wrong is
   what costs a day.**
2. **Verify against live reality, not a plan or a memory.** A ledger is not the database
   (`list_migrations` lies — query `pg_class`/`pg_proc`). A merged PR is not a deploy. A green CI is
   not a working page. A memory file is a point-in-time note, not current state. Re-check before
   asserting.
3. **Finish every phase.** Given a numbered or phased plan, execute all of it, in order. Never stop
   after 1–2 phases and never silently skip one. If a phase is genuinely blocked, stop and say which
   one and why — never quietly deliver a subset and call it done.
4. **After compaction or a long session, distrust yourself.** A replayed summary of earlier work
   reads like a live instruction. Before acting on "previous" state, re-run the check. Prefer one
   fresh session per task over one endless session.
5. **The absence of a permission prompt is not approval.** The desktop app starts every session with
   `--permission-mode auto`, so a classifier, not a prompt, decides; `permissions.ask` in
   `.claude/settings.json` is **empty** and `permissions.deny` holds only silent hard blocks. **Every
   approval rule in §6 is therefore behavioral: ask in plain words and wait for a plain answer.**
   Read the settings file before asserting what is enforced.

## 2. Hard-Learned Rules (each cost a real incident — do not relearn them)

Why each exists: `docs/agents-incident-history.md` — read it before changing branch protection, CI
cost, the deploy path or the region.

- **Never use `gh pr merge --auto`.** `main` is branch-protected with **4 required checks** — `validate`, `lint`, `typecheck`, `secret-scan`; `allow_auto_merge: false`. Merge only with a plain `gh pr merge` after separate owner approval.
- **Never commit directly onto local `main` in the primary checkout.** The push is then rejected (`enforce_admins: true`), and the commit strands on the one checkout every parallel session shares — where another session’s `git reset` destroys it. Branch first. If you already committed: `git branch <name> <sha>` then `git reset --keep origin/main` (**not** `--hard`, which would also wipe other sessions’ uncommitted work), then open a PR. Cost a real recovery on 2026-09-12 (#3728).
- **Do NOT run `gh pr update-branch` reflexively** — "require branches up to date" is OFF (`strict: false`) and each run costs ~16 Actions minutes. Run it **only when the change depends on something newly on `main`**.
- **`gh pr update-branch` acts on the SERVER** — `git fetch` and `git merge --ff-only origin/<branch>` before your next push; CI re-runs on the new head.
- **A merge to `main` SHIPS TO PRODUCTION IMMEDIATELY** (Railway, full traffic, no smoke test). **Never merge what you would not have serving employees within minutes**; confirm with `/api/healthz` `revision`.
- **There is a staging application**, wired to the staging Supabase project — §3.
- **A hand-run typecheck must start cold:** `tsc --incremental false`.
- **Never foreground-watch a long pipeline.** Background it and check at batched checkpoints.
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), never the cookie flow — it logs the real user out.
- **Merged-branch checks must be squash-aware:** `gh pr list --head <branch> --state merged`, never `git branch --merged`.
- **A regression test counts only if you break the fix and see its own headline assertion fire.**
- **`list_migrations` reports the ledger, not reality** — query `pg_class`/`pg_proc`.
- **Commit, push and open the PR WITHOUT asking; ALWAYS ask before merge** (owner rule, 2026-09-16 — supersedes the old auto-git ban). Branch first, stage only the task's files, never `--auto`.

### 2.1 Session-level traps

**The traps themselves moved to [docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md) — they are DELIVERED, not dropped.** `.claude/hooks/trap-injector.mjs` is a PreToolUse hook that reads what the session is about to run and injects the matching cluster once per session: the git traps when you touch git, the Supabase traps when you touch Supabase. Thirteen clusters — **Shell and tooling · Git · CI and PRs · Migrations · Database, grants and RLS · Probing, attributing and reporting production · Validation · Memory and this index · Parallel sessions · Worktrees · Next.js runtime · Browser and dev-auth · Machine ceiling.** That is 30 KB this file no longer charges to every request.

🔴 **The hook FAILS OPEN and SILENT, so its silence proves nothing** — it says the same thing when no cluster matched and when it never ran at all. **If you cannot see a trap block for the kind of work you are doing, open the clusters file and read the matching one yourself**, before the first command of that kind. A session started before the hook merged does not have it.

**Each line there is a cue, not the fact.** The account of every one is in [docs/agents-session-traps.md](docs/agents-session-traps.md); which memory backs which hook is in [docs/agents-memory-map.md](docs/agents-memory-map.md).

**Memory slugs that this section was the only pointer for.** `scripts/memory-index-reachability.mjs` scans **this file** and matches the **backticked** form, so these stay here whatever happens to the prose above — deleting one orphans that memory unless `MEMORY.md` also links it. They are a reachability roster, not a reading list; the hook each belongs to travels with its cluster.

`tz-africa-cairo-silently-returns-utc-in-msys` · `looking-at-a-generated-workbook-two-ways-that-lie` · `a-manual-scheduled-task-run-leaves-no-trace` · `main-is-not-the-primary-checkout` · `a-missing-table-answers-pgrst205-not-42p01` · `attribution-rollup-fingerprint-ignores-the-sales-data` · `offer-chain-was-live-in-the-registry-with-a-hole-past-approval` · `ats-candidate-children-one-has-no-fk-and-one-is-a-view` · `cv-extraction-reads-governorate-but-never-applies-it` · `the-medical-rep-cv-schema-reads-12-fields-universal-reads-38` · `a-cv-import-overwrote-a-candidates-whole-identity` · `the-email-import-allowlist-holds-an-inbox-not-a-sender` · `cv-file-is-in-ats-files-not-cv-external-url` · `census-client-errors-by-stack-not-message` · `typecheck-incremental-false-green` · `the-test-suite-runs-with-production-credentials-and-app-env-production` · `tailwind-merge-strips-custom-named-font-sizes` · `bilingual-bodies-need-direction-per-line-not-per-block` · `ireports360-timestamps-cairo-local-mislabeled-utc` · `verify-the-emitted-artifact-never-the-source` · `at-slash-lib-shadows-src-lib-via-tsconfig-paths` · `gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded` · `collapsed-browser-pane-reads-zero` · `agent-isolation-remote-ran-locally-in-a-worktree`

### 2.2 The memory index

**Each line is a cue.** Why, every trim pass and the budget arithmetic:
`docs/memory-index-budget.md`.

- **`MEMORY.md` is the ONLY auto-loaded memory file, and the loader truncates it at 24,400 bytes — SILENTLY.**
- **The budget is 22,000 bytes.** `node scripts/repo-doctor.mjs` prints the bytes to free; `.claude/hooks/memory-index-guard.mjs` repeats it at SessionStart.
- 🔒 **THE DISPLACEMENT RULE — never add an index line without freeing at least as many bytes in the same edit.**
- 🔒 **IGNORE the "compact it to under 17.1KB" message** — it is arithmetically impossible; landing under the cliff with headroom is a SUCCESS.
- **Route by KIND of fact, never by topic** — agent trap → §2.1, production or approval hook → §2.3, owner product rule → §4.
- **Never delete a hook to make room, and correct the memory FILE (its `description` decides recall) before the hook.**
- **A line earns its place only if** a session would act WRONGLY without it, it is durable (never a count, status or date), and it is not derivable in one step.
- **A relocation spanning git and `~/.claude/` finishes BOTH halves or neither, in that order — and the condition is PRESENT IN THE CHECKOUT YOU TRIM FROM, not merged.** `node scripts/memory-index-reachability.mjs` must read **0 reachable from neither in THAT folder** before you trim; check which slugs appear only in a section before cutting it.
- **Reporting may union `origin/main:AGENTS.md` (repo-doctor does); trimming must stay local-only.**
- **No required check can gate any of this** — `MEMORY.md` lives outside the repository, so the displacement rule is behavioural.

### 2.3 Production and approval hooks

**Each line is the rule, not the evidence.** Account: `docs/agents-production-hooks.md`.

**Railway deploys**

- **A deploy applies NO migrations, and auto-deploy can silently SKIP** — read `/api/healthz` `revision`.
- **Two merges inside a minute look ROLLED BACK when they are only QUEUED.** Read deployment STATES, never timestamps; settle with `git merge-base --is-ancestor <your merge> <live revision>`. Do NOT re-merge or `railway redeploy`.
- **`railway variables --stdin` stores a BOM** inside the value.
- **`railway ssh` JOINS argv and lands as ROOT.**
- 🔴 **`railway service source connect` is NOT environment-scoped — `--environment staging` REPOINTED PRODUCTION.** Never use it to preview; staging a branch needs a separate service.

**Cron and secrets**

- **A PARTIAL `CRON_SECRET` rotation leaves TWO fingerprints, and Healthchecks `up` is not proof.** The past 401s are resolved: **rotate NOTHING.** Always print `len` (71).
- **`CRON_SECRET` flows GitHub → Railway** (`sync-railway-production-secrets.yml` overwrites Railway) — **rotate GitHub first.** The 4 OFF iReports360 jobs are DELIBERATE.
- **The cron-job.org REST API allows 100 requests per DAY** — a bulk edit costs ~34 and CANNOT be rolled back.

**Production data**

- **NEVER rotate the Supabase DB password with `ALTER ROLE`** — dashboard only. `28P01` is a stale password, `XX000` a wrong host.
- **`expense_claims` is the ONE live RLS read path in production.** Put a precondition in every shared-queue production `WHERE`; **"Log out everywhere" is THREE writes.**
- **The 255 lower-cased `ats_candidate_status_events.actor_hr_id` rows STAY, by owner decision** — `canonicalHrIdKey` already matches them. Do not re-propose a repair or disable the trigger.
- **The `expense_claims` mirror builds `claimed_total` and `approved_total` from TWO tables**, so a stale request header breaches `expense_claims_approved_total_range`. **Read the expense components before touching an approved amount**; the rebuild flags `data_quality_hold`.
- 🔴 **Production has NO PITR — 7 daily backups are the whole recovery story.** Say so before any bulk or destructive change, and **never restore a daily backup in place.**
- 🔴 **Payroll reads `social_insurance_wage`, NEVER `social_insurance_status`, and NEITHER statutory figure reduces take-home pay.** Audit by querying both columns; never warn a wage costs the employee money. `payroll-reads-the-insurance-wage-never-the-status` · `social-insurance-and-tax-never-reduce-take-home-pay`
- 🔴 **A HELD payroll row is DROPPED at publish with no trace** (`publishToPayslips` filters `!onHold`). **HELD = OWED PART 2 ONLY** — validate part 2 against PUBLISHED rows; `payroll_eligible=false` is normal for executives; read `hold_reason`, never re-raise. `a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace`
- **A `not_found` on `marketing_pharmacy_distributor_codes` is a stale CACHE** — join the live `source_of_sales_customer_map` before telling the owner a venue's territory is unrecoverable.
- 🔴 **A shared distributor customer code CANNOT prove two direct-order venues are the same** (each distributor has its own codes). Use byte-identical order lines from one DM in one brick, or matching building numbers; **never merge on name similarity or your own inference — put the pair to the owner.**
- 🔴 **An area holds SEVERAL `teams` (named for regions), so RENAMING one corrupts other lines.** Resolve from the seat region (`au.v_org_tree.region_name`); read `team_id`, never the dead `team_name`/`department_name`.
- 🔴 **`sos_map_guard_customer` silently DROPS a held customer-map move** (fewer rows, no error). Read `sos_map_change_holds`, never the row count; release only via `sos_map_guard_decide`, never mint a permit.

**Which environment the code thinks it is in**

- **A LOCAL run writes PRODUCTION but skips every email, and the local Resend key CANNOT send** — send from production with `railway run`.
- **STAGING cannot rehearse a PRODUCTION shape.**
- **`isProductionRuntime()` reads `APP_ENV || VERCEL_ENV || NODE_ENV`, and a production build sets `NODE_ENV=production` on staging** — `APP_ENV` must stay set there (fixed).
- **Staging email is safe only because `PHOENIX_EMAIL_FORCE_TESTING` is set explicitly — one variable, nothing behind it.**
- **The `APP_ENV`/cron-secret hole is CLOSED — do not re-chase it**, but treat `!isProductionRuntime()` as an auth fallback with suspicion.
- **The `railway` CLI is linked to `production` — every variable command needs `-e staging`.** Setting a variable redeploys (unless `--skip-deploys`).
- **That deploy serves in MINUTES — confirm by listing DEPLOYMENTS**, never by probing the app, and never `railway redeploy` to make a variable "take".

## 3. Stable Environment Facts

Lookup facts, not behaviour. **The full list — Railway services and region, domains, the production
scheduler and the five Actions crons, the outbox-drain check, CI secrets, environment meanings — is
in `docs/environment.md` "Stable environment facts"; read it before touching deploy, staging, cron,
domains, the region or a Supabase ref.**

- Production: `https://phoenix-hr.satopharma.com`, Railway service `phoenix-people-workforce`, environment **`production`**, region `europe-west4-drams3a` — **it must stay in Europe.** Confirm the service's source branch before assuming a merge ships (§2.3).
- Staging: `https://phoenix-people-workforce-staging.up.railway.app`, same project, on the staging Supabase project.
- **GCP and Vercel are DEAD** — never deploy to or verify against them.
- **The production scheduler is `cron-job.org`** — check it before telling the owner anything is stalled; a green outbox cron proves nothing, read `drainHealth`. **The drain alarm is deliberately never email — do not "fix" that back.**
- **`.env.local` points at PRODUCTION Supabase.** `pnpm run dev` mutates production data.
- **Supabase project refs — the complete list `list_projects` returns.**

  | Ref | Name | Region | Org | What it is |
  | --- | --- | --- | --- | --- |
  | `ozucdzovmcqvepbozvqf` | Phoenix HR | eu-central-1 | `rovnkzmhokgsruftjsaw` | **PRODUCTION** — real payroll data |
  | `cifwmndunmlxjhyjugxa` | Phoenix-HR-Staging | eu-central-1 | `rovnkzmhokgsruftjsaw` | **STAGING** |
  | `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | `rovnkzmhokgsruftjsaw` | unrelated to this app |
  | `mlbpzvaanusdejqnimst` | the owner's personal project | eu-central-1 | **`xadcyivhxyjtehyheowl`** | unrelated — **different organization** |

  **Dead refs — treat any doc, memory or prompt still naming one as stale:** `izhmxvgiktiafqusolot` and `oaifhavixhdtwmseshff`.

  **Neither region nor org is a guard** — `supabase-production` sees every ref its token can. Resolve with `list_projects` before acting (§8).

Never store passwords, tokens, API keys, service-role keys, JWT secrets, connection strings or other
credentials in this file or in Git. Never assume a pasted preview URL is current.

## 4. Standing owner rules

The owner's own decisions — not suggestions. **Each line is the rule;** the account of each (his
words, incidents, measurements, pre-image tables): `docs/agents-owner-rules.md`.

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in both UI and chat.
- **Never truncate text with an ellipsis.** Where it collides with the no-horizontal-scroll rule, wrapping wins.
- Give only recommendations grounded in a real confirmed need. **Never pad a list to hit a number.**
- **Open every reply with ONE recommended next step — FIRST, not last, and not repeated at the end.** A reply that asks nothing of him needs none. `recommendation-goes-first-not-last`

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead.**
- **Ask when the answer changes the outcome; decide when it does not.**
- **Ask business-fact questions IN CHAT as multiple choice, never in prose** — short options, one idea each, recommended first; read his typed "Other" answers closely. An XLSX with dropdowns is only for long per-item lists. Never guess to avoid asking. `ask-business-questions-as-in-chat-multiple-choice`
- Take ownership. Automate the work rather than returning a checklist he has to execute.
- 🔴 **THE SOURCE OF SALES AUDIT IS FINISHED — never restart it.** Its findings are a FIX backlog: start from `sos-remeasure-2026-09-06.md` in the vault (`RESUME-2026-09-05.md` records completion). Never restart the finder agents, never `resumeFromRunId`, never overwrite the inputs — write a NEW file.

**How to build**

- **Before building new UI, match the sibling pages' exact design identity.** Never invent a one-off look.
- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.** Use `<table className="w-full table-fixed">` with a `<colgroup>`; fit by MERGING columns, never shrinking type — `overflow-x-auto` over a `min-width` IS the bug. Measure `scrollWidth > clientWidth` over `main` at desktop and 375px; `shrink-0` makes an inner `flex-wrap` inert. `never-horizontal-scroll-always-mobile-and-desktop-friendly`
- Admin shell: **desktop shows full tables/dashboards, mobile gets cards.**
- 🔒 **THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.** `tokens.css`'s `--phx-radius: 4px` is the bug; measure computed `border-radius`, since `globals.css`'s sweep is not coverage. Restoring premium polish from history re-rounds corners — take the depth only. Pinned by `tests/admin-shell-palette-scope.test.ts` and `tests/hiring-pack-paper-editor.test.ts`.
- 🔒 **THE DOCUMENT IDENTITY — every company document wears `SATO-DIS-2026-01 v1.0`** (Sato Pharma's, never the app's); "put it in the system template" is STANDING. Logo palette `#0A527D`/`#0A6BA6`/`#1482C2`. 🔴 **THE INK RULE — no filled areas** except the 6% zebra row; government forms are exempt; on paper the mark is `sato-pharma-logo-on-light.png`. Module: `src/lib/hiring-pack/house-identity.ts`. `the-house-document-identity-standard`
- **One production deployment per task.** Bundle all phases into one PR.
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.

**Product rules that must not be "fixed" back**

- No payslip on any overview/landing page for any role — not the amount, not even the month label.
- 🔒 **THE AUTOMATED PAYROLL EXPORTS stay Phoenix black-and-orange, EXEMPT from the house identity** (run sheet, finance downloads, step templates); the published batch download and payslip renderer stay house. Keep the held row's NOTE and the step template's cell LOCKING. Pinned by `tests/payroll-phoenix-look.test.ts`.
- 🔒 **THE OFFER LETTER DESIGN IS FROZEN** — `src/lib/offers/` keeps its blue, navy bands, tinted salary table and circular disc; no house-identity rule reaches it.
- 🔒 **THE SPOTLIGHT SHEET KEEPS ITS FILLS — the crest band, the plinth and the stat band are owner-approved exemptions from the INK RULE**, decided 2026-09-12 after he was asked in writing. Do not "bring them into line" with `SATO-DIS-2026-01`, and do not re-raise it. The rank chip going from a tinted box to two rules was a separate, accepted change — it is not a precedent for the other three. `src/lib/spotlight/pdf.ts`.
- 🔴 **THE SPOTLIGHT SHEET’S ARABIC MARK IS A PLACEHOLDER THE OWNER IS REPLACING HIMSELF — leave it on the sheet until he sends the official asset.** `public/brand/sato-pharma-arabic-on-light.png` is AI-generated and hand-edited (four dots removed; `tests/phoenix-official-logo.test.ts` goes red if the recipe puts them back). It is KNOWN, it is DECIDED, and it is his to close: never remove it, never regenerate it, never ask again. When the real file arrives, swap it and re-pin that test.
- 🔴 **A REJECTION NOTICE IS NEVER SENT AUTOMATICALLY**, in either channel, and already-rejected candidates are settled. **The planner built that day was removed the same day — do NOT rebuild it, and never read the two recipient sheets he was sent as a queue waiting for a send path.** Keep `isBatchActor` (`src/lib/recruitment/batch-actor.ts`).
- 🔴 **THE SYSTEM NEVER AUTO-APPROVES A PLAN — a DM's weekly plan is submit → NSM (or RSM) → HR acknowledge, NO CEO stage.** No system-signed APPROVAL (`SYSTEM-AUTO-HR-ACK` on the acknowledgement stays); never skip a stage by writing a decision row for it. DM plans carry NO `ceo_approve` row by design — do not restore one, and never delete a human decision on a fabricated-row predicate. `the-system-never-auto-approves-a-plan`
- 🔒 **A PHARMACY IS NOT A CONTACT — a CRM contact count is `PM` + `AM` only.** Pharmacies get their own tile; never name a pharmacy bag `contacts`. Row label **"Pharmacist"**, count **"Pharmacies"**. `a-pharmacy-is-not-a-contact`
- 🔒 **THE CALL RATE IS NEVER AVERAGED — AM against 2, PM against 10, reported APART**, with no combined figure anywhere. Never join the pair with a slash; use ` AM · ` / ` PM`. Pinned by `runKpiAttainmentAndIdentityTests` in the required `validate` job.
- Marketing Manager is hidden from the portal Incentive tab; GPM still sees it.
- The Organogram / AU seat model is the source of truth for org-structure and vacancy data.
- **SoS attribution is PERIOD-AWARE** — `au.f_monthly_attribution`/`au.f_monthly_achievement` resolve an area's region via `au.f_line_area_map_asof(period_end)`, never today's geography.
- 🔒 **A CRM account label is `[Name ]( Area / Line )`; `E`→`A` and `F`→`P` are RETIRED codes** (live: `A`, `C`, `P`) — never an open question. The CRM admin deactivates and CLONES, never deletes: **cloning is safe; RENAMING corrupts numbers.**
- **The Delta (3) territory move is LIVE and complete** (`D11`, `D24`, `D25`, `OT2`, `OT9`, dated 2026-09-01) — do not re-apply, re-date or "finish" it; `recruitmentAreaRegionOverrides` is PERMANENT. Keep `delta3_defer_backup_20260829.line_area_map_pre`; **never repoint `code_region_code`.**
- 🔒 **THE AUGUST / DELTA (3) GOLDEN RULE — the August closing NEVER contains Delta (3).** Already enforced (`runClosingPeriodDatingTests`); **never resolve closing geography at the run date**, and **never offer to publish August “now that the move is live” — the DATE is the mechanism.**
- 🔒 **THE AUGUST / UPPER EGYPT GOLDEN RULE — Pedia's Upper Egypt splits into UE-1/UE-2 on 2026-09-01, and August NEVER contains the split.** **UE-1** Fayoum, Beni Suef, Minia 1-2, Assuit 1-2. **UE-2** Sohag 1-2, Qena 1, Qena 2, and **LUXOR, which is NOT a separate area** — it rides in as `other_permanent` with no rep seat. Aswan stays in Others. **PEDIA ONLY** — do not "align" Anti Infective's `UE-1`/`UE-2`, whose membership DIFFERS (Assuit is UE-2 there, Fayoum is Giza); the DATE is the mechanism. 🔴 El Qema's divisor goes 37 → 39. Pinned by `tests/pedia-upper-egypt-split.test.ts`.
- 🔒 **Delta (3) is ANTI-INFECTIVE ONLY.** On CNS and Pedia the five areas never move; "half-migrated" is the CORRECT state.
- 🔒 **THE AUGUST / KAFR EL-SHEIKH GOLDEN RULE — Kafr El-Sheikh 1 joins Delta (1) on PEDIA from 2026-09-01, and August NEVER contains the move.** Anti Infective already filed it there; **CNS keeps it on Alex-BHR for good** — half-migrated across lines is CORRECT, never "align" CNS. 🔴 **Kafr El-Sheikh 2 STAYS in Others**, which is what holds El Qema's divisor at 39: unlike the Upper Egypt split this move shifts NO money, in EITHER month — a changed El Qema number is a DEFECT, not an effect. The DATE is the mechanism. Pinned by `tests/pedia-kafr-el-sheikh-delta-1.test.ts`.
- 🔒 **THE CLOSING GOLDEN RULE — never RELEASE a closing during the month it covers** (publishable the first day of the next month, Cairo). Enforced by `src/lib/sales/closing-period-gate.ts` + `tests/closing-period-gate.test.ts` in the required `validate` check; `unpublishClosing` stays ungated. No override flag.
- 🔴 **A PUBLISHED AND ANNOUNCED MONTH IS NEVER CORRECTED, however justified the fix.** A late ruling is a rule for UPCOMING months. `monthly_closing_locks` is his decision — unlock only when he says so about that month. `never-fix-a-published-and-announced-month`
- 🔒 **THE CITY RULE ALWAYS WINS — a wholesaler's sales split evenly over its OWN city's areas, even when its goods demonstrably LEFT the city**, except EZ (`evenSplitApplied`), Office, and El Qema's warehouses. **Never reintroduce a per-customer apportionment override.**
- 🔒 **EL QEMA (`QM`), PEDIA ONLY — 3 bands, then the صعيد pass, then the lead ladder.** Per warehouse per product on the month total: **≤200** governorate only; **201–699** half governorate, half rest of country; **≥700** flat over the republic. Qalubeya = Qalubeya + Cairo, evenly — 🔴 **the 60/40, 75/25 and PRIORITY LADDER are GONE, so finding one missing is a DECISION, never a gap to repair.** The صعيد pass runs in EVERY band: Upper Egypt's credited sales pooled, half back across it, half over the republic. Then Qalubeya first, Tanta (D14) and Mahalla (D15) level behind, 2% per tier (`QEMA_LEAD_TIERS`), once per line and product, NOT in `splitTargetsFor`. 🔴 Upper Egypt membership is `UPPER_EGYPT_AREAS`, never August's region codes. `store-sales-city-split.ts`, pinned by `tests/qema-warehouse-split.test.ts`.
- 🔒 **EL QEMA LEAVES NO TRACE IN A CLOSING DETAIL** — its detail ROWS are REMOVED for everyone but Super Admin (and `scope: "system"`); blanking was tried first and announced the hidden money. The standard workbook's distributor breakdowns and Source Coverage keep the money under an unnamed `—` (owner, 09-14); totals untouched. **Never invent a source.** Mask after every computation and before every render (`closing-source-mask.ts`; only the closing export passes `revealSource: true`), pinned by `tests/closing-source-mask.test.ts`.
- 🔒 **THE WEEKLY BI AND NSM/DSM EXPORT DESIGNS ARE PASSWORD-LOCKED** in `src/lib/sales/weekly/export-design.pins.json` (values and formulas are not). Re-pin only via `scripts/weekly-export-design-unlock.ts --unlock`; 🔴 **never fix a red design test by editing the pins.** NSM/DSM stays BEIGE; the BI book keeps the house identity. New capability ships BESIDE. `tests/weekly-export-design-lock.test.ts` · `tests/weekly-nsm-dsm-beige-look.test.ts`.
- 🔒 **THE PREMIUM MONTHLY CLOSING KEEPS ITS OWN EXECUTIVE LOOK** — rounded buttons, filled navy bands and its own navy are owner-approved exemptions. Pinned by `tests/closing-executive-look.test.ts`; the reference file is a spec, never a template. 🔴 **That look is THE WORKBOOK'S ONLY — the closing SCREEN stays Phoenix orange.** The screen was branded to the Sato workbook palette on 2026-09-12 at his request and he reverted it the same morning ("i mean the full front ui return orange as it was"), after five rounds on the Target column's ink alone. **Do not re-apply the workbook identity to a closing screen, and do not "fix" screen and download to match** — they are deliberately two looks.
- 🔒 **THE OLD MONTHLY CLOSING EXPORT IS FROZEN — every new closing feature ships BESIDE it**, in the premium export. The shared `runExport` is pinned by `tests/sos-ui-truth.test.ts`. `the-old-monthly-closing-export-is-never-touched`
- 🔒 **The premium closing workbook FILLS the `.xlsm` engine — it never rebuilds one.** Never round-trip it through ExcelJS; rewrite the data parts inside the zip, and ship the template EMPTY. `premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it`
- **Every weekly report and export MUST set `excludeUnmapped`, and an export must MATCH the screen** — label, never silently drop. The Weekly Summarized Report's LAYOUT AND SCOPE are locked; its ink is the house identity.
- 🔴 **A typed payroll Addition (incentive, bonus, overtime) has NO ceiling** — owner, 2026-09-15: no refuse, no flag, no "large addition" warning; never re-propose one. `typed-payroll-additions-have-no-ceiling`
- **The system FLAGS an expense; it NEVER auto-rejects one.** Never auto-publish a deductions month or approve a batch yourself; a same-day CRM check reads zero — never report it as measured.
- **CRM visit types `-5` (Public Holiday), `-6` (Casual Leave) and `-16` (Training, vendor-labelled "Unknown") are WORKING days.** `-4` is the only leave type, and only **FWC** reaches salary.
- **The Ready-sheet >25th full-pay waiver is for genuine RESIGNATIONS only** — terminated and inactive leavers stay prorated with zero allowances; a regional employee travelling TO Cairo earns no outstation per-diem; DSM and Medical Rep titles auto-provision their real role (the title-governance guard is DELIBERATELY relaxed for those two).
- **Social-insurance Form 1 prints exactly as the Authority issues it** — nothing Phoenix wrote on page 2, duplex.
- **The organogram XLSX keeps its Mobile column** (his override) — do not remove it.
- **The public Territory Management preview never shows the line** (pinned to Pedia server-side); the chart and employee popup read different sources; **the WhatsApp button stays on the CEO and NSM rows.**
- 🔴 **The CEO is NOT a district, and a picker is never wider than its viewer** — pass the viewer's scope to the PICKER as well as the query. `the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer`
- 🔒 **SCOPE RUNS DOWNWARD ONLY — never your own manager, nor anyone at or above your RANK.** Enforce it in `resolveDoctorCoverageScope`: the management chain plus a seat-rank ladder (`line` basis only); the viewer stays in his own scope; unranked titles are excluded. `scope-runs-downward-only-never-your-own-manager` **A DM never receives a DM CV.** `a-dm-never-receives-a-dm-cv`
- 🔴 **An NSM's outstation expense is NEVER held** — NSM only. `nsm-outstation-expense-is-never-held`
- 🔴 **An NSM's same-day-return outstation allowance is 300** — when `allowance = 300` exceeds `total`, raise the total; never trim the allowance.
- 🔴 **The mailbox-monitor app-password entry is `imap`** — never "Phoenix", never `___`. `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix`
- 🔒 **Turbify CANNOT issue app passwords centrally, and the owner is STAYING** — do not re-pitch a migration. `turbify-cannot-issue-app-passwords-centrally-owner-stays`
- 🔴 **A password reset does NOT revoke a Turbify mailbox** — also delete the app passwords, or suspend the mailbox. `public.mailbox_offboarding_tasks` rows are attestations. `a-password-reset-does-not-revoke-a-turbify-mailbox`
- **Four sales-attribution facts silently change a number:** EZ `1011654` splits evenly across Cairo+Giza CNS; the closing reads the DISTRIBUTOR-PRODUCT rollup, not `fact_rollup`; a case-duplicate `line_area_map` row doubles a line; "Stores" means `Office`, "UPA" is a channel. `ez-is-credited-evenly-across-cairo-giza-cns-reps` · `closing-reads-distributor-product-rollup-not-fact-rollup` · `a-case-duplicate-line-map-row-doubled-a-whole-line` · `owner-sheet-vocabulary-stores-is-office-upa-is-a-channel`
- 🔒 **THE DIRECT-ORDER MONTH GOLDEN RULE — an order counts in the month Finance books it, at its pharmacy's own brick and area.** The closing is `phx_closing_distributor_product` PLUS `phx_monthly_closing_direct`: quoting the first alone understates, flipping its `not is_direct` double-counts. Blank-area `DIRECT` rows are the retired vintage. `direct-orders-are-counted-in-the-month-finance-books-them`
- 🔴 **Not every distributor uploads every month — "N of 17 missing" is never a finding.** Measure the EVERY-MONTH set; files land across the first two weeks; a stopped feed is not outstanding. `not-every-distributor-uploads-every-month`
- 🔴 **IS-S 2026-04 and 2026-05 are the SAME FILE, and the owner is leaving both pending** — never void, re-import or pick a month. Quoting either month quotes a doubled figure; say so.

### 4.1 Marketing customer, venue and licence validation

Full account: `docs/agents-owner-rules.md` §4.1.

- 🔒 **Venue validation is GPS + a live picture ALWAYS; leg 3 (the registered code, else the licence) is PHARMACY-only.** A non-pharmacy venue routes to **`admin`**, never `none`; a codeless PHARMACY is still refused. Direct-order desk only. **`nursery` = any venue with no distributor account — the owner's own filing, not a defect.**
- 🔴 **Marketing pharmacies are TERRITORIAL, and a NULL `area_id` makes one invisible.** **The REGISTERED CODE beats live GPS.**
- 🔴 **A licence verdict is PERMANENT, with no correction path.** **Ask the owner before the first one is recorded.**
- 🔴 **`system_validated` means NO HUMAN LOOKED.** The screen is **Super Admin only** — not SFE.
- 🔴 **AREA governs both sight and reuse of a venue's evidence; never backfill ownership.**
- 🔴 **The badge must read the live evidence, not a frozen note** — EITHER half reaching `complete` clears it.
- 🔴 **A duplicate merge STRANDS the desk validation on the retired row.** Repair it with hand SQL, not code.
- 🔴 **The screen that SHOWS a badge is not the screen a rep can OPEN.** Check the gate before wiring any `actionUrl`.

## 5. Session, worktree, and parallel-work safety

Before editing, run `git status`, `git branch --show-current`, `git log -1 --oneline`,
`git worktree list`. Account: `docs/agents-worktree-and-machine-limits.md`.

- Use one working tree per active session. **Never two interactive sessions in one folder** — the SessionStart lock warning is a hard stop. (A crashed session's lock self-expires after 2 hours, and that AGE is the ONLY staleness test — the lock's `pid` is the hook's own parent shell, so EVERY lock names a dead PID.)
- Start new work from the latest `origin/main` on a focused `codex/<task>` branch unless told otherwise.
- Never run `git clone`, `git init`, or anything that recreates the primary repository's `.git`.
- Never discard, overwrite, clean, reset or revert changes you did not create. Treat unexpected changes as the owner's work; classify and preserve a dirty tree.
- **Never delete a `.xlsx` or `.pdf` file.** Scan a folder before removing it; move any not identical to a tracked copy into `xlsx/` at the repo root.
- **Start a session with `node scripts/new-session.mjs <task>`** (fetch, `_wt-<task>` on `codex/<task>`, `node_modules` junction, env files; refuses below 6 GB free commit). `--status`, `--repair`, `--from <ref>`. A bare `git worktree add` has no `.env.local` and no `node_modules`.
- **A sibling `_wt-<task>` is a NEW project to Claude Code** — `node scripts/sync-worktree-env.mjs` copies `.claude/settings.local.json` and points `autoMemoryDirectory` at the primary's memory.
- **Never `pnpm install`, `pnpm run` or `pnpm exec` inside a worktree** — they purge the `node_modules` junction, and `pnpm exec` fails silent-shaped. Invoke `node scripts/…`; dev server: `node node_modules/next/dist/bin/next dev --webpack --port 3000`. **Mechanical since 2026-09-16:** `bash-guard.mjs` C6 DENIES every pnpm form here and names the node equivalent — a deny because `Bash(pnpm run *)` and `Bash(pnpm exec *)` auto-approve it, so no prompt was ever coming.
- **Stop a dev server by PORT, not by task:** `Get-NetTCPConnection -LocalPort 3000 -State Listen`, then `Stop-Process -Id <OwningProcess> -Force`. Only a curl of `000` proves the port is free.
- In-repo worktree folders must start with `_wt-` (or sit under `.codex-worktrees/` or `.claude/worktrees/`). Locked `.claude/worktrees/` belong to live sessions — never remove them.
- **Remove worktrees with `node scripts/new-session.mjs --remove <task>`, only after approval** — its gate asks the merged PR, because **a squash-merged branch legitimately holds commits `main` does not.**
- **`git worktree remove` leaves a HUSK nothing in git can see** — run `pnpm run repo:doctor` after any removal; `--fix` deletes only zero-file husks.
- **`repo:doctor` lists memory files with no index line** (`--deep` for all) and writes nothing except `--snapshot-xlsx` (outside the repo) — **but by default it pages the PRODUCTION GoTrue admin API**; `--no-auth` skips that.
- **`xlsx/` is gitignored and has NO automatic backup** — never tell the owner the sheets are covered.
- **Worktree payload (path COUNT) is what makes this checkout slow** — retire merged worktrees and clear husks; do not tune `tsconfig`/`eslint`.

**Machine limits.** RAM is 16 GB. One dev server at a time, ever; one typecheck/build at a time
locally — parallel validation belongs to CI. **The binding limit is the Windows COMMIT charge, and it
FLOATS** — read it live (`node scripts/new-session.mjs --status`), never budget against a remembered
figure. 🔴 **Commit headroom can stay GREEN while physical RAM runs out — read FREE RAM, never the
session count.** `~/.claude/hooks/heavy-job-gate.mjs` refuses a cold typecheck, build or `ci` under
**5,000 MB** and lint or tests under **2,600 MB** — it does NOT gate a dev server (since 2026-09-12);
under **1,800 MB** `mem-watchdog.ps1` reaps idle dev servers; under **500 MB** any node job. **Stop a dev server (by port) before closing a session; a statusline count is not a guard.**

Route work by tier:

| Tier | Where | Use for |
| --- | --- | --- |
| **A — Cloud session** *(the default)* | Isolated cloud clone, ends in a PR | Any independent task not needing localhost browser verification, local files or local credentials. Sonnet by default. |
| **B — Local worktree** (max 2–3 woken) | Sibling `_wt-<task>` | Only tasks needing browser preview, dev-auth role sweeps or local creds. |
| **C — Main checkout** (exactly one — the control tower) | primary repo folder | Reviews, merge/deploy decisions, DB operations, deployed-env verification, worktree triage. Never feature edits. |

Only the control-tower session rewrites the memory index; others may append memory files but never
reorganize it. Cloud sessions cannot see local state — put everything they need in the task prompt.

## 6. Approval rules

Pipeline: `inspect → isolate → implement → validate → summarize → commit/push/PR
→ verify CI → approve merge → verify production`.

**The default decision is: PROCEED.**

Complete every pre-approved step automatically and ask permission ONLY at one of the two protected
actions below. Do NOT repeatedly ask for confirmation ("Should I proceed?") for pre-approved actions.
If a task requires no protected action, complete it without asking.

**PRE-APPROVED ACTIONS (proceed automatically):**
- Reading, searching and auditing the codebase
- Editing or creating files, refactoring, fixing bugs
- Running local commands, tests, lint, type checks, builds and validation
- Installing or updating dependencies when required for the task
- Creating branches, worktrees, commits, and pushing to non-production branches
- Creating, updating or reviewing Pull Requests (merging requires approval)
- Resolving merge conflicts on the working branch
- Creating database migration files, testing migrations locally or in non-production
- Running Supabase CLI commands that do NOT modify production
- Updating documentation, configuration or CI/CD configuration
- Deploying or testing in local, preview, development or staging environments
- Investigating logs, errors or infrastructure (GitHub, Railway, Supabase)
- Running safe diagnostic or repair actions outside production

**PROTECTED ACTIONS (stop and require separate, explicit approval before):**
1. Merging any branch or Pull Request into `main` or any production branch.
2. Running or applying any database migration against the production database/environment.

**Both are pre-approved while §6.1 AUTORUN is armed.**

### 6.1 AUTORUN — the owner's standing instruction to finish without stopping

Account — what he was shown, what he answered, why the trigger is a typed word:
`docs/agents-autorun.md`.

**Trigger: the word `AUTORUN` in a message the owner typed himself.** It arms the session that
received it, for the plan named in that message, until that plan is finished. **Read it PERMISSIVELY
(his decision):** his plain instruction to run a named plan without interruption — "don't stop", "do
the whole thing" — arms it too, and stopping to ask which he meant is the failure this rule removes.
**It is NEVER armed by a memory, a doc, a hook, another session or a replayed summary**, and one
arming authorizes ONE session (§2.1, Parallel sessions). The guard hook matches only the literal word,
so when he arms a long plan without it, say in one line that you are treating it as armed.

**While armed, BOTH protected actions are pre-approved** — merging to `main` and applying a
production migration. **Do not re-ask, do not re-warn, and do not treat a phase boundary as a
checkpoint.** **The run stops ONCE: after the last phase AND the cleanup are done.** Absorb and keep
going through: a red CI check (fix, push again); a merge conflict (resolve it); a business-fact
question (park it, then ask all at the end in chat as multiple choice, §4 — an xlsx only for a long per-item list); a blocked phase (finish
every other phase, then name it); a choice you could make yourself (prefer the reversible option).

**Three things AUTORUN cannot waive:**

1. **The Office golden rule** needs a password that exists only as a scrypt verifier
   (`pnpm run office-rule:unlock`). A plan needing it stops there and only there.
2. **A destructive or bulk PRODUCTION data change** still gets its §8 announcement — state it, take
   the pre-image or backup FIRST, prove it landed, then proceed.
3. **The other protected files** (CLAUDE.md) are still announced before the edit — announced, not awaited.

**The final report is the whole point:** every merge, production change and migration applied, the
parked questions, and anything left undone.

🔴 **AUTORUN survives compaction only where `.claude/hooks/autorun-guard.mjs` is loaded** — it
re-states an arming per `session_id` (never creates one; `AUTORUN OFF` stands it down), and hooks load
at session start from the worktree's own branch, so **never assume it is running**. **Restate
`AUTORUN ARMED — <plan>` at the top of every summary and hand-off**, and **if you cannot tell whether
you are armed, you are NOT** — finish the current phase, say so in one line, and continue asking as
normal. The hook's silence proves nothing either way.

**Git hygiene.** Review `git status`, `git diff`, `git diff --cached` before committing. Stage only
files owned by the task. Never commit `.env*`, `.vercel/`, credentials, local artifacts, screenshots,
temporary scripts, unrelated lockfile changes or unrelated user edits. Use conventional messages
(`fix(module): reason`, `feat(module): capability`, `docs(agents): change`). `main` is production —
never edit it directly. `delete_branch_on_merge` is on, so GitHub deletes the **remote** branch
automatically; the local branch and worktree survive and still need approval to remove.

## 7. Validation

**CI is the gate. Do not run a local full validation.**

`check:harden` and the `ask-before-validation` hook are retired at the owner's instruction. Do not
reintroduce them or invent a replacement — no "quick subset" of lint + typecheck before pushing, no
`pnpm run ci` as a pre-push ritual. **Push the branch and let the PR's checks answer.** The four
**required** checks — `validate`, `lint`, `typecheck`, `secret-scan` — run on the PR head commit and
block the merge if any is red. `pnpm run ci` is opt-in: run it **only when the owner names it**.

Two things are NOT covered by a PR's CI and still need a check immediately before the action:
**migrations** and **production deploys**. Verifying a UI change in the browser is not validation at
all — reload and look.

| Change type | Minimum validation | Who runs it |
| --- | --- | --- |
| Docs or repo instructions only | Review diff, formatting, links, secret exposure | You, by reading |
| Narrow TypeScript/JavaScript change | Lint, typecheck, targeted tests | CI, on the PR |
| Shared runtime, app/API route, server component, env or deployment behavior | Lint, typecheck, tests, build | CI, on the PR |
| UI workflow | Relevant code checks plus browser verification at desktop and mobile sizes | CI for the code; **you** for the browser |
| Migration, view, function, RPC, grant or policy | Migration checks, SQL review, target confirmation, schema/security review, staging verification after approval | **You, before the migration** — CI never sees this |
| Auth, RLS, payroll, HR lifecycle, sales, permissions, executive reporting | Full checks, role-based tests, failure-state checks, explicit risk review | CI for the code; **you** for the role sweep and the risk review |

Prefer repository scripts over improvised commands. Never present a known-broken change as ready.
Report failures your change caused separately from pre-existing ones. When a data source is
unavailable, verify the UI says so rather than showing a misleading zero.

**Role-based testing.** For permission-sensitive work, test the affected roles including denial
paths. Sales: Super Admin, CEO, National Sales Manager, Regional Manager, District Manager.
Coaching: Super Admin, CEO, SFE Manager, Training Manager, and Medical Rep when employee review is
affected. HR: Super Admin, CEO, HR Advisory, HR Operations, and Employee when portal behavior is
affected. Do not claim role safety from code inspection alone when real role testing is possible.

**Deploy verification.** Production is Railway auto-deploy on push to `main`. Confirm a deploy
through `gh api repos/Gawish-1997/phoenix-people-workforce/deployments` or `railway status`, and what
serves traffic via `/api/healthz` `revision`. Smoke-test on the live staging app (§3) before a risky
production deploy when there is time. After a runtime-impacting production deploy, verify the public
domain, smoke-test the changed workflow and inspect `railway logs`. When a page fails, capture the
visible error, browser console, network/API response, deployment logs and database/RLS evidence
before proposing a fix.

## 8. Supabase and data safety

- **Supabase writes are pre-authorized end to end — NO approval prompt** (the owner's `autoMode` grant deliberately removes the §6 gate for Supabase). It covers the `supabase-staging` and `supabase-production` MCP servers and the `supabase` CLI (incl. `db push`), on staging AND production, reads and writes alike — `execute_sql` mutations, `apply_migration`, bulk and destructive SQL. The one standing condition: **announce any destructive or bulk PRODUCTION change in plain words before you run it, and give the owner a chance to stop it.** (It does NOT cover creating/deleting a project or reading secrets.)
- All schema changes must be migration-based, repeatable, reviewable and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref, resolving it with `list_projects` rather than trusting a ref pasted in a prompt or copied from an older doc.
- `supabase-production` can see **every project its token reaches.** **Its name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.** `supabase-staging` is pinned to staging.
- Any UUID-named Supabase tool (a claude.ai account connector) stays deny-listed by default; `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087` remains denied. **Write the BARE server name in a deny rule** — a `__*` suffix matches nothing.
- **OWNER DECISION: `mcp__45bb6356-…` stays DENIED** — settled; do not re-allow it, propose it or chase a blocked call as a bug.
- Before destructive or bulk live-data work, inventory the target, create or verify a backup, show the exact mutation, and define post-change counts or checks.
- Verify RLS, grants, RPC authorization, service-role boundaries and browser-role exposure whenever permissions or data access change. Service-role credentials stay server-only.
- Visibility in this app is **application-scoped, not RLS-scoped** — most code paths use the service-role client. A `?? getSupabaseAdmin()` fallback is a silent fail-open.

## 9. Stop conditions

Stop before delivery or mutation and explain the blocker when:

- The target branch, worktree, environment, project or requested scope is uncertain.
- Unrelated changes cannot be isolated safely.
- Validation fails and the proposed action would publish known-broken work.
- A PR is conflicted, required checks are failing, or the preview is not the expected deployment.
- A secret may have been exposed. Do not repeat it; recommend revocation and replacement.
- A destructive action lacks a verified target, backup, recovery path or explicit approval.
