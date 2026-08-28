#!/usr/bin/env node
// Puts the memory index's size in front of a session at the ONE moment it can act on it: the start,
// before anything has been appended.
//
// WHY A HOOK AND NOT JUST repo-doctor. `MEMORY.md` is the only memory file that auto-loads, and the
// loader truncates it at 24,400 bytes SILENTLY — no error, no marker (AGENTS.md 2.2).
// `scripts/memory-index-budget.mjs` grades the file against a 22,000-byte budget and
// `scripts/repo-doctor.mjs` prints that grade, but only when somebody runs the doctor — which is
// never the moment they are adding a hook at 4am. The append is the event; the doctor is a periodic
// audit, and an audit cannot stop a write that already happened.
//
// Measured 2026-08-28, the append rate is what makes the gap matter: 1,619 bytes of new hook lines
// arrived in about 30 minutes across parallel sessions, and a retirement that freed 196 bytes was
// outrun by 331 bytes of fresh ones while it was being made. Nobody was careless — nothing told
// them the file was 15 bytes from the cliff at the moment they wrote.
//
// WHY A SEPARATE HOOK ENTRY AND NOT A LINE INSIDE session-lock.mjs. That script returns early,
// before its own footer, whenever another session's lock is live in the folder. A budget line added
// there would therefore go missing in exactly the case that produces colliding appends — two
// sessions in one project. Its own SessionStart entry is a separate process and runs regardless.
//
// IT NEVER FAILS QUIET ABOUT A FILE IT FOUND. No memory directory means this checkout has no index
// (CI, a fresh clone, someone else's machine) and nothing is reported. A directory that exists but
// whose `MEMORY.md` cannot be measured reports UNKNOWN out loud: `assessMemoryIndexSize` refuses to
// grade an unmeasured file as healthy, because a size check that answers "fine" when `statSync`
// threw is precisely how the cliff gets crossed while the report reads clean.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assessMemoryIndexSize, memoryIndexBudgetLines } from "../../scripts/memory-index-budget.mjs";

const projectDir = process.argv[2] || process.cwd();

/**
 * The primary checkout's root, or null when git cannot answer.
 *
 * Memory belongs to the PROJECT, not to the worktree a session happens to be sitting in, and
 * `repo-doctor.mjs` resolves it exactly this way. Without it a worktree session would look up a
 * slug of its own `_wt-*` path, find no directory, and stay silent — muting the warning for the
 * sessions that do most of the appending.
 */
function primaryRootFor(dir) {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return commonDir ? path.resolve(path.dirname(commonDir)) : null;
  } catch {
    return null;
  }
}

/**
 * `<config>/projects/<slug>/memory` for a checkout, or null when it does not exist. The slug is the
 * absolute path with every non-alphanumeric character replaced by a hyphen, so
 * `F:\Phoenix Workforce\phoenix-workforce` becomes `F--Phoenix-Workforce-phoenix-workforce` — the
 * doubled hyphen is the drive colon plus the separator, not a typo. `CLAUDE_CONFIG_DIR` relocates
 * the config root when set.
 */
function memoryDirFor(root) {
  const configRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const slug = path.resolve(root).replace(/[^A-Za-z0-9]/g, "-");
  const dir = path.join(configRoot, "projects", slug, "memory");
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

const roots = [primaryRootFor(projectDir), projectDir].filter(Boolean);
const memoryDir = roots.map(memoryDirFor).find(Boolean) ?? null;

if (memoryDir === null) process.exit(0);

let bytes = 0;
try {
  bytes = fs.statSync(path.join(memoryDir, "MEMORY.md")).size;
} catch {
  bytes = 0; // -> "unknown", never "ok"
}

const verdict = assessMemoryIndexSize(bytes);

// The figures and the sentence describing them both come from the shared module, so this hook and
// repo-doctor can never disagree about what a given size means.
const detail = memoryIndexBudgetLines(verdict)
  .map((line) => line.trim())
  .join("\n");

const context = [
  "MEMORY INDEX BUDGET (AGENTS.md 2.2)",
  detail,
  "The index is displacement-only: before adding a hook line, retire a resolved one or relocate it "
    + "into AGENTS.md 2.1/2.3, which auto-load in full and have no cliff.",
].join("\n");

const result = {
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
};

// The human is interrupted only when something is due. The session is told every time, because the
// number is what decides whether its next append is safe to make.
if (verdict.status === "unknown") {
  result.systemMessage = "MEMORY.md could not be measured — treat the memory index as UNKNOWN, not healthy.";
} else if (verdict.status !== "ok") {
  const headline = verdict.status === "over_ceiling" ? "OVER THE LOADER CLIFF" : "over budget";
  result.systemMessage = `Memory index ${verdict.bytes} bytes — ${headline}, free ${verdict.mustFree} bytes.`;
}

process.stdout.write(JSON.stringify(result));
process.exit(0);
