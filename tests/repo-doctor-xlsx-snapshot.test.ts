import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyXlsxSnapshot,
  isCovered,
  isLockFile,
  xlsxSnapshotLines,
} from "../scripts/repo-doctor-xlsx-snapshot.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The untracked spreadsheets in xlsx/ are in no commit, no branch and no archive ref, and the doctor
 * must never report them as backed up when they are not.
 *
 * WHY THIS EXISTS. On 2026-09-05 an unidentified sweep deleted every TRACKED pdf under xlsx/ from all
 * seven checkouts on this machine at once. Those came back from git. The 103 untracked sheets beside
 * them — 56 MB, including the July closing workbooks, all three .xlsm premium engines, and forty
 * decision sheets the owner had filled in — would not have: `.gitignore` matches `*.xlsx`. A copy did
 * exist in the DR set, taken eleven days earlier and missing 74 of them, and nothing measured that.
 *
 * Two properties are pinned, and they are the two ways this check could quietly stop being a check:
 *
 *   1. COVERAGE IS BY CONTENT, NOT BY NAME. A decision sheet the owner fills in and returns keeps its
 *      filename. Name-only matching would report the filled sheet as covered by the empty version of
 *      itself — a clean bill of health over the one file in the folder that just became irreplaceable.
 *      And every not-knowing state must read LOUD: an unreadable source, an unreadable snapshot root
 *      and an absent backup drive are each their own status, and none of them may print as covered.
 *      That is AGENTS.md rule 1 — a missed file reads as "safely backed up", which is worse than no
 *      check at all because it stops anyone looking.
 *
 *   2. THE REPORT PATH WRITES NOTHING. AGENTS.md section 5 documents repo-doctor as a tool that does
 *      not write, and other sessions rely on that. Only `--snapshot-xlsx` may copy, and the module
 *      may never delete anything at all. Checked at the SOURCE level, because the regression would be
 *      a one-line change in repo-doctor.mjs that no synthetic input can see.
 */

const DOCTOR = "scripts/repo-doctor.mjs";
const MODULE = "scripts/repo-doctor-xlsx-snapshot.mjs";
const NOW = Date.UTC(2026, 8, 5, 2, 0, 0);
const DAY = 86_400_000;

function file(name: string, bytes: number, mtimeMs: number = NOW - DAY) {
  return { name, bytes, mtimeMs };
}

function verdictFor(overrides: Record<string, unknown> = {}) {
  return classifyXlsxSnapshot({
    destinationExists: true,
    sourceFiles: [file("targets - FILL ME.xlsx", 20_952)],
    snapshots: [{ dir: "xlsx-snapshot-2026-09-05", entries: [file("targets - FILL ME.xlsx", 20_952)], mtimeMs: NOW }],
    now: NOW,
    ...overrides,
  });
}

/** Every line the section would print, joined — what a session actually reads. */
function rendered(verdict: Parameters<typeof xlsxSnapshotLines>[0]) {
  return xlsxSnapshotLines(verdict).join("\n");
}

export async function runRepoDoctorXlsxSnapshotTests() {
  // --- 1. Coverage is by content -------------------------------------------------------------

  assert.equal(verdictFor().status, "covered", "an identical file in a snapshot is covered");

  // The core case: same name, different content. The owner filled the sheet in and sent it back.
  const filledIn = classifyXlsxSnapshot({
    destinationExists: true,
    sourceFiles: [file("targets - FILL ME.xlsx", 31_004, NOW)],
    snapshots: [
      { dir: "xlsx-snapshot-2026-08-25", entries: [file("targets - FILL ME.xlsx", 20_952, NOW - 11 * DAY)], mtimeMs: NOW - 11 * DAY },
    ],
    now: NOW,
  });
  assert.equal(filledIn.status, "gap", "a same-named but different file must NOT count as covered");
  assert.equal(filledIn.uncovered.length, 1);
  assert.match(rendered(filledIn), /exist on this disk ONLY/);

  // Same name, same size, but the snapshot predates the source: a re-save that landed on the same
  // byte count. Freshness is the second half of the test for exactly this shape.
  const resaved = classifyXlsxSnapshot({
    destinationExists: true,
    sourceFiles: [file("closing.xlsx", 4096, NOW)],
    snapshots: [{ dir: "xlsx-snapshot-2026-08-25", entries: [file("closing.xlsx", 4096, NOW - DAY)], mtimeMs: NOW - DAY }],
    now: NOW,
  });
  assert.equal(resaved.status, "gap", "a snapshot older than the file it claims to hold is not coverage");

  assert.equal(
    isCovered(file("a.xlsx", 10, NOW), [file("a.xlsx", 10, NOW)]),
    true,
    "an equal-mtime copy IS coverage — `cp -p` preserves mtime, so a strict > would call every fresh snapshot stale",
  );

  // --- 2. Not knowing reads loud, never clean -------------------------------------------------

  for (const [label, verdict] of [
    ["unreadable source", verdictFor({ sourceFiles: null })],
    ["unreadable snapshot root", verdictFor({ snapshots: null })],
    ["backup drive absent", verdictFor({ destinationExists: false })],
  ] as const) {
    const text = rendered(verdict);
    assert.doesNotMatch(text, /every one is also in a snapshot/, `${label} must not print as covered`);
    assert.match(text, /Do NOT read this as clean|NOT CHECKED, not clean/, `${label} must say so out loud`);
    assert.notEqual(verdict.status, "covered", `${label} must not carry the covered status`);
  }

  // A folder with nothing untracked in it is genuinely fine, and must not nag.
  assert.match(rendered(verdictFor({ sourceFiles: [] })), /Nothing here git cannot already recover/);

  // --- 3. Excel lock files are not real files -------------------------------------------------

  assert.equal(isLockFile("~$Head Office employees.xlsx"), true);
  assert.equal(isLockFile("Head Office employees.xlsx"), false);
  assert.equal(
    verdictFor({ sourceFiles: [file("~$open workbook.xlsx", 165, NOW)] }).sourceCount,
    0,
    "a transient Excel lock file must not be counted, or every run reports a file that cannot be kept",
  );

  // --- 4. The report path writes nothing ------------------------------------------------------

  const doctor = stripComments(readFileSync(DOCTOR, "utf8"));

  const guard = doctor.indexOf("if (snapshotXlsx)");
  assert.ok(guard > 0, "repo-doctor must gate the copy behind an explicit --snapshot-xlsx flag");

  // Walk to the end of that if-block, then assert the only call site sits inside it. A regression
  // here would be a single line moved one brace outward, which no fixture input could detect.
  let depth = 0;
  let end = -1;
  for (let i = doctor.indexOf("{", guard); i < doctor.length; i += 1) {
    if (doctor[i] === "{") depth += 1;
    else if (doctor[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > guard, "could not find the end of the --snapshot-xlsx block");

  const callSites = [...doctor.matchAll(/takeXlsxSnapshot\(/g)].map((m) => m.index ?? -1);
  assert.equal(callSites.length, 1, "exactly one call site, so this check cannot be outflanked by a second one");
  assert.ok(
    callSites[0] > guard && callSites[0] < end,
    "takeXlsxSnapshot must be called ONLY inside the --snapshot-xlsx block — the default run writes nothing",
  );

  assert.match(doctor, /args\.includes\("--snapshot-xlsx"\)/, "the flag is opt-in and spelled --snapshot-xlsx");

  // --- 5. The module may never delete ----------------------------------------------------------

  const mod = stripComments(readFileSync(MODULE, "utf8"));
  for (const forbidden of ["rmSync", "unlinkSync", "rmdirSync", "renameSync", "truncateSync"]) {
    assert.doesNotMatch(
      mod,
      new RegExp(`\\b${forbidden}\\b`),
      `${MODULE} must never ${forbidden} — it creates copies and nothing else`,
    );
  }
}
