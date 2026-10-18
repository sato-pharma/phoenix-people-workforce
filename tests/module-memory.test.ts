// MODULE MEMORY — the guard that keeps it working (owner-approved 2026-10-02; docs/module-memory.md).
//
// WHY THIS EXISTS. The always-loaded rulebook (AGENTS.md + the MEMORY.md index) has a hard ceiling,
// so every new rule pushed an older one out of sight and a session returning to an old module no
// longer knew its rules. Module memory moved each module's rules and notes into
// `.claude/rules/<id>.md`, which Claude Code loads by itself when a session reads one of the
// module's files (`paths:` frontmatter), plus a hook for work that opens no file.
//
// Every way that silently stops working is pinned here, in the required `validate` job:
//   - a memory note filed under nothing (an orphan nobody will ever be shown)
//   - a glob that matches no file (a module that can never load)
//   - a rules file with no `paths:` (it would load at STARTUP — the cost this exists to end)
//   - a generated block edited by hand, or a module file over its cap
//   - the glob dialect drifting from what the route groups need
//   - the hook losing its routing (prompt, SQL, shell, file tools)
//   - a single-module rule written back into AGENTS.md, which re-grows the startup file
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { MODULES, globToRegExp, modulesForPath, mentions } from "../scripts/module-memory/modules.mjs";
import { checkModuleMemory } from "../scripts/module-memory/build.mjs";
import { classify, settleIndex } from "../scripts/module-memory/fold.mjs";
import {
  modulesFor,
  normalizePath,
  ruleHeadlines,
  renderPointer,
} from "../.claude/hooks/module-memory-injector.mjs";

const lib = { MODULES, mentions, modulesForPath };

/** Cross-cutting modules: a rule citing their files can legitimately be global. */
const CROSS_CUTTING = new Set(["engineering", "sessions", "database", "platform", "platform-design-tokens"]);

/**
 * Global rules in AGENTS.md that cite ONE business module's files on purpose. Adding to this list
 * is a decision: the rule must apply to work in EVERY module, not just the one it cites.
 */
const DELIBERATELY_GLOBAL = [
  "THE DOCUMENT IDENTITY", // every company document in every module wears it; its code lives in hiring-pack
  "THE SQUARE-EDGE GOLDEN RULE", // every page in every module; one of its pinning tests sits in hiring-pack
];

export function runModuleMemoryTests() {
  // 1. The system is consistent: no orphan, no dead glob, nothing stale, nothing loading at startup.
  assert.deepEqual(
    checkModuleMemory(),
    [],
    "module memory is broken — run `node scripts/module-memory/build.mjs` and read each problem; "
      + "an ORPHAN note needs a module in scripts/module-memory/assignments.json",
  );

  // 2. The glob dialect. Route groups are reached with `**`, never with literal parentheses.
  const g = (glob: string, p: string) => globToRegExp(glob).test(p);
  assert.ok(g("app/**/payroll/**", "app/(admin)/payroll/page.tsx"), "`**` must cross a route group");
  assert.ok(g("app/**/payroll/**", "app/api/payroll/run/route.ts"));
  assert.ok(!g("app/**/payroll/**", "app/(admin)/admin/m-payroll/page.tsx"), "a segment must match whole");
  assert.ok(g("src/lib/sales/*", "src/lib/sales/closing-period-gate.ts"));
  assert.ok(!g("src/lib/sales/*", "src/lib/sales/weekly/export.ts"), "`*` must not cross a folder");
  assert.ok(g("tests/*{closing,qema}*", "tests/qema-warehouse-split.test.ts"), "braces inside a segment");
  assert.deepEqual(modulesForPath("src/lib/sales/weekly/export.ts"), ["weekly-sales"], "weekly is not closing");
  assert.ok(modulesForPath("src/lib/payroll/policy.ts").includes("payroll"));
  assert.ok(modulesForPath("src/lib/phoenix-crm/visit.ts").includes("phoenix-crm"));

  // 3. The hook routes work that opens no file.
  const root = "F:\\Phoenix Workforce\\_wt-anything";
  const prompt = modulesFor({ hook_event_name: "UserPromptSubmit", prompt: "why did the held payroll row vanish?" }, lib, root);
  assert.ok(prompt.touched.includes("payroll") && prompt.inject, "a payroll question must bring payroll memory");
  const quiet = modulesFor({ hook_event_name: "UserPromptSubmit", prompt: "hello, what time is it in Cairo" }, lib, root);
  assert.deepEqual(quiet.touched, [], "small talk must load nothing");
  const sql = modulesFor(
    { hook_event_name: "PreToolUse", tool_name: "mcp__supabase-production__execute_sql", tool_input: { query: "select * from phoenix_crm_visits" } },
    lib,
    root,
  );
  assert.ok(sql.touched.includes("phoenix-crm"), "SQL on a module's tables must bring that module");
  const shell = modulesFor(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sed -n 1,40p src/lib/sales/closing-period-gate.ts" } },
    lib,
    root,
  );
  assert.ok(shell.touched.includes("sales-closing"), "a shell read of a module file must bring that module");
  const read = modulesFor(
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: `${root}\\src\\lib\\recruitment\\a.ts` } },
    lib,
    root,
  );
  assert.deepEqual(read, { touched: ["recruitment"], inject: false }, "a Read is recorded, never injected — Claude Code loads it");
  assert.equal(normalizePath("F:\\Phoenix Workforce\\_wt-x\\src\\lib\\vacation\\a.ts", root), "src/lib/vacation/a.ts",
    "a path into ANY checkout — with the space in 'Phoenix Workforce' — must reduce to repo-relative");

  // 3a. 🔴 HARNESS TEXT AND SEARCH PATTERNS ARE NOT THE WORK (.claude/hooks/lib/harness-text.mjs).
  // Measured 2026-10-08: one settings audit that touched no module was handed payroll, sales-closing,
  // sales-attribution, recruitment, notifications and engineering, because a background agent's
  // `<task-notification>` arrives in `prompt` and a quoted grep pattern reads like a command.
  const said = (prompt: string) => modulesFor({ hook_event_name: "UserPromptSubmit", prompt }, lib, root).touched;
  const notice = "<task-notification>\n<summary>Agent finished</summary>\n<result>The payroll batch and the "
    + "monthly closing read src/lib/payroll/policy.ts; one notification email was queued.</result>\n</task-notification>";
  assert.deepEqual(said(notice), [], "a background agent's notification is the harness speaking, not the owner");
  assert.deepEqual(
    said("[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event about the payroll run.\n"),
    [],
    "the system banner and its paragraph are harness text",
  );
  const mixed = said(`why did the held payroll row vanish?\n${notice.replace(/payroll/g, "recruitment")}`);
  assert.ok(mixed.includes("payroll") && !mixed.includes("recruitment"),
    `the owner's own sentence still routes, the envelope after it does not: ${JSON.stringify(mixed)}`);
  const shellOf = (command: string) =>
    modulesFor({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, lib, root).touched;
  assert.ok(!shellOf('git grep -n "railway run" -- docs/x.md').includes("engineering"),
    "a quoted SEARCH pattern is not railway work");
  assert.ok(shellOf("railway status").includes("engineering"), "a bare railway command still is");
  assert.ok(shellOf('node "F:/Phoenix Workforce/_wt-x/scripts/new-session.mjs" --status').includes("sessions"),
    "a quoted PATH is real work — every path under 'Phoenix Workforce' is quoted for its space");
  assert.deepEqual(
    modulesFor({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "src/lib/payroll/" } }, lib, root).touched,
    [],
    "a Grep pattern is what is hunted for; only its path and glob say where the work is",
  );
  assert.ok(
    modulesFor({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x", path: "src/lib/payroll/policy.ts" } }, lib, root)
      .touched.includes("payroll"),
    "a Grep INTO a module's folder still routes",
  );

  // 4. The pointer stays small: Claude Code shows only a 2 KB preview of hook context over ~10 KB.
  // 🔴 THE LIMIT IS 4,000, NOT THE 4,500 CLIFF, SO A MODULE IS SPLIT BEFORE A RULE IS BLOCKED. On
  // 2026-10-03 `phoenix-crm` measured 4,478 of 4,500 with 38 rules: the next CRM ruling anyone wrote
  // took it to 4,518 and reddened this required job, with nothing having warned beforehand. A margin
  // means the file goes over while there is still room for the rule in front of it — the remedy is
  // always to SPLIT the module (phoenix-crm -> + phoenix-crm-approvals), never to trim a rule.
  // 🔴 And this is NOT the module file's 72,000-byte cap: phoenix-crm sat at 70% of that while this
  // was 22 bytes from red. Two different limits, and the one that bites is the small one.
  const biggest = MODULES.map((m) => renderPointer(m, readFileSync(`.claude/rules/${m.id}.md`, "utf8")));
  for (const p of biggest) assert.ok(Buffer.byteLength(p) < 4_000, `a module pointer is ${Buffer.byteLength(p)} bytes, over the 4,000 margin before the 4,500 preview cliff — SPLIT that module (see phoenix-crm-approvals), do not trim its rules:\n${p.slice(0, 200)}`);
  assert.ok(ruleHeadlines(readFileSync(".claude/rules/payroll.md", "utf8")).length > 0, "rule headlines must parse");

  // 5. The fold files a note by its own words when its session left no record.
  const filed = classify("a-held-payroll-row-test", "---\nname: x\n---\nThe salary batch drops a held payroll row at publish.", lib);
  assert.equal(filed.module, "payroll");
  assert.equal(filed.how, "its own words", "a clear winner must still report as a clear winner, not as a tie");

  // 5a. 🔴 A TIE IS NOT A MATCH, and it must not be reported as a confident one. Measured
  // 2026-10-03: `a-not-loaded-assertion-is-satisfied-by-a-refusal` scored 2 across five modules and
  // was filed under `crm` — the one module its session had touched — as a "best match". It is a note
  // about module memory. A shared top score now prefers the fallback when it is among the tied, and
  // the `how` says it was a guess either way, so the fold's own PR shows which rows to check.
  const tie = classify(
    "a-tie-must-not-read-as-a-match",
    "---\nname: x\n---\nOne mentions payroll and the other mentions source of sales, nothing else.",
    lib,
  );
  assert.match(tie.how, /^tied at \d+ with .+ — a guess, move it if wrong$/, `a tie must say so: ${tie.how}`);
  assert.ok(!/best match|its own words|the only module/.test(tie.how), "a tie must not borrow a confident wording");

  // 5b. Settling the index removes ONLY pointers whose notes all load with a module on main: the
  // owner's RULE #1 block stays whole, global notes stay, the inbox heading stays, and an emptied
  // section goes. A pointer to a note NOT yet on main stays — the git half lands first.
  const index = [
    "# Memory Index",
    "## 🥇 RULE #1 - never trim, never forget",
    "- [held row](held-row.md) - payroll, but protected",
    "## In flight",
    "- [held row](held-row.md) - goes: filed under payroll on main",
    "- [owner](owner.md) - stays: global",
    "- [new](new-note.md) - stays: not on main yet",
    "## Old topic",
    "- [crm](crm-note.md) - goes, and the empty section with it",
    "## Inbox",
  ].join("\n");
  const settled = settleIndex(index, { "held-row": "payroll", owner: "global", "crm-note": "crm" });
  assert.equal(settled.removed, 2);
  assert.match(settled.text, /RULE #1[^]*held-row\.md\) - payroll, but protected/);
  assert.match(settled.text, /owner\.md/);
  assert.match(settled.text, /new-note\.md/);
  assert.doesNotMatch(settled.text, /## Old topic/);
  assert.match(settled.text, /## Inbox/);

  // 5c. 🔴 THE FOLD RUNS THREE TIMES A DAY (owner, 2026-10-03), so its branch name must carry the
  // CLOCK and not only the day. `git worktree add -b` fails outright on an existing branch, and the
  // local branch outlives both the temporary worktree it made and the PR's merge (GitHub deletes
  // only the remote one) — so a day-only name breaks every second run of a day that files a note
  // twice, with nothing to show for it but a git error buried in a scheduled run's output.
  const foldSrc = readFileSync("scripts/module-memory/fold.mjs", "utf8");
  assert.match(foldSrc, /const stamp = `\$\{day\}-\$\{clock[^`]*`/, "the fold must build a day+clock stamp");
  assert.match(foldSrc, /hourCycle: "h23"/, "the clock must be 24-hour, or midnight reads as hour 24");
  assert.match(foldSrc, /const branch = `codex\/memory-fold-\$\{stamp\}`/, "the branch must use the day+clock stamp");
  assert.doesNotMatch(foldSrc, /memory-fold-\$\{day\}/, "a day-only branch name cannot survive three runs a day");

  // 5d. 🔴 THE "A FOLD PR IS ALREADY OPEN" THROTTLE KEYS ON THE BRANCH, NOT THE TITLE. A title test
  // matched any open PR with "memory fold" in its name — a PR *about* the fold then stopped every
  // run until it merged, which is exactly what #5215 did to itself on 2026-10-03. Only this script
  // creates `codex/memory-fold-<digits>`, so the branch is the signal a human cannot collide with.
  assert.match(foldSrc, /\/\^codex\\\/memory-fold-\\d\//, "the open-fold throttle must match the fold's own branch");
  assert.doesNotMatch(foldSrc, /test\(p\.title\)/, "the open-fold throttle must not key on a PR title");
  assert.ok(
    !/^codex\/memory-fold-\d/.test("codex/memory-fold-cadence"),
    "the branch pattern must require digits, so a human branch named after the fold is not mistaken for one",
  );

  // 6. A rule that belongs to ONE business module must not grow back into AGENTS.md.
  const agents = readFileSync("AGENTS.md", "utf8");
  const offenders: string[] = [];
  for (const line of agents.split("\n")) {
    if (!/^- /.test(line)) continue;
    if (DELIBERATELY_GLOBAL.some((h) => line.includes(h))) continue;
    const cited = [...line.matchAll(/`((?:src|app|tests)\/[^`\s]+)`/g)].map((m) => m[1]);
    if (!cited.length) continue;
    // Every file the rule cites belongs to a business module (overlapping test-name globs can give
    // one file two owners — phoenix-crm and crm — so judge per file, never by counting owners).
    const owned = cited.map((p) => modulesForPath(p).filter((id: string) => !CROSS_CUTTING.has(id)));
    if (owned.every((o: string[]) => o.length > 0)) offenders.push(`${[...new Set(owned.flat())].join("/")}: ${line.slice(0, 120)}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "These AGENTS.md rules cite only one module's files, so they belong in that module's memory "
      + "(.claude/rules/<id>.md, ## Rules) — AGENTS.md is re-sent on every request and holds only rules true everywhere. "
      + "If a rule truly applies to every module, add its headline to DELIBERATELY_GLOBAL with the reason.",
  );
}
