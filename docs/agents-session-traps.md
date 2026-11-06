# Session-level traps — the full account

This is the detail behind the hooks in [AGENTS.md](../AGENTS.md) §2.1. **The hook there is the cue;
this file and the memory files it names are the fact** — the same split `MEMORY.md` states in its own
first line, applied one level up.

**Why the detail lives here and not in `AGENTS.md`.** `CLAUDE.md` pulls `AGENTS.md` in via
`@AGENTS.md`, in full, on every single request. That is the right home for a one-line hook, which has
to be seen *before* a session knows it needs it. It is the wrong home for a multi-paragraph incident
write-up, which is only wanted once a session is already looking. Between 2026-08-19 and 2026-08-29
`AGENTS.md` grew 32KB → 147KB, and §2.1 alone reached 58KB of the 147 — roughly 15,000 tokens of
fixed context occupancy, re-sent on every request, which is context the conversation no longer had.
Compaction got more frequent in exact proportion. Splitting hook from detail is what `MEMORY.md`
already does under its 22,000-byte budget; §2.1 had simply never had a budget of its own.

**Nothing here was rewritten, with one correction.** The body below is the verbatim §2.1 text as it
stood at `fe750dbdf`, including every measurement, date and PR number. The one exception, made
2026-08-29 and flagged inline at both sites: #2617 attached the memory slug
`a-mock-name-generator-reproduces-real-employee-names` to two traps that file does not describe —
the multi-statement `execute_sql` trap and the `au.occupancy_history` hr_id trap. Both citations are
removed, because a pointer that lands a session on the wrong record costs more than no pointer at
all. **Read the verbatim claim as provenance, not as licence to restore them.**

**Reading order.** Find the hook in `AGENTS.md` §2.1, then search this file for its wording. Groups
below, in order: Shell and tooling · Git · CI and PRs · Migrations · Database, grants and RLS ·
Probing, attributing and reporting production · Validation · Memory and this index · Parallel
sessions · Worktrees · Next.js runtime · Browser and dev-auth · Machine ceiling.

---


These are **agent-operating** facts, not Phoenix business rules. They lived in `MEMORY.md`, which the
memory loader truncates at **24,400 bytes** — past that the tail is silently dropped and the last
entries stop existing. This file has no such cliff and auto-loads in full via `CLAUDE.md`'s
`@AGENTS.md`, so these belong here: same reach, plus review and version control. Each names the memory
file holding the full account, under
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\`.

**Shell and tooling**

- **`grep -r` of a repo or worktree root (`.`, no path) or its `.claude` gets `--exclude-dir` for
  node_modules, .git, .next, worktrees and .codex-worktrees ADDED by `bash-guard.mjs` C1 (~3.5 s); a
  drive, home or Temp root, the workspace folder, `node_modules` and `.claude/worktrees` are still
  refused; any other named folder, file or small absolute path passes untouched (2026-10-22).** Worktree payload is ~1.9M paths; tools honouring `.gitignore` never
  see it. `shell-grep-unusable-use-git-grep-or-rg`. 🔴 **The blanket refusal was too wide** (2026-10-17,
  a `/doctor` pass over 50 sessions): C1 stopped 124 commands, about 70 of them naming one small tracked
  folder, plus a few that only QUOTED `grep -r` inside a search pattern — each a wasted round trip.
  Timed on this box the same day, warm, searching text that is not there: `docs` 0.1 s, `scripts` 0.3 s,
  `supabase` 1.5 s, `app` 2.7 s, `tests` 3.7 s, `src` 4.5 s (the memory note's old "9 ms a file" figure
  no longer holds). C1 now judges each command segment (quote-aware, heredoc and here-string bodies
  removed): a recursive grep passes ONLY when every path is under `src`, `app`, `tests`, `scripts`,
  `supabase`, `docs` or `public`, and no path, `.`, `..`, an absolute path, a glob, a variable,
  `node_modules`, `.claude` or anything the parser cannot place is still refused. Pinned by
  `tests/bash-grep-guard.test.ts` (allow and deny matrices, each half broken and watched to fire).
  🔴 **The seven-folder allow-list was the next false positive, so C1 became a DENY-list on 2026-10-22**
  (owner: "fix"). Replayed over the last two days' transcripts, it had refused 109 greps, and 102 of
  them could not hang — `.claude/rules`, `.github/workflows/*.yml`, `docs/*.md`, `scripts/*.ts`,
  `package.json`, the memory folder, a scratchpad — 13 of those only because `\"` inside a double-quoted
  pattern was read as the closing quote. Now every path is RESOLVED where it runs (the hook's cwd, moved
  by any `cd` in the command; `~`, `$HOME` and any `NAME=value` set earlier expanded) and refused only
  when it lands on a big tree: a repo or `_wt-*` root, the workspace folder, `node_modules`, `.pnpm`,
  `.next`, `.git`, `.claude`, `worktrees`, `~/.claude/projects`, Temp/AppData, or any path two
  segments deep or less (a drive, `/tmp`, home). An unknown variable, `$(…)`, `..` or `.` under an
  unknown cwd is still refused; a glob passes when its parent folder is not a big tree. The replay
  after the change: 102 allowed, the 7 left all walked a repo root or `.claude/`. A backslash is an
  escape for the Bash tool only — in PowerShell it is a path separator.
  🔴 **The 7 left are no longer refused either — the hook ADDS the excludes** (owner, the same night:
  "fix the 7 grep refusals that remain"). All 7 searched a repo root or its `.claude`. With
  `--exclude-dir` for node_modules, .git, .next, worktrees and .codex-worktrees that walk took 3.5 s warm
  over the primary (11 s cold), against 10-40 s+ without; the real commands, rewritten, ran in 2.2 s and
  0.7 s with their hits. So a grep of a repo root (by name, or any folder holding `.git`) or its
  `.claude` is ALLOWED with the flags it lacks added after its `grep` word (`updatedInput`) — but only
  when every segment is read-only (grep, head, sed without `-i` or a `w`/`e` command, git log/show/diff
  without `--output`, ls, cat …; no redirect but to /dev/null, no heredoc). Otherwise it is refused WITH
  the rewritten command, so the classifier still weighs the rest. `_wt-*` is NOT one of the flags: GNU
  grep 3.0 applies `--exclude-dir` to a folder named on the command line too, so a grep of a worktree
  root by its absolute path searched nothing (0 hits against 1). Replay after: 102 untouched, 7
  rewritten, 0 refused.
- **`pnpm run <script>` tries to PURGE `node_modules`** when the lockfile has moved, destroying the
  install before the script runs. Invoke directly: `node scripts/repo-doctor.mjs`.
  `pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved`
- **`git show <ref>:<path>` FAILS under MSYS when the path starts with a DOT — a stderr `fatal:`, not an empty file, which a pipe turns into a confident `0`.** Measured: `.github/…`, `.gitignore`, `.env.example` and `.claude/…` all mangle; `docs/…`, `supabase/migrations/…`, `tests/…` and `package.json` do not. `ambiguous argument` over a backslashed path means only that the CONVERSION fired — **not** that the file exists: a dotted path that is genuinely absent gives the identical message. Re-run it with `./` in front to learn which — bytes back means the trap was eating a real file, `path '…' does not exist in '<ref>'` means it was never there. Also **`grep -c $'\r'` matches EVERY line of a pure-LF file** — use the PowerShell tool, or count raw bytes in node. A CRLF working copy can read as CLEAN too: git normalises before comparing. **MSYS mangles a SEARCH PATTERN the same way: a `git grep`/`rg` pattern holding a leading-slash path matches NOTHING, silently** — `redirect("/employee-portals/` returned 0 against 41 real hits, and a zero here reads as *the code is clean*. Export `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` before any such sweep, and never quote a count from one without it.

🔴 **AND WHEN THE ANSWER YOU WANT IS A COUNT, THE FIX IS A DIFFERENT COMMAND RATHER THAN A VARIABLE: `git grep -c <pat> <rev> -- <path>` SEPARATES THE REVISION FROM THE PATH, SO THERE IS NO COLON FOR THE CONVERSION TO FIRE ON.** It needs neither `MSYS_NO_PATHCONV=1` nor a `./`, and it is the only form of this question that cannot hand you a false zero — which matters because the dangerous case is exactly the counting one. Measured 2026-10-02, verifying that a shipped PR's rule edit had really landed: eleven markers were checked with `git show "origin/main:<path>" | grep -c`, ten returned real counts and the one dotted path (`.claude/rules/phoenix-crm.md`) returned **`0`** — which reads as *that rule never shipped*, the single most alarming thing a post-merge check can say. `git grep -c readsPlaceVsActual origin/main -- .claude/rules/phoenix-crm.md` answered **2** for the same file at the same revision, minutes later, with nothing having changed but the command. The loop had `2>/dev/null` on it, which is the ordinary way to silence "file not found" noise across a list of paths and is precisely what hid the `fatal:`; so the lesson is not only about this trap but about the shape — **a sweep over several paths must not silence stderr, because that is where the difference between *absent* and *unaskable* lives.** Same family as the Validation cluster's fail-open shape, and the reason both this cue and `verify-the-emitted-artifact-never-the-source` insist a zero be read as a question rather than an answer. `git-ref-colon-path-is-mangled-by-msys-returns-empty`
- **`grep -c $'\r'` under MSYS reports a match on EVERY line of a pure-LF file, and a working copy can
  carry CRLF that `git status` calls clean.** Two separate faults that present as one argument, and
  between them they cost two sessions two rounds on 2026-08-29. The instrument first: MSYS translates
  line endings on read, so the `\r` pattern matches everywhere and the count equals the line count —
  it cannot distinguish LF from CRLF and its answer is always "CRLF". Never settle a line-ending
  question with a shell tool here; count bytes 13 and 10 from a raw Buffer in node
  (`fs.readFileSync(p)` — no encoding argument, so no text-mode translation) or use the PowerShell
  tool. The second fault is the one the bad instrument hid. `.gitattributes` pins `* text=auto eol=lf`,
  which governs what git **writes on checkout** — it does not govern what a local tool writes
  afterwards, and git then normalises on **read** before comparing, so the modification is invisible:
  `git status --porcelain -- CLAUDE.md` was EMPTY against a working copy of **6,924 bytes with 106 CRLF
  pairs** while the blob was **6,818 with zero CR**. It is selective, which is the tell that a writer
  and not a checkout is responsible: in that worktree `CLAUDE.md`, `.claude/agents/role-sweeper.md` and
  `.claude/hooks/bash-guard.mjs` carried CR while `AGENTS.md` beside them did not. **This moves a real
  number** — auto-loaded context is measured in bytes, so the same file legitimately has two honest
  sizes, one for the commit and one for what a given machine actually loads; a byte-budget gate should
  answer for the commit and discount the CR of a CRLF pair, while a reporter should say what the
  machine in front of it loads. Neither figure is wrong, and making them agree by lying about the
  second is. **The generalisable half is about method, not line endings: a wrong instrument tells you
  nothing about the conclusion.** Both readings here were true at once — the `grep` evidence was
  genuinely garbage *and* the CRLF copy was genuinely real — so dismissing the claim on the strength of
  the broken tool was the actual mistake. When you catch a tool lying, that discredits the tool and
  returns the question to open, not to answered-in-your-favour. **No memory file holds this trap, and
  this account is the record.**
- **`pg_dump` piped through stdout on Windows writes CRLF, and the archive looks perfect.** On
  2026-09-03, retiring ten dated pre-image schemas from production, all ten dumped with
  `pg_dump ... | gzip -9 > file.sql.gz`: exit 0 every time, zero bytes of stderr, byte counts in
  proportion to the tables. The verification pass is the only reason it was caught — parsing the
  archives for `COPY` blocks found **0 of 28**, while all 28 `CREATE TABLE` statements were present,
  which is not a shape any real dump has. Every line ended `\r\n`: `pg_dump`'s stdout is opened in
  **text mode** on Windows, so the C runtime translates each `\n` on the way out. `-f <file>` does not
  go through that path — the same schema dumped **0 CR / 144 LF**. **This is not cosmetic.** In `COPY`
  text format a literal carriage return inside a value is escaped as `\r`, so a raw CR can only ever be
  a line terminator; on a Linux `psql -f` restore every row therefore carries a trailing CR in its
  **last column**, and the terminator line `\.` arrives as `\.\r`, which does not end the block. The
  archive is silently unrestorable in exactly the place nobody looks. **The generalisable half: an exit
  code and a plausible file size certify that a backup command RAN, never that the backup is good.**
  The only proof is reading the archive back and counting what is in it against the live source — and
  doing that *before* the destructive step, because the drop is what makes the difference permanent.
  Re-dumped with `-f`, the ten verified **28/28 tables and 47,333/47,333 rows**, clean LF. This is the
  second Windows text-mode fault in this group and it points the opposite way from the one above:
  there the tool misreported line endings it was reading, here the tool silently introduced them on
  write. **No memory file holds this trap, and this account is the record.**
- **A role probe cannot trust the HTTP status code**, and **a POST to ANY `/api/**` path returns 403
  even when the route does not exist** — probe a deploy with GET and read 404/405/403.
  `a-role-probe-cannot-trust-the-http-status-code` ·
  `a-post-to-any-api-path-returns-403-even-if-it-does-not-exist`
- **`curl -d "@-"` creates NOTHING on Windows** — the stdin-payload form silently posts an empty body,
  so a cron-job.org REST call "succeeds" having made no job. Write the JSON to a file and pass
  `-d @file.json`. `cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui`
- **Reads of `.env*` are auto-approved here — deliberately, for EVERY key, not just `NEXT_PUBLIC_`.**
  The owner was shown the `SUPABASE_SERVICE_ROLE_KEY`/`DATABASE_URL` exposure explicitly and chose the
  broad option; do not re-litigate it or narrow it back on your own judgement. It is licence to
  *inspect*, never to *propagate* — §9's do-not-repeat-a-secret rule is unchanged, and a truncated
  check beats a full dump. `env-file-reads-fully-auto-approved-2026-08-09`
- **A Claude permission allow-rule stores the LITERAL command, so an inline env var bakes a live
  credential into `settings.local.json` in plaintext.** A working Telegram bot token sat there in the
  clear; the file is gitignored, so secret-scanning and CI never see it. Grep any `settings.*.json`
  for `TOKEN=`/`KEY=`/`SECRET=`/`PASSWORD=` before copying, merging, sharing or committing it, merge
  `allow`/`deny`/`ask` bucket by bucket (a flattened union promotes a `deny` into `allow`), and prefer
  a wildcard rule over an inline-secret one. `permission-allowlist-rules-can-embed-a-live-secret`
- **`mcp__supabase-staging__*` was broken until 2026-09-12 — its token belonged to a DIFFERENT
  Supabase account, one holding no projects**, so `list_projects` came back empty and every call
  answered `-32600`; the staging database was healthy throughout. Fixed by running the server on
  `SUPABASE_PROD_TOKEN` pinned with `?project_ref=cifwmndunmlxjhyjugxa`, measured live: 20 tools
  instead of 29, no `list_projects`/`create_project`, `execute_sql` takes no `project_id`, and passing
  one is refused (`unrecognized_keys`) — so this server has no path to production. A session started
  before its checkout pulled the change still runs the old server: route staging work there through
  `mcp__supabase-production__*` with the staging `project_id`. `supabase-staging-named-server-broken-2026-08-10`
- **The Supabase MCP returns ONLY the last result set of a multi-statement `execute_sql` — every
  earlier one vanishes with no error.** Measured on production 2026-08-29: three `select`s in one
  call, separated by semicolons, returned exactly one row, the third. Nothing anywhere reports that
  two result sets were discarded. So a batch written as "count A; count B; now show C" silently
  answers only C, and — the dangerous shape — a verification block that checks its own work in
  statement one and prints a summary in statement two certifies whatever the summary happened to
  say, having never shown you the check. Put every question in ONE statement (CTEs or scalar
  subqueries, as the occupancy proof below did), or make a separate call per question.
  **No memory file holds this trap, and this account is the record.** #2617 cited
  `a-mock-name-generator-reproduces-real-employee-names` here, which is a record of the staging
  anonymisation scrub this was noticed *during* — the name-collision method, not the MCP's
  behaviour. Do not re-add that citation.
- **A Windows USER env var SHADOWS every `.env.local` in every worktree, silently.** `node --env-file`
  / `--env-file-if-exists` only FILLS IN variables that are missing — it never overwrites one already
  in the process environment. So editing `.env.local` and re-running changes nothing, with no warning.
  **Which copy is valid has already flipped once**, hours apart on the same day: the env var was the
  dead key shadowing a good file at 10:00 Cairo and the only live key by 12:35, with three distinct
  164-char `OPENAI_API_KEY`s in play at once. Never reuse a previous session's answer — re-probe
  process env, `.env.local` and the Windows User env, all three, and never print the value.
  `windows-env-var-shadows-every-env-local-key`
- **The local attendance agent dies at EVERY logon and loses NOTHING — do not escalate it.** The
  `Phoenix Attendance Agent - Run At Logon` task ends `0xE0434352` (an unhandled managed exception)
  every single boot, but `Phoenix Attendance Sync - Every 2 Hours` starts the agent on demand and
  those runs INSERT — 19 rows and 1 row on 2026-08-26 off 5,406 device records. Overnight `503`s are
  the DEVICE, not the code (`192.168.100.52:4370` is reachable roughly 11:00–18:00 Cairo). **Never
  disable the 2-hourly task, and never launch a second agent — it can fire a PRODUCTION sync.**
  `attendance-agent-crashes-at-logon-but-loses-no-attendance`
- **ExcelJS emits two schema-invalid OOXML fragments, so Excel silently REPAIRS the workbook**
  (relocated from `MEMORY.md` 2026-08-28 together with its index line). The symptom is the "We found
  a problem with some content" dialog, logging *"Replaced Part: /xl/worksheets/sheetN.xml"* and
  *"Repaired Records: Drawing"*. **1 —** `CT_SheetPr` fixes the child order `tabColor`, `outlinePr`,
  `pageSetUpPr`; setting `outlineProperties` together with `pageSetup.fitToPage` makes ExcelJS write
  `<pageSetUpPr/>` **before** `<outlinePr/>`, and Excel then discards the ENTIRE sheet part — only
  the sheets carrying an outline group fail, which is the tell. **2 —** `CT_OneCellAnchor` declares
  no attributes at all, yet ExcelJS writes `editAs="oneCell"` on `<xdr:oneCellAnchor>` **whether or
  not you pass it**, so dropping the option from `ws.addImage` does NOT fix it. Both need the `.xlsx`
  zip post-processed. Four diagnosis traps cost real time: a clean `zipfile.testzip()` proves nothing
  (the container was always fine — parse the part XML), a non-greedy `<sheetPr\b.*?(?:/>|</sheetPr>)`
  regex stops at the first `/>` and makes a correct file look broken, openpyxl reports `images: 0` on
  every sheet because it cannot read ExcelJS DrawingML (check `xl/media/*` instead), and openpyxl
  under-reports grouped columns. `exceljs-writes-two-schema-invalid-ooxml-fragments`
- **THREE ways of LOOKING at a generated workbook lie, and they do NOT all lie in the same direction.**
  Two make a CORRECT file read as broken, which is the expensive way round — you go hunting for a defect
  that is not there. The third makes a BROKEN file read as CORRECT, which is worse: nobody goes looking
  at all. Excel is not drivable headlessly here, so LibreOffice
  (`/c/Program Files/LibreOffice/program/soffice.exe`) is the tool, and every one of its modes misleads
  about something.
  **1 —** `--convert-to png` renders only the LEFTMOST columns. On a sheet whose columns are 4 / 30 / 96
  characters wide it showed columns 1-2 and stopped: every body paragraph, every live counter and the
  title (which sits in column 3) came out blank, with no error. Diagnosed as a builder bug twice in one
  session; both times the cells were present and correct. **2 —** a "review copy" made by loading the
  workbook with ExcelJS, `removeWorksheet`-ing the other sheets and saving **destroys the merges** (7
  `mergeCell` refs became 0) and the column widths, so headings clip mid-word — in the copy only.
  §4 already forbids that round trip for the premium closing engine's pivots and VBA; it damages an
  ordinary workbook too, and destroys precisely what a visual review is trying to judge.
  **What works is
  `--convert-to html`**, which emits every sheet's real cell values: strip the tags and assert the
  strings you expect are present. That settled both false alarms in one command. Keep the PNG for
  STRUCTURE at a glance — masthead, rules, zebra banding, whether anything is a filled block — never for
  whether content exists.
  **3 — and this one inverts the direction: `--convert-to html` cannot judge a PIVOT's freshness.**
  LibreOffice rebuilds a pivot (its DataPilot) from the declared source on EVERY load, unconditionally
  and regardless of `refreshOnLoad`, so it renders a STALE cache exactly as it renders a live one — the
  defect reads as FIXED. Measured 2026-09-05 on the Weekly Sales BI workbook: the cached records were
  poisoned to `777777` in BOTH a fixed and an unfixed build, and both rendered the true total 6,786. The
  poison never appeared, so a clean render is no evidence at all about `refreshOnLoad`. What it CAN
  settle is the cache SOURCE, precisely because it rebuilds from whatever source is declared — append
  rows to the Data table, leave the cache untouched, re-convert and read the pivot's grand total:
  `<worksheetSource name="tblWeekly"/>` gave 855,270 with the new rows in, while
  `<worksheetSource ref="A1:O8" sheet="Data"/>` gave 6,786 with them invisible. That is a real
  end-to-end proof that a pivot grows with its data. `refreshOnLoad` itself is provable only
  STRUCTURALLY — the attribute present, singular, and matching the form Excel wrote in
  `assets/closing-engine/template.xlsm`. Confirming a pivot actually OPENS fresh needs Excel; say which
  half your evidence covers rather than letting a CLEAN render imply both.
  And the structural question is separate from all three: only
  `node scripts/check-workbook-integrity.mjs <file>` answers "will Excel silently repair this", so run it
  as well, not instead. `looking-at-a-generated-workbook-two-ways-that-lie`

### Excel names the part it repaired, and a CLEAN checker verdict is not a clean file — 2026-09-08

The premium Monthly Closing export asked to be repaired again, and the first instinct was to go
hunting: run the integrity checker, diff the package against a working export, deep-check the style
and shared-string indices, validate the worksheet element order against the CT_Worksheet sequence. All
of it came back clean, on a file Excel was refusing.

**Excel had already written the answer down.** Clicking Yes on "We found a problem with some content"
writes a recovery log to `%TEMP%\error<digits>_01.xml`, naming the part and the record kind verbatim:

    <removedRecord>Removed Records: Merge cells from /xl/worksheets/sheet1.xml part</removedRecord>

That is the FIRST thing to read, before any tooling — `Get-ChildItem "$env:TEMP\error*.xml"` finds it.
If the owner clicked No, open a COPY through Excel COM instead. Two things there are worth knowing:
`Workbooks.Open` on a file needing repair FAILS outright under `DisplayAlerts = $false` ("Unable to get
the Open property of the Workbooks class"), which is itself a usable signal; and a successful open that
writes **zero** new `error*.xml` files is the proof a fix actually worked.

**And the checker's CLEAN means "none of the defects that have already bitten us", never "Excel will
open this".** Every rule in `check-workbook-integrity.mjs` was written after a workbook shipped broken,
so what it looks at is exactly the set of things that have already gone wrong. It printed CLEAN on the
file above, because nothing in it looked at merged ranges: repeated merges parse, carry a content type,
break no relationship and leave the rows in order. Rule 4b was added the same day. **When the next one
gets through, add its rule to that script BEFORE fixing the cause** — otherwise the class stays
invisible and the dialog comes back looking like the same bug returning.

The defect itself: `moveMerges` in `closing-engine-fill.ts` ran one global string replace per moved
row, so each rewrite it had already made was still on the page for the next pattern to match. With the
footnote block sliding DOWN by less than its own height, each footnote's new row was the next one's old
row, and all three merges cascaded onto `B21:J21`. It is a function of the REGION COUNT and nothing
else — the template puts the footnotes at 18/19/20, so nine regions (September Anti Infective) shift
them by one and collapse, eight (August Anti Infective) move them nowhere, and seven (Pedia) move them
UP, which is always safe because a block moving up cannot land on a row it has not already left. Every
export before that one happened to have a safe shape, which is why a latent bug read as a fix that kept
coming undone. Fixed by mapping the whole list in one pass (PR #3541).

**Git**

- **Deleting a branch does not remove its pushed commit**, and **reusing a squash-merged branch makes a
  conflicting PR.** `deleting-a-branch-does-not-remove-a-pushed-commit` ·
  `reusing-a-squash-merged-branch-makes-a-conflicting-pr`
- **`git push` to origin hangs — kill it at ~60s and retry immediately.** A push or fetch that dies with `fatal: Out of memory, malloc failed (tried to allocate 524288000 bytes)` was never a real memory fault or a network problem: `http.postBuffer` was set to 500MB in `.git/config` and git allocates the whole buffer up front, so it died before sending a byte whenever free RAM dipped under it. **Fixed 2026-08-23 — that key is now `8388608` (8MB), verified with an unoverridden fetch, ls-remote and push.** Do NOT restore 500MB; if a genuine large-push failure ever appears, raise to 50MB at most. `git-push-to-origin-hangs-retry-immediately` · `git-push-oom-is-a-500mb-postbuffer-in-repo-config`
- **A merge to `main` mid-session silently orphans your next push.**
  `a-merge-mid-session-orphans-your-next-push-silently` · `two-sessions-fixed-one-bug-main-was-never-ci-validated`
- **`refs/deleted-*` is the ONLY copy of an archived branch tip or stash — never pushed — but it is
  NOT automatic, and this entry implied it was until 2026-08-27.** The glob trap is real and
  unchanged: `git for-each-ref 'refs/deleted-*'` reads **0** because `*` never crosses `/`, so use the
  full prefix `'refs/deleted-*/**'`, and count it live before believing any number (**44** refs on
  2026-08-23, **96** — 86 branches, 10 stashes — on 2026-08-27). What is wrong is the implied safety
  net. **Nothing in this repository writes that namespace**: not `scripts/`, not `.claude/hooks/`
  (`bash-guard`, `session-lock`, `worktree-exit-guard` only), and `.git/hooks` holds nothing live at
  all — just `pre-push.bak-20260730`. A plain **`git branch -D` archives NOTHING.** Measured
  2026-08-27: deleting 6 branches moved the count **96 → 96**, with the newest archived entry still
  hours older than the deletions — the second such measurement, after **44 → 44** on 2026-08-23.
  **So never delete a branch expecting this to catch it.** After a `-D` the tip survives only as an
  **unreferenced object** — recoverable by SHA, so keep the SHA the delete prints, and only until
  `git gc` prunes unreachable objects (default ~2 weeks). To archive a tip deliberately, write the
  ref yourself *before* deleting: `git update-ref refs/deleted-branches/<name> <sha>`. **And
  `refs/deleted-*` is not the only archive — `refs/backups/*` lives ON ORIGIN**, written by
  `scripts/prune-stale-branches.ps1`, pushed, and therefore the only copy that survives losing this
  laptop: `git ls-remote origin 'refs/backups/*'`. Check both before calling a tip lost.
  `deleted-branch-tips-live-in-refs-deleted-branches`
- **An empty `git log <branch> --not --remotes=origin` is NOT proof a branch is safe to delete.** A
  squash merge deletes the remote branch, but `git fetch` never prunes — so `refs/remotes/origin/<branch>`
  survives at the branch's OWN tip and the check compares the branch against itself, returning empty
  forever. Confirmed again 2026-08-23: it read empty while `git ls-remote --heads origin <branch>`
  returned **0** lines; the `git remote prune origin` that followed cleared **8** such ghosts at once.
  Gate deletion on the merged PR. And when the blobs DO differ from `main`, that is a question not a
  verdict — name the later commit with `git log <squashSHA>..origin/main -- <files>` before calling
  anything stranded. `not-remotes-flips-when-remote-refs-are-pruned` ·
  `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **A UTC merge time read against a Cairo commit time INVERTS the merged/stranded verdict.** §4's
  "report in Africa/Cairo, never raw UTC" is a REPORTING rule; this is the ANALYSIS failure it does
  not cover, and it is what makes the two traps above dangerous. `gh pr view --json mergedAt` returns
  **UTC** (`2026-08-28T09:51:22Z`) while `git log --format=%cI` returns **Cairo**
  (`2026-08-28T12:44:26+03:00`). Side by side, 12:44 looks LATER than 09:51, so squash residue reads
  as new post-merge work — but 09:51Z **is** 12:51 Cairo, and that commit predates its own merge by
  seven minutes. Measured 2026-08-28 on a peer session's worktree audit: combined with `ls-remote` =
  **0** (which is `delete_branch_on_merge` succeeding, not a missing backup) and `git cherry`'s
  multi-commit-squash false positive, it produced a confident STOP telling two sessions to **push**
  already-merged branches — the exact move that opens a conflicting PR, and a conflicted PR runs no
  CI at all here. Each signal is ambiguous alone; the timestamp is what *appears* to resolve them,
  and it resolves them backwards. **Compare instants, never wall clocks** — put both sides in one
  zone (`TZ=UTC git log`) before subtracting. And a timestamp is never the verdict anyway: the answer
  is CONTENT, per §5 — `git diff $(git merge-base origin/main <branch>) <branch> | git patch-id
  --stable` against the squash commit's own patch-id. Identical means fully represented on `main`,
  whatever the clocks appear to say.
  `a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal`
- **`git` "Authentication failed" can be the credential HELPER (GCM) going OOM, not a bad token.**
  Git Credential Manager dies at `internal/cpu.doinit` and git then retries ANONYMOUSLY, so the token
  is never presented — the failure is memory pressure, not auth. Look UP the output for a Go panic;
  change NO credentials. `git-auth-failed-can-be-the-credential-helper-going-oom`
- **`F:\PHX backup` is the disaster-recovery set, and a bundle restore silently returns ZERO refs
  without `core.longpaths`.** Phoenix's cloud side (Railway, Supabase, GitHub) survives a PC reset;
  this set exists for the local support layer, which does not — Claude memory, every `.env*`, the git
  bundle, the scheduled tasks, the attendance agent. Three copies: `F:\PHX backup`, a SHA256-verified
  USB, and an encrypted 7-Zip on Google Drive. **Restoring `06-git\phoenix-ALL-REFS.bundle` needs
  `git config core.longpaths true` FIRST**: Codex CLI writes refs past Windows' 260-char limit, git
  transfers every object then rolls the whole ref batch back on the first one, so a perfect bundle
  reads as 0 refs with no useful error — measured 0 without the flag, 315 with it. Three of its
  sections hold LIVE keys, so treat the set itself as a secret. `phx-backup-disaster-recovery-set`

- **An uncommitted file in the primary checkout can be OLDER than `main`, and `git diff HEAD` presents it as new work.** 2026-09-04. The primary sat on `codex/dsm-no-record-thursday-halfday-and-dead-day-guard` at `864aa49fb` — a **squash-merged** tip, and therefore not an ancestor of `main` — with `src/lib/outstation/service.ts` and `src/lib/outstation/submit-recipients.ts` showing as modified. `git diff HEAD` produced a clean, coherent change: comments and one metrics string rewritten so the outstation submit email reads as a confirmation to the employee rather than a heads-up to his manager. On a bare instruction to *“commit that outstation work on a new branch”*, that diff is the entire story a session sees, and it was the wrong story twice over. Measured against `main`: `submit-recipients.ts` was **byte-identical** (`fb50d761` on both sides) — already shipped as #3083, *“the submit email confirms to the employee, not his manager”* — and `service.ts` was **behind** it, missing the rest of that same PR (`main` also updates the `roleHrefs` comment and the `submitEnvelope.routing` label to `employee_to_manager_cc_superadmin_bcc`; the local copy still read `manager_to_skiplevel_...`, contradicting the comment directly above it) and missing, entirely, the **2026-09-04 Meeting-expense owner rule** — `isMeetingExpense` / `zeroAllowanceBreakdown` across all three `ManagerExpense*` functions, 20 references on `main` and none locally. Rebasing that copy onto `main` and committing it would have silently restored distance-driven travel cost and a per-diem allowance to Meeting expenses, against a rule the owner gave that same day.

  **The corollary cost a diagnosis too.** Running the registered suite against the working tree produced a real red — `FAIL outstation submit email routing … 'HR-REP' !== 'HR-DM'` — which reads exactly like *this change is unfinished, its tests were never updated*. It was the opposite: `tests/outstation-submit-email-routing.test.ts` was rewritten in the **same commit** as the source, so the old test from the stale HEAD was being run against the new routing. **A test that fails against a file you did not write is evidence about the BASE, not about the change.**

  **The check is CONTENT, not the diff** — the same lesson as the `git patch-id --stable` entry above, one level down. Before committing anything you did not write, run `git hash-object <path>` against `git rev-parse main:<path>` for every changed file. Equal means it is already shipped and there is nothing to commit. Different means read `git diff main -- <path>` and mind the direction: `-` lines are what `main` HAS, so a diff whose `-` side deletes named business rules is a **revert wearing a commit's clothing**. The copy itself is preserved on `codex/outstation-submit-confirmation-local-snapshot` (`362c9a5b4`), committed on its original base so the commit is exactly its author's edit and nothing else, with the reasons it must never become a PR written into the commit message.

**CI and PRs**

- **CI jobs failing in SECONDS mean billing, not code.** `ci-jobs-failing-in-seconds-means-billing-not-code`
- 🔴 **THERE ARE TWO REQUIRED CHECKS — `validate` and `checks` — AND `secret-scan` IS NO LONGER ONE
  OF THEM.** It is still this repo's only automated secret detection, because a personal account has
  no GHAS/OSS scanning. `github-personal-account-no-ghas-oss-scanning`
  🔴 **THE LIST HAS ROTTED FIVE TIMES AND THE COUNT IS THE PART THAT ROTS: 4 → 5 (2026-08) → 6
  (2026-09-18, `test` and `mobile`) → 4 (2026-09-27, #4527 folded `lint`+`typecheck`+`test` into one
  `checks` job) → 2 (2026-09-29, `mobile` and `secret-scan` demoted).** `lint`, `typecheck` and
  `test` are STEPS, not check names — `checks` carries lint and typecheck, `validate` carries the
  unit suite — so a session waiting on them by name waits for something that can never report. Every
  time this changed, the docs lagged: after 09-27 nineteen places in this repo still said six,
  including the `ship` and `verify-context` skills that sessions follow to merge. **Read
  `branches/main/protection/required_status_checks` live before stating or counting anything; never
  quote this paragraph, AGENTS.md, or a skill as the source.**
  🔴 **THE 09-29 DEMOTION WAS DELIBERATE, AND IT TOOK BOTH JOBS OFF THE PULL REQUEST TOO** — those
  two steps are always one change, because a required check whose job stops reporting leaves every
  PR on "Expected — waiting for status" for ever. `mobile` carries
  `if: github.event_name != 'pull_request'` and now runs on `main`, a dispatch and a schedule;
  `security-scan.yml` lost its `pull_request` trigger entirely (the same gitleaks 8.30.1 moved into
  `bash-guard.mjs` clause **C12**, which refuses the push, so a key never reaches GitHub at all) and
  keeps its daily `schedule` (20:17 UTC since 2026-10-16). **So a PR's check list IS the required pair and nothing
  else.** Their absence from a PR *and* from a merge commit is CORRECT, not a missed gate — do not
  hunt for either afterwards and do not dispatch one to "complete the set". What it costs is real
  and is the point: a red Expo typecheck or a gitleaks finding is now a **fix-forward on `main`**
  that nothing stopped at the merge, so read both on the commit rather than assuming they gated it.
- **`gh pr checks` LAGS behind the real job state.** `gh-pr-checks-lags-behind-the-real-job-state`
- **`check-runs: 0` also means CONFLICTED** — a conflicted PR runs no CI at all, which reads as "not
  started". `a-conflicted-pr-runs-no-ci-at-all`
- **A gate written as "no pendings" reads an EMPTY check list as GREEN, and a fast-moving branch
  supplies one.** For a few seconds after a push `gh pr checks <pr>` returns no rows at all; a
  watcher whose test is `grep -c 'pending'` then counts `0` and declares every check passed.
  Measured 2026-09-21 on #4153, whose session pushed six heads in ten minutes: the watcher printed
  `ALL SIX GREEN` — with a blank line where the six rows should have been — against a head on which
  only `secret-scan` had reported, and a live read a moment later was five of six still pending. It
  was one step from merging a PR whose CI had not started. This is the same shape as every other
  empty-result trap in this file: an absence read as a verdict, exactly like a mangled `git show`
  piped into `grep -c`. Gate on the **count of PASSES against the required list read LIVE from the
  protection API**, and require the head SHA unchanged across two consecutive polls — so the gate can
  neither fire into a push nor score a list that does not exist yet. 🔴 **Do NOT hard-code the
  expected number.** This paragraph said "the expected 6" until 2026-09-27, when #4527 took the real
  answer to 4 — a watcher built on that sentence now waits forever for `lint`, `typecheck` and `test`,
  which no longer exist as checks — **and then to 2 on 2026-09-29**, when `mobile` and `secret-scan`
  were demoted. The count is the part of every version of this rule that has rotted; the live read is
  the part that has not.
- **ONE new hub page trips FOUR separate CI gates.** `adding-a-hub-page-trips-four-separate-ci-gates`
- **A red `main` still builds, ships, and serves perfectly** — `ignoreBuildErrors` (see the
  exhaustive-`Record` entry under Validation below) hides it from the product, and a green PR is not
  a green `main`: two PRs can each pass alone, on checks taken before the other existed, then merge
  and never get validated together. After merging, check the run on **`main`'s new head**
  (`gh run list --branch main --limit 5 --json headSha,name,status,conclusion`), not the branch's own
  check. `a-red-main-ships-and-looks-fine-build-ignores-type-errors`
- **Runs NEVER CREATED (`check-runs: 0`, empty `gh run list --branch`) is an Actions OUTAGE, not
  billing — billing creates the run and fails it in seconds; `startup_failure` is an outage
  signature too.** Check `curl -s https://www.githubstatus.com/api/v2/components.json | grep -o
  '"name":"Actions","status":"[a-z_]*"'` and `https://www.githubstatus.com/api/v2/incidents/unresolved.json`
  BEFORE touching the spending limit. Recover a PR with `gh pr close <n> && gh pr reopen <n>` —
  it fires `reopened`, keeps the head SHA, and adds no junk commit. `gh workflow run ci.yml --ref
  <branch>` does NOT fix a PR: a `workflow_dispatch` run's check runs land on the head SHA but
  never enter the PR's `statusCheckRollup`, so branch protection does not count them. Verified
  2026-08-26 — identical check-run names on two heads, only the `pull_request`-sourced ones
  reached the rollup. (Cancelling such a dispatch run is harmless for the same reason.)
- **Simplest PR recovery of all: `gh run rerun <id>` on the PR's OWN `pull_request`-sourced run.**
  A rerun keeps the run's `event` as `pull_request`, so unlike a dispatch its check runs DO enter
  the rollup — and unlike close/reopen it touches nothing about the PR. Verified 2026-08-26 on
  #2418: run `32989112637`, `event=pull_request`, attempt 1 `cancelled` -> attempt 2 `success`,
  rollup populated with all four required checks, `mergeStateStatus` went `BLOCKED` -> `CLEAN`.
  Wait for the backlog to drain first (poll until no `in_progress`/`queued` runs remain), or the
  rerun is just one more racer. Branch protection reads the LATEST check run per name, so a green
  dispatch does not stay green once a newer run of the same name starts.
- **Then WAIT — dispatch lags 20–30 MINUTES during an outage, and the events are NOT dropped.**
  Measured on one PR 2026-08-26: reopen at `16:08:08Z` produced its runs at `16:29:29Z` (+21m); an
  empty-commit push at `16:09:58Z` produced its runs at `16:35:23Z` (+25m). Both ran and passed.
  The earlier claim here that dropped events are "NEVER replayed" was written from the same
  outage, before the queue drained — it is wrong. Polling at 20s/45s/100s and concluding the event
  fired nothing is how that session escalated for no reason: an empty commit, then a whole
  replacement PR, renumbering #2414 to #2419 to escape a problem that was only latency. Fire ONE
  recovery event, then leave it half an hour before believing anything.
- **An extra SHA is not merely useless during an outage — it ACTIVELY KILLS the real head's run.**
  `ci.yml`'s concurrency group is `${{ github.workflow }}-${{ github.ref }}` for a `pull_request`,
  with `cancel-in-progress: true`. On a PR `github.ref` is `refs/pull/<n>/merge` — the SAME value
  for every commit — so both SHAs share one group. When the backlog replays it replays the
  OBSOLETE commit's event too, and that late arrival cancels the run on the head you actually care
  about. Measured on #2418: head `21d25e3a`'s run started `16:34:04Z`, the abandoned `88f468d4`'s
  replayed event landed `16:35:08Z`, and attempt 1 of the head's run ended `cancelled`. It cost a
  full extra CI cycle to recover. Never push an empty commit to force a `synchronize`.
- **`actions/runs?head_sha=` needs the FULL 40-char SHA — an abbreviated one returns `total=0`
  with no error.** During an outage that is indistinguishable from "no runs exist", which is
  exactly when the query gets used: a watcher built on the 8-char form reported no runs for 8
  minutes after they had landed and `gh run list` was already showing them. Same repo, same
  moment: `head_sha=2c0979ca` -> `total=0`, `head_sha=2c0979cae674…` -> `total=2`. Pass all 40
  characters, or filter `gh run list --branch <b>` on `.headSha` yourself.
- **A push to `main` during an outage ships to PRODUCTION with no CI run at all.** Railway deploys
  on push regardless, so the merge is live and unvalidated — and the "green PR is not a green
  `main`" trap above applies with *nothing* having run, not merely with stale checks. On
  2026-08-26 `ad2a0148` and `33f2b5b7` merged a minute apart and neither ever got a run. Recover
  with `gh workflow run ci.yml --ref main` — the `statusCheckRollup` caveat does NOT apply to
  `main`, which is not gated by a PR, so a dispatch is a real answer there.
- **The GitHub repo is `phoenix-people-workforce`; almost everything local is called
  `phoenix-workforce`.** The checkout is `F:\Phoenix Workforce\phoenix-workforce`, `package.json`
  reads `"name": "phoenix-workforce"`, `supabase/config.toml` reads `project_id =
  "phoenix-workforce"`, `.claude/launch.json` names the dev server `phoenix-workforce`, and the
  dead GCP project is `phoenix-workforce-498619`. Only the GitHub remote carries the longer name.
  A session reconstructing an API path from the folder it is sitting in therefore writes
  `repos/it-gawish-hr/phoenix-workforce/…`, and GitHub answers
  `{"message":"Not Found","status":"404"}` — the same body a genuinely missing deployment would
  produce. On 2026-08-29 that 404 came back for `…/commits/<sha>` on a commit that was
  simultaneously the tip of `origin/main`, and was first read as API propagation lag. On
  `…/deployments` the identical mistake reads as *the production deploy never happened*, which is
  the one question that command exists to answer. **Nothing committed here has ever carried the
  wrong name** — verified 2026-08-29 across every ref (`git log -S "it-gawish-hr/phoenix-workforce"
  --all` returns no commits), across all six `repos/…` references (`AGENTS.md` §7,
  `docs/deployment.md`, `docs/disaster-recovery-runbook.md`, `docs/agents-incident-history.md`,
  and two in `.claude/skills/verify-context/SKILL.md`), and across all seven worktrees. There is no longer ANY
  `gh api` call in automation carrying the name — the one that did, in
  `.github/workflows/deploy-cloud-run.yml`, interpolated `repos/${{ github.repository }}` and could
  not be wrong; that workflow was deleted 2026-09-08. So this is never a defect to go fix in a
  file — it is a typo the checkout invites, and the fix is to read the name rather than infer it:
  `gh repo view --json nameWithOwner` returns `sato-pharma/phoenix-people-workforce`, and
  `git remote -v` agrees.

**Migrations**

- **A migration FILE written is not a migration APPLIED**, and **a merged migration file does not mean
  the grants are live.** `migration-file-written-is-not-migration-applied` ·
  `merged-migration-file-does-not-mean-grants-are-live`
- **Migration timestamps COLLIDE across parallel branches**, and **the ledger version never matches the
  filename.** `migration-timestamp-collides-across-parallel-branches` ·
  `migration-ledger-version-never-matches-the-filename`

  **Ask the ledger by NAME, never by the filename's timestamp — and a rename cannot desync it.**
  Measured on production 2026-09-03 over the twelve most recent migration files: **one**
  (`ats_whatsapp_question_prompts`) has no `supabase_migrations.schema_migrations` row at all and is
  genuinely unapplied; the other **eleven** are applied, and of those exactly **one**
  (`honour_manual_direct_areas`) carries a `version` equal to its filename prefix while the other
  **ten** carry a different number. So the version is stamped when the migration is applied, not
  taken from the filename, and a lookup keyed on the filename prefix answers *not applied* for **ten
  of the eleven** migrations that are in fact applied. That single wrong reading is the whole trap.

  It follows that **re-stamping a colliding migration's timestamp is safe for a NORMALLY stamped
  row, whether or not it has been applied**: the ledger row is found by `name`, and the rename
  changes only the digits in front of it. Applied-vs-unapplied is simply not what makes the rename
  safe — which matters, because reasoning from it points the wrong way in both directions. #1419
  proved it in practice, re-stamping `20260728100000_restore_report_rpc_statement_timeouts.sql` to
  `20260728100500_…`; that row still reads `name=restore_report_rpc_statement_timeouts,
  version=20260728091832`, untouched, and production has been healthy since 2026-07-28.

  ⚠ **Read the actual row first — not every one is stamped normally.** An earlier wording here said
  the filename prefix "was never in the ledger to begin with". That holds for the normal case and
  NOT for every case: measured 2026-09-03, that migration's own collision partner sits in the ledger
  as `name=20260728100000_au_resign_vacate_all_open_seats` — the FULL filename stem, old timestamp
  embedded — under `version=20260728092516`. For THAT row the prefix is in the ledger, and a
  re-stamp would leave its name pointing at a filename that no longer exists. Query the row before
  re-stamping; do not generalise from this bullet alone.

  `scripts/check-migrations.mjs`'s `GRANDFATHERED_DUPLICATE_TIMESTAMPS` comments carried the same
  mirror error — "renaming either would desync migration history" — and have since been corrected
  in that file's own header. That pass also found **three of its four entries DEAD**: only
  `20260814150000` still had two files, which the check's single warning confirmed on every run. The
  dead three were removed then, and section 2b now fails on an entry that no longer names a real
  duplicate — the repo's own doctrine, which `tests/hr-function-governance.test.ts` already enforced
  for its own list: a grandfather list "must not rot into cover for a name that no longer collides".

  🔴 **THE LIST IS EMPTY SINCE 2026-10-13, AND EMPTY IS ITS RESTING STATE — a new collision is fixed
  by RE-STAMPING the later file, not by adding an entry.** The last one went the way the bullets
  above describe: both ledger rows were read live on production AND staging first, both were stamped
  normally (`name=cv_extraction_any_job_title version=20260814125822`,
  `name=phx_rep_bulk_dependency version=20260814125938` — no filename prefix in either), so
  `20260814150000_phx_rep_bulk_dependency.sql` became `20260814150001_…`, one second after its
  partner, which is the order production applied them in. The drift check and the staging applier
  match by version **or** name through `scripts/lib/migration-inventory.ts`, where the name is the
  stem *after* the timestamp, so the renamed file still matches its row and is never re-applied —
  and `check:migrations` now runs with **0 warnings and 0 errors**, where a real warning is visible
  instead of sitting behind a permanent one. Add an entry only for the abnormal row two bullets up,
  whose `name` carries the old filename prefix and so cannot be re-stamped safely.
  `tests/migration-grandfather-staleness.test.ts` keeps section 2b pinned with the list empty by
  injecting a probe entry into a scaffold copy of the script.

  **The collision can appear with no change from you, because CI judges the MERGE ref.** Measured
  2026-09-04 on #3088: `check:migrations` PASSED on that branch's first CI run and FAILED on its
  second, with only two test files edited in between. In the gap,
  `20260905000500_contract_signatory_can_differ_per_contract.sql` merged to `main` as #3078, taking
  the same timestamp as the branch's own `20260905000500_salary_records_working_days.sql`. **That
  file was never on the branch** — `ls supabase/migrations/` there showed 411 files and no
  duplicate, and `node scripts/check-migrations.mjs` in the worktree reported *0 errors, passing*.
  CI checks out the pull request's merge commit, where both files exist, and counted 412. The branch
  was clean and the merge was not.

  Two readings this rules out. **It is not a flaky check, and not "the same failure again"** — the
  first red on that PR was a real test failure, so treating the second as more of the same sends you
  back into a suite that is green. And **a green local `pnpm run test` says nothing about it**:
  `check:migrations` is its own step in `validate`, one of six repo checks that run *before* the
  suite, so 1,212 passing test files cannot see it. The tell is the step name in the job log, not
  the test output.

  **Reproduce the merge condition rather than guessing** — extract main's copy into the worktree,
  run the check, remove it:

      git show origin/main:supabase/migrations/<their-file>.sql > supabase/migrations/<their-file>.sql
      node scripts/check-migrations.mjs      # now sees the real 412-file merge set
      rm supabase/migrations/<their-file>.sql

  Check the extraction is non-empty first — an empty file makes the check pass for the wrong
  reason, the same positive-control rule as everywhere else in this file. This particular
  command is safe as written: MSYS mangles a `git show <ref>:<path>` only when the path starts
  with a DOT, and `supabase/migrations/` does not. Measured both ways, 2026-09-21 — the same
  extraction wrote 1,568 bytes with and without `MSYS_NO_PATHCONV=1`.

  The fix is the rename, and **production needed nothing.** Both rows were already distinct in the
  ledger under their apply times — `contract_signatory_can_differ_per_contract` at `20260904145559`,
  `salary_records_working_days` at `20260904175101` — so the two never collided in the database at
  all, only on disk. After the rename, staging's automated apply matched by `name` and skipped it,
  leaving **one** ledger row rather than two, which is the concrete confirmation that renaming a
  file is safe after its migration is already live.

  **And the applied-state can flip UNDER a PR**, which is how the correct action came to carry a
  wrong justification. PR #2990's message states the ledger "does NOT hold
  `notification_role_policies_distributor_upload_overdue_key`". The exact timeline, all UTC:
  `attendance_rule_eighth_day_precision` applied **03:01:07**; #2984 merged **03:08:38**, landing the
  notification file; #2983 merged **03:10:47**, creating the collision; the notification migration
  applied **03:18:00**; #2990 merged **03:23:13**. So that session read the ledger before 03:18 and
  was **right when it looked** — the migration was applied five minutes before its own PR landed, and
  the claim was false by the time anyone could read it in `git log`. This is the mirror of the rule
  above it: a FILE written is not APPLIED, and equally **a migration you measured as unapplied does
  not stay unapplied**, because nothing about a merge applies one and a human can apply it at any
  moment. Re-read the ledger immediately before asserting applied-state in anything durable, and
  prefer stating the reading's timestamp over stating it as a standing fact.
- **A PostgREST `.in()` carrying several hundred ids returns ZERO rows and NO error.** The filter goes
  in the URL, so past some length the result comes back `{ data: [], error: null }` — an empty set
  indistinguishable from a true answer. On 2026-08-25 a 409-id `.in()` reported "never read: 409 of
  409" and "0 have a stored file"; chunked at 50 the truth was **10**. Chunk every `.in()` at ~50, and
  print the row count of the intermediate fetch — a pool of 409 candidates cannot return 0 extraction
  rows, which is what exposed it. `postgrest-in-with-hundreds-of-ids-silently-returns-nothing`

  **That is the QUIET mode, and it is not the only one.** The same filter also fails LOUDLY, two
  ways, and neither message says anything about a filter being too long — so a session carrying only
  the hook above goes hunting for missing data when what it actually has is a hard error. Both were
  re-measured against production (`ozucdzovmcqvepbozvqf`) on 2026-09-10 while fixing
  `/admin/customer-pharmacy-mapping` (PR #3627), where they fired one after the other.

  **ONE `null` in the id array fails the WHOLE request.** postgrest-js stringifies each value into
  the filter, so a JavaScript `null` reaches Postgres as the literal text `null` and the read comes
  back `22P02 invalid input syntax for type uuid: "null"`. Measured through the real client rather
  than a hand-built URL — `.in("id", [<four real uuids>, null])` returns exactly that. There is no
  per-row degradation and no partial answer: the read throws, and on that page every customer
  vanished behind an opaque "Customer pharmacy mapping failed." **`new Set(ids)` does not save you**
  — it dedupes the null down to a single entry and then sends it. And the column is nullable **on
  purpose**: `marketing_customer_pharmacies.distributor_code_id` is empty for a venue with no
  distributor account, which is the owner's own filing rather than a defect (§4.1, `nursery`), so
  this is not a data shape that gets cleaned up behind you. Live 2026-09-10: **444** active links,
  **4** of them NULL, **410** distinct real ids. Drop nullish ids and dedupe in one pass, before the
  array reaches the filter.

  **Then the read that SUCCEEDS overflows the response headers.** PostgREST echoes the query string
  back in the `Content-Location` **response** header, so the URL is paid for twice — once going out,
  once coming back inside a header block Node caps at 16,384 bytes
  (`require("http").maxHeaderSize`). Past that, `fetch` rejects with `TypeError: fetch failed` and
  `UND_ERR_HEADERS_OVERFLOW` on its `cause`. **That reads as a network fault**, which is the whole
  trap: the server did the work and answered correctly, the message names neither the filter nor its
  length, and the obvious next move is to retry the same query or blame the Atlantic hop.

  **The cliff sits LOWER than the URL length suggests, because the echo is longer than what you
  sent.** PostgREST percent-encodes on the way back, so `Content-Location` runs a few percent over
  the request URL — measured on this route, a 1,994-character URL echoed at 2,052 and a
  14,759-character URL at 15,507. Binary-searched against production the same day, on the page's own
  `select`: **395 ids succeed and 396 throw**, so the break arrives at a request URL of roughly
  **14.8KB**, about 1.6KB below the header cap, with the rest of the response headers making up the
  difference. "My URL is under 16KB" is therefore not a safety argument.

  **Expect them in that order, and do not stop at the first.** With the null still in the array
  Postgres rejects the request, and a 400 carries no long `Content-Location` — measured, the header
  is absent entirely — so the overflow stays invisible until the null is fixed. Replaying the exact
  production shape proves it: `new Set()` over the live column gives **411** entries, 410 real ids
  plus one null, and one unchunked `.in()` over all 411 returns the `22P02`, never the overflow.
  Repairing the first failure is what exposes the second, so a session that fixes the null and ships
  has shipped a page that still cannot load.

  **~50 answers all three modes at once**, which is why a single chunk size is the whole fix: 50
  uuids build a filter of about 1.9KB, comfortably inside every cap. `IN_CHUNK_SIZE` in
  `src/lib/customer-pharmacy-mapping/readiness.ts` stood at **500** — a number that looks
  conservative beside the 409-id incident above and is over the cliff on its own — which PR #3627
  drops to 50. That PR also pins both loud halves in
  `tests/customer-pharmacy-mapping-readiness.test.ts`: no nullish id survives into a filter, and the
  longest filter the chunker emits stays far under 16KB.
- **Two more PostgREST filters that answer WRONG with no error** (relocated from `MEMORY.md`
  2026-08-28 together with their index line). **A `neq` against a jsonb key that is ABSENT matches
  ZERO rows** — `NULL <> 'true'` is NULL, not true — so an "exclude the flagged rows" filter
  silently drops every row that never carried the flag. Measured live on production 2026-08-23: the
  bare form returned **0 of 390** where the truth was **19 of 390**. Write the OR-form
  (`.or("<path>.is.null,<path>.neq.<value>")`) and prove it with a `Prefer: count=exact` call whose
  counts add up to the table total. And **an unbounded `.select()` stops at 1000 rows** — no error,
  no marker, the array simply ends, so "these are all the rows" is indistinguishable from "these are
  the first 1000". `scripts/recruitment-reread-never-read-cvs.ts` decided who counted as
  already-read from one such select over a table holding **912 rows, 88 from the cap** — and that
  script adds a row per candidate it reads, so it was walking itself into the cliff. Run
  `select count(*)` before trusting any unbounded select, then page with an explicit `.order()` plus
  `.range()`; without the order the page boundaries are undefined and a row can come back twice or
  never. `postgrest-neq-on-an-absent-jsonb-key-matches-nothing` ·
  `postgrest-unbounded-select-silently-stops-at-1000-rows`
- **`n_live_tup` is STALE in this production project — it reports LIVE tables as empty** (relocated
  from `MEMORY.md` 2026-08-28 together with its index line). Same family as the `list_migrations`
  rule above: query reality, never a ledger or a statistic. Measured 2026-08-13, with
  `pg_stat_database.stats_reset` NULL, so these are simply stale planner stats rather than a reset:
  `sales_records` read **0** against a real **11,267**, `field_workforce_compliance_days` **0**
  against **4,030**, `email_templates` **0** against **22**, `salary_records` 105 against **796**,
  `attendance_raw_punches` 292 against **4,039**. An audit trusting it would have declared
  `sales_records` and the whole Field Workforce Compliance module dead; both are live. The write
  counters (`n_tup_ins/upd/del`) are equally untrustworthy — they cover only activity since the last
  stats reset, and a PG major-version upgrade wipes them. Sweep all 309 tables with a real count in
  seconds via `query_to_xml(format('select count(*) as cnt from public.%I', table_name), …)`.
  `n-live-tup-is-stale-use-real-count`
- **A Supabase client request that times out at 15s STILL COMMITS.** `getSupabaseAdmin()` aborts after
  15s (`src/lib/supabase/server.ts`; raise it with `getSupabaseAdmin({ requestTimeoutMs })`), and the
  JS client throws "Supabase request timed out" — but Postgres keeps running and commits the
  statement. Every later step of a multi-call orchestration (rollup refresh, audit write) is skipped,
  so the result is a **silent half-applied state with no audit row**, not a clean failure. Hit in
  production 2026-08-09: Territory Sync re-stamped ~14k `source_of_sales_import_rows` (committed),
  the client timed out, and 55 batches' rollups were never refreshed — rows on the new geography, the
  drilldown on the old. Do a heavy multi-step mutation in ONE `plpgsql` function so a client abort
  rolls it all back. Three further DB-performance hooks sit in `MEMORY-ARCHIVE.md`, including the
  one this depends on: every DB round trip from here crosses the Atlantic.
  `supabase-client-15s-timeout-commits-anyway-half-applies`

- **A missing TABLE answers `PGRST205`, NOT `42P01`.** `42P01` is Postgres's own `undefined_table`,
  it is what a direct `psql` connection returns, and it is therefore what the guard gets written as
  and what looks right in review. PostgREST never sends it: a read against a table it cannot find is
  answered **out of its schema cache**, as `PGRST205 "Could not find the table 'public.<name>' in the
  schema cache"`, with no Postgres error code on the object at all. So `code === "42P01"` fires
  never, and the code reads as though it survives a window it does not survive.

  Measured 2026-08-30 while adding `ats_candidate_manager_folders` (PR #2762) against a database that
  did not yet have the table: the optional read threw, and a manager's **entire My Candidates page**
  rendered the portal error boundary. That page is not a folders page — one new table that had not
  landed yet took the whole screen down.

  The window is the normal case here, not an edge: **a Railway deploy applies no migrations**, so a
  merge to `main` serves the new code within minutes while the migration is still waiting to be run
  by hand. Every page reading a new table runs against a database without it for that whole gap.

  Treat "that table is not there" as a **set** rather than a code —
  `const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"])` behind one `isMissingTable(error)`
  helper, so a read path and a delete path cannot drift apart on it — and degrade to the empty answer
  rather than throwing: an empty shelf is survivable, a dead screen is not. Pin it in a registered
  test. Reaching the real failure needs a database that is missing a table, which no unit test can
  arrange, so source-pin the constant **and** assert that no bare `code === "42P01"` comparison has
  come back; `tests/manager-folder-shelf.test.ts` is the worked example.

  The sibling trap is sharper because it fails *silently* rather than 500ing: a missing **function**
  is `PGRST202`, and a detector matching on the words *schema cache* cannot tell it from a missing
  table — see `pgrst202-missing-function-reads-as-missing-schema`.
  `a-missing-table-answers-pgrst205-not-42p01`

**Database, grants and RLS** (relocated from `MEMORY.md`, 2026-08-28 — these are platform
mechanics, not Phoenix business rules, so under §2.2's cap they were spending index bytes for reach
this file already gives them)

- **A write REVOKE does NOT make a table read-only.** An `ON DELETE CASCADE` and a `SECURITY
  DEFINER` function both execute with the **table owner's** rights, not the caller's, so both ignore
  it. Both were live back doors around the `sales_records` freeze — 11,267 H1 rows, the only record
  of what H1 2026 was actually paid on: deleting an import batch cascaded through the front door,
  and `phx_reassign_replacement_ownership` could rewrite 880 rows / EGP 6,436,342.01. Measured on
  staging, not assumed — the identical update was `permission denied` directly and `SUCCEEDED,
  rows=1` through a definer function. **`has_table_privilege` reports the revoke faithfully and
  tells you nothing about either bypass**, so a grant listing cannot answer this. Run both sweeps
  before trusting any freeze: FK actions (`con.confdeltype in ('c','n','d')`) pointing into the
  protected table, and `pg_proc.prosecdef` functions whose body writes it. Fixed on prod 2026-08-14
  — `ON DELETE RESTRICT` plus the definer function no longer writing it; **do not redo or undo.**
  `a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function`
- **An append-only table needs a STATEMENT-level `BEFORE TRUNCATE` trigger.** Two independent
  reasons, and fixing one does not fix the other: `TRUNCATE` fires **no ROW triggers**, so a
  `FOR EACH ROW` guard never runs; and revoking `TRUNCATE` from `service_role` does nothing to the
  table **OWNER**, which is what migrations run as. Supabase's default ACL also grants `service_role`
  **ALL** on every new `public` table, so a bare `grant select, insert` restricts nothing — revoke
  `update, delete, truncate` explicitly, and from the **named** roles, never from `PUBLIC`. Whenever
  a table is called append-only, immutable, or an audit log, **prove all three verbs are refused
  against a real database**: neither defect is visible from source review, and neither would have
  failed a test written in advance. `append-only-tables-need-a-truncate-trigger`
- **RLS on with no `authenticated` grant is the NORM here — ~4 in 5 public tables — not a defect
  class to sweep.** The posture is `service_role` only, stated outright in the default-privileges
  migration. **The exact pair drifts and the hook carries it dated for that reason:** 222 of 308
  public tables when first measured 2026-07, **258 of 326 on 2026-09-04**, when every one of the
  326 had RLS enabled. The proportion is what is durable — the schema grew by 18 tables and the
  posture did not change, so a count read from an older doc under-reports by design, never
  because a grant went missing. Re-measure with `has_table_privilege('authenticated', c.oid,
  'SELECT')` over `pg_class` before quoting either number. The `expense_claims` 42501 incident
  makes "policy exists but no grant" look like a bug to hunt; that one was real for exactly one
  reason — `listExpenseClaims` reads with the **user's own session**.
  `getSupabaseRlsClientIfAvailable()` has exactly **three** importers (outstation claims-read,
  outstation expenses, payroll) and there is **no browser Supabase client anywhere in the repo**,
  so if the table is not read by one of those three the missing grant is correct, and granting is
  a pure widening that exposes real HR rows to every logged-in JWT to satisfy nothing.
  Two decoys: inert `TO authenticated` policies that never had a grant behind them, and executable
  `SECURITY INVOKER` functions with zero callers.
  `rls-policy-without-an-authenticated-grant-is-usually-correct`
- **ONE `auth.users` row with `banned_until = 'infinity'` 500s the ENTIRE GoTrue admin API.** GoTrue
  scans it into a Go `time.Time`, which cannot hold a non-finite `timestamptz`, so any page whose
  result set includes that row returns `500 "Database error finding users"` in ~90ms — it reads like
  a code error, not a timeout. **The failure is page-shaped, so a small `per_page` probe passes and
  it looks transient. It is deterministic.** While it existed, Studio's Auth users list, the orphan
  check, and every account create/repair needing stale-link recovery hard-failed. Retire an auth
  account with the app's own finite `876000h`, **never `'infinity'`**; the app never writes that
  value, so finding one always means a direct DB/Studio write. One query finds it:
  `select email, banned_until from auth.users where not isfinite(banned_until)`. Repaired on prod
  2026-08-19. `banned-until-infinity-breaks-the-whole-auth-admin-api`

**Probing, attributing and reporting production**

- **A 200 from a health endpoint can be blind to the thing that is broken.** OpenAI's `/v1/models`
  returns 200 for a key with no BALANCE, so it certifies an account that cannot complete a single
  request — probe an actual completion instead. No AI failure is logged here, so the product
  degrades silently to the rules path. The BILL cannot be read from the API at all: costs 403s and
  usage returns 200-but-EMPTY, so reconstruct spend by counting `ats_candidate_cv_extractions`.
  (That memory file's NAME is stale — the key WORKS.)
  `openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules` ·
  `openai-spend-cannot-be-read-from-the-api-reconstruct-it`
- **`app_error_events` returning 0 rows means QUIET, not broken.** It is fed by real users' browsers
  and arrives in BURSTS (7 rows in 46s), so an empty table is an ordinary state and not evidence of
  a dead route. Prove the route with **405 against a 404 control**, and **never POST a synthetic
  error to production** to check that it works.
  `app-error-events-is-user-triggered-zero-is-not-broken`
- **The Error Monitor HIDES rows whose `environment` is NULL**, so the screen reads clean while the
  table holds the incident. And a `create table zz_backup_… as select` copies rows but never the
  source table's RLS or its policies — so **measure the new table's ACL; never assume it either
  way.** Six such tables did publish 529 rows to `anon` on 2026-08-09, which is where the flat
  "they are anon-readable" reading came from; but re-measured **2026-08-28** this project's
  defaults no longer grant `anon`/`authenticated` at all, and all **8** surviving `zz_backup_*`
  tables in production carry an owner+`service_role`-only ACL with **0** granting `anon` and **0**
  granting `authenticated`. Both stale readings cost something: "still exposed" is a false alarm,
  "safe by default" is a leak. So measure — `select relacl, relrowsecurity from pg_class` on the
  table you just created, then `get_advisors(type: "security")` after any bulk repair.
  `error-monitor-hides-null-environment-rows` · `ad-hoc-backup-tables-are-anon-readable`
- **`updated_by_hr_id` LIES about who wrote a row.** Never attribute a production write from it.
  `how-to-attribute-a-production-write`
- **HR ids are MIXED CASE in the database, so a plain `.eq` silently under-returns.**
  `activity_events.hr_id` is mixed case, the direct-order tables carry BOTH cases, and `access.hrId`
  is lowercase — one `.eq` hid **28% of reps' own orders**, which reads as a real business finding
  rather than a query bug. `activity-events-hr-id-is-mixed-case-not-lowercase` ·
  `direct-order-hr-id-columns-are-mixed-case-and-access-hrid-is-lowercase`
  **And the loss is not always partial — on `au.occupancy_history.occupant_canonical_hr_id` it is
  total.** That column is entirely lowercase while `employees.hr_id` is not, so the two never meet.
  Measured on production 2026-08-29: **120** occupancy rows, **0** carrying an uppercase character,
  against **178 of 179** employee hr_ids that do — `join employees on hr_id = occupant_canonical_hr_id`
  returns **0 rows**, and `on lower(hr_id) = occupant_canonical_hr_id` returns all **120**. A partial
  loss at least looks odd; a total one does not look like a join failure at all, because an occupancy
  row that matches nobody reads as **a vacant seat** — a plausible org-structure fact that nobody
  re-checks, on the very model AGENTS §4 calls the source of truth for vacancy data. Lower BOTH sides
  of any hr_id comparison. **The occupancy half has no memory file of its own** — the two slugs above
  cover the mixed-case rule, and this account is the record for the total-loss case. #2617 also cited
  `a-mock-name-generator-reproduces-real-employee-names` here, for the same wrong reason as the
  `execute_sql` trap above; do not re-add it.
- **The Sato logo's wordmark is WHITE, so "SATO" vanishes on white paper.** Reverse it onto a navy
  band, or recolour the near-white pixels, before any export or print.
  `sato-logo-wordmark-is-white-invisible-on-paper`
- **`railway logs --http` without `--since` returns only a SHORT recent window (about 12 minutes,
  as measured), whatever `--lines` says.** A filtered count taken that way reads as *zero calls*,
  or as a handful, while traffic is flowing — and a small, plausible number reads as a finding,
  not as a truncated window. Measured on production 2026-09-15 at about 22:45 Cairo with Railway
  CLI 5.30.3, on deployment `062cd765-8968-4347-b5a8-74a1b7a98cd7` of `phoenix-people-workforce` in
  `production`: `railway logs <deploymentId> -s phoenix-people-workforce -e production --http
  --filter "@method:POST" --lines 3000 --json` returned **17** lines, spanning only 22:33 to 22:45
  Cairo. The same command with `--since 2026-09-15T14:30:00Z` (17:30 Cairo) returned **919**, from
  17:38 to 22:50 Cairo. With `--filter "@path:/api/webhooks/whatsapp"`, the WhatsApp webhook read
  **3** calls without `--since` and **126** with it — 17:49 to 22:40 Cairo, every one HTTP 200.
  Nothing warns you: `railway logs --help` describes `--lines` only as a number of lines to fetch
  and names no default window at all, so about 12 minutes is a measurement, not a documented
  limit — never budget against it. Pass `--since` every time: it takes an ISO timestamp or ONE
  relative unit (`30s`, `5m`, `2h`, `1d`, `1w`); a compound `2h30m` is refused, so pass a timestamp
  for anything else. And HTTP logs exist only for the CURRENT deployment: a REMOVED deployment
  returns nothing at all, which again reads exactly like no traffic.
  **No memory file holds this trap, and this account is the record.**
- **Judge a WhatsApp SILENCE by DELIVERY LAG, never by quiet alone.** On 2026-09-15 no inbound
  message arrived on either company line from 07:49 to 11:52 Cairo — about four hours, longer than
  the prior week's longest daytime gap of 3.3 hours — and it was read as a possible outage. It was
  not one. What settles it is Meta's retry: a webhook delivery that fails is re-sent, with
  decreasing frequency, for up to **7 days**, so a real outage leaves a signature once delivery
  resumes — inbound rows recorded LATE, with `whatsapp_inbox_messages.received_at` (when Phoenix
  wrote the row) far behind `sent_at` (Meta's own message time). That day **121** live inbound
  rows arrived after the gap, **none** with `received_at - sent_at` over five minutes, and the
  hourly median lag ran **1.9 to 2.9 seconds**; Meta's configuration read healthy throughout —
  numbers connected, webhook subscription active, callback pointing at Phoenix. The test: filter
  `direction = 'inbound'`, exclude the rows `scripts/whatsapp-inbox-backfill.sql` wrote
  (`payload ? 'backfill'`) and any row with `historical` set, then look for late rows. **Zero late
  rows plus a normal lag means the silence was simply no traffic.** The `historical` exclusion
  comes from the code, not from that day's rows: a coexistence history replay arrives through the
  live webhook, in both directions, carrying each message's ORIGINAL `sent_at`
  (`src/lib/whatsapp-inbox/webhook-parse.ts`), so an inbound one reads as late by construction and
  fakes the outage signature. The table's own trigger draws the same line (`v_is_live_inbound`):
  `direction = 'inbound' and not historical`. The blind spot: a delivery Phoenix answered with 200
  but failed to record leaves no late row either, so pair the test with the error monitor
  (`app_error_events`) and the first and last message time per line (`phone_number_id`). Read-only
  Meta checks already exist in `src/lib/recruitment/inbound/whatsapp-health.ts` —
  `probeAllWhatsAppNumbers` and `fetchWebhookRouting`.
  **No memory file holds this trap, and this account is the record.**

**Validation**

- **A repo-wide pattern sweep must grep the TESTS for the old string too — a pinning test can pin
  the ANTI-pattern.** `tests/contract-renewal-hardening.test.ts` asserted the exact source line
  `if (!secret) return !isProductionRuntime();` across FOUR routes, so #2479 — whose entire purpose
  was deleting that line from 18 routes — turned the required `validate` job red on its own head.
  Two traps compound. First, the test enforces the very hole being closed, so "the suite went red"
  reads as "your fix is wrong" rather than "the pin is stale." Second, `runTest` **rethrows**
  (`tests/run-tests.ts:991-1002`), so a `for` loop over N routes reports only the FIRST: CI printed
  `birthdaysRoute` and stopped, hiding three identical failures **and every test after it**, so a
  green run was never demonstrated for anything downstream. Before any sweep, run
  `git grep -l '<the exact old line>' -- tests`, and fix the pin in the same commit.
- **A test name appended beside an existing one in `tests/run-tests.ts` becomes an ARGUMENT, not a
  registration** — `runTest(name, fn)` takes exactly two, so the third silently never runs; #2357
  escaped only because the surplus argument was also a `TS2554`. One `await runTest(name, fn)` per
  test (`docs/testing.md` step 5). Check by AST, not a local `tsc`: 883 `runTest` calls, all 2-arg,
  the new fn a second argument exactly once — a comma count cannot work, the names are long prose.

  **A MERGE CONFLICT is now the commonest route into that shape, and it arrives pre-built.** Every
  new-test PR appends at the same single anchor in `run-tests.ts`, so two of them in flight always
  conflict there — and because the anchor sits mid-call, git renders the conflict INSIDE one
  `await runTest(` invocation, with each side offering a name/fn pair:

  ```
  await runTest(
  <<<<<<< HEAD
    "employee RLS policy lock (...)",
    runEmployeeRlsPolicyLockTests,
  =======
    "a failed SoS aggregate reaches the screen (...)",
    runSosDashboardIncompleteReadIsVisibleTests,
  >>>>>>> origin/main
  );
  ```

  Taking both sides — the obvious resolution, and what "keep both" tooling produces — yields ONE
  call with four arguments. It compiles, CI is green, and the OTHER PR’s test is silently retired:
  the damage lands on someone else’s change, so nobody who reviews either PR sees it. The #2357
  `TS2554` rescue above does NOT fire here, because `runTest` is declared
  `(name: string, execute: () => void | Promise<void>)` and the surplus pair is still string+fn.

  Resolve as TWO separate `await runTest(...)` calls, main’s first. Verify structurally, never by
  eye — 2026-09-06, resolving #3388 against #3387: all **1,341** `runTest` calls parsed to exactly
  2 arguments, and each function had exactly 1 import and 1 registration. Then confirm the other
  side actually RUNS by calling its exported function directly; a green suite cannot tell you,
  since the retired test simply is not in the count.
- **RAM-saturated? WAIT — do not skip validation for it.** `dont-skip-validation-for-ram-wait-instead`
- **Source-pinning tests slice a fixed BYTE window and false-FAIL** when the file shifts.
  `source-pinning-tests-slice-a-fixed-byte-window`
- **A heredoc eats backslashes** and yields a test that only ever passes.
  `heredoc-eats-backslashes-and-makes-a-test-that-only-passes`
- **`parseDiagnostics` is SYNTAX-ONLY — it cannot see a typecheck error.**
  `parse-diagnostics-cannot-see-a-typecheck-error`
- **`setState` inside `useEffect` is a lint ERROR here.** `set-state-in-effect-is-a-lint-error-here`
- **A green TEST run carries NO type signal.** `pnpm run test` strips types and never typechecks, so
  a passing suite says nothing about type errors — only the PR's `typecheck` job answers.
  `a-green-test-run-carries-no-type-signal-at-all`
- **A test can NEVER hand a function a `process.env` literal — take the VALUE, not the bag.** Next
  augments `NodeJS.ProcessEnv` with a required `NODE_ENV` (`node_modules/next/types/global.d.ts:21`),
  so nothing in this repo causes it and grepping `src/` for the reason finds nothing. Both spellings
  fail, and each error only surfaces once you have fixed the other: `env: NodeJS.ProcessEnv =
  process.env` gives **TS2345** at every call site passing a literal, and `env: { MY_VAR?: string } =
  process.env` gives **TS2559** at the default (an all-optional weak type shares no property with
  `ProcessEnv`, whose only named member is `NODE_ENV`). An existing `env: NodeJS.ProcessEnv`
  parameter that compiles today only does so because nothing passes it a literal — that precedent
  does not transfer. Default the individual value at the signature instead
  (`configuredPath: string = process.env.MY_VAR ?? ""` — `resolveChromiumPath`, #2432), or take a
  `Record<string, string | undefined>` and use bracket access, as `src/lib/env.ts:6` does. Each
  attempt otherwise costs a full red CI round, and the local suite cannot see it at all.
  `a-test-can-never-hand-a-function-a-process-env-literal`
- **An exhaustive `Record` does NOT gate the build.** `next.config` sets
  `typescript: { ignoreBuildErrors: true }`, so a `Record<SomeUnion, X>` missing a key compiles,
  builds and DEPLOYS; only the PR's `typecheck` job sees it, and `strict: false` lets a PR merge on
  a check taken before the union grew. On 2026-08-24 #2395 added a ninth role family 4 minutes after
  #2396 added a `Record` over every family — neither CI run saw the other, and production served
  `bandByFamily["sales"] === undefined` -> **NaN sort keys**, which do not throw: 63 real candidates
  scattered at random through the screening queue and every band counter read 0. `main` was red 15
  minutes. Back any such `Record` with a RUNTIME assertion in a registered test — iterate the union,
  assert the looked-up value is real (`Number.isFinite`), and assert no key outside the union
  appeared. `an-exhaustive-record-does-not-gate-the-build-here`
- **A narrowed SELECT disarms every gate downstream of it.** A gate cannot fire on a column the
  query no longer fetches, so the branch still *reads* correct while the check is dead. Test the
  SELECT, not the branch. `a-narrowed-select-disarms-every-gate-downstream-of-it`
- **An OPTIONAL field written UNCONDITIONALLY is a silent erase.** With `.update()` OMIT the column
  entirely; with `.upsert()` carry a before-image. Both real occurrences are fixed (#2326, #2329) —
  the PATTERN is what regenerates, not those two call sites.
  `optional-field-written-unconditionally-is-a-silent-erase`
- **A feature can ship green, deploy cleanly, and be reachable by NOBODY - and zero usage is what
  both look like.** #2237's Capture Evidence was rejected for every `doctor` customer (**59 of the
  65 customers it existed for**, and 115 of the 126 pending links behind them) because one
  hand-written copy of the type list omitted `doctor`, while the union, the DB constraint and the
  classifier all allowed it - the module minted rows it then refused to accept back. Nothing
  errored, CI was green, the deploy was healthy, and the ONLY symptom was zero evidence files
  captured since it went live, which reads exactly like slow adoption. **When a just-shipped
  feature shows zero usage, exercise the path end to end before concluding it is adoption** - a
  silent 100%-rejection rate and nobody-tried-it are indistinguishable from outside. Fixed by
  #2249, which also deleted the copy: check a shared list, never a local duplicate of one.
  `capture-evidence-was-dead-on-arrival-for-doctor-customers`
- **A merged fix on a path nobody has exercised is untested, not proven.** #2241 gave the three
  payroll batch mutations audit rows; verified 2026-08-28, production `audit_logs` still holds
  exactly **15 `payroll_batch` rows, newest 2026-07-13, 0 since the fix** - no batch has been
  imported, replaced or deleted since, so the new path has never written anything. The row count
  cannot tell "works" from "broken" until someone touches a batch.
  `payroll-mutations-were-unaudited-until-2026-08-21`

- **`cn()` SILENTLY DROPPED every `text-phx-*` size, and nothing in this repo can see it.**
  tailwind-merge never sees Tailwind v4's CSS-first theme, so it classifies a custom-named font size
  as a COLOUR — and any real colour class in the same `cn()` call then wins and removes it. The
  sidebar rendered at **16px instead of 13px** and badges at **16px/900 instead of 10px**, across
  roughly **4,800** call sites. It is invisible in source review, in lint, in typecheck and in a diff
  audit; only `getComputedStyle` in a real browser sees it. The literal `text-[13px]` form was always
  SAFE — **the rename to a named size is what created the bug**, so a well-meant "tidy up the class
  names" pass is precisely the change that reintroduces it.
  `tailwind-merge-strips-custom-named-font-sizes`
- **`@/lib/utils` resolves to the ROOT `lib/utils.ts`, NOT `src/lib/utils.ts`.** `tsconfig.json` maps
  `"@/*": ["./*", "./src/*"]` — the repo root is tried FIRST — and both files really exist (measured
  2026-08-29: `lib/utils.ts` 2,993 bytes, `src/lib/utils.ts` 1,022 bytes). So editing
  `src/lib/<x>.ts` and reloading changes NOTHING, with no error anywhere to explain why; the symptom
  is a correct-looking edit that simply has no effect, which reads as a caching problem rather than a
  resolution one. Before touching any `src/lib/<x>.ts` whose importers say `@/lib/<x>`, run
  `ls <x>.ts` at the repo root first. `at-slash-lib-shadows-src-lib-via-tsconfig-paths`

**Memory and this index**

- **Sweep memories by CLAIM, never by filename or topic.** Every staleness sweep here has been scoped
  by topic, and that is exactly why they keep missing what matters: the 2026-08-19 sweep correctly
  banner-stamped the files that are *about* deployment, while "ships on the 2-hourly prod deploy cron,
  NOT on merge" and a dead Supabase ref survived untouched inside memories about an excuse module, a
  CRM filter and a sales import. A topic sweep fixes the files a session reads when it is already
  being careful, and misses the ones it reads when it is not. Grep the assertion itself across every
  file, then triage each hit: a present-tense assertion gets corrected in place (the dangerous
  bucket), an outstanding action pointing at dead infrastructure gets retired, and a dated record of
  what was true then gets left alone — **never rewrite a dated record.**
  `staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones`
- 🔴 **`scripts/memory-index-reachability.mjs` run from a WORKTREE audits the PRIMARY checkout's
  `AGENTS.md`, not the one you just edited.** It resolves the repository with
  `git rev-parse --path-format=absolute --git-common-dir` and takes that directory's parent — which
  in a worktree is the primary. That is right for the memory directory (auto-memory is repo-derived
  and shared by every worktree) and wrong for `AGENTS.md`, where each worktree holds its own copy.
  Measured 2026-09-21 from `_wt-memory-config-audit`: a probe slug appended to that worktree's
  `AGENTS.md` produced **0 occurrences** in the classifier's entire output, whose header read
  `repo: F:\Phoenix Workforce\phoenix-workforce`. It fails in the reassuring direction both ways — a
  slug you deleted still reads `ok` (trim it, merge, strand the memory), and a slug you added reads
  `STRANDED` (add an index line you do not need, against an index with 18 bytes of budget left).
  §2.2's instruction to prove the condition *in the checkout you trim from* therefore cannot be
  carried out from a worktree by the tool it names: run it from the primary once the change is
  there, or check by hand with `git grep -c` over the `AGENTS.md` you actually edited and over
  `MEMORY.md` in the shared memory directory.
  `memory-reachability-classifier-reads-the-primarys-agents-md`

**Parallel sessions** (relocated from `MEMORY.md`, 2026-08-27 — these are agent-operating traps, not
Phoenix business rules, and the index line at its cliff is the wrong place for them)

- **A parallel session can collide with NO git trace at all.** Six instances now. The first few were
  two sessions independently chasing one incident, and the prescribed checks caught those: `gh pr
  list`, `git log origin/main --oneline -20`, `git worktree list`. **On 2026-08-27 all three returned
  clean while another session was actively editing the same file** — it never opened a PR, never
  committed, and worked **in the primary checkout** rather than a worktree. The only signal was the
  SessionStart hook's working-tree line (`0 staged, 1 modified, 0 untracked / Changed: M AGENTS.md`).
  **Read that line as a collision signal, not as noise**: a file modified in the shared primary that
  you did not modify is someone else's live work. **And a stale lock proves the named PID is dead,
  not that the folder is unattended** — a live session appeared in none of the startup signals that
  same day; what surfaced it was a `.claude/worktrees/` branch that had not existed minutes earlier,
  a sibling worktree's HEAD advancing across checks, and untracked `tests/_tmp-*` probes appearing in
  the primary. Re-run `git for-each-ref refs/heads` and `git worktree list` at intervals through a
  long session. Never delete another session's `_tmp-*` probes or its `.claude/worktrees/` tree.
  **Resolve a collision by MERGING, never by discarding** their working copy. And note the fifth
  instance was self-inflicted: **if you report a finding to another session, it is theirs — do not
  also fix it**; reviewing and patching the same defect in parallel is a manufactured conflict, and a
  conflicted PR runs no CI at all here. `feedback-parallel-session-pr-collision`
- **ONE approval can reach SEVERAL sessions — N sessions holding the same "yes" is N executions.**
  2026-08-27: the owner typed `merge 2480` and it landed in **3** live sessions (`CONTTINUE` reached
  5); one of them merged and shipped to production while this session still read
  `validate: IN_PROGRESS`. He then said "i didnt merge it", which was true from the window he was
  sitting in. A second `gh pr merge` is harmless, but a bulk email, a destructive SQL statement or a
  production migration run three times is not. **Before executing a protected action on a terse
  approval** ("merge 2480", "yes", "go", "do it"), check how many sessions are live, say so in the
  reply, and re-verify the target's live state immediately before acting — not merely before
  reporting. **If it is already done, report who did it and never retry.** **`mergedBy` naming the
  owner is NOT evidence of a human click** — every session authenticates as his account, so the API
  cannot tell a UI merge from a session's command; grep the transcripts, which carry per-call
  timestamps and the verbatim command. A peer session's own summary is an inference and has been
  wrong. `one-approval-can-reach-more-than-one-session`

**Worktrees** (see also §5)

- **Another SESSION can remove a worktree under you.** `another-session-can-remove-a-worktree-under-you`
- **A gitignored `_wt-*/` scratch folder makes a worktree look clean.**
  `gitignored-wt-scratch-makes-a-worktree-look-clean`
- **The pre-push gate is GONE — a bare worktree pushes fine** (verified 2026-08-24: `.git/hooks`
  holds only `pre-push.bak-20260730`). What a bare worktree cannot do is RUN a suite; junction
  `node_modules` from the primary for that, invoke `node` directly, and never `pnpm` inside it.
  `bare-worktree-cannot-push-pre-push-gate-needs-node-modules`
- **"Permission denied" on `git worktree remove` still DEREGISTERS the worktree.**
  `worktree-remove-permission-denied-still-deregisters`
- **And a DEREGISTERED folder is worse than a husk: a shell still sitting in it resolves git
  against the PRIMARY checkout.** Measured 2026-09-03. A peer session ran
  `node scripts/repo-doctor.mjs --fix --force` from the primary and deregistered-then-emptied a
  `.claude/worktrees/` folder that a live session was still working in. Nothing announced it: the
  session kept running commands, and because the folder no longer held a `.git` file, git walked
  UP the tree and found the primary's. `git rev-parse --absolute-git-dir` returned
  `F:/Phoenix Workforce/phoenix-workforce/.git` and `git log -1` reported `main`'s head, not the
  session's own branch — so any mutating command would have landed on production's branch, with
  no error and no prompt. The session noticed only because it re-read the worktree list after a
  peer message, and stopped issuing mutating git commands from there.

  Two consequences worth knowing before you trust anything read from such a folder:

  1. **`cd` cannot escape it.** The harness resets the shell cwd back inside the pinned folder
     after every command (the same mechanism §2.1 records as "a session can NEVER clear its own
     husk"). Address the real repository explicitly — `git -C <path>` — rather than trying to
     move out of the husk first.
  2. **Path-filtered reads LIE there.** `git log <ref> -- <path>` exited 0 with no output and
     `git ls-tree <ref> --name-only | grep <path>` matched nothing, for a file `git show` then
     read 127 lines from. A blank from either form is indistinguishable from "clean", which is
     exactly how an empty read certifies a check nobody performed. Verify with a POSITIVE
     CONTROL: print the bytes or lines actually read and the count of the thing you expect to
     find, so a zero-hit result is only believable alongside a non-zero read.
  3. 🔴 **IT MAKES THE BRANCH-DELETION GATE PASS HAVING LOOKED AT NOTHING — the one gate whose whole
     job is to be the last word before work is destroyed.** Measured 2026-10-03 on PR #5199's
     `_wt-crm-mirror-refresh`, deregistered while the session still held the folder.
     `new-session.mjs --remove` prints three gates, and the third — *every file the branch changed is
     byte-identical on `origin/main`* — is the only one that also holds for a roll-up member, which
     lands CLOSED rather than merged. Run from inside the deregistered folder,
     `git log origin/main..HEAD` and `git rev-parse HEAD:<file>` both answer for the PRIMARY, on
     `main`: the gate compares `main` with `main`, reports **twelve files, all `same`, 0 differing**,
     and reads as a clean pass. That branch was in fact safe — re-proved afterwards from the primary
     against the archived tip — but **the vacuous pass and the true pass were indistinguishable at the
     time**, and the action it authorises is a deletion. Same family as consequence 2, one step worse:
     there an EMPTY read certifies an unperformed check, here a POSITIVE-looking one does.

     So run a branch gate **from the primary, naming the tip**, never from the worktree:
     `git show --name-only --pretty=format: <tip>` for the file list, then
     `git rev-parse <tip>:<file>` against `git rev-parse origin/main:<file>`. That form survives the
     branch's deletion too, provided the tip was archived first. And before trusting ANY git reading
     taken inside a `_wt-*` or `.claude/worktrees/*` folder, make the folder prove itself:
     `git rev-parse --absolute-git-dir` must end in `.git/worktrees/<that task>` and
     `git branch --show-current` must be that branch. One line, and it is the only thing that
     distinguishes a live worktree from a husk that answers anyway.
     `a-deregistered-worktree-folder-answers-git-from-the-primary`

  🔴 **AND A LIVE SESSION CAN BE SITTING IN ONE RIGHT NOW WITHOUT KNOWING IT.** Measured the same day:
  `.claude/worktrees/funny-lalande-3cfc0c` was reported by repo-doctor as a HUSK — 0 files, no `.git` —
  while the app still listed its session `isRunning: true`, active seconds earlier, and
  `archive_session` refused it as *"still working (a turn in progress)"*. From that folder git answered
  `F:/Phoenix Workforce/phoenix-workforce/.git`, branch `main`, at the primary's stale tip. The husk
  report and the session list disagree because they measure different things: the folder is empty AND
  occupied. **A husk with a running session in it is not a tidy-up, it is a live hazard** — tell that
  session, with the three readings, instead of trying to clear the folder around it.

  The recovery is not to fix the folder — it cannot be fixed from inside. Create a fresh worktree
  addressed at the primary (`git -C <primary> worktree add ...`), work there, and let the husk
  clear once the pinned session exits.
- **`--fix` / `--strip-idle` need exactly ONE live session**, and **`--fix` can NEVER clear a `_wt-*`
  husk** — `fs.rmSync` EPERMs on dangling pnpm junctions. Use `rmdir /s /q`, then re-check the folder:
  an OLD `CreationTime` proves it never went. **Run that `rmdir` from PowerShell, not the Bash
  tool** — `cmd /c rmdir /s /q "$folder"` with an MSYS-mangled backslash path prints the cmd banner
  and does NOTHING, and that stale `CreationTime` is the only thing that reveals it (2026-08-28).
  `repo-doctor-strip-idle-cannot-run-with-sessions-open` ·
  `repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm`
- **repo-doctor's RETIRABLE verdict names the branch a folder HAD at scan time** — a parallel session
  can repoint the tree first, and the report prints a paste-ready `git worktree remove` beside it, so
  `--force` eats the new branch's work. Re-read `status -sb -uall` and `git log origin/main..HEAD` in
  the worktree at the moment of removal, never the report: on 2026-08-23 one listed retirable on merged
  #2362 sat on a NEW branch with 90 uncommitted lines and an unpushed migration, and opened #2364.
- **Every retirement gate in this list can PASS on a worktree that is in active use.** The bullet
  above catches a repointed BRANCH; nothing catches a live PROCESS. On 2026-08-28
  `_wt-reps-plans-line-region` passed all four at 09:07:5x — branch matched on a live re-read,
  `status --porcelain -uall` empty, `gh pr list --state merged` returned #2494, and the
  cumulative-diff patch-id equalled the squash commit's exactly (`ec45aa3b…`) — while a Next build
  was writing `.next/client-development-fallback/*.pack.gz_` into it at **09:08:05**, seconds later.
  A session was mid-diagnosis on that very page (the `unstable_cache` Map entry below, same PR).
  `git worktree remove` then died `Permission denied`, which **still deregistered the tree**: source
  files deleted, `.git` entry gone, a husk left. Two cheap signals see what the gates cannot —
  **the newest mtime under `.next/`** (`Get-ChildItem -Recurse -Force <wt>\.next | Sort-Object
  LastWriteTime -Descending | Select-Object -First 1`), and **HEAD moving between the gate read and
  the removal**. That tree's HEAD went `1325649a` -> `99349cf0` inside one minute, which also
  silently poisoned the rescue ref: `git branch rescue/<name> $(git rev-parse HEAD)` taken at
  removal time captured **`main`'s squash commit, not the tip**. Read the tip at the GATE and reuse
  that SHA, then verify the ref points where you meant. Nothing was lost here only because the
  content was already upstream. **Worktree->branch bindings churn far faster than they look**:
  measured the same morning, **five of the nine** trees standing 30 minutes earlier had been
  repointed — the PRIMARY among them, off detached HEAD onto a branch — two new trees had appeared,
  and the session count reached 11. Treat any scan older than the current command as fiction.
- **A squash-merged branch reads as "on NO origin ref" — that means BACKED UP, not stranded.**
  `delete_branch_on_merge` is ON, so GitHub deletes the branch's own remote ref at merge and pure
  reachability then calls every successfully merged worktree unbacked-up. repo-doctor did exactly
  that until 2026-08-24, printing a STOP that told you to **push** the branch — which is how you get
  a conflicting PR, and a conflicted PR runs no CI at all. It now asks about CONTENT
  (`scripts/repo-doctor-unpushed.mjs`, pinned by `tests/repo-doctor-unpushed-commits.test.ts`):
  the branch's CUMULATIVE diff from its merge base against each upstream commit's patch-id, plus
  `git cherry` for anything cherry-picked or rebased on its own. Both are needed — `git cherry`
  alone marks every commit of a MULTI-commit squash `+` "not upstream", which is what makes the old
  advice look sound right up until it is not. To check an OLD report by hand, compare
  `git diff <mergeBase> <tip> | git patch-id --stable` with the merge commit's; comparing the tip
  commit alone only works when the PR carried exactly one commit. Never push a merged branch to
  "rescue" it; `git branch rescue/<name> <tip>` keeps the tip locally at zero risk.
  `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **Self-removing a worktree MUTES its own session-end guard.**
  `self-removing-a-worktree-mutes-its-own-session-end-guard`
- **`next dev` CANNOT run in a worktree — the junction §5 prescribes is what breaks it.** Turbopack's
  resolver reads the Windows directory junction as a symlink escaping the project root and fatals on
  the first route: `Symlink [project]/node_modules is invalid, it points out of the filesystem root`.
  Reproduced twice on 2026-08-28, with and without `--turbopack` — Next 16.2.11 prints "(Turbopack)"
  either way, so the CLI flag alone gives you no webpack fallback. The primary checkout, same repo and
  same version, is fine: its `node_modules` is a real directory. §5's junction pattern was written and
  tested for `typecheck`/`lint`/`node scripts/…`, none of which go through Turbopack's root
  resolution. **Do not burn more than one retry on it** — verify against the primary checkout's server,
  or prove the change at data level instead. `turbopack-cannot-resolve-a-junctioned-node-modules-here`
- **`gh pr merge` from a worktree exits NON-ZERO after the merge already SUCCEEDED.** `main` is
  checked out in the primary checkout, so `gh`'s local post-merge step — switch to the base branch,
  delete the local branch — cannot run, and the command dies `failed to run git: fatal: 'main' is
  already used by worktree at 'F:/Phoenix Workforce/phoenix-workforce'`. The REMOTE merge has
  already landed by then: `gh` merges via the API first and only afterwards touches the local
  checkout. 2026-09-03, PR #2998 — the command "failed", and the PR was `MERGED` at 04:18:15Z as
  `9f31ac376` with its remote branch already deleted. Every session here works in a `_wt-*` tree
  while the primary holds `main`, so this fires on **every** merge, not as an edge case. The text
  names `main` and says `fatal:`, so it reads as a merge that did not happen — and both tempting
  responses are damage in reply to a no-op: a retry errors on an already-merged PR, which reads like
  a second and worse failure, and checking `main` out here to "unblock" it strands the primary.
  **Treat a non-zero `gh pr merge` in a worktree as UNKNOWN, never as failed**, and settle it
  against the PR before doing anything else:
  `gh pr view <n> --json state,mergedAt,mergeCommit --jq '{state:.state,sha:.mergeCommit.oid}'`.
  `state: MERGED` means done, and the only residue is the local branch (`git branch -D <branch>`).
  Note `gh pr view` has **no `merged` JSON field** — it is `state`; asking for one errors out and
  prints the valid field list, which costs a round trip mid-incident.
  `gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded`

**Next.js runtime**

- **A >2MB `unstable_cache` entry KILLS the dev server** — it throws only in dev, is uncatchable, and is
  muted in prod. Gzip rows; return null over the ceiling.
  `next-2mb-data-cache-throws-only-in-dev-and-kills-the-server`
- **`unstable_cache` SERIALIZES, so a returned `Map` comes back `{}`** — and the page works on exactly
  one render, the one that fills the cache, then throws on every render after it for the whole
  revalidate window. Measured 2026-08-28 on `/admin/reps-plans` (#2494): first load the full board,
  every load after `TypeError: index.get is not a function`, rendered as the admin error boundary — a
  page that reads as a **permission redirect**, not a crash, which is where the first 30 minutes of
  diagnosis went. Cache the ROWS and rebuild the object graph per call. **No unit test can see this**:
  every test calls the pure builder, where a Map is still a Map, and it is only reachable by loading
  the page TWICE. Pin it two ways — assert a JSON round-trip loses `.get`, and source-pin the loader
  as a plain `async function`. `unstable-cache-serializes-a-map-into-an-empty-object`
- **Standalone tracing copies FILES, not pnpm SYMLINKS** (fixed 2026-08-22 with a hoist plus a `*/**`
  glob, now CI-gated), and **a top-level `import sharp` 500s a whole PAGE** when the `.so` is missing.
  Load native modules on demand and assert at BUILD. `next-tracing-copies-files-not-pnpm-symlinks` ·
  `next-standalone-trace-misses-a-native-librarys-so-dependency`

**Browser and dev-auth**

- **A MINIMIZED window makes every browser reading LIE — check `document.visibilityState` FIRST.**
  When Chrome is minimized or occluded the tab reads `hidden`, and Chrome throttles `setTimeout` to
  ~**1 per second** and stops `requestAnimationFrame` **entirely** (measured **0** frames, not slow
  ones) and stops compositing, so `Page.captureScreenshot` times out. **Both** browser surfaces here
  report `hidden` — the claude-in-chrome tab and the Claude Browser pane. On 2026-08-28 that produced
  four false diagnoses on one page in one session: "998ms per mouse move" (the timer throttle — the
  same drag ran in **5 ms** through a `MessageChannel` yield), "the drag freezes the browser"
  (nothing froze; `Runtime.evaluate` answered instantly throughout), "it reproduces on production so
  it predates the branch" (same artifact), and "the page never hydrates" (real reading, wrong cause —
  one screenshot forced a frame and it hydrated). **dnd-kit cannot run at all** when hidden: it
  measures droppables inside rAF, so every drop is a no-op. **Plain `.click()` and `MessageChannel`
  yields still work**, so click-driven UI IS verifiable and drag-driven UI is NOT — a standing reason
  to give any drag a click equivalent. Two companions: `javascript_tool` does **not await a returned
  promise** (stash to `localStorage` and read in a second call — **not** to an attribute of `<html>`,
  which React reverts), and the extension's **isolated world** cannot see the React fiber expandos,
  so every fiber-based hydration probe returns 0 regardless of truth — judge hydration by behaviour.
  `a-minimized-window-makes-every-browser-test-lie`
- **Click by TEXT — blind coordinate clicks once fired a real production collection run.**
  `blind-coordinate-clicks-fired-a-production-collection-run`
- **Dev login is `GET /api/dev-auth?role=<Role>`, and it DOES role-switch the Browser pane.** This
  line said the opposite until 2026-08-29 — "it is header-only and the Browser pane cannot use it" —
  and that sentence is true only of the SEPARATE `x-phoenix-role` / `x-phoenix-hr-id` request-header
  path (`isLocalDevHeaderRequest`, gated on `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`), which the pane
  genuinely cannot set. The cookie route is a different mechanism: `app/api/dev-auth/route.ts` sets an
  httpOnly `phoenix_dev_preview` cookie and 302s to the role's landing page, and
  `accessContextFromDevPreviewToken` is consulted BEFORE the header path — so no proxy is needed. Measured in the pane on 2026-08-29 by navigating to the URL three times:

  | Navigated to | Landed on | `/admin` links | `/employee-portals` links |
  | --- | --- | --- | --- |
  | `?role=Super Admin` | `/admin` | present | — |
  | `?role=Medical Rep` | `/employee-portals` | 0 | 69 |
  | `?role=Super Admin` | `/admin` | 79 | 0 |

  So it is a genuine round-trip switch, not merely a first login. The memory file had carried this
  correction since 2026-08-09 and re-stated it on 2026-08-28; what stayed wrong was its frontmatter
  `description` and both auto-loaded copies — which is the failure mode AGENTS.md 2.2 warns about,
  since the description is what decides whether a memory is recalled at all. It also closes the one
  question that file left explicitly open: a 2026-08-28 attempt left the pane on `/` reading
  "Loading workspace" and was recorded as proving nothing either way. It proves nothing because that
  string is a known false signal — `document.body.textContent` read 166,998 chars of real admin
  content on exactly such a page here. **Role SWEEPS still use the headers**, for the reason stated
  further up this file: each cookie switch replaces the browser's session, so sweeping N roles
  through the cookie clobbers it N times. The slug below is now a misnomer; the file it names leads
  with the correction.
  **CORRECTED 2026-08-30 — it DOES take `hrId`, and `loginId` too.** The paragraph above said the
  cookie route needs neither, and that was measured wrong. `app/api/dev-auth/route.ts` reads both
  from the query string and bakes them into the session token, so
  `?role=National%20Sales%20Manager&hrId=a-12&next=<path>` signs you in as THAT PERSON, not merely as
  that role. It matters because without it there is no way to verify anything scoped to one manager's
  own team in a browser — a role alone lands you on the right page as nobody in particular. Header-only
  is the separate `x-phoenix-*` path, which the pane cannot set.

  **A HIDDEN pane also mixes correct rects with 0×0 ones** inside one measuring sweep, so a layout
  reading taken while it is hidden is part real and part garbage. Re-measure with the pane visible;
  do NOT retract the number — the 125px read was REAL and the repo MODEL of it was wrong (#2353).
  `dev-auth-is-header-only-browser-pane-cannot-use-it`

- **Turbopack 500s with `0xc0000142` when the commit charge is exhausted** — close a session, do not
  debug the code. `turbopack-500s-with-0xc0000142-when-commit-is-full`
- **Verify a 375px mobile layout with NO dev server.** `verify-a-mobile-layout-without-a-dev-server`

**Machine ceiling** (the same exhaustion the two entries above are symptoms of)

- **The ceiling is the Windows COMMIT limit, not RAM — and a freeze leaves NO dump.** Commit is
  RAM + pagefile, so the pagefile is the half that was fixable. It was raised to a fixed 16 GB on
  2026-08-25 (limit ~19.79 GB -> 31.79 GB), then **re-pinned on 2026-08-26 to 32768/65536 MB — a
  RANGE, not a size, so the limit is `RAM + the pagefile as currently ALLOCATED` and it FLOATS**:
  15.79 + 32.00 = **47.79 GB at rest**, climbing toward **~79.79 GB** as Windows grows the file
  under pressure. That growth, not a third reset, is the 53.83 GB limit in the next entry — a
  pagefile grown to ~38 GB. **Read the limit, never quote it from here**: a HIGHER reading is
  ordinary growth, but a reading BELOW 47.79 GB — ~37.4 GB, say — means the setting was reset
  again, which has now happened twice. `Win32_PageFileUsage.AllocatedBaseSize` tells the two apart.
  **A pagefile change does not fix a leak** — Windows was reinstalled 2026-08-26 06:19 and
  the box still froze at 10:57 and 15:15 on the raised limit. A commit-limit hang produces no
  bugcheck and no minidump, so an empty `C:\Windows\Minidump` is the **expected** signature and never
  an all-clear — the tell is `dwm.exe` dying with `0xC00001AD` (`STATUS_COMMITMENT_LIMIT`) minutes
  before the freeze, with `System.OutOfMemoryException` in the Application log. **Never judge a
  process by `VirtualSize`** — it is address-space *reservation*: on this box Edge reserves 3,621 GB
  against 503 MB of real commit. That trap is how an ordinary `node` was read as a 22 GB runaway and
  `repo-doctor.mjs` was wrongly blamed for three freezes on 2026-08-25 — an accusation raised and
  then withdrawn. Judge by commit, and suspect **breadth** (many sessions plus Excel/Edge/Defender)
  over any single process. Symptoms of a saturated commit charge — none of which mean your work was
  wrong: bash `fork: retry: Resource temporarily unavailable` / `0xC000012D`, PowerShell refusing to
  load `System.Management.Automation` with *"The paging file is too small"*, `gh` returning
  *"Resource temporarily unavailable"*, and a heredoc silently failing to create its script so the
  next command dies `MODULE_NOT_FOUND`. Check the shell with `echo alive` before blaming the task.
  `commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb`
- **Two decoys sit on top of that diagnosis.** `nvlddmkm` (the display driver) in the event log is a
  **DECOY** — it is what dies when the desktop compositor is starved, not the cause. And the
  `node.exe` gigabyte figures in **Event 2004** are the one memory number here that IS real, unlike
  `VirtualSize`: do not dismiss them as reservation. **The single largest leak found so far is a
  throwaway ExcelJS probe** — a `tests/_tmp-run-*.mjs` scratch script took commit 22 -> 41 GB in 40
  seconds, reaching 99.7% of a 53.83 GB limit. ExcelJS holds workbook data **off-heap**, so
  `--max-old-space-size` cannot cap it. Delete such probes when done; one sat untracked in the tree
  for days. `commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb`
- **An interrupted session leaves the tree BROKEN ON PURPOSE.** Before acting on a bare "commit it"
  from a resumed or compacted session, `git grep BREAK-` — a deliberate breakage marker means a
  regression test is mid-proof, and the source-pinning test states the intended fix verbatim.
  Committing over it ships the break and destroys the proof.
  `an-interrupted-session-leaves-the-tree-deliberately-broken`


## A docs-only PR used to skip the tests, and no longer does

**The fast path below was removed from `ci.yml` on 2026-10-06. Every pull request now runs the whole
suite, docs-only included, in the `unit` jobs behind `checks`, so a docs-only PR's red is real.**

What a green PR has not run today is the same for docs and code, and it first runs on the push to
`main`, the branch that deploys to production:

- the login smoke test, the canvas check and the standalone assembly, on every PR
- the build — a pull request never builds, whatever it touches (owner, 2026-11-05: "Yes, skip the PR build")

So the check that matters after any merge is still the run on `main`'s NEW head. **A short `validate`
says nothing about tests any more**, because it holds none on any PR: on pull request 50 of
2026-11-03 `validate` took 38s while `unit` took 3m47s. Read `checks`. Do not bring a fast path back:
the file list it relied on was wrong twice, and `tests/ci-gate-parity.test.ts` refuses it.

The rest of this section is the account of why it went.

**Measured 2026-09-01, after three PRs shipped `main` red without a single red PR check.**

`ci.yml` detected a documentation-only change and skipped the expensive STEPS while still reporting
every required check name, so a docs PR cost seconds instead of four minutes. **The fast path was
`pull_request`-only**:

| event | detector answers | what runs |
| --- | --- | --- |
| `pull_request`, docs-only | `docs_only=true (documentation only)` | nothing expensive — `validate` passes in ~10s |
| push to `main` | `docs_only=false (not a pull_request — always run everything)` | the full suite |

Both lines above are quoted from the real job logs of #2868 and its merge commit `9c161d35f`.

So for a docs-only change the test suite's **first ever run was the push to `main`**. A green PR
there was not weak evidence, it was **no evidence**: the tests were never executed. #2862, #2864 and
#2866 each showed `validate pass` in about ten seconds, and `main` was red from #2864 onward because
the relocation dropped `AGENTS.md` below a slug floor pinned in
`tests/memory-index-reachability.test.ts`. Nobody noticed for three merges.

It happened again after that. #5182 was seven `.claude/cloud-context/*.md` files: both required
checks passed in about ten seconds, then `validate` failed on `main` on that merge and the two after
it, and Railway withheld all three deploys. That is what removed the fast path, and `ci.yml`'s header
holds the full account.
## `node --test` on a test file in this repo proves nothing

Measured 2026-09-01. Every suite here is an **exported function** — `tests/memory-index-reachability.test.ts`
is one `export function runMemoryIndexReachabilityTests()` spanning lines 50-266 — and `tests/run-tests.ts`
imports it and passes it to `runTest(name, fn)`. The file itself never calls `test()`.

Node's runner does not treat that as an empty file. It treats the FILE as the test, and a file that imports
cleanly is a file that passed:

```
node --experimental-strip-types --test tests/memory-index-reachability.test.ts
OK testsmemory-index-reachability.test.ts (137ms)
  tests 1 | pass 1 | fail 0
```

That run asserts NOTHING. It was produced twice on this repo while quoting it as verification, and the second
time the file under test had been **deliberately broken** — a load-bearing slug stripped out of `AGENTS.md`,
exactly the condition the suite exists to catch. Still `pass 1`. The failure mode is the dangerous direction:
it never goes red, so it reads as a clean verification rather than as a broken harness.

This mattered most on a **docs-only PR** while CI skipped the tests there (see the docs-only section
above, removed 2026-10-06), because a session reached for a local run precisely when CI would not do one.
The green is just as vacuous on any PR today.

The real invocation imports the module and calls the export:

```
node --experimental-strip-types --input-type=module -e "
  const m = await import('file:///F:/Phoenix%20Workforce/phoenix-workforce/tests/<name>.test.ts');
  await m.run<Name>Tests();
"
```

And per AGENTS.md 2.1, a local green only counts once the same command has been shown to go RED on the
suite's own headline assertion. Breaking it produced the right one:

> every memory the map marks load-bearing must still be named in AGENTS.md

## `TZ=Africa/Cairo date` silently returns UTC

MSYS ships no tzdata. So the one command a session reaches for in order to obey the owner's
standing rule — report every time in Africa/Cairo — is the command that breaks it, by exactly
three hours, with no error and no warning. Recent events read as older than they are, which is
the direction that matters: work done ten minutes ago looks like work done before the session
started, and a freshly written file looks stale enough to ignore.

**The tell is a Cairo reading carrying a `+0000` offset.** Cairo is never UTC+0, in any season.

**The machine clock is ALREADY Cairo (`+0300`).** Plain `date` is correct, and so are Windows
file mtimes. Only the explicit `TZ=` override lies, so the fix is to stop passing it — not to
correct for it, and never to add three hours by hand.

Read it explicitly with node when a timezone must be named:

```
node -e "new Date().toLocaleString('en-GB',{timeZone:'Africa/Cairo'})"
```

**This account was recovered on 2026-09-01 from a duplicate.** The hook existed twice in
`AGENTS.md` — the terse consolidated form at the top of the Shell and tooling group, and a
594-byte pre-consolidation copy that a long-running branch reintroduced when it merged `main`
in twice. The duplicate cost 594 bytes on EVERY request while `docs/` carried no account of the
trap at all, which is the exact inversion AGENTS.md 2.2 exists to prevent: the hook belongs
there, the evidence belongs here. Dropping the copy took the bytes back and this section is
where its extra detail went.

## Verifying the source instead of the emitted artifact — 2026-09-05

Three defects reached production in one night, on one button, every one with `typecheck` green,
`validate` green and all four required checks green. They share a single cause: **the thing that was
checked was not the thing the browser receives.**

**1. A backslash died in a template literal.** The Download PDF guard was written `/\/print\/?$/`
inside a `<script>` authored in a TypeScript template literal. A backslash there is an escape *for
the template*, so the browser got `//print/?$/` — a line comment. The script died on a `SyntaxError`
before the line that unhides the link, so the button was present in the HTML of every document and
hidden on every one.

It had been "verified in a browser". The verification pulled the script text **out of the source
file** and ran that, which is the one copy that was correct.

**2. A font stack fixed in one of the two places that hold it.** The production image installs only
`ttf-freefont`, and every family in `ARABIC_FONT_STACK` is a Windows font — so a server-rendered PDF
fell through to FreeSans, which carries Arabic codepoints but does **not shape** them. Chromium drew
each letter isolated and the wrong metrics turned a three-page contract into sixteen. The body was
fixed by adding Noto; the footer template carried its own hardcoded copy of the stack and was missed,
so the document shaped correctly above a footer that did not.

**3. A quoted font name closed a quoted attribute.** Interpolating `ARABIC_FONT_STACK` — whose
families are quoted, `"Tahoma", "Segoe UI"` — into a double-quoted `style="…"` closed the attribute
at the first family. The div was malformed from that byte on, Chrome dropped the footer entirely, and
the page numbers vanished after being correct the build before. A single-quoted attribute holds
double quotes legally.

**Why none of it went red.** None are type errors. None are string mismatches — the HTML compared
equal in every test that looked at it. The stack has nothing that renders a page and asserts on the
result, so the only place the defect exists is the printed output. All three were found by the owner
opening the file.

**What to do instead.** Export the generated constant so a test can assert on the emitted string
rather than a retyped copy — `PAGE_NUMBER_FOOTER` and the print banner's script are exported for
this. Compile an injected script with `new Function`, which catches a lost escape without executing
anything; `tests/print-banner-script.test.ts` does that and was proven RED against the real defect
before being trusted. For a PDF, render it and read it back: extract the text, crop the region to an
image and look at it. **Page count is the cheapest tell** — a three-page contract arriving as sixteen
is a font problem, not a layout one.

And whenever a value is interpolated into markup, check the delimiters. A font stack, a name with an
apostrophe, an Arabic title — any of them can close the attribute they are dropped into.

## A keyword scan decided a fact, and the fact was a comment — 2026-09-21

The mirror image of the section above. That one verified a fix by reading the source; this one
*concluded* something about an artifact by pattern-matching the source, and reported it to the
owner as a finding.

`~/.claude/scripts/scratchpad-regen-run.mjs --run` rebuilt nine scratchpad documents lost to the
Temp sweep and wrote `_regen-results.json`. One row carried `readsLiveData: true`, and on that flag
alone the owner was told that the rebuilt video-uploads workbook dated 15 September held **today's**
figures under that old name, and was asked to decide whether to keep it. **The warning was wrong.**
Its generator, `build_video_report.py`, imports `openpyxl` and nothing else — no client, no HTTP
library, no database driver, no environment read, no URL. Every figure is a literal in a
`rows = [` list. The one occurrence of "Supabase" in the file is a comment recording where the
numbers were read from on 2026-09-15, and the workbook prints that same provenance into cell A2.
The eight other rebuilds were literal-data scripts too: **all nine were faithful**, which was the
correct headline and the opposite of what the flag implied.

**How the flag is computed** (`scratchpad-regen-plan.mjs`, line 141):

    best.readsSupabase = /supabase|SUPABASE_|postgres|psycopg|pg\b|createClient/i.test(code);

One case-insensitive regex over the entire source text. Measured against it:

| Source line | Flags? | Matched |
| --- | --- | --- |
| `# numbers read from Supabase on 2026-09-15` | **yes** | `Supabase` |
| `logo = "sato-pharma-logo.jpg"` | **yes** | `pg` |
| `from supabase import create_client` | yes | `supabase` |
| `img = "mark.png"` | no | — |
| `from openpyxl import Workbook` | no | — |

So there are two false-positive paths, not one: **a provenance comment, and any `.jpg` filename**,
because `pg\b` matches the tail of `jpg`. A script that embeds a logo reads as a database client.

**How to apply.** A regex over source text is a *hint* about where to look. Before telling the
owner a rebuilt or regenerated artifact carries different data from the original, open the
generator, read its imports, and find the actual call. It is one grep. The same shape bites
anywhere a scan stands in for reading: a word in a comment, a string in a docstring and a
commented-out line all match exactly as live code does.

The script itself was left as it is: it has done its one run, and the rebuilt set carries its
provenance in the scratchpad archive's `_regenerated-README.txt`.

## Relocated from AGENTS.md — 2026-09-01

Verbatim, unabridged. These entries had grown from cues into full accounts inside `AGENTS.md`,
which auto-loads in full on every request. Per AGENTS.md §2.2 the cue — and every memory slug —
stays in `AGENTS.md`; the account lives here.

- **`next dev` in a worktree needs the explicit `--webpack` flag** — TURBOPACK is what rejects the §5 junction, not Next. Measured 2026-08-29: `--webpack` served a junctioned worktree fine (`Ready in 1770ms`, HMR and all). With and without `--turbopack` are NOT the same as `--webpack`, and this line said "CANNOT run" off exactly that gap. `turbopack-cannot-resolve-a-junctioned-node-modules-here` **`pnpm run dev` now CHOOSES for you** (`scripts/dev-server.mjs`: webpack on win32, turbopack elsewhere) — the platform guard has been deleted three times, most recently by #1435, so the measurements live in that file. **CORRECTED 2026-09-01 — the watchdog's 6 GB kills are NOT a turbopack trait, and this line said they were.** **SEVEN** webpack servers were killed at the same ceiling in the 38 minutes AFTER that launcher merged (02:19–02:46 Cairo, 6.03–7.23 GB, one started by the launcher itself WITH a memory cap set) — indistinguishable from the eight before it; 100 attempts / 98 succeeded all-time. So **the bundler is never the fix for the kill/restart sawtooth**. **You cannot attribute a kill to a bundler from `mem-watchdog.log`**: both spawn the same `start-server.js` child, so grepping the logged cmd for `turbopack` returns 0 of 100 and reads as *no turbopack kill ever happened* — attribute by TIMESTAMP, and count with `-CaseSensitive` or `KILL` also matches every `killed OK`. Turbopack's OWN failures are WEDGING (no answer to `GET /` in 25-60s) and the junction above. The sawtooth is a **watchdog-THRESHOLD** problem — this dev server legitimately reaches ~6 GB — made acute by running **two** servers at once (§5: one, ever); each cycle re-drove RAM to 94% and re-evicted the desktop to the pagefile. 🔴 **SETTLED 2026-09-12 — `mem-watchdog.ps1` EXEMPTS a dev server from every one of its rules** (*"A NEXT DEV SERVER IS THEREFORE TOUCHED BY NOTHING IN THIS SCRIPT AT ALL"*, its own header), so there is no threshold left to tune and no sawtooth to attribute; under its floors it reclaims NODE JOBS. **AMENDED 2026-09-21, the owner's choice ("Over 8 GB or unused 25 min"): rule 1 stops a dev server again at or over 8 GB of commit, and rule 3 after 25 minutes with no work; every other rule still skips it.** The sawtooth above cannot return, because it came from a 6 GB ceiling while healthy servers peaked at 6.03–7.23 GB, and 8 GB sits above all of those. What forced the re-arm was a preview tab stuck in a redirect loop that drove one server to 9.9 GB for over an hour while nothing was allowed to stop it; the account is in `docs/agents-worktree-and-machine-limits.md`. What stops a dev server since 2026-09-17 is `~/.claude/hooks/dev-server-reaper.mjs` — the one the ENDING session started, nobody else's. 🔴 **CORRECTED 2026-09-21 — `--max-old-space-size` DOES bind the dev server.** This line called it a measured no-op ("`heap_size_limit` 4288 MB with AND without it"), but that was a plain `node`'s own default, never the `start-server.js` child that grows. Next hands that child HALF OF RAM (an 8,278 MB limit here) unless `NODE_OPTIONS` already carries a cap, and restarts it only past 80% of the limit; `node scripts/dev-server.mjs` now caps it at 4,096 MB (a 4,288 MB limit, restarted in place near 3.4 GB), and `bash-guard.mjs` C7 refuses a raw `next dev`. Account: `docs/agents-worktree-and-machine-limits.md`, "The dev server's heap cap".

- **The SUITE runs with PRODUCTION credentials while a test sets `APP_ENV=production`.** So
  `isProductionRuntime()` is TRUE for part of every run, and any module that writes on it writes to
  PROD from a bare `pnpm run test`. Gate such a write on `PHOENIX_TEST_SUITE` — set in
  `tests/run-tests.ts`, read nowhere else. `NODE_ENV` alone is not enough: it depends on two other
  tests' restore discipline, and it is READ-ONLY in the type system, so assign it through a mutable
  view. `the-test-suite-runs-with-production-credentials-and-app-env-production`

- **Arabic + English in ONE value needs direction PER LINE, and `dir="auto"` on the block is the
  WRONG fix.** Nothing in this repo can see either state, and both shipped through four green
  checks. `auto` reads only the FIRST strong character, so a bilingual body turns wholly RTL and the
  ENGLISH half then renders backwards (`Thanks for contacting Sato Pharma.` becomes
  `.Thanks for contacting Sato Pharma`) — the exact mirror of the bug being fixed.

  **SINGLE-language free text is the opposite case.** Block-level `dir="auto"` is correct there and
  is already house style across 57 files. Do not "fix" those.

  **Measure production for Arabic before changing a screen.**
  `outstation_expense_requests.notes` carried Arabic in 17 of 48 rows; `coaching_reports` in **0 of
  112**. A screen with no bilingual data does not have this bug.
  `bilingual-bodies-need-direction-per-line-not-per-block`

## Section 2.1 was trimmed to its floor — 2026-09-01

**What was done.** A wording-only pass over §2.1, plus two whole bullets removed as duplicates:
19,789 → 19,060 bytes, **−729 B (3.7%)**. No hook and no memory slug was lost — 15 slug-shaped
tokens before and after, and all 30 memory files named in `AGENTS.md` are still named there. Proven
by arming the guard first: deleting `tailwind-merge-strips-custom-named-font-sizes` made
`runMemoryIndexReachabilityTests` go RED with *"every memory the map marks load-bearing must still
be named in AGENTS.md"*, and all three memory-index suites were green after restoring it.

**The two bullets that went were de-duplicated, not deleted.** §2.2 says never delete a hook to make
room; neither of these lost a claim, because a fuller statement of each already sits elsewhere in
the same auto-loaded file:

- *"`pnpm run <script>` PURGES `node_modules` when the lockfile moved. Invoke `node scripts/…`
  directly."* — §5 carries a strict superset: *"Never `pnpm install` inside a worktree, and never
  `pnpm run` there. `pnpm run` purges `node_modules` outright once it sees the lockfile has moved,
  destroying the junction before your script starts. Invoke `node scripts/…` directly."* — and adds
  what the junction IS enough for. The general trigger ("once it sees the lockfile has moved") is
  stated there too, so nothing narrowed.
- *"'Permission denied' on `git worktree remove` still DEREGISTERS the worktree."* — absorbed
  word-for-word by the hook PR #2880 added the same morning, which reads *"`git worktree remove`
  then fails Permission denied, deregisters anyway, and leaves the husk."*

Reach is identical either way — everything in `AGENTS.md` auto-loads in full — so de-duplicating
costs scannability only, never recall. That is §2.2's *"Reach is identical; only scannability
differs"* being spent on purpose.

**PR #2880's own hook was compressed 884 → 692 B** in the same pass. It was the largest bullet in
§2.1, about four times the section average, and its 33-line account had already shipped to
`docs/agents-worktree-and-machine-limits.md` in the same PR — so the evidence it carried inline
("two clean closes and a kill of the owning `claude.exe`", the daemon's command line never naming
the tree it serves) has a home and did not need to be paid for on every request. Every instruction
survived: what fails, that nothing points at the holder, that your own read-only gate scans spawn
the daemon, and the stop-then-retry-for-minutes fix with its ~5 min figure.

**The dates removed are pure provenance and all still live in `docs/`** — `http.postBuffer` fixed
2026-08-23, the REVOKE fix on prod 2026-08-14, the three docs-only PRs of 2026-09-01, `--strip-idle`
narrowed 2026-09-01, the dev-server launcher merge. §2.2 already requires a hook to be *"durable
(never a count, a status or a date)"*, so this is the rule being applied rather than evidence being
lost. Every number a session actually judges against was kept: 222 of 308 tables, 41 hits, ~6 GB,
20–30 MINUTES, `876000h`, ~5 min, 40-char SHA.

**The finding that matters more than the 729 bytes: §2.1 has no structural fat left.** It is 96
bullets in 19,060 bytes — about 198 bytes each — and every one is a claim whose account is already
in this file. A second wording pass will not pay. The measured yield here was 3.7%, and roughly a
third of that came from the two duplicates rather than from wording; the first sixteen wording edits
together bought only 282 B.

**The growth pressure is additions, not slack.** PR #2880 put a single 884-byte hook into §2.1 that
same morning — more than this entire trim recovered. If §2.1 has to shrink again, the lever is the
displacement rule applied to *new* hooks at the moment they are written (cue here, account in
`docs/`), not another editing pass over what is already there. Re-reading this section and finding
it terse is the expected state, not an invitation to compress it further.

## The holder of a husk IS findable, and can be unkillable — 2026-09-05

Hook: AGENTS.md §2.1 (Worktrees), *"Closing the session does NOT release its worktree"*.

`.claude/worktrees/nifty-benz-8de692` was a textbook husk — unregistered, no `.git` file, zero
files, zero subdirectories — and every removal refused with exit 32, *the process cannot access
the file because it is being used by another process*. `repo-doctor --fix` aborted on its own
concurrency census (9 sessions), `rmdir` and `rmdir /s /q` both failed, and `--force` would have
hit the identical lock: the guard was never what stood in the way.

**The old hook said "no OS tool points at the holder — and `list_sessions` does NOT either."
Both halves were wrong.**

- Windows exposes no process's current directory through `Get-Process`, `Win32_Process`, Task
  Manager or `openfiles`, and Sysinternals `handle.exe` is not installed here. But the cwd lives
  in each process's PEB and can simply be read: `NtQueryInformationProcess` for the PEB base,
  `+0x20` for `RTL_USER_PROCESS_PARAMETERS`, `+0x38` for the `CurrentDirectory` UNICODE_STRING.
  129–257 processes come back readable in about a second. That is now
  `scripts/find-worktree-holder.ps1`. It named the holder on the first run: **PID 23316
  `claude.exe`** and **PID 8584 `powershell.exe`**, both cwd'd into the husk.
- `list_sessions` named it too — session *"Add a share-link screen for the CV lifecycle sheet"*,
  `cwd` set to that exact folder. The "every session reports the PRIMARY" claim is true only of
  `_wt-*` sibling worktrees; a `.claude/worktrees/` session PINS its cwd to its worktree. Reading
  the old hook literally is what delayed finding this.

**Then it would not die.** PID 23316 had burned 5,039 s of CPU and was still taking 104–106% of
one core, sampled repeatedly over six hours. The split was the tell: **4,549 s kernel against
1,778 s user**, with 43 threads reading 1 Running, 42 Waiting and **zero Terminated**. `Stop-Process`
and Task Manager's End task both failed — a thread spinning inside a kernel call is marked for
termination but cannot be unwound until the call returns, and it never did. Its creation time was
byte-identical across five separate checks, proving it had never been killed or respawned. The
likely mechanism: its worktree was deregistered and emptied underneath a live session, leaving a
file watcher spinning on a path that had vanished — which is also what held the directory open.

**Only the restart cleared it.** After the 06:55:55 reboot the process was gone, the folder
released immediately, and a plain non-recursive `rmdir` took it with exit 0 on the first attempt.

**The cost lesson matters more than the fix.** `repo-doctor` had priced this husk at
`0 empty path entries reclaimable` — deleting it reclaimed nothing, not one file, not one path
entry. Five rounds went into it. The merged worktrees retired the same night gave up **68,167
path entries**, taking the checkout from 83,243 to 15,076. Read the price before chasing a husk.

Method note: the mid-sweep check that nearly went wrong was a "has this folder gone quiet" mtime
sample which returned **blank on both reads** and scored itself *the folder is quiet* — two nulls
comparing equal. The folder had in fact been removed by another session seconds earlier. Verify
with a positive control (bytes read, rows found), never with a clean-looking blank.

## An unkillable holder dies when its SESSION is archived — no reboot — 2026-09-07

Correction to the conclusion of the section above, whose 2026-09-05 account otherwise stands:
*only the restart cleared it* was true of the levers tried that night, not of the problem. There
is a second lever, and it is the cheap one.

`.claude/worktrees/quirky-golick-444b9a` was held by **PID 16692 `claude.exe`** at **13,771 s of
kernel CPU**, which `find-worktree-holder.ps1` flagged `KERNEL-STUCK?` — the same signature as PID
23316 above, and read the same way: a reboot is the only way out. It was not. The process belonged
to the session *"Fix conversation threads that email only their first message"* (PR #3411, merged),
and **archiving that session ended it.** The next PEB sweep read *no process is sitting in any
worktree*, and a plain non-recursive `rmdir` took the husk with exit 0 on the first attempt.

**So the order is: archive the owning session, THEN consider a restart.** `Stop-Process` and Task
Manager still cannot unwind a thread inside a kernel call — that half is unchanged — but the app
tears its own session down by a route neither of those uses. `archive_session` stops the process
and releases the worktree, and it refuses a session that is mid-turn, pinned, or on screen, so a
refusal is informative rather than destructive.

Found while archiving 26 merged sessions in one sweep: 31 `claude.exe` down to 21, **2.8 GB of
commit charge** returned, and free RAM essentially unmoved — 2,139 to 2,206 MB. Windows does not
hand working sets back eagerly, so **judge what archiving bought by commit charge, never by free
RAM.** The same sweep took `.claude/worktrees/` from 9 worktrees plus 2 husks to empty.

**The cost lesson above is untouched.** That husk was still priced at `0 empty path entries
reclaimable`. It was worth clearing only because archiving the session was wanted anyway — never
chase a zero-priced husk on its own.

### Why `list_sessions` cannot answer "is anyone in that folder" — 2026-09-08

Relocated from the AGENTS.md hook so the hook could stay a hook (§2.2). Two fields there are
routinely misread, and both make an occupied worktree look free:

- **An `_wt-*` session reports the PRIMARY as its cwd**, not the worktree it is actually working in.
  So a sweep of session cwds answers *nobody is in that folder* for a worktree in active use, and
  §5's retirement gate passes on it. The reliable cross-check is by BRANCH: compare the worktree's
  branch against every open PR's `headRefName`, and re-read HEAD at the moment of removal rather
  than trusting a scan taken earlier. A `.claude/worktrees/` session is the exception — those pin
  their cwd to the worktree itself.
- **`isRunning: false` means IDLE, not CLOSED.** It reports only that the session is not mid-turn.
  A session sitting idle still holds its folder, and killing on that signal is how a worktree gets
  removed under someone.

## A husk is pinned by a PROCESS, not by the session's cwd — 2026-09-21

Two wrong answers reported to the owner before this was measured properly. Both are the kind that
sound settled, so they are written down as errors rather than as findings.

**1. "The husks are held by each session's current directory, so moving that session frees it."**
Five husks stood under `F:\Phoenix Workforce`. Session `a15b5e6b` was relayed out of
`_wt-classifier-permission` and changed cwd at **01:30:43Z**; the folder stayed held for another
ten minutes. A session's *logical* cwd is not the handle. The handle belongs to an
already-running child **process** whose own current directory is inside the folder, and moving the
session does not move a `powershell.exe` or `node.exe` it started earlier — those keep their cwd
until they exit. Two husks did clear after a relay, which is exactly what made the theory look
right: those sessions' children happened to exit too.

**2. "Without Sysinternals `handle64.exe` the holder cannot be named."** Wrong, and wrong in a way
this file already records — the 2026-09-05 section above says the holder IS findable and names the
tool. `scripts/find-worktree-holder.ps1` ships in this repo, reads each process's PEB via
`NtQueryInformationProcess` + `ReadProcessMemory`, and prints pid, name, kernel CPU and cwd. Run
here it read **202 processes** and named every holder, including `PID 20644 claude` flagged
`KERNEL-STUCK?` in `_wt-device-mgmt\`. The mistake was repeated because a whole session of worktree
work went by without the **Worktrees** cluster ever being opened — which is the failure mode
AGENTS.md §2.1 warns about in its own words: the injector fails open and silent, so its silence is
not evidence the cluster does not apply.

**Why the scan that produced answer 2 said "no holder".** It enumerated `/proc/<pid>/cwd` under
MSYS and saw only `bash` and `sleep`. **MSYS `/proc` exposes ONLY MSYS processes.** `claude`,
`node.exe` and `powershell.exe` are invisible there, and they were the actual holders. A clean
`/proc` result is not evidence about a Windows process — it is evidence about nothing.

Two mechanics that make the outcome easy to misread either way:

- **`[IO.Directory]::Delete` is accepted and left PENDING.** Windows marks the directory for
  deletion and removes it once the last handle closes, so a folder whose delete "failed" can be
  gone minutes later with no further command, and one whose delete "succeeded" can still be on
  disk. Re-measure `Test-Path`; never report either outcome from the call alone.
- **Rename succeeds while delete fails.** `Rename-Item` on a held husk works, which reads as
  proof that no handle exists. It is not a test for one.

What to do with a named holder is unchanged and lives above: archive the owning session (no
reboot), a session can never clear its own husk, `--fix` clears only a zero-file husk, and a
zero-priced husk is not worth chasing at all.

## Two ways a Windows liveness check lies, and a count that invents a row — 2026-09-05

All three were hit while building `xlsx-tripwire.ps1`, the watcher that names the process deleting
files out of `xlsx/`. Each one produced a **confident wrong answer** rather than an error, which is
the only reason they are worth a page.

**1. A process filter matches the process running it.** Stopping the watcher was written as

    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object { $_.CommandLine -like '*xlsx-tripwire.ps1*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

The command's own PowerShell process has that string in its command line, because the filter is
part of the command. So it matched itself and killed the shell mid-pipeline. What comes back is
`exit 255` and **no output whatsoever** — not the partial output up to the kill, nothing. That
signature reads as a blocked call, a hook refusal or a bad path, and the natural next move is to go
looking at permissions. The fix is one clause: `$_.ProcessId -ne $PID`, plus matching on the
`-File <script>` form rather than a bare substring.

**2. A scheduled task's state does not mean its job is alive.** `(Get-ScheduledTask).State` reported
`Running`, and minutes later `Ready` beside a `LastRunTime` that looked like a normal finish, while
zero watcher processes existed and the heartbeat file was 140 seconds stale. Reading the state alone
would have certified a dead monitor as healthy — the worst possible failure for a monitor, because
its silence then reads as *nothing has happened*.

`LastTaskResult` carried the real story: **`3221225786` = `0xC000013A` = `STATUS_CONTROL_C_EXIT`**,
a Ctrl-C-class termination, not a clean exit. Note also that **restart-on-failure did not fire** —
the task sat at `Ready` and brought nothing back.

So: a long-running scheduled job needs **two** things the scheduler will not give you. A **heartbeat
file it rewrites on a known interval**, so a reader can tell "quiet because nothing happened" from
"quiet because it is dead" — and that heartbeat must be written once *before* entering the wait
loop, or it does not exist for the first interval. And a **repeating trigger** (every 10 min here)
with the script no-opping when a healthy instance already exists, which self-heals regardless of how
the previous one died. Make that no-op `exit 0`: a distinct failure code fires every interval,
paints the history permanently red, and trains whoever reads it to ignore the one run that mattered.

**3. `@($null).Count` is 1.** `Get-Acl -Audit` needs `SeSecurityPrivilege`; unelevated it throws and
yields nothing, so `@((Get-Acl -Audit $f).Audit).Count` printed **`1`** — reported, in this session,
as evidence that a folder held one audit rule. The array wrapper turns "no value" into a
single-element array holding `$null`. Any count taken from a call that can fail must check the call
succeeded first, or count `Where-Object { $_ }`.

**The shared shape.** Every one of these answers a question you did not ask. The filter answered
"which processes match" and silently included the asker. The task answered "is the task in a running
state" when the question was "is the job alive". The count answered "how big is this array" when the
question was "how many rules are there". **Prefer the measurement that fails loudly**: a live process
check over a status field, a fresh heartbeat over an absence of errors, and a verdict computed from
the number rather than a label typed beside it — a printed `(under 30 = still beating)` sat next to
the value `140` in this session and was read straight past.

## Two ways a search reported zero and meant "I did not look" — 2026-09-05

Both surfaced in one session, auditing the repo for hand-written `border-radius` the shell sweeps
cannot see (PRs #3214, #3228, #3237, #3244). Each produced a clean-looking **0** from a tool that had
not actually searched what it appeared to search, and a 0 in a sweep for defects reads as *the code
is clean* — the most expensive way to be wrong.

**1. `git grep -E` is POSIX ERE, and a backslash inside a bracket expression is a literal backslash.**

The pattern was written for `rg` and reused verbatim:

    rounded[a-zA-Z0-9_.,()\[\]-]*

In Rust regex and in PCRE, `\[` and `\]` inside the class are escaped brackets. In POSIX ERE they are
not escapes at all: the backslash is an ordinary member of the set, and the first unescaped `]`
CLOSES the class. The expression therefore means something entirely different, and matched nothing.

Measured on one file, same pattern, three engines:

| engine | invocation | matches |
| --- | --- | --- |
| POSIX ERE | `git grep -o -E …` | **0** |
| PCRE | `git grep -o -P …` | 9 |
| Rust regex | `rg -o …` | 9 |

A simpler class (`rounded[a-z-]*`) returns 9 from every engine, which is what makes this so quiet:
the pattern works everywhere you test it casually, and fails only on the class that happens to carry
escaped brackets. `-o` is NOT the culprit — that was the first diagnosis in this session and it was
wrong; `git grep -o` works fine. The fix is `-P`, or a class with no `\[`/`\]` in it.

This is the same family as the leading-slash-path entry above: **a pattern that means something else
than you think returns 0 rather than an error.**

**2. A native Windows binary cannot resolve MSYS's `/tmp`.**

`/tmp` in this shell is `C:/Users/<you>/AppData/Local/Temp`. Bash resolves it, and so does any MSYS
binary. A native Windows executable does not — it receives the literal string `/tmp/...` and fails:

    echo x > /tmp/probe.txt      # bash resolves it — file is written
    wc -c < /tmp/probe.txt       # 11        (MSYS)
    grep -c x /tmp/probe.txt     # 1         (MSYS)
    rg -c x /tmp/probe.txt       # IO error … The system cannot find the path specified. (os error 3)
    curl -o /tmp/out https://…   # exit 23   "Failure writing output to destination"
    curl https://… > /tmp/out    # exit 0    — the SHELL does the redirect, so this works

The dangerous half is `rg`, because in this session it was used to count defects in a file fetched
from production. It printed its error to stderr and `0` to stdout, and the surrounding command read
the 0 as "the class is gone — the fix is live". Three readings were quoted from it before a positive
control caught them. `curl -o` at least exits non-zero.

**Both were caught the same way, and it is the only reliable way: a positive control.** Before
believing any count of a thing you expect to be absent, make the same instrument report a thing you
know is present — a marker string in the file, a byte count, a field that must exist. In this session
the controls were `login-ember` in a login page and `--phx-` tokens in a CSS bundle; each time the
control came back 0 or blank, the "clean" result beside it was fiction.

## `main` is not in the primary, and a number from HEAD is not a number about `main` — 2026-09-05

Two sessions hit the same fact within hours of each other, from opposite directions, and the second
nearly ran a destructive command on a third session's branch because of it.

**The fact.** A worktree holds `main` — on this day `_wt-dashboard-follow-closing` — and git forbids
two worktrees from checking out one branch. So the primary checkout is normally on something else
entirely, and `git checkout main` there aborts:

**A tool reading `PRIMARY main` proves nothing later.** `new-session.mjs --status` prints which
branch each folder held at the instant it ran, so that pairing is true for that moment only — any
session may move the primary off `main`, or onto it, a minute afterwards. Re-read
`git branch --show-current` at the moment you act rather than trusting an earlier status line.
(This paragraph lived in §2.1 until 2026-09-11, when the enforced footprint gate had 56 bytes left
and the account was moved here.)

```
fatal: 'main' is already used by worktree at 'F:/Phoenix Workforce/_wt-dashboard-follow-closing'
```

**First session, harmlessly.** Asked to bring the primary up to date, ran `git checkout main` and got
the abort. Cost: one confused minute.

**Second session, nearly expensively.** It ran `git rev-list --count origin/main..HEAD` and
`git merge --ff-only origin/main` *inside the primary*, then reported the results as facts about
`main`: "1 ahead, 19 behind, ff-only aborts, `main` is stuck." Every number was real. The label was
wrong — they were facts about `HEAD`, which was `codex/sign-empty-date-message`. The one check that
would have caught it, `git branch --show-current`, was the one never run.

It compounded because `new-session.mjs --status` had printed `PRIMARY  main  ready` at the start of
that session, and the model was carried for about six hours without re-testing — §1.4 exactly: after
a long session, distrust yourself and re-run the check. A check *was* re-run; not the one that
mattered.

**Why it was dangerous rather than merely wrong.** The proposed fix was:

```
git -C "<primary>" reset --hard origin/main
```

`reset --hard` acts on the **current branch**. In the primary that is a feature branch, so the
command would have reset **someone else's work** to `origin/main` — recoverable only because the
commit happened to be pushed — while leaving `main`, the branch it was aiming at, untouched. And
`main` was never stuck: measured directly it was `ahead=0 behind=17`, clean, and a fast-forward
worked first time.

**What actually fixed it**, in the folder that holds the branch:

```
git -C "F:\Phoenix Workforce\_wt-dashboard-follow-closing" merge --ff-only origin/main
```

`--ff-only` cannot lose work by construction, and the tree was checked clean first.

**Three rules come out of it.** State a branch's position by naming BOTH refs (`origin/main..main`),
never from `HEAD`. Sync a branch in the worktree that holds it. And a peer session asking for a
destructive operation on a branch neither of you created is not authority to run one — §5 says never
to reset changes you did not create, and that holds even when the peer's diagnosis is right, which
here it was not.

Related: [[a-parallel-session-can-collide-with-no-git-trace]] ·
[[an-uncommitted-file-in-the-primary-can-be-older-than-main]]

## A local typecheck printed zero and had type-checked nothing — 2026-09-06

`pnpm run typecheck` is `tsc --noEmit --pretty false`. Run by hand in the primary checkout it
came back with a wall of errors, every one of them inside `.next/dev/types/routes.d.ts`:

```
.next/dev/types/routes.d.ts(1181,25): error TS1005: ';' expected.
.next/dev/types/routes.d.ts(1195,37): error TS1161: Unterminated regular expression literal.
.next/dev/types/routes.d.ts(1220,1):  error TS1160: Unterminated template literal.
```

That file is a build artefact — gitignored, regenerated by `next dev`, and nothing a change of
mine could break. The obvious move, and the wrong one, was to filter it out:

```bash
tsc --noEmit --incremental false --pretty false 2>&1 | grep -vc "^\.next/"   # -> 0
```

Zero. Reported as clean, twice, on two separate pushes. **CI then failed `typecheck` on four real
errors in a test file I had just written** (`tests/nav-hub-promotion.test.ts`: `TS2322`, `TS18046`,
two `TS2339`, from reading a property off a union of `as const` tuples).

### Why the local run could not see them

Those `TS1xxx` codes are PARSE errors. A file that fails to parse — here, an unterminated template
literal running to EOF, left behind when a dev server was killed mid-write — takes the whole
program down with it: `tsc` reports the syntax pass and **never runs the semantic pass at all**. So
the output contained no type errors not because there were none, but because nothing was
type-checked. Filtering the artefact's own noise out of that output turns "I did not look" into
"I looked and it was clean" — the same shape as the two searches in
*Two ways a search reported zero and meant "I did not look"*, reached by a different route.

Deleting `.next` and re-running gave the real answer: `TSC EXIT:0`, genuinely, and the four errors
were fixed before the next push.

### The rule

- **Never filter a path out of typecheck output.** If `.next` (or anything else) is producing
  errors, that is the finding — deal with it, do not hide it.
- **A `TS1xxx` code anywhere means the semantic pass did not happen.** Treat the run as VOID, not
  as a result with some noise in it. `TS1005`, `TS1160`, `TS1161` under `.next/` is the exact
  signature of a dev server that was killed while writing its route types.
- **`rm -rf .next` costs nothing** — it is gitignored and regenerated on the next `next dev`.
- CI never hits this: it starts from a clean checkout with no `.next`. Which is why the failure is
  invisible locally and only ever surfaces as a red PR, one push later.

This is a stronger sibling of AGENTS.md §2's *"a local typecheck must not trust a warm TypeScript
cache"*. That one costs a STALE answer; this one costs NO answer wearing a clean one.

Related: [[typecheck-incremental-false-green]] · [[parse-diagnostics-cannot-see-a-typecheck-error]]

## A dependency sweep that misses RLS policies, and the CASCADE that would have hidden it — 2026-09-06

A session was asked to drop two empty legacy tables, `public.users` and `public.user_roles`. It swept
for dependents the obvious way — views, functions, triggers, foreign keys — and every query came back
clean. It wrote the migration and ran it on staging, where it failed:

```
ERROR:  2BP01: cannot drop table users because other objects depend on it
DETAIL:  policy emp_docs_delete_own on table employee_documents depends on table users
         policy emp_docs_insert_own on table employee_documents depends on table users
         ... eight policies in total
HINT:  Use DROP ... CASCADE to drop the dependent objects too.
```

**Eight RLS policies on two LIVE tables referenced `public.users`** — four on `employee_documents`,
four on `employee_history`. Not one of the per-surface queries had found them, because a policy's
expression is a dependency surface of its own: `pg_policy.polqual` and `pg_policy.polwithcheck`. A
sweep of `pg_class`, `pg_proc`, `pg_trigger` and `pg_constraint` cannot see them, and there is no
error to say so — the sweep simply reports nothing and reads as *nothing depends on this*.

**The dangerous part is the HINT.** Postgres itself suggests `DROP ... CASCADE`, and cascade would
have succeeded — silently deleting all eight policies and stripping row-level security from
`employee_documents`, a live feature with 29 code files behind it. The failure was only a failure
because the migration had been written without `cascade` on purpose, so that an unknown dependency
would raise rather than resolve itself. **Never reach for `cascade` to get past this error.** The
error is the control working.

**The fix is to ask `pg_depend`,** which sees every surface at once:

```sql
select d.classid::regclass::text, d.objid, d.deptype
from pg_depend d
where d.refobjid = 'public.<table>'::regclass
  and d.deptype not in ('i','a')
  and not (d.classid = 'pg_class'::regclass and d.objid = 'public.<table>'::regclass);
```

**And carry a POSITIVE CONTROL, because the answer you want is an empty result.** Run the same query
against a table you know has dependents; if it does not return them, the query is broken and its
clean zero means nothing. Measured that day: `public.user_roles` returned **0** while `public.users`
returned **29** (6 constraints plus 23 policy rows, a policy appearing once per expression it
matches). That contrast is what made the zero trustworthy — the same discipline as the grep positive
control in *Two ways a search reported zero and meant "I did not look"*.

Outcome: `user_roles` was dropped (PR #3364, applied to production 2026-09-06). `public.users` was
left in place, because removing it also means rewriting those eight policies — a security-boundary
change on two live tables, and a separate decision.

Note for whoever picks that up: the eight are already inert twice over. Their `users` half reads
`employee_hr_id = (select u.hr_id from users u where u.id = auth.uid())`, and against an empty table
that subquery is NULL, so the disjunct never grants; and `authenticated` holds no privilege at all on
either table, so the policies are unreachable regardless. Both facts were measured, not inferred.

Related: [[a-missing-table-answers-pgrst205-not-42p01]]

## A deregistered worktree's reads lie by SUCCEEDING, and a positive control certifies the lie — 2026-09-06

§2.1 already warned that a shell sitting in a deregistered worktree resolves git against the
PRIMARY checkout. Its advice on how to detect that was wrong in a way that made it worse.

**`cd` cannot get you out of one.** The shell resets its working directory back inside the
deregistered folder after every command, so a `cd` to the real repository looks like it worked and
the next command runs in the wrong place again. Address the real repository explicitly with
`git -C <path>`. (This sentence lived in §2.1 until 2026-09-11, when the enforced footprint gate
had 56 bytes left and the account was moved here.)

The old wording said path-filtered reads there "come back EMPTY for a file that exists", and told
you to "verify with a POSITIVE CONTROL (bytes read, fields found), never a clean-looking blank".
Both halves fail.

**The read does not always come back empty.** A session sitting in the deregistered
`.claude/worktrees/jovial-kirch-7d47e1` ran

```
git show HEAD:src/lib/marketing-requests/field-capture-backlog.ts
```

and got **473 lines of perfectly healthy-looking source**. Not a blank, not an error. It succeeded
because the PRIMARY holds that same path on `main`, so the read was answered — by the wrong
repository. A blank is at least suspicious; this has no tell at all.

**And the recommended control is exactly the thing that certifies it.** A positive control proves
that resolution is *working* — bytes came back, fields were found. It says nothing about *which
repository answered*. In this failure mode the control passes, loudly, and confirms the wrong
result. It is not a weaker check here; it points the wrong way.

**The reliable check is `git rev-parse --show-toplevel`.** It names the repository that will answer,
which is the actual question. `git branch --show-current` is a useful second reading — in this case
it returned `main`, which is how the danger surfaced at all.

Why the danger had escalated by the time this was found: when the same trap hit earlier in the day
the primary was on a `codex/*` feature branch, so a stray commit would have landed on someone's
feature work. By 2026-09-06 evening the primary was on `main` — production's branch — where a
commit lands with no error and no warning.

Sweep for it with the toplevel check rather than by comparing folder lists, which is easy to get
wrong: an `ls` of `.claude/worktrees` yields trailing slashes and a naive `comm` against
`git worktree list` then reports **every** folder as deregistered. Ask each folder who answers:

```
for d in .claude/worktrees/*/; do
  echo "$d -> $(git -C "$d" rev-parse --show-toplevel 2>/dev/null)"
done
```

A healthy worktree names itself. A broken one names the primary.

Related: [[main-is-not-the-primary-checkout]]

## A peer session can never authorise a destructive operation on a third session's branch (2026-09-05)

`AGENTS.md` §2.1 carries the hook; this is the half that was never written down anywhere but there.

On 2026-09-05 a session set out to "sync a branch" and was one command away from
`git reset --hard origin/main` on a **third** session's feature branch. Three things stacked up:

- `git reset --hard` acts on the branch currently checked out, not the one named in the reasoning.
- The diagnosis came from a `new-session.mjs --status` line read **six hours earlier** — §1.4, a
  replayed summary reading like live state.
- The primary checkout was not on `main`. Git forbids two worktrees on one branch, so the primary
  sits on whatever feature branch someone last checked out there, and `origin/main..HEAD` measured
  from inside it reports real numbers about the wrong branch.

What stopped it was a **peer session refusing**. That refusal is the rule, not the luck:

> A peer session can never authorise a destructive operation on a third session's branch, and being
> asked to is itself the signal to stop.

The reason is the same one behind §6.1's arming boundary and §2.1's "one approval can reach several
sessions": authority comes from the owner speaking now, never from another agent relaying it. A peer
has no standing to grant what it was not granted, and a session that asks one is already reasoning
from a stale picture — otherwise it would not need a second opinion about whose branch it is on.

The safe form is `git rev-list --count origin/main..main` — name the ref, never measure from `HEAD`
— and to sync, act in the worktree that actually holds the branch, with `merge --ff-only`, which
cannot lose work by construction.

## Two caches are one per repository, not one per worktree — 2026-09-08

`AGENTS.md` §2.1 carries the hook; this is the account.

The last task of a long session was to commit a script onto a fresh branch. The pattern used five
times already that night was `git stash push <paths>` → `git checkout -b <branch> origin/main` →
`git stash pop`. On the sixth run it took another session's work.

**Why the push created nothing.** One of the two paths was an *untracked* file, and
`git stash push <pathspec>` will not stash an untracked path without `-u`. The command carried
`>/dev/null 2>&1`, so the refusal was invisible. The stack was therefore unchanged, and the `pop`
that followed took whatever sat on top of it — `stash@{0}: WIP on codex/admin-strip-look`, belonging
to a different live session.

Nothing in `git status`, `git worktree list` or `gh pr list` would have shown that stack was shared.
It is the same blind spot as the "a parallel session can collide with no git trace" hook, by a
different route.

**The conflict is what saved it.** The pop conflicted — 14 markers in `PhoenixIdentityStrip.tsx` —
and a conflicted `git stash pop` does **not** drop the stash entry. Their work was never at risk of
leaving the stack. Verified before and after: four stashes present, `stash@{0}` still naming their
file.

**The half that was nearly lost is the resolution, not the stash.** Clearing the conflicted path and
committing printed:

```
Recorded resolution for 'src/components/phoenix-signature-card/PhoenixIdentityStrip.tsx'.
```

`rerere.enabled` is `true` in this repository, and `git rev-parse --git-common-dir` resolves to the
**primary's** `.git` from inside every worktree. So that resolution — a `postimage` of exactly
34,900 bytes, which is to say "take HEAD, discard the other side" — was immediately repository-wide.
The next time that session popped their stash, rerere would have replayed it, rewritten their file
to HEAD, and reported a perfectly ordinary resolution. `rerere.autoupdate` is unset, so it would not
even have staged the result: the file would simply have contained the wrong thing.

That is the worst shape available — silent, and indistinguishable from git working correctly.

**The removal.** `git rerere forget` needs the conflict live in the index, which it no longer was.
The entry was removed by hand, and identified **positively** rather than by recency: `postimage`
byte-size equal to the resolved blob, `preimage` holding conflict markers and the file's own
identifiers. Afterwards 235 entries remained with the newest predating the session's own conflict —
the check that proves nothing else went with it.

`git rerere gc` is the wrong instrument here. It prunes by age across the whole cache, and this
repository holds 200+ entries other sessions rely on.

**The rule.** There is no reason to stash for a branch move. `git switch -c <branch>` carries
uncommitted work onto the new branch by itself, touches no shared stack, and the entire failure mode
does not arise.

## git's own maintenance stops silently on a leftover lock, and its defaults delete shared state — 2026-09-17

**What was found.** `objects/maintenance.lock` sat in the primary's `.git` from 2026-08-10 18:31
Cairo until 2026-09-17: an empty file, left by a maintenance run that never finished cleanly. By then
the repository held 13,456 loose objects (179 MiB, beside 187 MiB of packs), 396 loose ref files and
a commit-graph five days stale. There was no `gc.log`, no error and no failing exit code anywhere.

**Why nothing said so.** Measured on git 2.55.0.windows.3 in a throwaway repository: while that lock
exists, `git maintenance run` does nothing, prints nothing and exits 0. That held for the automatic
run a commit starts (`git maintenance run --auto --quiet --no-detach`) and for a run typed by hand
with an explicit `--task=loose-objects`. The loose objects stayed exactly where they were.

**The repair has a trap of its own.** Removing the lock lets maintenance run again, and git 2.55's
DEFAULT automatic run, traced in that throwaway repository with no maintenance config at all,
executes `git rerere gc`: the instrument the account above rules out, because there is one rerere
cache for every worktree and session. git's default for a run typed by hand is the geometric
strategy, which also expires reflog entries, removes worktrees it cannot locate and, when it decides
on an all-into-one repack, expires unreachable objects (`git help maintenance`, under
`maintenance.strategy`). An explicit `maintenance.<task>.enabled` beats any strategy.

**What was done.** The lock was removed first, and only named tasks were run on the repository
(`git maintenance run --task=loose-objects --task=commit-graph --task=pack-refs`, twice). Six
minutes later, with `.git/config` backed up, the five data-deleting tasks were pinned off: `gc`,
`geometric-repack`, `rerere-gc`, `reflog-expire` and `worktree-prune`. `prefetch` was pinned off
too; `loose-objects`, `commit-graph`, `incremental-repack` and `pack-refs` were pinned on. Traced
with that exact set, an automatic run executed only `pack-objects`, `prune-packed`, the
multi-pack-index steps and `pack-refs`, and the rerere cache held all 295 entries before and after.
No count of that cache exists from before the lock came off, so those six unpinned minutes are
unverified rather than proven harmless. **Pin first, then remove the lock.** Result: loose objects
13,456 to 0, storage 366 MiB to 215 MiB, loose ref files 396 to 1.

**Twice, on purpose.** The loose-objects task first deletes loose copies that are already packed,
THEN packs the rest. After the first run all 13,252 remaining objects were both loose and packed
(`prune-packable: 13252`); the second run deleted them.

**How it is watched now.** `repo-doctor` prints a GIT MAINTENANCE section. It flags a lock older
than two hours, any of the five tasks not pinned off, and more loose objects than git's own
`gc.auto` default of 6,700. An unreadable lock, config or object count prints "Do NOT read this as
clean". Pinned by `tests/repo-doctor-git-maintenance.test.ts`, whose config half runs real
`git config --list -z`.

## A killed workflow run is recoverable — relocated from `AGENTS.md` §2.1, 2026-09-09

The hook in `AGENTS.md` is one line. This is the account it stands on, moved here under §2.2's
standing rule that the rules file carries hooks and `docs/` carries the evidence.

**The false conclusion, written down twice.** A workflow run that dies partway leaves a journal, and
the journal carries no agent *label*. That reads as "a partial verdict cannot be mapped back to the
finding it judged", and on that reading the only option is to re-run everything. It was concluded
twice, and it **threw away two runs' work**. It is wrong.

**Why it is wrong.** The journal does carry `agentId`. Each agent's transcript is
`agent-<agentId>.jsonl`, and that file's first user turn is the prompt the workflow built, which
names the finding verbatim. So the chain is complete:

```
journal.result -> agentId -> transcript -> first user turn -> the finding it names
```

**What it recovered.** 72 of 72 verdicts from one dead run, and 5 findings plus 2 adjudications from
another.

**Two conditions on using it.** Gate the mapping on controls, and include a NEGATIVE one: a
fabricated finding title must NOT match anything. Without that, a matcher that matches everything
looks exactly like a matcher that works. And never let an agent that DIED score as a finding
REFUTED — an outage read as a judgement once bought 45 needless opus adjudicators.

**Worked example.** `_audit-vault-sos-2026-08-09/recover-run3.mjs`.

## An empty paid stamp read as an unpaid month, and a stamp would not have caught the real shortfall — 2026-09-18

**What was seen.** Twelve approved outstation trips booked to the August 2026 payout (8,811.31 EGP,
seven employees) carried no `imported_payroll_batch_id`, though the August batch was approved on
2026-09-08 at 14:43 Cairo. A session reported it to the owner as a possibly unpaid month.

**Why that was wrong.** The column is the paid stamp that `src/lib/automated-payroll/expense-stamp.ts`
writes when a run is PUBLISHED, and publishing only started writing it on 2026-09-12 (#3786). The
module says so itself: "HISTORY IS NOT BACKFILLED. The July and August runs stay unmarked", by the
owner's ruling. On production on 2026-09-18, 0 of all 347 approved trips carried it. Empty on those
two months is the designed state, not a missed payment.

**What proves a payment.** Each employee's `salary_records.expenses` in that month's `salary_batches`
row, compared with the payable total of their approved trips (`approved_amount` where HR edited it,
the claim otherwise). Measured for August: six of the seven matched to the pound. The seventh was paid
2,155 against 2,665.56 approved, one 510.56 trip short, because the Expenses step figure was typed by
hand on 2026-09-08 (`automated_payroll_draft_rows.expenses`, `source = inline`) and left that trip out.

**Why the stamp would not have caught it either.** From September on the stamp is written, but
`planPaidExpenseStamp` marks EVERY approved trip of an employee who was paid any expenses, even when
the paid figure is lower than those trips. The gap is reported only in `differing`, which lands in
`automated_payroll_audit` on the run's `published` row, under `detail.expenseStamp.differing`. So a
stamped trip means "this publish covered this employee", not "this trip was paid in full". Read
`differing` before telling anyone a month paid what was approved.

## A mangled `git show` read as "the fix is not there" — 2026-09-21

Measured in this repository on 2026-09-21, while confirming that #4148's docs-only guard had
actually reached `origin/main`.

**The command every such verification reaches for.** From the Bash tool on this machine:

    git show origin/main:.github/workflows/ci.yml

**What git actually receives.** MSYS path conversion rewrites the whole `<rev>:<path>` argument
before git ever sees it — **but only when the path begins with a DOT**, as `.github/…` does here.
`docs/…`, `supabase/migrations/…`, `tests/…` and `package.json` pass through untouched, which is
why this trap looks intermittent and why testing it on the wrong path "disproves" it. The
trigger is a dot followed by a NAME, so a `./` in front disarms it and needs nothing exported —
measured, `origin/main:.github/workflows/ci.yml` reads 0 bytes while
`origin/main:./.github/workflows/ci.yml` reads 47,311, and `./` on a path that was already fine
changes nothing. When it does fire, the colon becomes a SEMICOLON and every slash a backslash:

    fatal: ambiguous argument 'origin\main;.github\workflows\ci.yml': unknown revision or path not in the working tree.
    Use '--' to separate paths from revisions, like this:
    'git <command> [<revision>...] -- [<file>...]'

**Which paths, measured — the dot must START the path.** The same read, byte counts with and
without the export:

| path | without | with `MSYS_NO_PATHCONV=1` | |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | 0 | 47,311 | **mangled** |
| `.claude/settings.json` | 0 | 6,129 | **mangled** |
| `.gitignore` | 0 | 5,015 | **mangled** |
| `.env.example` | 0 | 13,841 | **mangled** |
| `mobile/.gitignore` | 1,137 | 1,137 | fine |
| `package.json` | 20,391 | 20,391 | fine |
| `tests/run-tests.ts` | 477,124 | 477,124 | fine |
| `supabase/config.toml` | 15,317 | 15,317 | fine |

`mobile/.gitignore` is the row that pins the rule, and it is the one worth remembering: a dot-name
INSIDE the path is harmless, so *"dotfiles are dangerous"* is the wrong generalisation. Only a path
whose FIRST character is a dot converts — `.github`, `.claude`, `.gitignore`, `.env*` — which is
where CI config, hooks and settings live, so the fault falls precisely on the files a session
verifies most. Everything else passes through, which is why a `supabase/migrations/…` extraction is
safe exactly as written.

Run on its own that is an error a session would notice. **The trap is the next step**, which is how
the command is actually used:

    git show origin/main:.github/workflows/ci.yml | grep -c "docs-only fast path"    # 0

The `fatal:` goes to **stderr**, which a verification pipeline discards or scrolls past. What the
session reads is `0` — and a zero from a presence check means exactly one thing: *the guard is not
in the shipped file, so the fix did not ship*. This is a plausible WRONG ANSWER, not an error:
nothing in the output looks broken, and the file was never read at all.

**The exit code does not rescue it.** That pipeline exits `1`, but the `1` is `grep`'s "no matches"
— the identical status a genuine, correctly-read absence produces. No status here distinguishes
*git failed* from *the string is not there*.

**`ambiguous argument` does NOT mean the file is there — the tell is a TWO-STEP.** Four probes,
measured. The first three were the original claim; the fourth is what corrects it:

    1  dotted + PRESENT, untreated    fatal: ambiguous argument 'origin\main;.gitignore': unknown revision or path not in the working tree.
    2  ordinary + ABSENT, untreated   fatal: path 'docs/no-such-file-here.md' does not exist in 'origin/main'
    3  dotted + ABSENT, export SET    fatal: path '.github/workflows/no-such.yml' does not exist in 'origin/main'
    4  dotted + ABSENT, UNTREATED     fatal: ambiguous argument 'origin\main;.github\workflows\no-such.yml': unknown revision or path not in the working tree.

**Probe 4 is byte-identical to probe 1**, and it is the one that was missing. In the untreated
state — which is the state every session is in the first time it hits this — a dotted path answers
`ambiguous argument` whether the file exists or not. The conversion happens before git resolves
anything, so git never gets far enough to know. Reading that message as *MSYS ate a real file* is
the same false positive as the zero this whole account exists for, one layer up: a session chasing
a typo'd `.github/workflows/…` would conclude the file is present and the tooling is lying.

Probe 3 does not show the two causes staying distinct. It shows that **disarming the conversion is
what makes them distinct.**

**So `ambiguous argument` on a dotted path means "conversion fired", and nothing more.** To learn
whether the file exists, re-run with `./` in front — nothing to export:

    git show origin/main:./.gitignore                       # 5,015 bytes — real, and the trap was eating it
    git show origin/main:./.github/workflows/no-such.yml    # fatal: path '…' does not exist in 'origin/main'

The backslashes-and-semicolon shape does identify the mangling reliably. What it never identified
is the file.

**Three near-fixes that do NOT work, each measured:**

| attempt | result |
| --- | --- |
| quoting the argument — `git show "origin/main:.github/workflows/ci.yml"` | the same `fatal:` |
| `git cat-file -p origin/main:.github/workflows/ci.yml` | `fatal: Not a valid object name origin\main;.github\workflows\ci.yml` |
| redirecting to a file — `git show … > ci.yml` | no visible complaint, **0 bytes written** |

The redirect is still worth doing, but not as the fix: a 0-byte file is *visible*, where a piped
`0` is not.

**What works.** Turn the conversion off, or leave MSYS entirely:

    MSYS_NO_PATHCONV=1 git show origin/main:.github/workflows/ci.yml | wc -l                         # 813
    MSYS_NO_PATHCONV=1 git show origin/main:.github/workflows/ci.yml | grep -c "docs-only fast path"  # 4

**A `./` in front disarms it, with no variable at all** — the trigger is a dot followed by a NAME:

    git show origin/main:./.github/workflows/ci.yml | wc -l                                       # 813

The PowerShell tool performs no path conversion and needs no variable either: the same two readings
there are **813** and **4**.

**The real answer was 4 of 4.** #4148 — "fix(ci): a docs-only PR no longer skips the tests that
police the docs", merged 2026-09-21 00:36 UTC — had shipped exactly as written, and the session
verifying it was one discarded stderr line away from reporting the opposite.

**The rule this leaves.** Before believing a zero, check that the byte or line count of what you
read is PLAUSIBLE. A 47,311-byte file measuring 0 bytes is the tell, and it is the same
positive-control discipline that catches the `rg` and `git grep -E` zeros recorded above.

**Close cousins in this file.** `tz-africa-cairo-silently-returns-utc-in-msys` is the same shape in
a different MSYS gap — a command that returns a confident wrong value instead of failing; read it
rather than treating this as a separate lesson. "Two ways a search reported zero and meant *I did
not look*" (2026-09-05) carries the positive-control rule that generalises the plausibility check
above. The cue lives in the **Shell and tooling** cluster of
[docs/agents-session-traps-clusters.md](agents-session-traps-clusters.md), and the memory is
`git-ref-colon-path-is-mangled-by-msys-returns-empty` — whose wording, "returns EMPTY", this
measurement corrects. It does not return empty. It fails loudly, on a stream nobody is reading.

**Narrowed the same night, 2026-09-21 (#4153, then #4156).** As first written this account said MSYS
rewrites the argument, full stop. Measuring the boundary made it narrower: only a path whose FIRST
character is a dot. The over-broad form would have had sessions exporting the variable before every
`git show` and reading a correct result as a rescued one — a rule wider than the fault it describes,
which is the same class of error as the zero it documents.

## An empty `~/.claude/projects` was read as "the history is gone" — 2026-09-21

Measured on this machine on 2026-09-21, after the owner reported that every session had started
feeling like a fresh repo with no memory of anything.

**What actually happened.** Two retention keys were added to `~/.claude/settings.json` in the small
hours, where **neither had existed before**:

| Time (Cairo) | Key added | What it prunes |
| --- | --- | --- |
| 03:15 | `cleanupPeriodDays: 7` | `~/.claude/projects` — the conversation transcripts |
| 03:17 | `desktopSessionCleanupPeriodDays: 7` | the desktop app's own per-account session store |

At 03:23 a sweep under the first key removed **1,771 files, 3.877 GB, across 628 distinct sessions**
(459 of them in the Phoenix primary folder); a second sweep at 03:25 took cached tool results. Its
own record — `~/.claude/backups/deleted-transcripts-2026-09-21.txt`, a full `mtime/bytes/path`
manifest — states that the content is not recoverable, and it is right: the Recycle Bin held **0
items** (the delete bypassed it), the Volume Shadow Copy service returned *initialization failure*
with no shadow storage configured, and there were no System Restore points. **The conversation text
was genuinely gone.**

**Why "gone" was still the wrong answer.** The sweep touched ONE store. There are three:

1. **`~/.claude/projects/<slug>/*.jsonl`** — the conversation TEXT. Pruned by `cleanupPeriodDays`.
   442 transcripts survived the sweep, 198 of them in the Phoenix primary folder.
2. **`AppData\Roaming\Claude\claude-code-sessions\<accountUuid>\`** — one JSON metadata record per
   session **per account**: title, folder, model, effort, turn count, archive state, and every pull
   request that session opened with its branch and merge state. Untouched by the sweep, and it held
   **3,410 records across 8 account folders, 3,631 distinct pull requests, reaching back to 9 May
   2026** — four months earlier than the oldest surviving transcript.
3. **`~/.claude/file-history/<sessionId>/<hash>@vN`** — every version of every file a session
   edited. Pruned by NEITHER key. 1,629 versions were still on disk.

Store 3 settled the only question that mattered for the codebase: every recovered version was
hash-checked with `git hash-object` + `git cat-file -e` against the repository, and **all of them
were already in git** except one 655-byte ad-hoc test runner from a scratch worktree — whose two
test functions are both registered in the live `tests/run-tests.ts` today. **No code, no commit, no
branch and no file was lost.** What was lost was the text of the conversations, and the catalogues
built from store 2 now name 3,410 of them.

**The second loss that was about to happen.** `desktopSessionCleanupPeriodDays: 7`, added at 03:17,
governs store 2 exactly — and **2,990 of its 3,410 records were already older than seven days.** The
store that made the recovery possible was itself one interactive startup away from being swept. A
full verified copy (3,454 files, 200 MB, per-folder counts confirmed identical) was taken to
`F:\Claude Recovery 2026-09-21` before anything could run.

**The rule.** An empty or thin `~/.claude/projects` is **not** evidence that a session's history is
gone; it is evidence about one of three stores. Look in all three before telling the owner anything
is lost, and when one store turns out to be the recovery, check its OWN retention key before
assuming it is safe. Raising or removing either key is a `settings.json` edit, which is the owner's
own paste — a session cannot make it for him
(`automode-allow-cannot-authorize-editing-the-permission-config`).

**Where the artifacts are:** [docs/recovery-2026-09-21.md](recovery-2026-09-21.md) — the master
copy at `F:\Claude Recovery 2026-09-21`, a gitignored working copy in the repo folder, and what each
catalogue holds.

`two-session-stores-two-retention-keys`

## Three diffs answered "is any work stranded on this branch", and two of them over-reported — 2026-09-27

Four worktrees were being retired. The only question that mattered for each was whether the branch
held anything `main` did not, and two sessions asked it three different ways on the same branch —
`codex/gate-proven`, tip `b5c76a3a3`, which had **no PR of its own** because a second session had
taken it as the base for #4554 (merged as `76ff12607`). So the standard gate,
`gh pr list --head <branch> --state merged`, returned nothing and could not answer.

| reading | said | what it was actually showing |
| --- | --- | --- |
| `git diff origin/main...codex/gate-proven` | **137 insertions**, 5 files | the branch's WHOLE history since the fork point |
| `git diff codex/gate-proven origin/main` — **unscoped** | **139 lines** | the branch's work PLUS everything `main` deleted since |
| the same, **scoped to the branch's own files** | **6 lines** | the answer |

**Why the three-dot lies.** A three-dot diff is computed from the merge base. A squash merge puts the
branch's content on `main` as one new commit that is not a descendant of the branch, so the merge base
stays at the original fork point for ever. The three-dot diff therefore shows everything the branch
ever did, merged or not, and cannot distinguish the two. This is the `git branch -d` trap
(`git-branch-d-is-not-a-safety-gate-after-a-squash-merge`) in diff form.

**Why the unscoped two-dot lies, and why it is the more dangerous of the two.** `git diff A B` is
symmetric about content, not about authorship: a line `main` has **removed** since the fork appears as
an addition on the branch side, indistinguishable from work the branch added. Here that produced 139
lines of business-review and `ReviewScopeFilter` code — `packLevel`, `payoutPercentageFor`,
`filterParams` — that the branch never touched. That number grows with `main`'s churn and has nothing
to do with the branch at all. The three-dot error is at least waved away as squash residue; this one
shows real-looking code and argues **against** deleting a branch whose work has fully landed, so its
failure mode is a merged branch kept alive indefinitely and a session hunting work that is not there.

**The rule.** Scope the two-dot diff, and **derive the path list rather than choosing it**:

```
git log origin/main..<branch> --name-only          # the files the branch actually touched
git diff <branch> origin/main -- <those files>     # a `-` line is branch content main LACKS
```

Hand-picking the paths is how the same question got a third wrong answer: passing two of the five
files returned **2 lines**, which happened to support the right conclusion for the wrong reason.
Omitting the filter returns 139. Only the derived list returns 6.

**What the six lines were, and why the branch was safe.** Four were a `docs/deployment.md` paragraph
reading "Three hypotheses, not yet separated"; two were a duplicated fragment in
`scripts/check-migrations.mjs`'s rule-2c message. Both had been **deliberately replaced** on `main` —
the paragraph because a later measurement settled all three hypotheses, the fragment by a print on the
check's passing path. So every line absent from `main` was one somebody removed on purpose, which is
the finding, and it is only visible once the count is small enough to read line by line.

**The archive clause, same shape.** `node scripts/new-session.mjs --remove <task>` retires the
worktree and says so; it does **not** push an archive, and `git update-ref refs/backups/<name> <tip>`
succeeds silently in the local `.git`. `git branch -D` then prints `(was <sha>)` as though something
kept it. Nothing in that sequence says the only copy is on this laptop, and the gap becomes visible
exactly when it cannot be checked. Three tips were archived local-only this way on the same day, by a
session that had read the rule that morning. The check is one command, and it belongs **after** the
delete as well as before it:

```
git push origin <tip>:refs/backups/<name>-<YYYYMMDD>
git ls-remote origin 'refs/backups/<name>-<YYYYMMDD>'   # must print the sha
```

`git-branch-d-is-not-a-safety-gate-after-a-squash-merge` ·
`a-squash-merge-makes-a-stacked-branch-rebuild-not-merge`

## `employees` carries dead label columns, and a blank from one reads as a fact — 2026-09-29

`public.employees` holds a denormalized text copy beside three of its links. Nothing writes them.
Measured across all 198 employees on production:

| label | populated | the link beside it | populated |
| --- | --- | --- | --- |
| `line_name` | **1** | `line_id` | 181 |
| `department_name` | **0** | `department_id` | 180 |
| `area_name` | 145 | `area_id` | 174 |

**A read that takes the label reports almost everybody as having nothing, and reports it as a
BLANK.** That is the whole danger: a blank Line reads as a sentence about the person — *this one has
no line* — rather than as a broken read, so nobody investigates it. This is the same defect the
organogram's Team column was burned by on 2026-09-09 (`employees.team_name`, 0 of 107 populated,
105 with a real `team_id`), on the same table, three weeks later.

**`area_name` is the dangerous one, not the dead ones.** At 145 of 198 it LOOKS like it works, which
is how it survived a sweep that caught the other two. Against the link: 29 rows have a link and no
label (a blank on screen), **4 have both and disagree** (a stale name on screen), and 0 have a label
without a link — so preferring the link can never lose information. The four disagreements are what
the label actually is, a snapshot frozen at write time: two resigned reps still read
`Fayoum-Beni Suef`, that territory's name from BEFORE the split, against `Fayoum` on the link.

**Read the link, fall back to the label, never the other way round.** `employee-org-labels.ts` is the
one resolver. The reader in `notifications/email.ts` had the pair inverted (`line_name || lines.name`),
which is harmless only while the label stays empty and backwards the moment one row carries a stale
one.

### The worse defect the dead column was hiding

`app/api/report-it/submit/route.ts` asked `employees` for `name`, `area` and `department` — **three
columns that do not exist.** The table has `full_name`, `area_name`, `department_name`.

🔴 **PostgREST ANSWERS A MISSING COLUMN WITH AN ERROR, AND FAILS THE WHOLE READ — it does not return
null for that one field.** So `data` came back undefined, `emp` was null, and every field resolved to
null: an adverse-event report would have been filed with no submitter name, no department, no line
and no area on it, with a **201** and nothing in the logs. Report It is patient data. Nothing needed
repairing only because `report_it_reports` held 0 rows. The lookup now logs its failure — swallowing
it is what let a select naming three non-existent columns live.

**A select is a string, and nothing else in the system checks that it names a column that exists.**
The typecheck cannot see inside one. That is why the pinning test scans `.from("employees").select(…)`
by text, and why a repo-wide grep for a column name must be anchored to the table: vacation requests,
probation rows, seats, calendar events and the org-placement view all have their own REAL
`line_name`, and a blanket sweep that confuses them with this one would delete live data.

### Dropping such a column is TWO deploys, never one

🔴 **While any read still NAMES the column in its select, the column cannot be dropped** — the DDL
turns every one of those reads into a 42703 the moment it runs, and the failure is total rather than
per-field. The order is: the code stops naming it → that ships and is **confirmed serving** → then
the `ALTER TABLE … DROP COLUMN`. Removing the field from the TYPE as well as the select is what
makes the compiler enforce it; leaving it optional lets a read quietly re-add it and still typecheck.

Before the DDL: take a pre-image table, measure its grants rather than assuming them (a
`create table … as select` copies rows but never RLS), and ask `pg_depend` for dependents **with a
positive control** — `hr_id` returns 96, so an empty result for the dropped column means "nothing
depends on it" rather than "my query is wrong". No `CASCADE`: cascade is what silently removes RLS
policies a sweep missed.

Pinned by `tests/employee-line-is-read-from-the-link.test.ts` (the resolver's order, the selects,
and a text scan of every `.from("employees").select(…)`) and, for the earlier instance of the same
defect, `tests/organogram-team-label.test.ts`. There is deliberately no memory slug for this: the
rule lives here and in those two tests, and `MEMORY.md` is at its budget.

🔴 **The rule has a SECOND HALF, and it only starts applying once the column is gone:
from that moment every OLDER build is BROKEN rather than merely stale.** A build that still names
the column answers 42703 for the whole read, so promoting one is an outage, not a rollback. Three
things can do it: a revert onto an older tree, an out-of-order promotion from a queue that has
piled up, and the Railway dashboard's Redeploy button — which sits one click from every earlier
successful deployment and stays there indefinitely.

Measured 2026-09-29, dropping `employees.team_name`, the fourth and last of these labels. The drop
was gated correctly on the code being CONFIRMED SERVING, and when it ran all three in-flight
deployments post-dated the safe commit — but the deployment from forty minutes earlier was still
listed `SUCCESS`, and that one names the column in the organogram's 16-column employees select.
Redeploying it would have taken every occupant's name off the live seat chart with nothing turning
red: the outage this section exists to prevent, arriving from the opposite direction.

🔴 **And the recovery is NOT the one written for a withheld deploy.** *Do nothing, the next
merge carries production forward* is right when a deploy was refused. It is wrong here, because the
site is broken NOW. Restore the read first and let the deploy sort itself out afterwards:

```sql
alter table public.employees add column if not exists team_name text;
```

An EMPTY column restores the read completely, because the label was dead data to begin with — 0 of
199 rows populated when it was dropped, against 152 live `team_id` links. Once a build at or after
the safe commit is serving again, drop it a second time.

### 🔴 That census was a GREP, the grep missed two, and the owner found the outage before any check

Written hours later the same day, after `line_name` and `department_name` had already been dropped
on the strength of it.

**`src/lib/reports/organogram-au-source.ts` named `department_name` in a 16-column select and
DISCARDED its error.** The moment the column went, that join returned nothing and the organogram
lost every occupant at once: names rendered as **HR IDs**, the Head Office branch (built entirely
from those rows) went empty, and a correctly seated District Manager — `PD-0014`,
`SEAT-PED-DM-UE-1`, occupancy open since 2026-09-11, `is_vacant = false` — drew as a **vacancy**.
Nothing went red. The owner reported it: *"osama is not added in the organo gram still vacanty and
organogram is showingf hr ids not names"*.

**Why a grep could not have found it, twice over:**

- `admin/test-accounts.ts` passes its select as a **CONSTANT** (`.select(EMPLOYEE_COLUMNS)`), so a
  scan that reads the call's argument sees an identifier with no column name in it and calls the
  file clean. Resolve one level of `const` before believing a select is safe.
- The compiler cannot help either: a select is a **string**, and a read that never touches the
  field — this one only mapped rows by `hr_id` — gives the type system nothing to catch.

**Restoring service does NOT have to wait for a deploy.** `alter table … add column if not exists
<label> text` put the empty column back and the read answered 200 again within seconds; it held 0 of
198 values, so nothing was lost or restored but the column itself. Re-adding an empty column is not
a reversal of the decision — it buys the two deploys their correct order back.

**The two guards that replaced the grep, and what each one caught:**

1. A **tree-wide scan** in the pinning test: it walks `src/` and `app/`, anchors on
   `.from("employees")`, resolves a constant select, and asserts it actually reached the tree —
   because a filter that silently matches nothing reports a clean repo it never looked at. It found
   three offenders on its first run.
2. **Probing every distinct select against the live database** — all 99 of them, `&limit=1`, reading
   the status. That found a **second, unrelated live 42703**: `support-requests/service.ts` asked for
   `position_title`, which has never been a column on `employees`, and that read re-throws, so the
   HR recipient lookup could never have resolved anybody. Latent only because
   `employee_support_requests` holds 0 rows. Same defect as the Report It route above, and found
   only by asking the artifact rather than reading the source.

**So: before dropping a column, probe every select naming that table against the live database, and
never let a census be a grep.**

**The tooling for it, since 2026-09-30:** `node scripts/select-census.mjs <table> [--column <col>]`
is the census (any table, constants resolved one import away, embedded relations read with balanced
parentheses, filters and write keys listed, anything it cannot resolve reported UNRESOLVED), pinned by
`tests/select-census.test.ts`. The **`select-auditor`** subagent (`.claude/agents/select-auditor.md`)
runs it, probes every named column against production's catalog with a sentinel as its positive
control, and reports BROKEN / UNVERIFIED / OK. First run, on `employees` that day: 221 call sites, 53
distinct column names, 4 embedded relations, all present on production, and 1 run-time select left
UNVERIFIED (`src/lib/email-templates/custom-variables.ts`).

🔴 **THE PAYROLL AUDIT THE SAME DAY FOUND THE SAME DEFECT CLASS AGAIN, AND IT HAD BEEN LIVE FOR
THREE AND A HALF MONTHS.** Every table the payroll code touches — 31 tables, 601 call sites, 454
column names — against production: `src/lib/calendar/service.ts` asked `v2_vacation_requests` for
**`type`**, which that table has never had (it is `vacation_type`). The whole read 42703s, and
`loadLeaveItems` catches and returns `[]`, so from the calendar's first commit (2026-06-11) **every
employee's approved leave was silently missing from their own calendar** — 551 approved requests
across 92 people. Nothing was red, nothing was logged, and the type system could not see it, because
a select is a string. Pinned by `tests/company-calendar.test.ts`.

🔴 **AND THE AUDIT'S FIRST PASS CRIED WOLF FOUR TIMES OUT OF FIVE — a census that invents findings
gets switched off, and the real one goes down with it.** All four were census defects, now fixed and
pinned in `tests/select-census.test.ts`: an **apostrophe inside a `//` comment** (`the column's …`)
opened a quote that swallowed the statement end, so the scan ran into the NEXT statement and claimed
its filter (`outstation_expense_requests.trip_id`, from an `.eq` 120 lines later on another table);
**`.order("year", { foreignTable: "salary_batches" })`** was attributed to the base table, reporting
`salary_records.year`; **`.delete({ count: "exact" })`** was read as a write payload, reporting a
column `count`; and a chain longer than the cap was half-read instead of reported UNRESOLVED. **The
rule that survives all four: never report a finding you have not opened the file and read.**

## A DDL cannot be attributed to a session, and adjacency in time named the wrong one twice — 2026-09-29

The owner asked a plain question: *find who dropped the two label pre-image tables.* The tables were
`public.employees_team_label_preimage_20260929` and `public.employees_area_label_preimage_20260929`,
taken hours earlier as rollback material for the dead-label drops above, and both were simply gone.

**What the database could answer, and it is more than it looks.** `pg_stat_statements` had not yet
evicted the statements, and `stats_since` on an entry whose `calls = 1` is that statement's execution
time — the entry cannot have existed before its only call. That pinned three drops to **20:14:13
Cairo** in one transaction, and recovered something better than a timestamp: the statement's own
twelve-line comment, headed *"Retiring tonight's three pre-images"*, listing for each table its row
count, its populated-label count, how many labels were identical to the link that replaced them, and
ending `-- No CASCADE: nothing may depend on a backup table, and if anything does I want the
refusal.` **That comment is what proved the drop safe after the tables it described no longer
existed** — 0 of 145 area labels had no link, 141 were byte-identical to the link today, the 4 that
disagreed were already recorded verbatim in the header of
`20260929173000_drop_employee_area_name_label.sql`, and the 199 team rows held no label values at
all because `team_name` was NULL throughout. Nothing unrecoverable went. A ledger row could not have
said any of that.

**What it could NOT answer, which is who.** `pg_stat_statements` aggregates by normalised query text
and carries `userid` and `dbid` — no pid, no connection, no application name. Production does run
`log_statement = ddl`, so the Postgres log holds every `create`/`drop`/`alter`; but **every session's
Supabase MCP connection reports `application_name = mgmt-api`**, so even that log names a pid and no
session. `pgaudit` is not installed, and the `query_logs` tool rejects every log-source name here —
`postgres_logs`, `edge_logs` and `auth_logs` all answer *does not exist* — so the log is
dashboard-only. There was no source that could name a session.

**The trap, and it fired twice.** Lacking identity, the obvious move is adjacency: the statements
30–70 seconds before the drop were a marketing customer-pharmacy GPS audit, so that session did it.
Wrong. Two peer sessions were named in turn and each ruled itself out from its own transcript — the
first with tool-call timestamps bracketing 17:14:13 UTC with no SQL in the window, the second by
counting its production writes (135 `marketing_*` UPDATEs, no `create table`, no `drop table`) and
noting that the two table names had never appeared in its transcript before being asked about them.
The GPS audit *was* the second session's. The drop was not. **One shared table, no session identity:
two sessions working the same database land their statements side by side, and side by side carries
no information at all.** The accusation cost two peer sessions a turn each, and the owner a corrected
answer after he had already been given a name.

**The rules.**

1. **Never attribute a statement to a session from timing.** The database cannot support it, in any
   view, and the inference reads as evidence because the timestamp is real.
2. **Ask the peers** — `ListAgents`, then `SendMessage`. A session can grep its own transcript, which
   is the only record that ties a statement to an author, and it answers in one turn.
3. **Write your reason INTO the SQL.** Not in the PR, not in a doc, not in a memory: in the statement.
   A comment inside a `drop table` survives the object it destroyed, reaches whoever reads
   `pg_stat_statements` next, and is the one artefact that turned "two tables vanished" into "three
   redundant snapshots were retired deliberately, with the loss measured first".
4. `stats_since` **is** usable for a `calls = 1` entry, and only then. For anything called twice it is
   the first sighting, not an execution, and `minmax_stats_since` is not an execution time either.
   **There is no `last_exec` column on this server** — a peer session offered it while correcting
   this reading, and the catalog on PostgreSQL 17.6 has no such thing: `calls`, `dbid`, `queryid`,
   `userid`, `stats_since`, `minmax_stats_since`, and that is the whole of the identity-and-time
   surface.

**The shape worth carrying, in one line: `pg_stat_statements` tells you WHEN with real precision and
can never tell you WHO — and the precision is exactly what makes the wrong answer persuasive.** A
vague timestamp would have invited a question. An exact one, correct to the second and genuinely
derived, made the adjacent session look proven. That is why this is a trap rather than a slip: the
reliable half of the evidence is what lent authority to the half that carried no information at all.

## A source-and-path git command ate the fix it was being used to test — 2026-09-29

The fix was four edits to `scripts/check-required-checks.mjs`, which had to stop printing `OK` from a
stale checkout. Testing the two stale paths needed a tree genuinely behind `origin/main` that still
held the new code, so: detach HEAD to an older commit, then bring the new script back with
`git checkout <branch> -- scripts/check-required-checks.mjs`.

**The edits were not committed.** That command restored the branch's *committed* version of the file —
the one without the fix — over them. No warning, no refusal, and `git status` read clean afterwards,
because the file really did match the ref now.

**What made it cost the work twice rather than once is the direction the evidence appeared to point.**
The test then ran the pre-fix script and printed exactly the pre-fix output: a bare `OK`, no position
line. That is indistinguishable from *the fix does not work*, and the natural next move is to go back
and debug a fix that was already correct. What gave it away was the *shape* of the output rather than
its content — a broken fix would still have printed a `checkout …` line, and there was none — plus a
system notice that the file had changed on disk.

**The general form.** Any git command that names both a source and a path silently prefers the source:

- `git checkout <ref> -- <path>`
- `git restore --source=<ref> <path>`
- `git stash pop` onto a dirty file

None of them is a merge, none of them refuses, and none of them behaves like plain
`git checkout <branch>`, which *does* refuse when it would lose work. Commit first, or copy the file
outside the repo. Never rely on git objecting.

The narrow version is already an owner standing rule under verification discipline: *"A regression test
only counts if you break the fix and watch the NEW assertion fire. Restore the break from a copy —
`git checkout -- <file>` wipes your own uncommitted fix with it."* That lives in `~/.claude/CLAUDE.md`,
so every local session has it. **Cloud sessions do not** — they get the repo and the prompt and nothing
else, which is why the general form belongs in the clusters file.

Same family as the `git checkout --theirs` bullet beside it: a command whose job is to bring content
*in* is also, silently, a command that throws content *away*.

## The second deployment row is STAGING, and two inferences were drawn before that was measured — 2026-09-29

`GET /deployments?sha=<sha>` returns **one row per environment**, so every commit here has two:

```
8a53c2755   row 6744668252   Phoenix-HR-Workforce / production
            row 6744668096   Phoenix-HR-Workforce / staging
f3c444d30   row 6744372404   Phoenix-HR-Workforce / staging
            row 6744372341   Phoenix-HR-Workforce / production
b28639906   row 6743650894   Phoenix-HR-Workforce / production
            row 6743650893   Phoenix-HR-Workforce / staging
```

Both carry `task=deploy` and the description "Deployed to Railway", and the order is not stable — on
`f3c444d30` staging comes first, on the other two production does. So an unfiltered `.[0]` is a coin
flip between two different answers, and it misleads **in both directions**:

- `f3c444d30` was **serving production**, and one of its rows read `in_progress -> inactive`, never
  reaching `success` — §2.3's withheld signature exactly. That was the **staging** row. Production had
  gone `in_progress -> success`.
- `8a53c2755` was the reverse. **Staging** reached `success` inside two minutes while **production** was
  still `in_progress` eleven minutes later. A session reading the succeeded row would have called it
  shipped.

`verify-shipped.mjs` has always been right about this — it filters
`deployments.filter((d) => String(d.environment || '').includes('production'))` before it reports
anything — so the trap only bites a hand-rolled query. Which is exactly what happened.

### The two inferences, because the inferences are what will repeat

**First: the terminal state was read as a history.** The final states of both rows on `e8194079c` and
`b28639906` really are `inactive, inactive`. From that, "and never `success`" was asserted — and never
measured. Asking the full history:

```
e8194079c  row 6744530536   success -> inactive                             ever success: YES
           row 6744350656   in_progress -> success -> inactive -> inactive   YES
b28639906  row 6743650894   in_progress -> success -> inactive -> inactive   YES
           row 6743650893   in_progress -> success -> inactive -> inactive   YES
```

Every one had passed through `success`, so §2.3's tell was correctly silent on two ordinary superseded
deploys. That invented half was about to be offered as a reason to change §2.3 — auto-loaded guidance
every session reads on every request — to say the tell could not be read off a row at all. A peer
session's own query overturned it before it went anywhere. Had it landed, it would have deleted the one
signal that separates a refused deploy from a superseded one, on evidence that confirms the signal
works.

**Second, and one layer down: "two rows" was read as "two production rows".** After the first
correction, the surviving claim was that the tell must therefore be evaluated across *all* of a
commit's rows. That is also wrong, and wrong in a new way — it would have told the next session to
treat a staging row as evidence about production. The count was a fact; its meaning was an assumption,
and one `.environment` field would have settled it at any point.

The shape both share: **a measurement was taken, and then a second claim was reported beside it with
the same confidence, having never been measured.** The first one cost a near-miss on auto-loaded
guidance; the second was caught only because the same commit's deploy was still in flight and its rows
had to be read again.

### The rules

1. **Filter by environment first.** `.environment` must contain `production` before any deploy
   conclusion. Never trust row order — it is not stable across commits.
2. **Ask a predicate, never an index:** `any(.[].state; . == "success")`.
   `GET /deployments/{id}/statuses` returns newest first, so an index reads backwards, and no single
   state implies the states before it.
3. **Staging succeeding says nothing about production.** Measured here at two minutes versus still
   building at eleven.
4. **Two questions, two instruments.** *Did it ship* is ancestry against the live `/api/healthz`
   revision. *Was it refused* is the ever-`success` predicate on the production row. Neither answers
   the other, and §2.3's tell needs no change.
5. The rows **lag** the live domain, they do not stall. A row still reading `in_progress` while its own
   sha is serving means you read it early: do not wait on it, and do not distrust it.

## Four defects in one afternoon were one bug: an absent answer read as a positive one — 2026-09-30

On 2026-09-30 `scripts/rollup-prs.mjs` took nine merges in a day. Six of those merges fixed a real
defect, and **four of the six were the same bug wearing four different names.** That is worth more than
any of the four fixes, because the fixes are specific to one script and the shape is not.

### The four

| PR | What was absent | What it was read as |
| --- | --- | --- |
| #4906 | a PR's required checks had not FINISHED | not red, therefore buildable |
| #4944 | `statusCheckRollup` came back `null` (a PR seconds old) | the fixture branch's default: finished and green |
| #4948 | the required LIST could not be read, or came back EMPTY | nothing objected, therefore everything passed |
| #4948 | a required check with no `startedAt` (a StatusContext, which never has one) | *inverted* — pending for ever, so that member could never be built from again |

The first three are fail-**open**: an unknown read as a pass. The fourth is the same mistake corrected
too hard — a shape that cannot answer the question was refused instead of exempted, which would have
been worse than the hole it guarded, because a PR whose required check is a commit status could never
again enter a roll-up and the wait would always time out.

### Why the third one was invisible for so long

`checksSettled` — the one flag `--apply` builds on — was `red.length === 0 && pending.length === 0`.
That is not "every required check passed". It is "nothing in the list I could see objected", and the
clause that enumerates the required names and calls the unreported ones PENDING can only enumerate a
list it HAS. With `required === null` (protection unreadable) or an empty Set (protection answered with
an empty `contexts` array, which is a *successful* call — the classic array is deprecated in favour of
`checks`, and a rule moved to a ruleset leaves it empty), nothing was enumerated, so the only thing
judging the PR was the loop over the checks that existed. A PR opened seconds ago has none. A PR whose
only reported check is `mobile (skipped)` has none that gates. Both answered two empty lists.

Measured: roll-up **#4937** was opened at 14:49:58Z carrying **#4936**, whose `validate` ran
14:48:14 → 14:51:14Z and whose `checks` ran 14:48:13 → 14:51:48Z. Both required jobs were still
running when the build committed to it, and the squash carried all three of #4936's files. Two empty
lists is the only reading that could have done that.

### The rule, and it is about writing code rather than reading it

1. **Never let "nothing objected" stand in for "the thing that would object was consulted."** Count
   what was CONFIRMED, positively, and require that count to be non-zero. `red === 0 && pending === 0`
   became `red === 0 && pending === 0 && confirmed > 0`, and that one clause closes all three
   fail-open shapes at once.
2. **Zero is the ultimate subset.** A guard written as "all of them must pass" is silently satisfied by
   an empty set. Whenever the set is read from somewhere that can fail — an API, a config, a protection
   endpoint — an empty answer is a changed SHAPE, not a permissive one.
3. **A gate that cannot be read stops the run, it does not soften it.** Reporting may continue on a
   degraded reading and say so; an ACTION may not.
4. **And do not over-correct: exempt the shapes that cannot answer, never refuse them.** A CheckRun
   always carries `startedAt` here, so one missing it is a genuine anomaly and pends. A StatusContext
   never carries one, so holding it to a timing test refuses it for ever. Pin BOTH directions, or the
   exemption becomes the next fail-open.
5. **The two sessions caught each other's, and neither caught its own.** Two sessions were started for
   this defect. The first's diagnosis of #4937 did not reproduce; the second's footprint figure was a
   measurement from earlier the same afternoon quoted as current. Each was corrected by the other, from
   live reads rather than from the claim — which is the same discipline as rule 1, aimed at a peer.

Family: the same sentence as the local-suite/typecheck trap in the Validation cluster — *a signal that
cannot say "I did not look at this" gets read as "I looked and it was fine."* Those invent a success,
an event and a scope; these invent a **verdict**.

### Two more the same afternoon, and they are about READING rather than about that script

Both were found after the four above had been written down, which is the argument for the shape over any
instance: the four were a script's logic, these two are what a session does with a command's output, and
nothing about the roll-up tool is involved in either. **Six, and in every one an ABSENT answer arrived in
the shape of a NEGATIVE one.**

**5 · A pipeline's exit status is the last stage's, so `| tail` turns every failure into a success.**
`node scripts/wait-pr.mjs 4950 --timeout 15 | tail -6` reported **exit 0** while the script had exited
**3** for `SETTLED RED`, and a backgrounded task's notification reports the shell's status — so a red PR
was announced to the owner as a green one. It happened twice that afternoon in two different sessions,
the other time on `| tail -3` around a refusal test that had exited 2. Both were caught only because the
script's own stdout said what had happened; a tool that answered in its exit code alone would have been
believed. This is the `; echo $?` trap in a shape that does not look like it, and it reaches a
short-circuit chain too: `git cat-file -e <sha> | head -1 || echo missing` never runs the `||` branch,
because `head` succeeded — measured here while checking the very guard described below, which left the
guard unmeasured and nearly asserted on nothing. **Redirect and read `$?` from the command itself**
(`cmd > out.txt 2>&1; echo $?`), or `${PIPESTATUS[0]}` where a pipe is unavoidable.

**6 · A 40-character string is not a sha, and the runs API answers `total_count: 0` about a commit that
does not exist.** §2.3 already records that the runs API answers zero silently for a SHORT sha. A WRONG
40-char sha is worse, because it looks like the remedy. A sha assembled by padding out a 9-char prefix
returned `0` runs while the neighbouring real commit returned `1` — a working positive control beside a
reading that matched mode 5's tell exactly, one step from reporting a healthy merge as a withheld
deploy. **The positive control is worthless here:** it proves the endpoint works, which was never in
question. Two free guards, measured, either sufficient:

```
git cat-file -e 040583238ec3…28cf39b   -> exit 1   (fabricated)
git cat-file -e 040583238a00…db98667   -> exit 0   (real)
commits/<fabricated sha>/check-suites  -> 422 No commit found for SHA
commits/<real sha>/check-suites        -> 5 suites
```

`git cat-file -e` costs nothing and runs before any API call; `check-suites` REFUSES an unknown commit
instead of answering about it. Never assemble a sha from a prefix — read `mergeCommit.oid` — and when a
zero appears, ask one of those two before believing it.

### How all six were actually caught

Not by review, and not by either session auditing itself. Two sessions worked this area in parallel and
**each caught the other's, neither its own** — the first's #4937 diagnosis did not reproduce and the
second found the real cause; the second's footprint figure was a measurement quoted after it went stale
and the first re-derived it; the second's StatusContext over-correction was found by the first reading
its diff; the first's line-wise comment strip was found by a ratchet the second's area already had. The
rule that follows is not "review more carefully" — it is that a fail-open is invisible from inside the
window that wrote it, so **ask GitHub, git or the file rather than the message, including when the
message is your own earlier turn.**

## A TS1005 in `tests/run-tests.ts` was invisible to every local run — 2026-09-30

Also 2026-09-30, and it belongs beside the above because it is the same family: a check that never
looked read as a check that passed.

A registration description in `tests/run-tests.ts` was given a double-quoted phrase inside a
double-quoted string. `TS1005`. It reached a PR and was caught by `remote-check.mjs typecheck` on the
box, at 118s, after the local run had reported green.

**The local run had reported green because it never parsed that file.** Both sessions had spent the
afternoon running ONE suite through its exported function —
`import('./tests/rollup-prs.test.ts')` then `runRollupPrsTests()` — which is the right way to iterate
on one suite and never loads `tests/run-tests.ts` at all. The full `pnpm run test` WOULD have crashed
on it immediately: `--experimental-strip-types` erases types but still has to parse, and that file is
the suite's own entry point. Verified by extracting `run-tests.ts` from the broken commit and parsing
it — it throws. So the blind spot is not the suite. It is **running one suite in isolation**, and the
remedy is therefore not a 118s remote typecheck.

Node 24 strips types without executing, so a pure parse of the registry costs 0.337s and involves no
`tsc` — nothing for `bash-guard.mjs` C8 to refuse:

```
node scripts/check-tests-parse.mjs
```

Verified in both directions: it throws `Expected ',', got 'ident'` on exactly the unescaped-inner-quote
shape and passes on the escaped one. `tests/tests-parse-guard.test.ts` pins the guard itself against a
known-bad and a known-good fixture, so the guard cannot rot into one that always passes — which would
be this whole section's own bug, one level up.

### And that test's first version WAS the bug in the section above

One of its clauses asserts that the guard's own code reaches for no compiler. The first version stripped
comments line-wise — `.filter((line) => !line.trimStart().startsWith("//"))` — and
`tests/comment-strip-ratchet.test.ts` failed the PR for it in CI:

```
FAIL no source-pinning test strips comments unsafely — a regex that eats the code it pins,
     or a line filter blind to a comment block
  tests/tests-parse-guard.test.ts strips comments line-wise at line 154
```

The ratchet is right, and right for exactly the reason the section above is about: a line judged by how
it STARTS is blind to a `/* … */` block and to a `//` inside a string, so the clause could report a clean
pin over a file it had only partly read. **A guard blind to a shape reads as a clean pass** — the same
sentence, one level up again. `stripComments` in `tests/support/comment-strip.ts` scans for string and
template state instead of guessing, and is the only sanctioned stripper here.

Proved in BOTH directions after the fix, because a ratchet can be appeased without being satisfied: real
code carrying `const COMPILER = "tsc"` still fires the clause, and a `/* … tsc --noEmit … */` block does
NOT — which is the false alarm the line-wise version would have raised.

No local run could have caught it. `comment-strip-ratchet` resolves stripper → call site → argument →
path across the whole `tests/` tree, so a new offender only appears when the suite runs as a whole —
and the isolated run is precisely what this section is about. That is the honest limit of the 0.3s
parse: it is a parse, and the PR's required checks remain the gate.

## `AGENTS.md` §2.1 Session-level traps — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

**Each line is a cue, not the fact.** The account of every one — measurements, dates, PR numbers,
the diagnosis traps — is in **[docs/agents-session-traps.md](agents-session-traps.md)**; search
it for the hook's wording. Which memory backs which hook:
[docs/agents-memory-map.md](agents-memory-map.md).

**Shell and tooling**

- **`grep -r` of a repo or worktree root (`.`, no path) or its `.claude` gets `--exclude-dir` for node_modules, .git, .next, worktrees and .codex-worktrees ADDED by `bash-guard.mjs` C1 (~3.5 s); a drive, home or Temp root, the workspace folder, `node_modules` and `.claude/worktrees` are still refused; any other named folder, file or small absolute path passes untouched (2026-10-22).**
- **MSYS mangles paths silently, four ways:** `git show <ref>:<path>` returns EMPTY; `grep -c $'\r'` matches EVERY line of a pure-LF file; a `git grep`/`rg` PATTERN holding a leading-slash path matches NOTHING — 41 hits read as 0, i.e. *the code is clean*; and **a NATIVE Windows binary cannot resolve `/tmp` at all** (it is `C:/Users/<you>/AppData/Local/Temp`) — bash writes the file and `wc`/`grep` read it, while `rg` says *cannot find the path* and `curl -o` exits 23. Export `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` first; save with `>` rather than `-o`; never quote a count without it.
- **`git grep -E` is POSIX ERE, where a backslash inside `[...]` is a LITERAL BACKSLASH — so a character class written for `rg` silently matches NOTHING.** Same pattern, same file, measured: `-E` **0**, `-P` **9**, `rg` **9**. The 0 reads as *the code is clean*, and the pattern looks right because it IS right everywhere else. Use `-P`, or keep the class free of `\[`/`\]`.
- **`TZ=Africa/Cairo date` silently returns UTC in MSYS — 3h early, no error**, so recent work reads as old. The tell is a Cairo reading at `+0000`; the clock is ALREADY `+0300`, so use plain `date` or node, never `TZ=`. `tz-africa-cairo-silently-returns-utc-in-msys`
- **A role probe cannot trust the HTTP status code**, and **a POST to ANY `/api/**` path returns 403 even when the route does not exist** — probe with GET.
- **`curl -d "@-"` creates NOTHING on Windows** — write the JSON to a file, pass `-d @file.json`.
- **`pg_dump` piped through stdout on Windows writes CRLF into every `COPY` row — exit 0, plausible size, empty stderr, and the restore puts a stray `\r` in the last column of every row.** Use `pg_dump -f <file>`, which writes clean LF, and verify the archive's row counts against the live tables *before* the drop.
- **Reads of `.env*` are auto-approved deliberately, for EVERY key** — licence to inspect, never to propagate. Do not re-litigate or narrow it.
- **A permission allow-rule stores the LITERAL command, so an inline env var bakes a live credential into `settings.local.json` in plaintext.** Grep `settings.*.json` for `TOKEN=`/`KEY=`/`SECRET=` before sharing or merging.
- **`mcp__supabase-staging__*` is broken** — route staging work through `mcp__supabase-production__*` passing the staging `project_id`.
- **The Supabase MCP returns ONLY the last result set of a multi-statement `execute_sql`** — earlier ones vanish with no error, so a block that verifies in statement one and summarizes in two certifies a check you never saw. One question per call.
- **A Windows USER env var SHADOWS every `.env.local`, silently.** Re-probe all three; never print the value.
- **The local attendance agent dies at EVERY logon and loses NOTHING — do not escalate it.** Never disable the 2-hourly task, never launch a second agent (it can fire a PRODUCTION sync).
- **ExcelJS emits two schema-invalid OOXML fragments, so Excel silently REPAIRS the workbook** — both need the `.xlsx` zip post-processed. **Never HUNT it — Excel NAMES the part in `%TEMP%\error<digits>_01.xml`.**
- **LOOKING at a generated workbook has THREE modes that LIE, and the third lies the OPPOSITE way — a BROKEN file reads as CORRECT.** `--convert-to png` renders only the LEFTMOST columns and an ExcelJS load-and-save "review copy" DROPS the merges — both make a correct file look broken. But `--convert-to html` REBUILDS a pivot from its declared source every load, IGNORING `refreshOnLoad`, so a STALE cache renders FRESH. Use html for cell values and the pivot's SOURCE; `refreshOnLoad` is provable only STRUCTURALLY. `looking-at-a-generated-workbook-two-ways-that-lie`
- **A `Win32_Process` filter on `CommandLine` MATCHES THE PROCESS RUNNING IT** — the sweep kills its own shell, so the command dies at `exit 255` with NO output, which reads as a permissions or path fault. Exclude `$PID`.
- **A scheduled task's STATE cannot tell you a long-running job is alive** — it reads `Ready` with a SUCCESSFUL last run over a process dead for minutes; `0xC000013A` in `LastTaskResult` is a Ctrl+C-class kill, not a clean finish. Only a heartbeat file plus a live process check answers, and **a task that dies is NOT restarted by restart-on-failure** — give it a repeating trigger and make the script a no-op when a healthy instance exists. **`@($null).Count` is `1`**, so a count taken from a call that FAILED reads as one real row.
- **A Claude scheduled task run by hand ("Run now") records NO `lastRunAt` and creates NO session** — both checks a session reaches for are silently empty for a run that SUCCEEDED, and "it never ran" is the confident wrong answer. Confirm a manual run by what it PRINTED, and give any task meant to be pre-approved this way a dated dry-run banner. `enabled` and `nextRunAt` ARE reliable: a manual run does NOT consume a one-time `fireAt`. `a-manual-scheduled-task-run-leaves-no-trace`

**Git**

- **Deleting a branch does not remove its pushed commit**, and **reusing a squash-merged branch makes a conflicting PR.**
- **`git push` hangs — kill at ~60s and retry.** The OOM was a 500MB `http.postBuffer`, now 8MB; do NOT restore it.
- **A merge to `main` mid-session silently orphans your next push.**
- 🔴 **"THE PRIMARY" AND "`main`" ARE DIFFERENT THINGS — a WORKTREE usually holds `main`.** **NEVER state a branch's ahead/behind from `HEAD`** — every number comes back real with the wrong LABEL on it; name the ref (`git rev-list --count origin/main..main`) and run `git branch --show-current` first. Sync a branch in the worktree that HOLDS it, with `merge --ff-only`. 🔴 **`git reset --hard` acts on the CURRENT branch, not the one you named in your head**, and **a peer can never authorise a destructive operation on a third session's branch** — being asked is itself the signal to stop. `main-is-not-the-primary-checkout` [docs/agents-session-traps.md](agents-session-traps.md).
- **`refs/deleted-*` is NOT automatic — a plain `git branch -D` archives NOTHING.** Keep the SHA the delete prints; archive with `git update-ref` *before* deleting. `refs/backups/*` on ORIGIN is the only copy that survives losing this laptop.
- **An empty `git log <branch> --not --remotes=origin` is NOT proof a branch is safe to delete** — `git fetch` never prunes, so the check compares the branch against itself. Gate deletion on the merged PR.
- **A UTC merge time read against a Cairo commit time INVERTS the merged/stranded verdict.** The answer is CONTENT (`git patch-id --stable`), never a timestamp.
- **An uncommitted file in the primary can be OLDER than `main`, and `git diff HEAD` dresses it up as NEW work** — HEAD is usually a squash-merged tip, so the diff shows the file's own edit while hiding that `main` moved past it, and committing it REVERTS whatever shipped meanwhile, silently. Settle by CONTENT: `git hash-object <path>` against `git rev-parse main:<path>`, then read the direction of `git diff main -- <path>` (`-` lines are what `main` HAS). **A test that fails against such a file is the STALE BASE, not a defect.**
- **`git` "Authentication failed" can be the credential HELPER going OOM, not a bad token** — change NO credentials.
- **`F:\PHX backup` is the disaster-recovery set, and a bundle restore silently returns ZERO refs without `core.longpaths`.** Three of its sections hold LIVE keys.
- 🔴 **THE STASH STACK AND THE `rerere` CACHE ARE ONE PER REPOSITORY, NOT ONE PER WORKTREE** — both live in the PRIMARY's `.git` and neither shows in `git status`. **`git stash push <untracked path>` creates NO entry** (it needs `-u`), so the `pop` after it takes ANOTHER SESSION'S stash. Identify an entry POSITIVELY before deleting it, **never `git rerere gc`**, and **never stash for a branch move** — `git switch -c` carries the work across. [docs/agents-session-traps.md](agents-session-traps.md).

**CI and PRs**

- **CI jobs failing in SECONDS mean billing, not code.**
- 🔴 **THERE ARE TWO REQUIRED CHECKS — `validate` and `checks` — AND `secret-scan` IS NO LONGER ONE OF THEM.** `mobile` and `secret-scan` were **demoted 2026-09-29**, and the same change took both off `pull_request`: neither blocks a merge and neither reports on a PR, so their absence from a PR and from a merge commit is CORRECT. They run on `main`, a schedule or a dispatch — a finding there is a fix-forward nothing stopped at the merge. 🔴 **`lint`, `typecheck` and `test` are STEPS since 2026-09-27 (#4527), NOT check names — read `branches/main/protection/required_status_checks` live, never a doc.**
- **`gh pr checks` LAGS behind the real job state.**
- **`check-runs: 0` also means CONFLICTED** — a conflicted PR runs no CI at all, which reads as "not started".
- **ONE new hub page trips FOUR separate CI gates.**
- **A red `main` still builds, ships and serves perfectly**, and a green PR is not a green `main` — after merging, check the run on `main`'s NEW head.
- **A docs-only PR's `validate` runs NO tests — it skips the expensive steps, ~10s.** The fast path is `pull_request`-ONLY, so the suite's FIRST run is the push to `main` — production's branch. Three PRs shipped `main` red this way; a `validate` under ~30s is the tell.
- **Runs NEVER CREATED is an Actions OUTAGE, not billing** — billing creates the run and fails it in seconds. Check githubstatus BEFORE touching the spending limit. A `workflow_dispatch` run never enters a PR's `statusCheckRollup`.
- **Recover a PR with `gh run rerun <id>` on its OWN `pull_request`-sourced run** — it keeps the `event`, so its checks DO reach the rollup. Then WAIT: dispatch lags 20–30 MINUTES during an outage and events are NOT dropped. Fire ONE recovery event and leave it.
- **An extra SHA does not merely waste a run — it ACTIVELY KILLS the real head's**, because `ci.yml`'s concurrency group is the same for every commit on a PR. Never push an empty commit to force a `synchronize`.
- **`actions/runs?head_sha=` needs the FULL 40-char SHA** — an abbreviated one returns `total=0` with no error.
- **A push to `main` during an outage ships to PRODUCTION with no CI run at all.** Recover with `gh workflow run ci.yml --ref main`.
- **The GitHub repo is `phoenix-people-workforce`; the FOLDER, npm package, `supabase/config.toml` and dead GCP project are all `phoenix-workforce`.** A path built from the checkout name 404s, which reads as *the deploy never happened*. `gh repo view --json nameWithOwner` settles it.

**Migrations**

- **A migration FILE written is not a migration APPLIED**, and **a merged migration file does not mean the grants are live.**
- **Migration timestamps COLLIDE across parallel branches, and CI judges the MERGE ref — so a green `check:migrations` flips RED with NO change from you, over a file that is not on your branch at all.** Reproduce by extracting main’s copy in; a green local suite cannot see it, and the second red on a PR is NOT the first one again. And **the ledger version never matches the filename — ask the ledger by NAME, and READ the row: one embeds its old filename in `name`.** A prefix lookup reported 11 of the 12 newest files *not applied* when 10 of those 11 were. **Applied-state also FLIPS mid-PR**, so re-read it before asserting one durably.
- **A PostgREST `.in()` fails 3 ways: ZERO rows and NO error; `22P02` on ONE null id; headers over ~16KB.** Chunk at ~50, drop nulls.
- **A `neq` against an ABSENT jsonb key matches ZERO rows**, and **an unbounded `.select()` stops at 1000** with no marker. Write the OR-form; `count(*)` before trusting any select, then page with an explicit `.order()`.
- **`n_live_tup` is STALE in production — it reports LIVE tables as empty.** Sweep with a real `count(*)` via `query_to_xml`.
- **A Supabase client request that times out at 15s STILL COMMITS**, leaving a half-applied state with no audit row. Do heavy multi-step mutations in ONE `plpgsql` function.
- **A missing TABLE answers `PGRST205`, NOT `42P01`** — so the obvious guard fires never and the deploy-before-migration window 500s a whole page. Treat both codes as one set behind one helper. `a-missing-table-answers-pgrst205-not-42p01`

**Database, grants and RLS**

- **A write REVOKE does NOT make a table read-only** — `ON DELETE CASCADE` and `SECURITY DEFINER` both run as the table OWNER, and `has_table_privilege` sees neither bypass. Fixed on prod; **do not redo or undo.**
- **An append-only table needs a STATEMENT-level `BEFORE TRUNCATE` trigger** — `TRUNCATE` fires no ROW triggers, and a revoke never binds the OWNER. Prove all three verbs are refused.
- 🔴 **A dependency sweep over views, functions, triggers and FKs MISSES RLS POLICIES, and `DROP … CASCADE` then deletes them SILENTLY** — and cascade is what Postgres's own HINT tells you to use. A policy's expression is a surface of its own (`pg_policy.polqual`/`polwithcheck`), so a clean sweep reads as *nothing depends on this*. Ask `pg_depend`, which sees every surface at once, and **carry a POSITIVE CONTROL**: without that contrast an empty result is indistinguishable from a broken query. [docs/agents-session-traps.md](agents-session-traps.md).
- **RLS on with no `authenticated` grant is the NORM here — ~4 in 5 public tables (258 of 326, 2026-09-04) — not a defect class to sweep.**
- **ONE `auth.users` row with `banned_until = 'infinity'` 500s the ENTIRE GoTrue admin API** — page-shaped, so a small `per_page` probe passes. Retire with the app's finite `876000h`.
- **`au.f_monthly_achievement` SERVES A PRECOMPUTED ROLLUP, and its fingerprint covers the CONFIG surface — NOT the sales data.** So repairing an import or rollup row changes NOTHING on Sales vs Target or its five siblings — no error, no staleness marker, the old number just keeps coming. Run `au.f_refresh_monthly_attribution(period)` after ANY sales-row repair, diffing stored against live first so the refresh is a check, not a hope. `attribution-rollup-fingerprint-ignores-the-sales-data`
- **The ATS data model carries four traps that each read as normal.** The offer chain was live in the registry with a HOLE past `approved_at`; the `ats_candidate_*` children have NO FK and one is a VIEW; a CV RE-READ never wrote what it read (`applied_fields` is NOT the writer); and `medical_rep` reads 12 fields where `universal` reads 38. **NEVER raw-SQL `national_id`/`email`/`phone`** — the `_norm` dedupe index is app-maintained. `offer-chain-was-live-in-the-registry-with-a-hole-past-approval` · `ats-candidate-children-one-has-no-fk-and-one-is-a-view` · `cv-extraction-reads-governorate-but-never-applies-it` · `the-medical-rep-cv-schema-reads-12-fields-universal-reads-38`
- **A CV import OVERWROTE a candidate's whole identity — detect it with a per-candidate SENDER COUNT, where healthy is 1.** The allowlist holds an INBOX, not a sender, so never resolve a CV by sender; and the CV file lives in `ats_files`, NOT `cv_external_url`, which is empty for EVERY candidate and reads `NO FILE`. `a-cv-import-overwrote-a-candidates-whole-identity` · `the-email-import-allowlist-holds-an-inbox-not-a-sender` · `cv-file-is-in-ats-files-not-cv-external-url`

**Probing, attributing and reporting production**

- **A 200 from a health endpoint can be blind to the thing that is broken** — OpenAI's `/v1/models` certifies a key with no balance. The BILL cannot be read from the API at all.
- **`app_error_events` returning 0 rows means QUIET, not broken.** Prove the route with 405 against a 404 control; never POST a synthetic error to production.
- **A client-error census by MESSAGE reads iOS-ONLY on an every-platform failure** — masking blanks the Android and desktop messages and spares iOS WebKit's, so every legible row is an iPhone: 112 Android vs 39 iOS, ONE cause. Group on the STACK; never platform-predicate the FIX. `census-client-errors-by-stack-not-message`
- **The Error Monitor HIDES rows whose `environment` is NULL**, and a `create table … as select` copies rows but never RLS — **measure the new table's ACL, never assume it either way.**
- **`updated_by_hr_id` LIES about who wrote a row.**
- **HR ids are MIXED CASE, so a plain `.eq` silently under-returns** — one `.eq` hid 28% of reps' own orders, and on `au.occupancy_history` the loss is TOTAL (0 of 120 join), where a row matching nobody reads as *a vacant seat* rather than a bug. Lower BOTH sides.
- **The Sato logo's wordmark is WHITE, so "SATO" vanishes on white paper.**

**Validation**

- **A repo-wide pattern sweep must grep the TESTS for the old string too — a pinning test can pin the ANTI-pattern.** `runTest` rethrows, so a loop over N routes reports only the FIRST. Run `git grep -l '<the exact old line>' -- tests` first.
- **A test name appended beside an existing one in `tests/run-tests.ts` becomes an ARGUMENT, not a registration — and a MERGE CONFLICT is the commonest route to it.** Every new-test PR appends at the SAME anchor, so git puts the conflict INSIDE one `await runTest(` call: keeping both sides yields ONE call taking four arguments, which compiles, goes green, and silently retires the OTHER PR’s test. One `await runTest(name, fn)` per test; check by AST.
- **`node --test <file>` on this repo's suites passes VACUOUSLY** — each is an exported function registered in `tests/run-tests.ts`, so a file with no `test()` call reports `pass 1` for merely IMPORTING. It reported pass on a check deliberately broken. Call the exported function, and prove RED before quoting a local green.
- **RAM-saturated? WAIT — do not skip validation for it.**
- **Source-pinning tests slice a fixed BYTE window and false-FAIL** when the file shifts.
- **A heredoc eats backslashes** and yields a test that only ever passes.
- **`parseDiagnostics` is SYNTAX-ONLY — it cannot see a typecheck error.**
- **A local typecheck printing ZERO errors can mean it never TYPE-checked at all.** A truncated `.next/dev/types/routes.d.ts`, what an interrupted dev server leaves, stops `tsc` after the SYNTAX pass, so filtering `^\.next/` out reads as a clean 0 while CI goes red. The tell is `TS1005`/`TS1160`/`TS1161` under `.next/`. **Delete `.next` and re-run — never filter it away**, and treat a syntax error ANYWHERE as "the semantic pass did not happen". 🔴 **A BACKGROUNDED one fails the same way for a second reason: `node` is NOT on the background shell's PATH here, so `node …/tsc` exits 127 while the pipeline's LAST stage reports 0 — a run that never happened reads as clean, and was quoted to the owner as proof.** Run it in the FOREGROUND and print `node --version` beside the exit code. `typecheck-incremental-false-green`
- **`setState` inside `useEffect` is a lint ERROR here.**
- **A green TEST run carries NO type signal** — `pnpm run test` strips types. Only the PR's `typecheck` job answers.
- **The SUITE runs with PRODUCTION credentials while a test sets `APP_ENV=production`**, so any module writing on `isProductionRuntime()` writes to PROD from `pnpm run test`. Gate such a write on `PHOENIX_TEST_SUITE`. `the-test-suite-runs-with-production-credentials-and-app-env-production`
- **A test can NEVER hand a function a `process.env` literal** — both spellings fail, and each error only surfaces once you have fixed the other.
- **An exhaustive `Record` does NOT gate the build** — `ignoreBuildErrors` lets a missing key compile, build and DEPLOY. Back it with a RUNTIME assertion in a registered test.
- **A narrowed SELECT disarms every gate downstream of it** — test the SELECT, not the branch.
- **An OPTIONAL field written UNCONDITIONALLY is a silent erase.** The PATTERN regenerates, not the two fixed call sites.
- **A feature can ship green, deploy cleanly, and be reachable by NOBODY — and zero usage is what both look like.** Exercise the path end to end before concluding it is adoption.
- **A merged fix on a path nobody has exercised is untested, not proven.**
- **`cn()` SILENTLY DROPPED every `text-phx-*` size, and only `getComputedStyle` in a real browser can see it.** The literal `text-[13px]` form was always safe: **the rename to a named size is what creates the bug.** `tailwind-merge-strips-custom-named-font-sizes`
- **Arabic + English in ONE value needs direction PER LINE; `dir="auto"` on the block is the WRONG fix** — `auto` reads only the FIRST strong character, so the ENGLISH half renders backwards, the exact mirror of the bug. SINGLE-language free text is the opposite case: block-level `dir="auto"` is correct there, and house style. Measure production for Arabic before "fixing" a screen. `bilingual-bodies-need-direction-per-line-not-per-block`
- **A UI `timeZone: "UTC"` has THREE causes and only ONE is a bug — a blanket Cairo fix breaks all 43 remaining sites.** DATE-ONLY (a `date` column, a period key, a window bound) parses as UTC midnight, so UTC is what STOPS the calendar day shifting; a VENDOR wall-clock (`crm_save_date`, `check_date`) is ALREADY Cairo, so Cairo renders it 2–3h LATE; only an instant WE stamped belongs in Cairo. **Classify by the BACKING COLUMN, never by the formatter name** — `cairoMinutesOfDay()` reads UTC on purpose. `ireports360-timestamps-cairo-local-mislabeled-utc`
- **VERIFY THE EMITTED ARTIFACT, NEVER THE SOURCE — three defects shipped in ONE night from this, all green.** An escaped slash in a template literal, a font stack fixed in the body but not the footer's own copy, and a QUOTED font stack that closed a `style=""` and deleted the footer — each "verified" by reading the SOURCE. **Export the generated constant and assert on THAT**; compile an injected script with `new Function`; render the PDF and read the page count back. `verify-the-emitted-artifact-never-the-source`
- **`@/lib/utils` resolves to the ROOT `lib/utils.ts`, NOT `src/lib/utils.ts`** — editing the `src/` copy changes nothing, with no error. `at-slash-lib-shadows-src-lib-via-tsconfig-paths`
- 🔴 **A killed workflow run is RECOVERABLE — never write one off.** The missing agent LABEL reads as "a partial verdict cannot be mapped back to its finding"; that conclusion was written twice and threw away two runs' work. The journal carries `agentId`, and **`journal.result → agentId → transcript → first prompt → the finding`** closes it. Gate it on controls including a NEGATIVE one, and **never let an agent that DIED score a finding REFUTED**. [docs/agents-session-traps.md](agents-session-traps.md).

**Memory and this index**

- **Sweep memories by CLAIM, never by filename or topic**, and never rewrite a dated record.

**Parallel sessions**

- **A parallel session can collide with NO git trace at all** — `gh pr list`, `git log` and `git worktree list` were all clean while another session edited the same file. Read the SessionStart working-tree line as a collision signal. A lock's dead PID proves NOTHING — it is the hook's own parent shell, so every lock has one; staleness is AGE >2h, and even a stale one does not prove the folder is unattended. Resolve by MERGING, never discarding.
- **ONE approval can reach SEVERAL sessions — N sessions holding the same "yes" is N executions.** Before executing a protected action on a terse approval, check how many sessions are live, say so, and re-verify the target immediately before acting. `mergedBy` naming the owner is NOT evidence of a human click.

**Worktrees** (see also §5)

- **Another SESSION can remove a worktree under you.**
- **A gitignored `_wt-*/` scratch folder makes a worktree look clean.**
- **The pre-push gate is GONE — a bare worktree pushes fine.** What it cannot do is RUN a suite.
- **`--fix` needs exactly ONE live session; `--strip-idle` does NOT** — it gates per worktree on dirty/unpushed/120-min-idle behind a lock, so RUN it with sessions open. **`--fix` can still FAIL on a locked husk** — then use `rmdir /s /q` from PowerShell, not Bash.
- **`--force` is the flag BOTH guards name in their OWN failure text, and it turns the concurrency check OFF.** The `--fix` census refuses at >1 session and this machine runs ~11, so **refusing is the NORMAL state and `--force` becomes the habitual answer**, which is how the guard erodes. The risk is never a wrong deletion (the zero-file proof is ungated) — it is two sessions cleaning at once, the one pattern that has lost work here. Close the others instead. The census **fails CLOSED**, so the same message appears when nothing is wrong.
- **`--repair` SKIPS every `.claude/worktrees/` path, and `ready()` counts a REAL `node_modules` as fine** — so a stray `pnpm install` there is invisible to BOTH tools, and `--remove` refuses the path too. The only tell is repo-doctor's file count against its siblings. Fix BY HAND: `rmdir` the real directory, then `mklink /J` to the primary's.
- **repo-doctor's RETIRABLE verdict names the branch a folder HAD at scan time.** Treat any scan older than the current command as fiction — re-read at the moment of removal.
- **Every retirement gate can PASS on a worktree in active use** — nothing catches a live PROCESS. Two signals see what the gates cannot: the newest mtime under `.next/`, and HEAD moving between the gate read and the removal. Read the tip at the GATE and reuse that SHA.
- **Closing a session does NOT release its worktree, and the release is not INSTANT** — `git worktree remove` then fails *Permission denied*, deregisters anyway, and leaves the husk. **The holder IS findable** (`scripts/find-worktree-holder.ps1`), and **`list_sessions` MISLEADS here** — cross-check by BRANCH against every open PR. 🔴 **A holder can be UNKILLABLE — ARCHIVE the owning session, which ends it with NO reboot**; it survives `Stop-Process`, and a reboot is never worth a husk holding no files. A session can NEVER clear its own husk. **NEVER kill git machine-wide.** [docs/agents-session-traps.md](agents-session-traps.md).
- **A DEREGISTERED worktree is worse than a husk — a shell still sitting in it resolves git against the PRIMARY checkout**, silently, so a commit lands on PRODUCTION's branch with no error. **`cd` cannot escape it** — address the real repo with `git -C <path>`. **Path-filtered reads LIE there, and a POSITIVE CONTROL does NOT catch it**: the read can come back EMPTY, but it can also SUCCEED with the PRIMARY's copy of a path that lives in both, and that half has no tell — a control proves resolution WORKS, never WHICH repository answered. The one reliable check is `git rev-parse --show-toplevel`. [docs/agents-session-traps.md](agents-session-traps.md).
- **A squash-merged branch reads as "on NO origin ref" — that means BACKED UP, not stranded.** Never push a merged branch to "rescue" it; `git branch rescue/<name> <tip>` is the zero-risk move.
- **Self-removing a worktree MUTES its own session-end guard — and a `.claude/worktrees/` one canNOT retire itself at all.** `ExitWorktree` no-ops on a worktree it did not create that session, and `change_directory` refuses to move a pinned session, so its own cwd holds the folder. **So strip the payload FIRST, while you still can**: drop the junction with cmd's NON-recursive `rmdir` (never `Remove-Item -Recurse`, which can follow it into the primary), then `.next`. Only a ZERO-file husk is what `--fix` will clear.
- **`next dev` in a worktree needs the explicit `--webpack` flag** — TURBOPACK rejects the §5 junction, not Next; `pnpm run dev` now chooses for you (`scripts/dev-server.mjs`). **The watchdog's 6 GB kills are a THRESHOLD problem, not a bundler trait.** 🔴 **`--max-old-space-size` DOES bind the dev server** (corrected 2026-09-21 — the old "measured no-op" was read from a plain `node`): Next gives its server HALF OF RAM unless `NODE_OPTIONS` caps it, so start it with `node scripts/dev-server.mjs --port 3000` (4 GB cap); `bash-guard.mjs` C7 refuses a raw `next dev`.
- **`gh pr merge` from a worktree exits NON-ZERO after the merge SUCCEEDED.** `fatal: 'main' is already used by worktree` is its LOCAL post-merge step, never the merge, and it fires on EVERY merge here since the primary holds `main`. Treat a non-zero exit as UNKNOWN, not failed: `gh pr view <n> --json state,mergeCommit`; `MERGED` means done. Never retry — that errors on an already-merged PR and reads like a worse failure. `gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded`

**Next.js runtime**

- **A >2MB `unstable_cache` entry KILLS the dev server** — throws only in dev, uncatchable, muted in prod.
- **`unstable_cache` SERIALIZES, so a returned `Map` comes back `{}`** — the page works on exactly ONE render, then throws for the whole revalidate window, rendered as the admin error boundary (which reads as a permission redirect). Cache the ROWS.
- **Standalone tracing copies FILES, not pnpm SYMLINKS**, and **a top-level `import sharp` 500s a whole PAGE** when the `.so` is missing.

**Browser and dev-auth**

- **A MINIMIZED window makes every browser reading LIE — check `document.visibilityState` FIRST.** rAF stops entirely, so **dnd-kit cannot run at all** while plain `.click()` still works. `javascript_tool` does not await a returned promise, and the isolated world cannot see React fibers.
- **A COLLAPSED PANE is worse than a minimized window: the page sticks on "Loading workspace" and EVERY element measures 0** — server 200, content in the DOM, widths zero. Next streams it as a `<div hidden>` whose reveal is rAF-gated, so `style.display` LOSES to `[hidden]`: remove the ATTRIBUTE, and find that wrapper by what it CONTAINS. Carry a POSITIVE CONTROL — `innerWidth`/`main.clientWidth` must equal the size you emulated. Only the app's own UI opens the pane. `collapsed-browser-pane-reads-zero`
- **Click by TEXT — blind coordinate clicks once fired a real production collection run.**
- **Dev login is `GET /api/dev-auth?role=<Role>`, and it DOES role-switch the Browser pane** via an httpOnly cookie. **It DOES take `hrId`** — `?role=National%20Sales%20Manager&hrId=a-12&next=<path>` signs you in as THAT person, the only way to verify anything scoped to one manager's team. **Header-only is the SEPARATE `x-phoenix-*` path**, which the pane cannot set; that is what role SWEEPS use.
- **Turbopack 500s with `0xc0000142` when the commit charge is exhausted** — close a session, do not debug the code.
- **Verify a 375px mobile layout with NO dev server.**

**Machine ceiling**

- **A freeze leaves NO dump** — an EMPTY Windows Minidump folder is the EXPECTED signature, and the tell is `dwm.exe` dying `0xC00001AD`. The ceiling is COMMIT, not RAM; §5 carries the mechanics and the live-read rule. **Never judge a process by `VirtualSize`.**
- **Two decoys sit on that diagnosis:** `nvlddmkm` is what dies when the compositor is starved, not the cause; but the `node.exe` figures in **Event 2004 ARE real**. The largest leak so far is a throwaway ExcelJS probe (22 → 41 GB in 40s, off-heap). Delete such probes when done.
- **An interrupted session leaves the tree BROKEN ON PURPOSE.** Before acting on a bare "commit it", `git grep BREAK-`.

## A PR's file size read against today's `main` invented a blocked merge — 2026-10-01

The owner had just merged two Phoenix CRM fixes and asked what was next. Three PRs were open, all
green, and two of them touched `AGENTS.md` — which is graded in CI against a hard ceiling
(`AUTOLOAD_REPO_SHARE`, 150,000 − 24,400 = **125,600** bytes for `CLAUDE.md` + `AGENTS.md`, asserted
by `tests/autoload-footprint-budget.test.ts` inside the required `validate` job).

So the footprint was worth checking, and the check was run on the wrong baseline:

| read | `AGENTS.md` | conclusion drawn |
| --- | --- | --- |
| `origin/main` | 115,081 | 781 bytes of slack |
| `refs/remotes/pr/5088` | 115,716 | "#5088 adds **+635**" |
| `refs/remotes/pr/5090` | 115,338 | "#5090 adds **+257**" |

124,819 + 635 + 257 = 125,711 — over by 111. That was reported to him as a measured fact, with the
consequence spelled out: merge both and `main`'s own required check goes red, and a red `main` CI
makes Railway withhold the production deploy silently (§2.3). He was told to merge one and that the
other needed 111 bytes freed first.

**Every byte in that table is real and the arithmetic between them is fiction.** #5088's branch was
based on `3d5f6bd15`, where `AGENTS.md` was **115,848** — 767 bytes larger than `main`, because
#5089 had landed in between and moved the deploy-gate evidence out into its account. A squash merge
applies the branch's **diff**, not its file, so #5088's delta was **115,716 − 115,848 = −132**. The
merge made `main`'s copy *smaller*: 115,081 → 114,949. Nothing was over budget, nothing was blocked,
and the warning described a failure that could not occur.

### Why nothing catches it

- Both PRs read **green**, correctly: each check grades its own tree, and each tree was under the
  ceiling. The gate was never going to fire.
- A **positive control** proves nothing here. Both file reads succeed and return true byte counts;
  what is wrong is the subtraction, which no query validates.
- The error is **invisible in the direction that matters**. It over-reports: it argues against a
  merge that was safe. A session that believed it would have held a green PR indefinitely and asked
  the owner for a trim that nothing needed.
- It reached the owner **as advice**, in a table, with a production consequence attached — the shape
  his standing rules exist to prevent (`docs/agents-owner-rules.md`: being confidently wrong is what
  costs a day).

### The guards

Either one answers in a second:

```bash
# the delta a squash merge will actually apply
base=$(git merge-base origin/main refs/remotes/pr/<n>)
echo $(( $(git cat-file -s refs/remotes/pr/<n>:AGENTS.md) - $(git cat-file -s $base:AGENTS.md) ))   # -132

# or read it off the diff, with THREE dots (merge base), never two against today's main
git diff --numstat origin/main...refs/remotes/pr/<n> -- AGENTS.md CLAUDE.md
```

Measured the same evening: the merge-base form printed `-132`, against the `+635` the absolute
comparison had implied.

**And a margin printed by a hook or a script is about the tree it measured.** #5092 shipped that
same night to make the enforced-footprint margin say which tree it read, for exactly this reason:
the SessionStart figure (`125,586 of 125,600 — 14 bytes left`) was read from the local primary
checkout, one commit behind `origin/main`, where the number was 124,819 with 913 free. Neither
figure is wrong; neither is a statement about a PR's merge result.

**The cue lives in the CI and PRs cluster** of
[docs/agents-session-traps-clusters.md](agents-session-traps-clusters.md). It is the same shape as
the short-sha trap in that cluster and the stale-citation shapes in the memory cluster: a true
number, read against a baseline it was never measured on.

## `AGENTS.md` — the full wording condensed out on 2026-10-08

AGENTS.md loads on every request and again after every compaction, so on 2026-10-08 these lines were shortened to their rule. Nothing was dropped: each block below is the wording as it stood, word for word, and the rule it carries is still in AGENTS.md. Search here for the evidence, the owner's words and the measurements behind a rule.

### §2.1 — Session-level traps (the prose above the slug roster)

**The traps themselves moved to [docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md) — they are DELIVERED, not dropped.** `.claude/hooks/trap-injector.mjs` is a PreToolUse hook that reads what the session is about to run and injects the matching cluster's **headlines** once per session: the git traps when you touch git, the Supabase traps when you touch Supabase. 🔴 **A headline is a trap's first sentence, not the rule** (owner, 2026-10-08 — the clusters had grown to 131 KB and one `gh pr merge` pasted 46 KB): before acting on anything one touches, search the clusters file for its words and read the trap in full. Thirteen clusters — **Shell and tooling · Git · CI and PRs · Migrations · Database, grants and RLS · Probing, attributing and reporting production · Validation · Memory and this index · Parallel sessions · Worktrees · Next.js runtime · Browser and dev-auth · Machine ceiling.** That is 30 KB this file no longer charges to every request.

🔴 **The hook FAILS OPEN and SILENT, so its silence proves nothing** — it says the same thing when no cluster matched and when it never ran at all. **If you cannot see a trap block for the kind of work you are doing, open the clusters file and read the matching one yourself**, before the first command of that kind. A session started before the hook merged does not have it.

**Each line there is a cue, not the fact.** The account of every one is in [docs/agents-session-traps.md](docs/agents-session-traps.md); which memory backs which hook is in [docs/agents-memory-map.md](docs/agents-memory-map.md).

**Memory slugs that this section was the only pointer for.** `scripts/memory-index-reachability.mjs` scans **this file** and matches the **backticked** form, so these stay here whatever happens to the prose above — deleting one orphans that memory unless `MEMORY.md` also links it. They are a reachability roster, not a reading list; the hook each belongs to travels with its cluster.

## A background `cat` with nothing feeding it held a worktree for over an hour — 2026-10-08

At 22:49 Cairo a session ran one background Bash command that began
`cd "/f/Phoenix Workforce/_wt-field-day-holidays" && cat > "$TMPDIR/q.mjs" 2>/dev/null; …` and went
on, several statements later, to `cat > scripts/field-day/_probe.tmp.mjs <<'EOF' … EOF` and a node
probe that read production through the folder's `.env.local`. The heredoc belonged to the SECOND
`cat`. The first had no file, no heredoc, no `<` and no pipe, so it read its standard input — and a
background command's standard input is a pipe that nothing ever writes to or closes. It waited.

Found past midnight while retiring finished worktrees, it had held the folder for over an hour:

- the repo doctor reported a live process in `_wt-field-day-holidays`, so the folder could not be
  removed from under it;
- the desktop app refused to archive its session ("it still has live work"), and its 7-day
  auto-archive would have skipped it for as long as the shell lived;
- the worktree was still clean and the probe file did not exist, so nothing after the stuck `cat` had
  run — but the production read was still queued behind it, armed. Stopping the `cat` alone would
  have released it, so the two shells were stopped first and the `cat` last.

**The foreground differs, measured the same night:** `timeout 8 cat > probe.txt` in a foreground
Bash call exited 0 in 0 s. Its input is closed, so it does not hang — it silently writes an EMPTY
file instead, which is a quieter bug of its own and not what C17 refuses.

**The guard.** `bash-guard.mjs` **C17** refuses a background Bash command holding a `cat` with
nothing to read: no file operand, no `<`, `<<` or `<<<`, and no pipe into it (`||` is not a pipe;
`-` is standard input, not a file). It quotes the idle `cat` back, shows the heredoc on the cat
itself, and names `PHX_STDIN_OK=1` as the stand-down. Pinned by
`tests/background-cat-guard.test.ts`, which replays the 8 Oct command and seventeen shapes that must
still pass — among them the commit-message `$(cat <<'EOF' … )` idiom, `|&`, process substitution,
the foreground and the PowerShell tool. Breaking the rule turns that test red on the 8 Oct command;
dropping the pipe check turns it red on "a pipe into it".

## A bare python REPL wrote 20.3 GB into three task logs and filled C: — 9-15 Oct 2026

Three background Bash tasks, in three different sessions, launched an **interactive** Python: a bare
`python` / `python3` with no script and no `-c`, and one `python - <<'PY'` whose closing delimiter
was mangled, so bash passed nothing and Python went to the prompt anyway.

Nothing in this harness can type into that prompt — and on this machine it does not wait quietly for
the input that will never come. With no console attached, Python 3.13/3.14's new REPL raises
`OSError: [WinError 123]` inside `Lib/_pyrepl/windows_console.py` `getheightwidth` (the handle it
asks for the console's width is not a console), prints the traceback, and re-enters the same path to
print the next prompt — for ever. The harness writes a background command's output to
`%LOCALAPPDATA%\Temp\claude\<project>\<session>\tasks\<id>.output`, so the loop went to disk.

**Measured on this box on 2026-10-15**, with the Bash tool's own stdin:

| command | output |
| --- | --- |
| `timeout 3 python` (3.13.13) | 1,774,873 bytes |
| `timeout 6 python` (3.13.13) | 3,948,442 bytes |
| `timeout 3 py` (3.14.4) | 1,732,643 bytes |
| `PYTHON_BASIC_REPL=1 timeout 3 python` | **176 bytes**, then it exits |

That is ~640 KB/s, about **2.2 GB an hour**, identical on both interpreters. The three logs reached
**12.5 GB, 5.4 GB and 2.4 GB** (9, 10 and 15 October) and took C: down to **12 GB free**. A cleanup
session deleted them and recovered 19 GB.

**Why it ran for hours.** Each session had already ended its turn — a background task keeps running
across turns, and nothing reads its output file until it exits, which this one never does. There is
no error anywhere else: the task is "running", the disk quietly fills, and the first symptom is
Windows complaining about free space. The foreground is no safer in kind, only in degree: the same
flood arrives in the tool result and is capped by the 600 s ceiling.

**What a mangled delimiter actually is.** `<<DELIM` ends only at a line holding the delimiter
**alone, at column 0**; `<<-DELIM` additionally strips leading **tabs**, never spaces. So an
indented `  PY`, or a `PY` with anything after it, leaves the heredoc open — bash warns about a
here-document delimited by end-of-file (into a log nobody reads) and Python gets no script. The
repo's older `withoutHeredocBodies` regex accepts any indentation on the closing line, which is why
C19 does its own line-based scan (`markHeredocs`) rather than reusing it.

**The guard.** `bash-guard.mjs` **C19** refuses a Bash or PowerShell command whose first python
would reach the REPL: no positional script, no `-c`, no `-m`, no pipe into it, no `<`, `<<<` or
well-formed heredoc, and nothing that makes python print and exit (`--version`, `-V`, `--help`); or,
whatever else the segment carries, a `<<DELIM` on it with no closing delimiter. It quotes the python
back, carries the measured rate and the three log sizes, names a script file, `-c`, `-m` and a
well-formed heredoc as the ways out, and offers `PYTHON_BASIC_REPL=1` — which is the fix, not a
bypass, so the clause accepts it on the command line as well as `PHX_PYTHON_REPL_OK=1`. A
`timeout N python …` is deliberately not matched: it bounds the flood, and it is how the rate above
was measured.

Pinned by `tests/python-repl-guard.test.ts` — nineteen interactive shapes (the bare interpreter,
`py -3`, a quoted `"C:\Program Files\Python313\python.exe" -u`, `python 2>&1`,
`python > out.log 2>&1`, `python -`, flags-only, the 15 Oct unclosed heredoc, an indented delimiter,
and one unclosed heredoc that also carries `-c`) and thirty that must keep passing
(`python script.py`, `-c`, `-m`, `--version`, a well-formed heredoc, `<`, `<<<`, a pipe, a
`timeout`-bounded run, mentions in quotes, a commit message, a heredoc body documenting the trap, a
PowerShell here-string, and both stand-downs in both dialects). Each refusal's own stand-down is
re-fed to the guard and must be allowed, in the dialect of the tool that asked. Breaking the clause
turns it red on "the bare interpreter"; reusing the old heredoc regex turns it red on "an indented
closing delimiter"; unwrapping the quoted path before tokenizing turns it red on "a full path with
spaces in it".

## `--check` on the cloud-context mirror was a full write, and the undo was refused — 2026-10-15

`node scripts/sync-cloud-context.mjs --check` was run inside
`.claude/worktrees/fervent-solomon-1a4930` — a worktree another provably live session shares — to
ask whether the cloud mirror had drifted from the laptop's memory directory. It is not a dry run,
and there is no dry run: a grep of the script for `argv`, `--check`, `--dry` and `usage` returns
**zero hits**. Writing the mirror is its only behaviour. It printed what it always prints,
`mirrored 1370 memory files (5.60 MB) + global rules + 7 pinned hook(s)`, and exited **0** — which
is indistinguishable from a clean check, and was read as one until `git status` was next run.

What it left in a folder belonging to someone else: **7 modified tracked files**
(`.claude/cloud-context/README.md`, two mirrored memory notes, `MEMORY.md`,
`.claude/rules/database.md`, `.claude/rules/phoenix-crm.md`,
`scripts/module-memory/assignments.json`) and **1 untracked mirror note**. All eight were
byte-for-byte what fold PR #5945 already carried, so the write gained nothing at all — the question
it was meant to answer was already answered, and the answer was "no drift that is not already on
its way to `main`".

Then the second half, which is the part worth remembering: `git restore --source=HEAD -- <the 7
paths>` was **refused by the auto-mode classifier as `[Irreversible Local Destruction]`**. That
refusal is correct. The classifier cannot distinguish a script's own output from the owner's
uncommitted work, and in a shared worktree the odds that unexplained modifications are his are
real. So the cost of a flag that did nothing was a dirty worktree that only he could authorise
cleaning — he did, in his own words ("restore the 7 mirror files in fervent-solomon"), and the
pre-image of all 8 files was copied into the session scratchpad before the restore ran.

### The split this family of scripts never states

- **To ASK whether the mirror has drifted** — the SessionStart banner already counts it ("N of 1367
  mirrored memory files no longer match"), and `node scripts/module-memory/build.mjs --check` does
  parse its flag and writes nothing.
- **To FIX drift** — `node scripts/module-memory/fold.mjs --apply`. It builds in its own temporary
  worktree on a fresh branch from `origin/main` and never touches the calling checkout, which makes
  it the only script in this family safe to run from a folder someone else is using.
- **`sync-cloud-context.mjs` itself** is for when you intend to rewrite the mirror in the checkout
  you are standing in, on your own branch, inside the PR that will carry it. Never as a question.

A flag that is ignored rather than rejected turns a read into a write, and the write lands wherever
you are standing. Instance of the fail-open shape the Validation cluster opens with: an action that
produced no verdict reading exactly like a verdict of "nothing to do".

### Fixed the same day

`scripts/sync-cloud-context.mjs` now reads `process.argv` for the first time: `--help`/`-h` print a
usage that carries both routes, every other argument prints `REFUSED`, quotes back what it was
given, names `module-memory/build.mjs --check` (ASK) and `fold.mjs --apply` (FIX), and exits **2**
having written nothing. Exit 1 stays what it always was — a real failure.

The gate deliberately runs **before** the memory-source existence check, which is the only reason a
repo test can pin it: a CI runner has no `~/.claude`, so with the checks in the other order a
refused flag would exit 1 with *memory source not found* there and 2 on the laptop, and every case
would pass locally and fail on the box. `tests/sync-cloud-context-args.test.ts` runs the script for
each flag, asserts exit 2, asserts `.claude/cloud-context/README.md` has not changed size or mtime
(the one thing a source read cannot prove), and pins that ordering from the comment-stripped source.
It never runs the script bare — running it IS the write.

Verified by breaking it: disarming the gate (`if (false && argv.length > 0)`) with
`PHX_MEMORY_DIR` pointed at a path that does not exist turns the headline case red —
`--check must exit 2 (refused), got 1: memory source not found` — and the fix was restored from a
copy, never with `git checkout --`.

## A flag the script has never heard of was read as absent — 2026-10-15

`args.includes("--apply")` answers false for `--aply`, `--apply-all` and `--dryrun`, and the script
then does the OTHER thing while the caller believes the flag took effect. The sibling account above
covers the scripts that take no arguments; this is the same defect one layer up, in the scripts that
DO take some. Measured that day: 63 non-library `scripts/**/*.mjs` parse argv, 32 of those write
files, and only 5 (`check-contracts`, `remote-check`, `repo-doctor-xlsx-snapshot`, `rollup-prs`,
`rotate-production-db-password`) already refused an unknown flag. The sharpest case was
`module-memory/run-fold.mjs`: its one flag is `--dry-run`, and its bare run opens a real pull
request, so `--dryrun` used to be ignored and file the inbox for real.

The gate is `refuseUnknownFlags({name, entry: import.meta.url, known, hints})` in
`scripts/lib/refuse-arguments.mjs`. Only a token starting with `-` that is outside `known` is
refused (exit 2, naming just that token); `--flag=value` compares on the part before the `=`;
positionals and a flag's separate value pass; `--help`/`-h` prints the vocabulary at exit 0 unless
the script defines its own. `entry` is the guard against the parent-flags trap: `build.mjs` is
imported by `fold.mjs`, so a gate that judged `process.argv` on import would refuse `--apply` on the
child's vocabulary. `PHX_FLAG_GATE_PROBE=1` lets the test run any wired script to its gate and stop
(`GATE-OK <name>`, exit 0; a refusal exit 2; a non-entry module exit 3) without ever starting the
body. `run-fold.mjs` carries an inline copy instead, because its header keeps it on node builtins.

🔴 **`known` has to hold every flag a CALLER passes, not just the ones the code names.**
`.github/workflows/ci.yml` passes `--dry-run` to `ci-tree-reuse.mjs`, which never appears as a
literal in the script. Gated with only `--report`, that CI step would have exited 2 on the next
push. The test reads the workflows, `package.json` and the hooks for every call into a gated script.

Verified by breaking it, each restored from a copy: the helper that never refuses → "args [--aply]
must be refused with exit 2, got 0"; `slow-audit` losing its call → "a pinned script lost its gate";
`ci-tree-reuse` dropping `--dry-run` → the ci.yml line it would refuse; the helper judging argv on
import → "an imported gated module must not refuse its parent's flags". 🔴 **The fifth break caught
a hole in the test itself:** turning run-fold's `if (FOLD_UNKNOWN.length > 0)` into `if (false)` left
every source assertion green, because the REFUSED text was still in the file. The case now SPAWNS
the script with `PHX_FOLD_PRIMARY` at an empty directory and the home directory redirected, so a
working gate answers exit 2 and a dead one answers exit 1 at the missing-checkout line, before any
fetch, worktree or pull request — "must be REFUSED (exit 2), got 1".

## The same gate, across every script that takes arguments — 2026-10-15

The first sweep gated the `.mjs` scripts that wrote files, and its ratchet was built on "parses argv AND
writes files", so the whole `.ts` tree and every read-only report sat outside it. Measured when this
one started: 79 more scripts took a flag or a positional and ignored a stranger. The ones that matter
most are not the writers. `rep-seat-vacancies.ts`, `respread-swing-table.ts`, `restate-area-month.ts`
and `dm-line-achievement.ts` read `--period=YYYY-MM` and fall back to September when the flag is
misspelled, so `--perod=2026-10` printed a confident September answer. Every one of the production
mutators behind `--apply` or `--execute` (backfills, provisioning, the vacation corrections, the
source-of-sales cleanups) took the same silent fall-through.

What was wired: 79 scripts through `refuseUnknownFlags`, each vocabulary read from the script's own
code and checked against every caller (workflows, package.json, hooks, `~/.claude`, the scheduled
tasks). 17 of them take positionals only and carry `known: []`: a flag-shaped typo there is read as the
file to write (`customer-pharmacy-pending-questions.ts` resolves `argv[2]` as its output path) or the
month to read. The ratchet is now "any tracked script that parses arguments", over `.mjs` and `.ts`,
with an `EXEMPT` map that must give a reason and goes red when a listed script gets gated.

Three traps the work hit, each caught by the test and not by looking:

- **A gate cannot import from `lib/` in a file that runs alone.** `xlsx-snapshot.cmd` extracts
  `repo-doctor-xlsx-snapshot.mjs` alone from `origin/main`, so the hourly backup is gated inline on node
  builtins, with exact-token matching because its own parser reads only the separate-value form (`--repo
  x`) and would have ignored `--repo=x`. The wrapper passes `--repo "<path>"` and nothing else.
- **A strict probe fails on a nested import.** `validate-railway-production-secrets.mjs` imports the
  gated `sync-railway-production-secrets.mjs`; under `PHX_FLAG_GATE_PROBE=1` the imported gate exited 3
  ("not the entry point") before the probed script's own gate ran. `PHX_FLAG_GATE_PROBE=<script path>`
  now makes only that file strict; `=1` stays strict everywhere.
- **A survey by eye missed a flag.** `headwind-bootstrap.mjs` reads `flag("role")` as well as the five it
  declares. The own-flag assertion (every flag a script tests for must be in its `known`) caught it before
  the script could refuse its own option, and it fires on a dropped `--apply` too.

Also handled: `pnpm run x -- --flag` can hand a bare `--` to a script, so the helper stops judging at it.
Probes run in parallel batches with a MINIMAL environment, because CI has no `.env.local`: a script that
cannot even be imported without credentials must fail on the laptop first.

Verified by breaking it, each restored from a copy: a `.ts` script losing its call → "a pinned script
lost its gate"; the helper judging past `--` → "a bare -- is not a flag"; the backup's inline gate
turned to `if (false)` → "the refusal must name the typo"; `cronjob-sync` dropping `--apply` → "tests for
--apply itself"; a wrong `entry` → "must pass entry: import.meta.url"; a strict probe → "a gated module
IMPORTED by the probed script must pass quietly"; `restate-area-month` dropping `--area` → the same
own-flag message.
