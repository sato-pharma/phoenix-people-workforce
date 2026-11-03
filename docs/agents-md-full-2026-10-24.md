# AGENTS.md and CLAUDE.md — the full text before the 24 Oct 2026 shrink

The owner asked on 24 Oct 2026 (~18:30 Cairo) for AGENTS.md to be shrunk "so every session starts lighter": it is re-sent on every request of every session, and the weekly Claude usage was draining. Every rule stayed in AGENTS.md as a short cue; the wording, evidence and owner quotes each rule carried are kept here, word for word, as they stood on `main` plus the same-day removal of the scheduled PR merger. **Read the matching section here when a cue in AGENTS.md is not enough to act on.** This file is NOT auto-loaded.

---

## (the original title) Phoenix Workforce — Agent Rules

Operating rules for every AI agent and automation tool in this repository. Codebase reference
(layout, auth, API conventions, cron, env) lives in [docs/architecture.md](docs/architecture.md);
daily commands and the protected-file gate live in [CLAUDE.md](CLAUDE.md). Higher-priority platform
or system instructions take precedence. When instructions conflict or scope is unclear, stop before
the risky action and explain the conflict plainly.

**This file auto-loads in full on every request, so it holds hooks only** — the rule plus the one
detail needed to obey it; the evidence goes in `docs/`. A rule for ONE module goes in that module's
memory (`.claude/rules/<module>.md`, §2.2); a session-level trap goes in
[docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md) under its cluster,
never back into §2.1. Measure a section before adding to it (`docs/memory-index-budget.md`).

**The accounts are read on demand — before working in an area, search its account for the hook's
wording.** Payroll, sales/closing, recruitment, CRM, exports → `docs/agents-owner-rules.md`. Deploy,
cron, production data → `docs/agents-production-hooks.md`, `docs/environment.md`. Worktrees and
machine limits → `docs/agents-worktree-and-machine-limits.md`. Shell, git, CI, validation →
`docs/agents-session-traps.md`. Memory index → `docs/memory-index-budget.md`. AUTORUN →
`docs/agents-autorun.md`. Why a §2 rule exists → `docs/agents-incident-history.md`.

**Every memory note is filed under a module, `global` or `history` in
`scripts/module-memory/assignments.json`, and CI refuses an orphan (§2.2).** A backticked slug here or
in a module file is a cue to open that note; `docs/agents-memory-map.md` maps the older slugs to hooks.

## 0. How this repo is actually run (calibrate to this)

One owner runs everything. He is **not a career engineer** — he is the business owner of a live HR
platform a real pharmaceutical company runs payroll, attendance and sales on. Real employees are
paid from this data. Over the last 90 days (measured 2026-09-21):

- **~46 commits/day, 6.7 files per commit.** Small, focused changes, shipped constantly.
- **1,935 fix commits vs 1,226 feature commits.** More than half of all work repairs work.
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

- **Never use `gh pr merge --auto`.** `main` is branch-protected with **2 required checks** — `validate`, `checks`; `allow_auto_merge: false`. Merge only with a plain `gh pr merge` after separate owner approval. 🔴 **THAT LIST HAS ROTTED FIVE TIMES, AND `lint`, `typecheck` and `test` ARE NOT CHECK NAMES** — read `branches/main/protection/required_status_checks` live, never this line; `node scripts/check-required-checks.mjs` catches the next rotation. Account: `docs/agents-incident-history.md`.
- **Never commit directly onto local `main` in the primary checkout.** The push is then rejected (`enforce_admins: true`), and the commit strands on the one checkout every parallel session shares — where another session’s `git reset` destroys it. Branch first. If you already committed: `git branch <name> <sha>` then `git reset --keep origin/main` (**not** `--hard`, which would also wipe other sessions’ uncommitted work), then open a PR. Cost a real recovery on 2026-09-12 (#3728).
- **Do NOT run `gh pr update-branch` reflexively** — "require branches up to date" is OFF (`strict: false`) and each run costs ~16 Actions minutes. Run it **only when the change depends on something newly on `main`**.
- **`gh pr update-branch` acts on the SERVER** — `git fetch` and `git merge --ff-only origin/<branch>` before your next push; CI re-runs on the new head.
- **A merge to `main` SHIPS TO PRODUCTION as soon as that commit's CI is green** (Railway, full traffic, no smoke test). **Never merge what you would not have serving employees within minutes**; confirm with `/api/healthz` `revision`.
- 🔴 **THE DEPLOY IS GATED BY THE RELEASE GATE, NOT RAILWAY'S "WAIT FOR CI" (OFF ON BOTH SERVICES SINCE 2026-10-20), AND THE GATE FAILS BY NOT SHIPPING — SILENTLY.** Railway builds at the merge; the new container answers `/api/readyz` 503 until `ci.yml`'s `release-gate` job has recorded that `validate` and `checks` passed on that commit, so **red or unfinished CI = the old version keeps serving, the new deploy is marked failed after its 15-minute window, and nothing turns red** — read `/api/healthz` `revision`, never the merge. Only those two checks hold it now (a scheduled or Dependabot suite no longer does); `railway variables --set` still redeploys at once, so confirm the serving commit is in `release_gates` first; never remove `push: main` or the `release-gate` job from `ci.yml`; **never have both gates off**. 🔴 **Never cancel a stuck `main` run and walk away** — `gh run rerun <id>` the push run, or produce a succeeding run on that SHA. Account: `docs/deployment.md`, "The release gate".
- **There is a staging application**, wired to the staging Supabase project — §3.
- **A hand-run typecheck must start cold:** `tsc --incremental false`.
- **Never foreground-watch a long pipeline.** Background it and check at batched checkpoints.
- **Batch your look-arounds: when you already know the next few files, greps or status reads you need, send them as parallel tool calls in ONE step** (or one shell command that prints them all). Every step is a full model round trip, ~10 s here; on 8 Oct 2026 a build task averaged 14 single look-around steps and only 10% of steps batched. `.claude/hooks/batch-nudge.mjs` reminds a session after three in a row and never blocks. Account: `docs/hook-dispatcher.md`, "batch-nudge".
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), never the cookie flow — it logs the real user out.
- **Merged-branch checks must be squash-aware:** `gh pr list --head <branch> --state merged`, never `git branch --merged` — 🔴 **but that asks about a NAME, so a REUSED name returns the OLD merged PR while yours is still open**: before deleting a branch ask for the PR by NUMBER and check its files are byte-identical on `main`. `a-reused-branch-name-finds-the-old-merged-pr`
- **A regression test counts only if you break the fix and see its own headline assertion fire.**
- **`list_migrations` reports the ledger, not reality** — query `pg_class`/`pg_proc`.
- **Commit, push and open the PR WITHOUT asking; ALWAYS ask before merge** (owner rule, 2026-09-16 — supersedes the old auto-git ban; the scheduled PR merger that replaced the ask on 2026-10-24 was REMOVED the same day, §6). Branch first, stage only the task's files, never `--auto`.

### 2.1 Session-level traps

**The traps live in [docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md), DELIVERED by `.claude/hooks/trap-injector.mjs`** — a PreToolUse hook that injects the matching cluster's **headlines** once per session (the git traps when you touch git, the Supabase traps when you touch Supabase). 🔴 **A headline is a trap's first sentence, not the rule** — before acting on anything one touches, search the clusters file for its words and read the trap in full. Thirteen clusters — **Shell and tooling · Git · CI and PRs · Migrations · Database, grants and RLS · Probing, attributing and reporting production · Validation · Memory and this index · Parallel sessions · Worktrees · Next.js runtime · Browser and dev-auth · Machine ceiling.**

🔴 **The hook FAILS OPEN and SILENT** — no trap block for the kind of work you are doing? Open the clusters file and read the matching one yourself, before the first command of that kind. Accounts: [docs/agents-session-traps.md](docs/agents-session-traps.md); which memory backs which hook: [docs/agents-memory-map.md](docs/agents-memory-map.md).

**Reachability roster** — `scripts/memory-index-reachability.mjs` scans THIS file for these backticked slugs, so they stay here; deleting one orphans that memory unless `MEMORY.md` also links it.

`tz-africa-cairo-silently-returns-utc-in-msys` · `looking-at-a-generated-workbook-two-ways-that-lie` · `a-manual-scheduled-task-run-leaves-no-trace` · `main-is-not-the-primary-checkout` · `a-missing-table-answers-pgrst205-not-42p01` · `attribution-rollup-fingerprint-ignores-the-sales-data` · `offer-chain-was-live-in-the-registry-with-a-hole-past-approval` · `ats-candidate-children-one-has-no-fk-and-one-is-a-view` · `cv-extraction-reads-governorate-but-never-applies-it` · `the-medical-rep-cv-schema-reads-12-fields-universal-reads-38` · `a-cv-import-overwrote-a-candidates-whole-identity` · `the-email-import-allowlist-holds-an-inbox-not-a-sender` · `cv-file-is-in-ats-files-not-cv-external-url` · `census-client-errors-by-stack-not-message` · `typecheck-incremental-false-green` · `the-test-suite-runs-with-production-credentials-and-app-env-production` · `tailwind-merge-strips-custom-named-font-sizes` · `bilingual-bodies-need-direction-per-line-not-per-block` · `ireports360-timestamps-cairo-local-mislabeled-utc` · `verify-the-emitted-artifact-never-the-source` · `at-slash-lib-shadows-src-lib-via-tsconfig-paths` · `gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded` · `collapsed-browser-pane-reads-zero` · `agent-isolation-remote-ran-locally-in-a-worktree` · `automode-allow-cannot-authorize-editing-the-permission-config` · `claude-project-dir-is-the-sessions-own-worktree` · `supabase-access-and-prod-token-are-one-token` · `git-branch-d-is-not-a-safety-gate-after-a-squash-merge` · `a-squash-merge-makes-a-stacked-branch-rebuild-not-merge` · `claude-code-effort-max-got-slow-xhigh-is-the-balance` · `slowness-audits-compare-before-and-after` · `verifying-a-new-workbook-builder-takes-three-layers` · `two-session-stores-two-retention-keys` · `a-worktree-husk-is-pinned-by-the-session-not-its-cwd` · `regen-readslivedata-flag-matches-a-comment-not-a-call` · `apply-sql-file-default-pooler-host-is-wrong-for-production` · `railway-services-are-born-in-sfo-and-volumes-are-region-pinned` · `a-green-test-run-carries-no-type-signal-at-all` · `a-mismatch-query-hides-the-row-that-matches` · `grepping-a-wrapped-report-turns-an-explanation-into-a-verdict` · `pg-stat-statements-times-precisely-and-attributes-never` · `never-hand-roll-a-rule-the-repo-already-implements` · `mains-required-checks-are-four-not-six-checks-carries-the-suite` · `a-field-that-does-not-exist-is-a-silently-dead-branch` · `the-four-shapes-a-stale-citation-sweep-misreads` · `a-ledger-version-never-matches-the-file` · `the-small-pr-merge-guard-and-the-classifier-deadlock` · `a-no-commit-merge-probe-actually-merges-in-the-shared-primary`

### 2.2 Memory — module memory and the index

**Each line is a cue.** How it works, why, and the proof it loads: `docs/module-memory.md`.

- 🔴 **A MODULE-MEMORY LIMIT IS NEVER PUT TO THE OWNER — IT IS THE SESSION'S TO FIX AND SHIP** (owner, 2026-10-03). A pointer over its margin, a module file near its cap, an orphan note, a dead glob, a stale generated block, an inbox that will not settle: **split it, file it, rebuild it, and ship it inside the PR you are already opening** — never a question, a `Next step:` line, a sentence in a summary, or a request to free space in `MEMORY.md`. Each one already fails the required `validate` job. Account: `docs/module-memory.md`, "Limits".
- 🔒 **MODULE MEMORY HOLDS EACH MODULE'S RULES AND NOTES — `.claude/rules/<module>.md`, loaded BY CLAUDE CODE the moment a session reads a file of that module** (owner, 2026-10-02). Work that opens no file gets it from `.claude/hooks/module-memory-injector.mjs`. 🔴 **About to change a module and its memory has not appeared? Open `.claude/rules/<module>.md` yourself** — the hook fails open and silent.
- 🔒 **ROUTE A NEW RULE BY WHERE IT APPLIES — never into this file by default.** One module → that module's `## Rules` section, in the PR that teaches it; a changed rule is an EDITED line, never a second one that contradicts it. True everywhere → here. A session trap → `docs/agents-session-traps-clusters.md`. The account always goes to `docs/`. **Never delete a rule to make room.**
- **A new memory note lands in `MEMORY.md` under `## Inbox`; the fold (`node scripts/module-memory/fold.mjs --apply`) files each under its module in ONE PR, and the inbox empties once that merges.** The note's `description` becomes its module line — write it as the cue, and correct a wrong note there. 🔴 **The fold runs at 09:00, 15:00 and 21:00 Cairo** (owner, 2026-10-03); a run with nothing new opens no PR, and only one fold PR is ever open.
- 🔴 **`tests/module-memory.test.ts` runs `scripts/module-memory/build.mjs --check` in the required `validate` job and REFUSES an orphan note, a dead glob, a module file over its cap, a stale generated block, or a rules file with no `paths:`** (that one would load at startup for everyone). Never hand-edit a generated block — edit `scripts/module-memory/modules.mjs` or `assignments.json` and run `node scripts/module-memory/build.mjs`.
- **`MEMORY.md` still auto-loads and is still SILENTLY truncated at 25 KB / 200 lines — it now carries only what is true everywhere plus the inbox.** Never move a module fact back into it "to make sure it is seen": that is the cycle module memory replaced.

**63 modules**, each one a `.claude/rules/<id>.md` whose own `paths:` holds every glob. The id → title → globs table is in `docs/module-memory.md` ("The module directory"); `ls .claude/rules/` lists them. You do not need either to reach a module — Claude Code loads the matching file the moment you open one of its files, and `.claude/hooks/module-memory-injector.mjs` matches work that opens no file.

### 2.3 Production and approval hooks

**Each line is the rule, not the evidence.** Account: `docs/agents-production-hooks.md`. **The
module-specific production hooks are module memory now** — Railway and the deploy queue in
`engineering`, cron and secrets in `platform`, each data hook with the module that owns the table.

- **A deploy applies NO migrations, and auto-deploy can silently SKIP** — read `/api/healthz` `revision`.
- 🔴 **Production has NO PITR — 7 daily backups are the whole recovery story.** Say so before any bulk or destructive change, and **never restore a daily backup in place.**

**Which environment the code thinks it is in**

- **A LOCAL run writes PRODUCTION but skips every email, and the local Resend key CANNOT send** — send from production with `railway run`.
- **STAGING cannot rehearse a PRODUCTION shape.**
- **`isProductionRuntime()` reads `APP_ENV || VERCEL_ENV || NODE_ENV`, and a production build sets `NODE_ENV=production` on staging** — `APP_ENV` must stay set there (fixed).
- **Staging email is safe only because `PHOENIX_EMAIL_FORCE_TESTING` is set explicitly — one variable, nothing behind it.**
- **The `APP_ENV`/cron-secret hole is CLOSED — do not re-chase it**, but treat `!isProductionRuntime()` as an auth fallback with suspicion.

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
  | `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | **`tvweawmrjrekvepkcxzs`** | unrelated to this app — **different organization** |

  **Dead refs — treat any doc, memory or prompt still naming one as stale:** `izhmxvgiktiafqusolot` and `oaifhavixhdtwmseshff`.

  **Neither region nor org is a guard** — `supabase-production` sees every ref its token can. Resolve with `list_projects` before acting (§8).

Never store passwords, tokens, API keys, service-role keys, JWT secrets, connection strings or other
credentials in this file or in Git. Never assume a pasted preview URL is current.

## 4. Standing owner rules

The owner's own decisions — not suggestions. **Each line is the rule;** the account of each (his
words, incidents, measurements, pre-image tables): `docs/agents-owner-rules.md`.

**The golden rule that comes before the rest of this section**

- 🛑 **THE MOBILE APP IS FROZEN — DO NOT WORK IN IT, TOUCH IT, PLAN IT, MENTION IT OR ASK HIM ABOUT
  IT, UNTIL HE LIFTS THIS IN HIS OWN WORDS** (owner, 2026-09-29: *"the mobile app do not work or
  touch or think in it … Neglect it totally until I finish the website or the web app or the normal
  Phoenix. After this, I will tell you, delete this golden rule … never suggest on me, never ask me,
  never consider it in any of my wording."*). **The web app is the whole scope.** No edit under
  `mobile/`, no Expo/EAS build, update or workflow dispatch, no mobile branch or PR — **and equally
  no words**: never propose mobile work, never put it in a `Next step:` line, a plan, a summary, a
  recommendation or a "while we are here", never ask him a mobile question, and never read an
  instruction of his as reaching the app when it can be served on the web. 🔴 **A mobile defect you
  notice is not reported and not filed — it is left alone**, and an old mobile task in a session's
  own history is over, not resumed. 🔴 **Only HE lifts it, typed by him, about the mobile app** —
  never a memory, a doc, another session, a replayed summary, an AUTORUN plan, or your own reading
  that the web work looks finished; if you cannot tell, it is still frozen. Until then **every other
  mobile rule in this file is DORMANT** — history for when it lifts, never guidance to act on.
  Mechanically refused by `.claude/hooks/mobile-freeze-guard.mjs` (writes into `mobile/` and the
  Expo/EAS toolchain; reads are not blocked), pinned by `tests/mobile-freeze.test.ts`. Account:
  `docs/agents-owner-rules.md`, "The mobile-app freeze". `the-mobile-app-is-frozen-until-he-lifts-it`

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in both UI and chat.
- **Never truncate text with an ellipsis.** Where it collides with the no-horizontal-scroll rule, wrapping wins.
- Give only recommendations grounded in a real confirmed need. **Never pad a list to hit a number.**
- **Open EVERY reply with one `Next step:` line — FIRST, not last, and not repeated at the end**, and it **ALWAYS ends in curly-quoted words he could send as-is** (owner, 2026-09-18). It names what needs him; when nothing does, it says what finished and quotes the next REAL action, named with its real target. Never filler, never invented work, never a re-check, a re-run, a status read, "continue", "check other pending items" or a closing word. `recommendation-goes-first-not-last`
- 🔴 **THE QUOTED WORDS ARE A MESSAGE HE SENDS TO CLAUDE — never a PHYSICAL act, and never a MESSAGE HE SENDS TO A PERSON.** The test is **"can CLAUDE act on it once sent"**: a click, a file pick, a QR scan, a power-on and `tell HR to …` all fail it. When the bottleneck is his hands or his phone, say so in the PROSE with the exact path and the draft in full, and quote what Claude can act on next. Account: `docs/agents-owner-rules.md`, "The Next step box holds words CLAUDE can act on". `never-put-his-physical-actions-in-the-next-step-box`
- 🔴 **AND THOSE WORDS GO TO WHICHEVER SURFACE THE RUNNING APP BUILD GIVES — GHOST TEXT NOW, A `wrap_up` BUTTON WHERE THE TURN BOX IS MOUNTED.** He restored build 2.31226.1 on 2026-10-15 20:03 Cairo, which mounts no turn box, so the app asks the CLI for a suggestion again and the quoted words reach his input box for Tab+Enter; the 2026-10-13 build (44.7.0) mounted the pair and zeroed the request (`zt && (Q.promptSuggestions = void 0)`), and there the same words ship as `actions[0].message`, verbatim, his pick first. 🔴 **The session's OWN TOOL LIST decides, never the version** — call `mcp__ccd_turn__wrap_up` whenever it exists and never name a box he has not got; `next-step-capture.mjs` clause 7 warns about a missing button only there. Account: `docs/agents-owner-rules.md`, "The words ship as a button". `the-turn-box-took-the-ghost-text`

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead.**
- **Ask when the answer changes the outcome; decide when it does not.**
- 🥇 **EVERY QUESTION TO HIM IS A MULTIPLE-CHOICE QUESTION, NEVER PROSE** (owner, 2026-10-18: *"you never ask me in the form of text … you must ask me in the form of MCQ"*) — a business fact, a design choice, a data fix, a scope call, an "if you want, I can …". Use `AskUserQuestion`: 2–4 short options, recommended first, one idea each; read his typed "Other" answers closely. Never end a reply with an open question or an offer in prose; if no choice is genuinely his, decide and report. An XLSX with dropdowns is only for long per-item lists. Never guess to avoid asking. `ask-business-questions-as-in-chat-multiple-choice`
- Take ownership. Automate the work rather than returning a checklist he has to execute.

**How to build**

- **Before building new UI, match the sibling pages' exact design identity.** Never invent a one-off look.
- 🔴 **IN ANY MODULE THAT HOLDS A LIVE EVIDENCE PHOTO, THE PHOTO'S OWN GPS IS THE PRIMARY SOURCE OF TRUST** (owner, 2026-10-18) — it outranks a declared brick or area, an inherited label and a typed address, and a disagreement leads the sentence; never print a territory as "nothing to check" beside a photo that says otherwise. A pin whose nearest brick centre is implausibly far is "not usable", never an accusation. Account: `docs/agents-owner-rules.md`, "The evidence photo is the primary source of trust".
- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.** Use `<table className="w-full table-fixed">` with a `<colgroup>`; fit by MERGING columns, never shrinking type — `overflow-x-auto` over a `min-width` IS the bug. Measure `scrollWidth > clientWidth` over `main` at desktop and 375px; `shrink-0` makes an inner `flex-wrap` inert. 🔴 **A table that can sit in a GRID CELL switches on its own width** — `@container` + `@min-[Npx]`, never a viewport breakpoint like `lg:block`. `never-horizontal-scroll-always-mobile-and-desktop-friendly`
- 🔒 **THE ONE FORM DESIGN — every form, admin shell or employee portal, wears the Adverse Drug Reaction wizard's skin** (owner, 2026-10-06). Import the field, label and button strings from `src/components/ui/form-tokens.ts` and assemble from `form-kit.tsx` (`FormField`, `FormWizard`, `CheckTile`, `FormActions`); never hand-write a field's border, background, radius, height or focus ring. 🔴 **The ratchet in `tests/form-design-system.test.ts` is at ZERO — never raise it.** Exempt by his own rulings: `h-8`/`h-9` dense table and filter controls, every dark ground, chromeless controls, `hiring-pack/` and `offers/`. Account: `docs/agents-owner-rules.md`, "The one form design". `the-one-form-design-every-form-wears-the-adr-wizards-skin`
- Admin shell: **desktop shows full tables/dashboards, mobile gets cards.**
- 🔒 **THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.** `tokens.css`'s `--phx-radius: 4px` is the bug; measure computed `border-radius`, since `globals.css`'s sweep is not coverage. Restoring premium polish from history re-rounds corners — take the depth only. Pinned by `tests/admin-shell-palette-scope.test.ts` and `tests/hiring-pack-paper-editor.test.ts`.
- 🔒 **THE DOCUMENT IDENTITY — every company document wears `SATO-DIS-2026-01 v1.0`** (Sato Pharma's, never the app's); "put it in the system template" is STANDING. Logo palette `#0A527D`/`#0A6BA6`/`#1482C2`. 🔴 **THE INK RULE — no filled areas** except the 6% zebra row; government forms are exempt; on paper the mark is `sato-pharma-logo-on-light.png`. Module: `src/lib/hiring-pack/house-identity.ts`. 🔒 **The papers he ticked "change" wear the HR PREMIUM identity over it** (owner, 2026-10-13) — `premium-identity.ts`, current versions only; every paper he ticked "keep" prints as before (`PREMIUM_DRESS`, one line each), and the contract, its annex and notice, government forms and his other frozen designs are never touched. 🔴 **The Arabic Sato logo is a watermark or a footer mark, never a masthead** (owner, 2026-10-12). Account: `docs/agents-owner-rules.md`, "The HR premium identity". `the-house-document-identity-standard`
- **One production deployment per task.** Bundle all phases into one PR.
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.
- 🔴 **EVERY AI CALL, IN EVERY MODULE, GOES THROUGH ONE DOOR — OpenAI, then Anthropic account 1, then account 2** (owner, 2026-10-24). Use `createOpenAiResponseText` (`src/lib/ai/`) or the sales chain (`runWithSalesAiFailover`); ask `hasAiApiKey()`, never read a key or post to a provider yourself. `tests/ai-one-door.test.ts` refuses a second door. Rule: `.claude/rules/platform.md`, "AI providers".

**Product rules that must not be "fixed" back** — **each one lives in its module's memory**
(§2.2) and loads with that module. Kept here: the one live web-side gate the mobile freeze leaves
standing, and the rule the owner ordered locked EVERYWHERE, because every module's numbers depend on it:

- 🔒 **`phoenix_app_shell=1` defaults FALSE and must stay** — removing it strips the **WEB** portal's
  chrome for every browser user. Pinned by `tests/native-web-handoff.test.ts`.
- ⏸️ **The DORMANT mobile rules moved to `docs/agents-owner-rules.md`** (2026-10-23, unchanged) — read
  them only when he lifts the freeze: `the-mobile-app-is-a-shell-over-the-web-portal` ·
  `managed-play-cannot-reach-the-rep-tablets`
- 🔒 **THE MONTHLY-CLOSING SOURCE-OF-TRUTH GOLDEN RULE — the Monthly Closing module is the ONE source of truth for every SALES *and* every TARGET figure, system-wide** (owner, 2026-08-13; locked everywhere 2026-09-27). Every surface computes BOTH the sales and the target it divides by through the closing engine and must equal the **PUBLISHED** closing for that person and month; a page that re-derives either half from its own query, table or period is the bug, never a variant. Weekly Sales, Marketing ROI and the **Business Review pack** are the carve-outs — never invent a fourth. 🔴 **THE BUSINESS REVIEW READS THE LIVE ENGINE, NOT THE PUBLISHED SNAPSHOT** (owner, 2026-09-28) — never "fix" it back onto the snapshot, never republish a month to make them agree, never acknowledge the drift to silence it. A partial-window or per-page TARGET that inflates an achievement is the same defect. Account: `docs/agents-owner-rules.md`, "The Business Review reads live". `sos-monthly-closing-is-the-only-sales-truth`


## 5. Session, worktree, and parallel-work safety

Before editing, run `git status`, `git branch --show-current`, `git log -1 --oneline`,
`git worktree list`. Account: `docs/agents-worktree-and-machine-limits.md`.

- Use one working tree per active session. **Never two interactive sessions in one folder.** When the SessionStart lock warning shows a PROVABLY LIVE holder (refreshed inside 15 minutes), isolate with `node scripts/new-session.mjs <task>` and **carry on without stopping** — never ask him to confirm what the lock proves; an older non-stale lock (15 min – 2 h) may be a crashed session, and that one still asks. Both keep every commit/push/edit ban in that folder. A lock self-expires 2 hours after its last refresh, and that AGE is the ONLY staleness test — every lock's `pid` is a dead shell. Pinned by `tests/session-lock-staleness-is-age.test.ts`.
- Start new work from the latest `origin/main` on a focused `codex/<task>` branch unless told otherwise.
- Never run `git clone`, `git init`, or anything that recreates the primary repository's `.git`.
- Never discard, overwrite, clean, reset or revert changes you did not create. Treat unexpected changes as the owner's work; classify and preserve a dirty tree.
- **Never delete a `.xlsx` or `.pdf` file.** Scan a folder before removing it; move any not identical to a tracked copy into `xlsx/` at the repo root.
- **Start a session with `node scripts/new-session.mjs <task>`** (fetch, `_wt-<task>` on `codex/<task>`, `node_modules` junction, env files; refuses below 6 GB free commit). `--status`, `--repair`, `--from <ref>`. A bare `git worktree add` has no `.env.local` and no `node_modules`.
- **A sibling `_wt-<task>` is a NEW project to Claude Code** — `node scripts/sync-worktree-env.mjs` copies `.claude/settings.local.json` and points `autoMemoryDirectory` at the primary's memory.
- **A worktree session WRITING into the primary checkout is denied mechanically** — `.claude/hooks/primary-write-guard.mjs` refuses an Edit/Write into the primary or another session's worktree (never a read). Your own `_wt-<task>` is edited with Edit/Write, never a Bash write. `PHX_PRIMARY_GUARD_OFF=1` stands it down.
- **Never `pnpm install`, `pnpm run` or `pnpm exec` inside a worktree** — they purge the `node_modules` junction; `bash-guard.mjs` C6 denies them and names the node equivalent. Invoke `node scripts/…`; dev server: `node scripts/dev-server.mjs --port 3000` (4 GB heap cap, refuses a second server) — C7 denies a raw `next dev` everywhere.
- 🔴 **THE DEV SERVER IS THE LAPTOP'S `pnpm run dev` AGAIN, IN EVERY FOLDER AND BRANCH — `phx-live` AND `phx-preview` ARE BOTH RETIRED** (owner, 2026-10-17 ~18:24 Cairo, choosing "Laptop + lighter compile" after phx-live stopped working anywhere on the 7.7 GB box). His PowerShell profile routes `pnpm run dev` / `pnpm dev` to `node scripts/dev-server.mjs` from the folder he stands in, so a worktree's junctioned `node_modules` is never offered for deletion; every other pnpm command is untouched. A session starts `node scripts/dev-server.mjs` in its own worktree only when live free RAM allows, never asks him to run phx-live or proposes `phx-preview`. 🔴 **Both went with the Hetzner box on 2026-10-19 (owner)** — never start, repair or mention them as an option. Account: `docs/agents-worktree-and-machine-limits.md`, "The dev server is the laptop's `pnpm run dev` again".
- **A dev server a SESSION opened dies with it** (`dev-server-reaper.mjs`); one you started yourself is stopped **by PORT:** `Get-NetTCPConnection -LocalPort 3000 -State Listen`, then `Stop-Process -Id <OwningProcess> -Force` — `TaskStop` leaves the child holding the port, and only a curl of `000` proves it free. 🔴 **One YOUR session started is yours to stop; one HE or another session started waits for his word** (owner, 2026-09-28). Check the PID's start time first. `i-may-stop-a-dev-server-i-started-myself`
- In-repo worktree folders must start with `_wt-` (or sit under `.codex-worktrees/` or `.claude/worktrees/`). Locked `.claude/worktrees/` belong to live sessions — never remove them.
- **Remove worktrees with `node scripts/new-session.mjs --remove <task>`, only after approval** — its gate asks the merged PR, because **a squash-merged branch legitimately holds commits `main` does not.**
- **`git worktree remove` leaves a HUSK nothing in git can see** — run `pnpm run repo:doctor` after any removal; `--fix` deletes only zero-file husks.
- **`repo:doctor` lists memory files with no index line** (`--deep` for all) and writes nothing except `--snapshot-xlsx` (outside the repo) — **but by default it pages the PRODUCTION GoTrue admin API**; `--no-auth` skips that.
- **`xlsx/` is gitignored and its hourly backup has holes — never call a sheet covered without checking.** Covered: untracked sheets at the top of the PRIMARY's `xlsx/`, **plus the named subfolders in `BACKED_UP_SUBDIRS` — `field-day-superseded/` since 2026-10-09 and `scratch-map-unmapped/` since 2026-10-12 (his word), so the field day archives and the mapping pre-images are off this disk** — copied to `F:\PHX backup\05-data-files`, with a Telegram alert on a failed or killed run. Not: any OTHER subfolder, worktree `xlsx/` folders, hours the laptop is off (caught up on wake, never alerted), or a disk failure (same SSD). 🔴 **The snapshot folder is FLAT and keyed by basename**, so adding a subfolder whose filenames can repeat a top-level one loses a copy — the module refuses that file and exits non-zero rather than overwrite.
- **Worktree payload slows TREE-WALKING TOOL CALLS and nothing else** — a recursive `grep` or `dir /s` pays ~346k path entries here; `.gitignore`-honouring tools never do. Retire merged worktrees for command speed, **never on machine-performance grounds: FREE RAM is what binds, and fewer open SESSIONS is the only lever — his call alone.** Do not tune `tsconfig`/`eslint`.

**Machine limits.** RAM is 16 GB. One dev server at a time, ever; parallel validation belongs to CI.
🔴 **FREE RAM is what binds, not the commit charge** (the pagefile is fixed at 64 GB) — read it live.
🔴 **Nothing gates a heavy job any more — the heavy-job gate was RETIRED on 2026-09-17 and is never
rebuilt**; a typecheck, build or dev server is YOUR judgement from live free RAM. `mem-watchdog.ps1`
reaps a typecheck, build or test run under **1,800 MB** free and any node job under **500 MB**, and a
dev server only as a runaway (8 GB+ of commit) or after 25 idle minutes.

**THE ROUTING GOLDEN RULE (owner-confirmed 2026-09-25) — route by what a task NEEDS, not what it
is, and default to cloud.** The 4am mechanical test: needs a **browser look, a dev-auth role sweep,
or local creds/files** → local worktree; is a **decision, a merge/deploy, or the database** → main
checkout; **everything else → cloud.** Cloud sessions never compete for this box's RAM, so
defaulting to cloud IS the anti-freeze lever, not a compromise — the freeze bites on the number of
*local* sessions, never on the work itself.

🔴 **A CLOUD SESSION IS PHOENIX-BLIND BY DEFAULT — it gets the git repo and your prompt, and NOTHING
ELSE** (no `~/.claude/CLAUDE.md`, no auto-memory). **Never send cloud a judgment call or a question
that leans on tribal knowledge — send it a SPECIFIED change whose context is in the repo or the
prompt.** Account: `docs/agents-worktree-and-machine-limits.md`.

Route work by tier:

| Tier | Where | Use for |
| --- | --- | --- |
| **A — Cloud session** *(the default)* | Isolated cloud clone, ends in a PR | A SPECIFIED, self-contained change — feature, logic fix, refactor, a test, docs — whose context is in the repo or the prompt, plus anything heavy (build, typecheck, full test). NOT judgment calls or memory-dependent questions. Sonnet by default. |
| **B — Local worktree** (max 2–3 woken) | Sibling `_wt-<task>` | ONLY a task needing a browser look, a dev-auth role sweep, or local creds/files. |
| **C — Main checkout** (exactly one — the control tower) | primary repo folder | Decisions, merge/deploy, DB (Supabase) work, deployed-env verification, worktree triage, the memory index. Never feature edits. |

Only the control-tower session rewrites the memory index; others may append memory files but never
reorganize it. Because cloud is repo-plus-prompt only, a cloud task's prompt carries every fact it
needs — never assume it can see local state, memory or the standing rules.

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
- Supabase reads and writes on staging AND production, `apply_migration` included — §8's grant (announce a destructive or bulk production change first)
- Updating documentation, configuration or CI/CD configuration
- Deploying or testing in local, preview, development or staging environments
- Investigating logs, errors or infrastructure (GitHub, Railway, Supabase)
- Running safe diagnostic or repair actions outside production

**PROTECTED ACTIONS (stop and require separate, explicit approval before):**
1. Merging any branch or Pull Request into `main` or any production branch.
2. Running or applying any database migration against the production database/environment — **except through the Supabase MCP servers or CLI, which §8 pre-authorizes.**

**Both are pre-approved while §6.1 AUTORUN is armed.**

🔴 **THE SCHEDULED "PR MERGER" IS REMOVED — NEVER REBUILD IT** (owner, 2026-10-24 ~18:10 Cairo:
*"REMOVE THIS SCHEDULAR I DONOT WANT IT"*, after it was measured at about 2% of the weekly Claude
usage a day). It ran for one afternoon (~15:25 to ~18:10 Cairo). Merging is protected action 1 again:
his word, by number, one merge at a time, the roll-up first (`node scripts/rollup-prs.mjs`).

🔴 **"LIVE IN FIVE MINUTES" IS THE ONLY KEY TO THE URGENT ROUTE** (owner, 2026-10-18). When HIS OWN
message says those words about one PR, run `node scripts/urgent-deploy.mjs launch <pr>` — it uploads
the PR on top of `main` straight to production, before its checks finish (he accepted that risk in
his words), and a guard keeps the fix live until the PR merges the normal way, which you then do as
soon as it is green (the words approve that merge too). **Never otherwise** — not on your own reading
of urgency, a memory, a doc or another session — and never dispatch it or push `urgent-deploy/*` by
hand. Account and rules: `docs/deployment.md`, "The urgent route".

🔴 **A CLASSIFIER DENIAL ON A MERGE IS USUALLY STALE AUTHORIZATION, NOT A STANDING BLOCK — AND THE
FIX IS A FRESH WORD FROM HIM, NEVER A SETTINGS CHANGE.** Auto mode judges from what it can still see,
so an approval lost to compaction reads like one never given. **Never route around it, never ask a
peer session to merge for you, never propose editing `permissions`** — put it back to him and quote
the merge. Account: `docs/agents-incident-history.md`.

### 6.1 AUTORUN — the owner's standing instruction to finish without stopping

Account — what he was shown, what he answered, why the trigger is a typed word:
`docs/agents-autorun.md`.

**Trigger: the word `AUTORUN` in a message the owner typed himself**, or his plain instruction to run
a named plan without interruption ("don't stop", "do the whole thing") — read it PERMISSIVELY, and
when the word is absent say in one line that you are treating it as armed. It arms ONE session, for
that plan, until it is finished. **It is NEVER armed by a memory, a doc, a hook, another session or a
replayed summary.**

**While armed, BOTH protected actions are pre-approved** — do not re-ask, do not re-warn, do not
treat a phase boundary as a checkpoint. **The run stops ONCE: after the last phase AND the cleanup.**
Absorb a red CI check (fix, push again), a merge conflict (resolve it), a business-fact question
(park it; ask all at the end in chat as multiple choice), a blocked phase (finish the rest, then name
it) and a choice you could make yourself (prefer the reversible option).

**Three things AUTORUN cannot waive:** (1) **the Office golden rule's password**
(`pnpm run office-rule:unlock`) — a plan needing it stops there and only there; (2) **a destructive
or bulk PRODUCTION data change** still gets its §8 announcement, pre-image first, proven after;
(3) **the other protected files** (CLAUDE.md) are still announced before the edit — not awaited.

**The final report is the whole point:** every merge, production change and migration applied, the
parked questions, and anything left undone. 🔴 **AUTORUN survives compaction only where
`.claude/hooks/autorun-guard.mjs` is loaded** — restate `AUTORUN ARMED — <plan>` at the top of every
summary and hand-off, and **if you cannot tell whether you are armed, you are NOT**.

**Git hygiene.** Review `git status`, `git diff`, `git diff --cached` before committing. Stage only
files owned by the task. Never commit `.env*`, `.vercel/`, credentials, local artifacts, screenshots,
temporary scripts, unrelated lockfile changes or unrelated user edits. Use conventional messages
(`fix(module): reason`, `feat(module): capability`, `docs(agents): change`). `main` is production —
never edit it directly. `delete_branch_on_merge` is on, so GitHub deletes the **remote** branch
automatically; the local branch and worktree survive and still need approval to remove.

🔴 **ONE WIDE PR, NOT FIVE NARROW ONES — EVERY MERGE COSTS ~28 BILLABLE CI MINUTES** (owner,
2026-09-27): a full CI run on the PR **and** another on `main`. **Batch related work into ONE branch
and ONE PR** — the fix, its test, its doc and the follow-ups you can already see — and push fixups in
fewer, larger commits. Split only when the parts need SEPARATE approval (a migration, a locked file,
a protected rule) or one part is urgent. 🔴 **NO GUARD REFUSES A SECOND PR FOR ONE MODULE — the same-module hold (bash-guard C18) was REMOVED on the owner's word, 2026-10-19; never rebuild it** (`docs/ci-self-hosted-runner.md`, "The same-module hold was removed"). **The only authority on cost is his invoice — never convert
measured minutes into a bill.** 🔴 **A FEATURE ARRIVING IN INSTALMENTS IS STILL ONE FEATURE — HOLD THE
PARTS** (owner, 2026-09-29) and open ONE PR when it is whole, saying in one line that you are holding.
`hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces`
🔴 **AND A SMALL PR IS NEVER PUT TO HIM AT ALL — NOT EVEN WHEN IT IS THE ONLY ONE OPEN** (owner,
2026-10-12: *"i will not merge a small pr"*). It never reaches a `Next step:` line, and "it is the
only open PR, so it is one merge" is the mistake itself — `rollup-prs.mjs` reporting nothing to roll
up is not permission to hand it over. **WIDEN it** (commit the work already in hand onto that same
branch) or park it, saying in one line what it waits for. 🔴 **SMALL IS MEASURED IN PATHS, NOT IN
FILES — a PR that changes only `docs/`, `.claude/` and root markdown is small however many files it
touches** (he refused #5802 at three files and again at seven, where `rollup-prs.mjs`'s `<= 4 files`
called it wide). `scripts/needs-you.mjs` now demotes such a PR out of his lane with what to do about
it, pinned by `tests/needs-you-board.test.ts`; an unreadable file list is never a demotion.
🔴 **NEVER HAND HIM MORE THAN ONE MERGE AT A TIME — TRIAGING OPEN PRs IS NEVER HIS JOB** (owner,
2026-09-30). **Before asking him to merge anything, run `node scripts/rollup-prs.mjs`**: it groups the
open PRs whose files are disjoint, names the SUPERSEDED and the SEPARATE ones, and `--apply` opens ONE
roll-up PR (it waits up to 25 min for the members' checks and builds only from the green ones; a
quiet run is working, and an unknown flag is refused). `bash-guard.mjs` C13 refuses `gh pr merge` of
a listed member. 🔴 **A ROLL-UP MUST BE MERGED BEFORE ITS MEMBERS, NOT MERELY BUILT BEFORE THEM** — the
window is about three minutes and the comment is a courtesy, never a guard — so put it to him in the
SAME turn. 🔴 **And if they land first, CLOSE it — never merge it:** it replaces nothing and pays a
full `main` run. Account: `docs/ci-self-hosted-runner.md`, "A roll-up must be merged before its members".
🔴 **MEASURE CI IN MINUTES, NEVER IN RUNS, AND NEVER FROM A SAMPLE**; `main`'s ~40% is the production
deploy gate and is not reclaimable, and the Actions runs API silently truncates at 1,000 rows. Account:
`docs/ci-self-hosted-runner.md`.

## 7. Validation

**CI is the gate. Do not run a local full validation.**

`check:harden` and the `ask-before-validation` hook are retired — do not reintroduce them or a
replacement. 🔴 **No suite step stands in front of any push** — the 2026-10-12 pre-push `remote-check test` for a push that ADDS a test file ended on 2026-10-19 with the CI box, because GitHub runs only a commit origin already holds. Commit, push, open the PR, and its checks are the verdict (owner, 2026-10-08). `node scripts/check-contracts.mjs` (~8s) is the one pre-push read, and since 2026-10-23 the push guard REMINDS of it before EVERY push (owner: "warn on every push") — a clean full run records a per-commit pass and the next push of that exact commit goes quiet, a dirty tree or a SKIPPED gate records nothing, and `PHX_PUSH_CHECK_OFF=1` stands it down for one push; `remote-check` READS the PR's run — once, with `run_in_background: true`, acting on the notification, never a poll loop or a foreground run (bash-guard C14, C15). NO VERDICT (exit 2-9) is never a pass: say so. `.claude/hooks/push-typecheck-guard.mjs` only reads a recorded verdict for the exact sha — it says both notes back and **never refuses over the suite** (owner, 2026-10-04: "keep the pre-push test as a rule, no guard") (`docs/testing.md`, "Before every push"). The two **required** checks are `validate` (the production build, and the Playwright login smoke on a push) and `checks` (the gate over the parallel `static` — the `check:*` contracts, the audit, lint, `next typegen` and the type gate — and the two `unit` jobs that run **the unit suite**, with a proof that every test ran once); either red blocks the merge. 🔴 **A pinned test belongs in the suite** — which job runs it is ci.yml's business. The retired check names stay retired: no job may be called `test` again (#3950).
🔴 **`mobile` REPORTS, NEVER GATES; `secret-scan` IS NOT ON A PR AT ALL** (read live 2026-10-01).
`mobile` is the Expo typecheck, skipped unless `mobile/` changed, and red never blocks a merge.
`security-scan.yml` lost its `pull_request` trigger 2026-09-29 — gitleaks moved into
`bash-guard.mjs` **C12**, which refuses the push — so its absence is CORRECT, never a coverage gap:
never wait for it or dispatch one. Account: `docs/testing.md`.
🔴 **NEVER TAKE "PINNED BY A REQUIRED CHECK" ON TRUST, AND NEVER COUNT TO A NUMBER A DOC GAVE YOU —
read the protection API**; `node scripts/check-required-checks.mjs` catches a doc that lags. Demoting
a check and un-wiring its job are ONE change in one window, never two — a required check whose job no
longer reports leaves every PR waiting forever. `pnpm run ci` is opt-in: run it **only when the owner
names it**.

🔴 **A LOCAL TYPECHECK IS DENIED MECHANICALLY — `bash-guard.mjs` C8, in every spelling** (a reaped
run prints nothing and exits non-zero, so a session used to retry another spelling).
`PHX_TYPECHECK_OK=1 <cmd>` (`$env:PHX_TYPECHECK_OK=1;` in PowerShell) stands it down for one command
you will sit and watch. Pinned by `tests/local-typecheck-guard.test.ts`.

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

**Deploy verification.** Production is Railway auto-deploy on push to `main`, **gated by the release
gate** (the new container answers `/api/readyz` 503 until `validate` and `checks` passed on that
commit — see §2). So a green CI is now a precondition of the
deploy rather than a report on it, and the new failure mode is a deploy that never happened: confirm a
deploy through `gh api repos/Phoenix-HR-CRM/phoenix-people-workforce/deployments` or `railway status`, and
what serves traffic via `/api/healthz` `revision` — **a merge plus a green PR is not evidence
production moved.** Smoke-test on the live staging app (§3) before a risky
production deploy when there is time. After a runtime-impacting production deploy, verify the public
domain, smoke-test the changed workflow and inspect `railway logs`. When a page fails, capture the
visible error, browser console, network/API response, deployment logs and database/RLS evidence
before proposing a fix.

## 8. Supabase and data safety

- **Supabase writes are pre-authorized end to end — NO approval prompt** (the owner's `autoMode` grant deliberately removes the §6 gate for Supabase). It covers the `supabase-staging` and `supabase-production` MCP servers and the `supabase` CLI (incl. `db push`), on staging AND production, reads and writes alike — `execute_sql` mutations, `apply_migration`, bulk and destructive SQL, **and since 2026-10-15 `scripts/apply-sql-file.mjs` as the STANDING route for a migration the MCP refuses, with no per-migration word** (*"make apply-sql-file.mjs the standing route when the MCP refuses a migration"*) — reversing the 2026-10-08 correction that demanded one; it writes NO ledger row, so it ends in an evidenced `ACKNOWLEDGED_EXCEPTIONS` entry, never a ledger write, and the mechanics are in `.claude/rules/database.md`, "The migration ledger". The one standing condition: **announce any destructive or bulk PRODUCTION change in plain words before you run it, and give the owner a chance to stop it.** (It does NOT cover creating/deleting a project or reading secrets.)
- All schema changes must be migration-based, repeatable, reviewable and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref, resolving it with `list_projects` rather than trusting a ref pasted in a prompt or copied from an older doc.
- `supabase-production` can see **every project its token reaches.** **Its name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.** `supabase-staging` is pinned to staging.
- Any UUID-named Supabase tool (a claude.ai account connector) stays deny-listed by default; `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087` is the one exception: the owner allowed it on 2026-10-05 and had its project-level deny removed. It stays allowed — no Phoenix project setting may re-deny it, and a blocked call to it is a bug, not a decision. **Write the BARE server name in a deny rule** — a `__*` suffix matches nothing.
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


---

# CLAUDE.md — the full text before the 24 Oct 2026 shrink

The owner approved shrinking CLAUDE.md the same evening ("APPROVED", ~19:00 Cairo). Kept here word for word.

## (the original title) CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

**[AGENTS.md](AGENTS.md) is the source of truth for operating rules** — branching, approval,
validation, worktrees, deployment, and data safety. This file stays deliberately thin: daily
commands, the two rules worth loading on every turn, and the protected-file gate. Everything else
lives in `docs/` and is read on demand.

(the line `@AGENTS.md` loaded AGENTS.md here)

## 🛑 The mobile app is FROZEN — the web app is the whole scope

Owner rule, 2026-09-29: **do not work in the mobile app, touch it, plan it, mention it or ask him
about it** until he lifts this in his own words. No edit under `mobile/`, no Expo/EAS build or
dispatch, no mobile PR — and no words either: not in a `Next step:` line, a plan, a summary or a
question to him. A mobile defect you notice is left alone. **Only he lifts it**; if you cannot tell,
it is still frozen. Full rule, what stays dormant, and the guard that refuses it mechanically:
[AGENTS.md §4](AGENTS.md), first bullet.

## Cloud sessions — read your Phoenix memory first

A **cloud** session is an isolated git clone of this repo: it does **not** have the laptop's
`~/.claude/` — so the two layers that make a local session wake up knowing Phoenix (the global
standing rules and the entire auto-memory) are missing, and it answers generically. Both are
**mirrored into this repo** so you still have them. **If `~/.claude/` is absent — you are a cloud
session — then before your first substantive answer read `.claude/cloud-context/memory-mirror/MEMORY.md`
(the memory index) and `.claude/cloud-context/global-standing-rules.md` (the owner's standing rules;
its machine/RAM sections are laptop-only, ignore them), and grep `.claude/cloud-context/memory-mirror/` for
any specific fact** — the same two-tier recall a local session has. The mirror is regenerated by
`node scripts/sync-cloud-context.mjs` and is current as of this branch's last commit. **Local
sessions ignore this** — they have the live originals under `~/.claude/`.

## Commands

All commands run from the repo root.

| Task | Command |
| --- | --- |
| Dev server (auto: webpack on Windows) | `pnpm run dev` |
| Production build | `pnpm run build` |
| Lint | `pnpm run lint` |
| Typecheck — **CI's job, not yours** (see below) | `pnpm run typecheck` |
| Unit/integration tests | `pnpm run test` |
| **The repo-wide contract gates + your changed files' lint + `check:migrations`, ~8s — the reds you did not write** | `pnpm run check:contracts` (optional, never a gate; types stay CI's) |
| **What CI said about the pushed commit — read from GitHub, nothing runs here** | `node scripts/remote-check.mjs typecheck` (also `lint`, `test`, `build`, `all`; `--dispatch` starts a run) |
| Whole gate, by hand — **only when the owner names it** | `pnpm run ci` |

🔴 **`scripts/remote-check.mjs` ASKS GITHUB WHAT CI SAID ABOUT THE PUSHED COMMIT — THE HETZNER CI BOX IS RETIRED** (owner, 2026-10-19: *"retire the hetzner box and do not use it ever again because it is the source of slowness"*). It needs the commit on origin (it refuses otherwise and prints any uncommitted files it ignores), reads that commit's PR run by sha and prints `remote-check: PASS|FAIL — <sha9>` per stage from the jobs' own steps; with no PR it stops at NO VERDICT (exit 6), and `--dispatch` starts a `ci.yml` run on the branch. `lockfile` regenerates `pnpm-lock.yaml` through `.github/workflows/lockfile.yml`. The retired `--wait`, `--no-wait`, `--free`, `--no-actions` and `--else-actions` flags are refused by name. Pinned by `tests/remote-check.test.ts`.

🔴 **THE PR'S OWN CI IS THE VERDICT, AND IT IS FAST BECAUSE IT IS PARALLEL** — `ci.yml` runs `validate` (build and login smoke), `static` (contracts, audit, lint, the type gate), two `unit` jobs and `checks` (the gate over `static` + `unit`) side by side on GitHub-hosted runners; `validate` and `checks` are the two required names. Commit, push and open the PR. **There is no pre-push suite run any more** — the 2026-10-12 "a push that ADDS a test file runs `remote-check test` first" step needed the box and ended with it; `node scripts/check-contracts.mjs` (~8s, local) is what the push guard now points that push at, and the PR's `unit` jobs run the suite. Run `remote-check` **once with `run_in_background: true` and act on the notification** — exit 0 PASS, 1 FAIL, 2-9 NO VERDICT, and only `remote-check: PASS|FAIL — <sha9>` for the sha you pushed counts; a NO VERDICT is never a pass. Never a poll loop (bash-guard **C14**), never a foreground run (**C15**), never a sleep on a task output file (**C16**). Rule and account: `.claude/rules/engineering.md` (Validation), `docs/testing.md`.

**CI is the gate, and a local typecheck is denied** (`bash-guard.mjs` C8; `PHX_TYPECHECK_OK=1 <cmd>`
stands it down for one command you will sit and watch) — the full rule, the required-check rotation,
the retired `check:harden` and `check:edit`, the per-change validation matrix and the measured reason a
cold `tsc` no longer fits this machine are in [AGENTS.md §7](AGENTS.md), loaded with this file.
**Push the branch — the PR's typecheck is cold, clean and under a minute** since the gate moved to
TypeScript 7 (`typescript-native`, an `npm:typescript@7` alias; `typescript` 5 stays for the editor,
Next and typescript-eslint). It is `--checkers 1` in the package script deliberately: nothing else names a
version, and TypeScript 5 refuses that flag, so a lost alias fails loudly instead of quietly restoring
the 3-minute compiler.

## The two rules that apply to every change

- **Domain-first.** Business logic lives in `src/lib/<domain>/`. Pages and components **call domain
  services**; they must not re-implement payroll, leave, expense, outstation, HR, or sales rules
  inline. When changing behavior, start in `src/lib/<domain>/`.
- **Server-side access control is the security boundary.** `system-navigation.ts` hiding a link is
  UX only. Always enforce with `assertPermission(ctx, resource, action)` in the route handler,
  before any mutation.

## Global edit points (don't hunt)

| Change | File |
| --- | --- |
| Brand, URLs, email defaults | `src/config/system-settings.ts` |
| Sidebar, nav, role routing | `src/config/system-navigation.ts` |
| Design tokens | `src/styles/tokens.css` + `app/globals.css` |
| Shared UI primitives | `src/components/ui/` |

## Where the detail lives

| Topic | Doc |
| --- | --- |
| Layout, auth trio, API route convention, workflows, cron, conventions, env, tests | [docs/architecture.md](docs/architecture.md) |
| Full edit-point table and editing policy | [docs/editing-guide.md](docs/editing-guide.md) |
| Migration safety harness, RLS, role alignment | [docs/security/](docs/security/) |
| Deploy triggers and verification | [docs/deployment.md](docs/deployment.md) · [docs/observability.md](docs/observability.md) |
| Test wiring — a test not registered in `tests/run-tests.ts` never runs | [docs/testing.md](docs/testing.md) |
| What is waiting on the owner — the board, its four channels, and the rule that it never under-reports | [docs/needs-you.md](docs/needs-you.md) |

## Protected Files — OWNER APPROVAL REQUIRED

These files are **permanently locked** by the owner. No AI session, developer, or automated tool may
read-then-edit, refactor, rename constants, adjust formulas, or change any value inside them without
the owner explicitly approving that specific change in the active conversation first.

| File | What it protects |
| --- | --- |
| `src/lib/incentives/scheme-2026.ts` | 2026 incentive payout curve, achievement thresholds, semester target formula |
| `src/lib/payroll/policy.ts` | `BASIC_SALARY_RATE` (70%), and all salary derivation formulas (base → basic → net → gross) |
| `src/components/employee-portal/identity-card.tsx` | Employee portal identity banner — must always use `PhoenixSignatureCard`; do NOT swap it for another component |
| `src/lib/sales/office-allocation.ts` (the `GOLDEN RULE · LOCKED` region) | The Office allocation golden rule — units spread by each area's share of the line's non-Office **value**. **Enforced mechanically**, not just behaviourally: see below |

**If any request would touch one of these files** (fix, refactor, rename, extend, delete): STOP. Show
the owner the exact change you intend to make and why it is necessary, and continue only after the
owner approves that specific change in the conversation.

**The Office golden rule is the one lock a session cannot talk itself past.** Locked 2026-08-11 at
the owner's instruction. `tests/office-golden-rule-lock.test.ts` pins the formula with a source
fingerprint, a behaviour fingerprint, and four verbatim clause checks, and it runs in the required CI
`test` job — so a PR that changes the rule goes red and cannot merge. Changing it needs the
owner's password; it exists only as a scrypt verifier in `src/lib/sales/office-golden-rule.lock.json`
and is not recoverable from this repository. **ARMED 2026-09-05 — before that date no verifier
existed at all**, and `unlock` refused rather than re-pinning (it fails closed), so a session reading
this line would have believed a password was in place when none was. Do not re-pin the fingerprints
by hand, and do not "fix" a red lock test by editing `src/lib/sales/office-golden-rule.ts` — that
edit is precisely what the check exists to catch.

🔴 **NEVER run the unlock as `pnpm run office-rule:unlock` from a worktree** — §5's pnpm rule applies
and this is its worst case. `pnpm` runs its deps check first, sees the moved lockfile, and offers to
delete **the PRIMARY's `node_modules`** (the worktree's is a junction to it), breaking every session
on the machine. It happened on 2026-09-05 and was answered `N` with one second to spare. Invoke node
directly instead, from the folder holding the change:
`node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs scripts/office-rule-unlock.ts --unlock`
(`--set-password` first, one time, if no verifier exists). **The folder matters more than it looks:**
run it in the primary while the edit sits in a worktree and it re-pins the UNCHANGED source — a
silent no-op that prints success.

**The other three locks raise a PROMPT since 2026-09-30** — `.claude/hooks/protected-file-guard.mjs`
answers any edit of them (Write/Edit, or a shell write) with `ask`, so his click in the UI lets it
through; under AUTORUN it proceeds and you must announce it (§6.1). **The prompt is not the approval:**
ask him in plain words FIRST and wait for a plain answer; a refused prompt is his answer, never retry
another way. Pinned by `tests/protected-file-guard.test.ts`. Do not reintroduce a passphrase — a shared one
was removed 2026-07-31 because it sat in a committed file and authenticated nobody. Full history of
the settings changes, and how to recover the pre-2026-08-14 file:
[docs/agents-incident-history.md](docs/agents-incident-history.md).
