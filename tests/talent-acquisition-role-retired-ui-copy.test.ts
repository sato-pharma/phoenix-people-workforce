import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { HR_SEAT_JOB_TITLES } from "../src/lib/auth/hr-functions.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * WHAT THIS PINNED UNTIL 2026-10-08. "Talent Acquisition" was a `PhoenixRole` retired on 2026-08-28
 * and replaced by the two HR function-bundle seats, "HR Advisory" and "HR Operations". Twelve
 * employee-portal pages kept rendering it as a role a refused viewer should go and get, so from
 * 2026-09-05 this test refused the string in live UI copy.
 *
 * WHAT CHANGED. On 2026-10-08 the owner opened the Talent Acquisition seat (key "HR Resourcing",
 * shown as "Talent Acquisition" through HR_SEAT_JOB_TITLES) and, the same evening, retired the HR
 * Business Partner seat: "no more HR business partner. This title, no more … everything regarding
 * recruiting is for the talent acquisition". So the name a denial message should give is Talent
 * Acquisition again, and the retired title is now "HR Business Partner". The defect this test exists
 * for is unchanged — UI copy naming a seat nobody can be given — only the name moved.
 *
 * Comments are stripped before matching, because the retirement is recorded in many legitimate
 * historical comments, including permissions.ts's own. The role KEY "HR Advisory" is not searched:
 * it survives on purpose as a dormant key (retiredPhoenixRoles), and code that names a key is not
 * copy a viewer reads.
 */

const SCAN_ROOTS = ["app", "src/components"];
const SCAN_EXTENSIONS = [".ts", ".tsx"];
const RETIRED_TITLE = "HR Business Partner";

/** A healthy scan finds ~1,800 files today. A walker that silently sees nothing must fail, not pass. */
const SCANNED_FILE_FLOOR = 1500;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.posix.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SCAN_EXTENSIONS.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => walk(root));
}

function findRoleClaimViolations(files: readonly string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, "utf8"));
    if (stripped.includes(RETIRED_TITLE)) violations.push(file);
  }
  return violations;
}

/**
 * The detector must be shown to fire on a case small enough to read, and to correctly ignore a
 * comment — otherwise the sweep below would pass just as happily against a check that flags nothing.
 */
function testDetectorFiresOnARoleClaimButNotOnAComment() {
  const roleClaimBadge = 'badge="HR Business Partner"';
  const roleClaimMessage = 'message="Retention is available to the HR Business Partner and the Super Admin only."';
  const retirementComment = "// The retired HR Business Partner seat used to sit here.";

  assert.ok(
    stripComments(roleClaimBadge).includes(RETIRED_TITLE),
    "a live JSX badge naming the retired title must survive comment-stripping, or the sweep below checks nothing",
  );
  assert.ok(
    stripComments(roleClaimMessage).includes(RETIRED_TITLE),
    "a live denial message naming the retired title must survive comment-stripping too",
  );
  assert.ok(
    !stripComments(retirementComment).includes(RETIRED_TITLE),
    "a `//` comment recording the retirement must be stripped, or every historical comment fails this test",
  );
}

function testTheLiveSeatCarriesTheName() {
  assert.equal(
    HR_SEAT_JOB_TITLES["HR Resourcing"],
    "Talent Acquisition",
    "the premise that makes \"Talent Acquisition\" correct UI copy again — if the seat's shown title " +
      "changes, the denial messages naming it must change with it",
  );
}

function testNoLiveCopyNamesTheRetiredTitle() {
  const files = scannedFiles();
  assert.ok(
    files.length >= SCANNED_FILE_FLOOR,
    `only ${files.length} files scanned under ${SCAN_ROOTS.join(", ")}, below the floor of ` +
      `${SCANNED_FILE_FLOOR}. The walker has stopped seeing the app/portal tree, so this test is no ` +
      "longer checking anything — fix walk()/SCAN_ROOTS, do not lower the floor.",
  );

  const violations = findRoleClaimViolations(files);
  assert.deepEqual(
    violations,
    [],
    'these files present the retired "HR Business Partner" seat as if it were still grantable ' +
      "(a badge or a denial message naming it) — the owner retired it on 2026-10-08. Name the seat " +
      "that actually holds the page's grant: the Talent Acquisition seat for recruiting, otherwise " +
      "the Super Admin.",
  );
}

export function runTalentAcquisitionRoleRetiredUiCopyTests() {
  testDetectorFiresOnARoleClaimButNotOnAComment();
  testTheLiveSeatCarriesTheName();
  testNoLiveCopyNamesTheRetiredTitle();
}
