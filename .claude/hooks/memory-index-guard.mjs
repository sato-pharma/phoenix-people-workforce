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

import {
  assessAutoloadFootprint,
  assessMemoryIndexSize,
  autoloadFootprintLines,
  memoryIndexBudgetLines,
} from "../../scripts/memory-index-budget.mjs";

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

/** Bytes of `MEMORY.md`, or 0 when it cannot be measured — which both graders read as "unknown". */
function indexBytes() {
  try {
    return fs.statSync(path.join(memoryDir, "MEMORY.md")).size;
  } catch {
    return 0; // -> "unknown", never "ok"
  }
}

const verdict = memoryDir === null ? null : assessMemoryIndexSize(indexBytes());

/**
 * Size a file that is auto-loaded into every request.
 *
 * ENOENT is a different fact from a failed measurement: the first says this checkout does not have
 * the file, the second says it has one we could not size. Collapsing them would let a permissions
 * error read as a SMALLER footprint, which is the one direction this must never fail in.
 */
function measureAutoloaded(file) {
  try {
    return { present: true, bytes: fs.statSync(file).size };
  } catch (err) {
    return err?.code === "ENOENT" ? { present: false, bytes: 0 } : { present: true, bytes: null };
  }
}

// THE TWO INSTRUCTION FILES ARE RESOLVED FROM THE SESSION'S OWN DIRECTORY, and the index is not.
// That asymmetry is deliberate and is the whole point of the section: `CLAUDE.md` and `AGENTS.md`
// are loaded from the tree this session is sitting in, so a worktree holding a half-finished
// AGENTS.md edit is occupying THIS session's context and the primary's copy would under-report it.
// There is only ever one memory index, so that keeps resolving from the primary as before.
const footprintParts = [];
for (const label of ["CLAUDE.md", "AGENTS.md"]) {
  const measured = measureAutoloaded(path.join(projectDir, label));
  if (measured.present) footprintParts.push({ label, bytes: measured.bytes });
}
// Reuse the index's own figure rather than measuring the file a second time, so the two verdicts in
// one report can never disagree about `MEMORY.md`. A directory with no readable index contributes a
// zero here, which `assessAutoloadFootprint` grades as unmeasured — matching the UNKNOWN it makes
// the index report, instead of quietly totalling a footprint that is missing a file it knows about.
if (verdict !== null) footprintParts.push({ label: "MEMORY.md", bytes: verdict.bytes });

const footprint = assessAutoloadFootprint(footprintParts);

// Silence, and only here: no index and no instruction files means this is CI, a fresh clone, or
// someone else's machine, and there is no fact to report.
if (verdict === null && footprint.status === "not_applicable") process.exit(0);

// Every figure and the sentence describing it come from the shared module, so this hook and
// repo-doctor can never disagree about what a given size means.
const flatten = (lines) => lines.map((line) => line.trim()).join("\n");

const sections = [];

if (verdict !== null) {
  sections.push(
    [
      "MEMORY INDEX BUDGET (AGENTS.md 2.2)",
      flatten(memoryIndexBudgetLines(verdict)),
      // The old wording ended at "auto-loads in full and has no cliff", full stop — which is true
      // and, on its own, is the advice that let AGENTS.md reach 146,898 bytes. A session following
      // it was moving bytes out of the only counter that was watching them, into a file loaded on
      // exactly the same terms. The clause after the dash is the correction.
      "The index is displacement-only: before adding a hook line, retire a resolved one or relocate "
        + "it into AGENTS.md, which auto-loads in full and has no cliff of its OWN — but it is inside "
        + "the footprint budget below, so a relocation buys scannability, never context. Route by "
        + "KIND of fact: a session or tooling trap to 2.1, a production or approval hook to 2.3, an "
        + "owner product rule to 4. Put the ACCOUNT in docs/, never in AGENTS.md.",
    ].join("\n"),
  );
}

const footprintDetail = flatten(autoloadFootprintLines(footprint));
if (footprintDetail) {
  sections.push(["AUTO-LOADED CONTEXT FOOTPRINT (AGENTS.md 2.2)", footprintDetail].join("\n"));
}

const result = {
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sections.join("\n\n") },
};

// The human is interrupted only when something is due. The session is told every time, because the
// numbers are what decide whether its next append is safe to make.
const alarms = [];

if (verdict?.status === "unknown") {
  alarms.push("MEMORY.md could not be measured — treat the memory index as UNKNOWN, not healthy.");
} else if (verdict !== null && verdict.status !== "ok") {
  const headline = verdict.status === "over_ceiling" ? "OVER THE LOADER CLIFF" : "over budget";
  alarms.push(`Memory index ${verdict.bytes} bytes — ${headline}, free ${verdict.mustFree} bytes.`);
}

if (footprint.status === "unknown") {
  alarms.push(
    `Auto-loaded footprint UNKNOWN — could not measure ${footprint.unmeasured.join(", ")}.`,
  );
} else if (footprint.status === "over_budget") {
  alarms.push(
    `Auto-loaded footprint ${footprint.bytes} bytes — over budget, free ${footprint.mustFree} bytes `
      + "by moving detail into docs/.",
  );
}

if (alarms.length > 0) result.systemMessage = alarms.join(" ");

process.stdout.write(JSON.stringify(result));
process.exit(0);
