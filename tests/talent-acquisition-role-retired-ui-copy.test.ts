import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * "Talent Acquisition" is a `PhoenixRole` retired 2026-08-28 (src/lib/auth/permissions.ts) and
 * replaced by the two HR function-bundle seats, "HR Advisory" and "HR Operations" — nobody can be
 * granted it any more. Twelve employee-portal pages nonetheless kept rendering it as a role or
 * permission name: a page-header badge, or a denial message telling a refused viewer to go get a
 * role that no longer exists and cannot be granted. Fixed 2026-09-05; this pins the fix.
 *
 * "Talent Acquisition" is ALSO a live company JOB TITLE (`phoenixCompanyJobTitles` in
 * permissions.ts) and the subject of ~90 files' worth of legitimate historical comments recording
 * the retirement itself — neither of those is the defect. So this strips comments before matching
 * (a raw grep would fail on its own history, including permissions.ts's own retirement note) and
 * allowlists the two pages that genuinely describe Talent Acquisition staff as people handling
 * CVs, not as an access grant.
 */

const SCAN_ROOTS = ["app", "src/components"];
const SCAN_EXTENSIONS = [".ts", ".tsx"];

/** Genuine prose naming company personnel, not a permission claim — see the job-title list above. */
const JOB_TITLE_PROSE_ALLOWLIST = new Set(["app/privacy/page.tsx", "app/terms/page.tsx"]);

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
    if (JOB_TITLE_PROSE_ALLOWLIST.has(file)) continue;
    const stripped = stripComments(readFileSync(file, "utf8"));
    if (stripped.includes("Talent Acquisition")) violations.push(file);
  }
  return violations;
}

/**
 * The detector must be shown to fire on a case small enough to read, and to correctly ignore both
 * a comment and the allowlisted job-title prose shape — otherwise the sweep below would pass just
 * as happily against a check that flags nothing.
 */
function testDetectorFiresOnARoleClaimButNotOnAComment() {
  const roleClaimBadge = 'badge="Talent Acquisition"';
  const roleClaimMessage = 'message="Resignations are available to Talent Acquisition and Super Admin only."';
  const retirementComment = "// The retired Talent Acquisition seat used to sit here.";
  const jobTitleProse = "Handled by Sato Pharma's Talent Acquisition and HR personnel.";

  assert.ok(
    stripComments(roleClaimBadge).includes("Talent Acquisition"),
    "a live JSX badge naming the retired role must survive comment-stripping, or the sweep below checks nothing",
  );
  assert.ok(
    stripComments(roleClaimMessage).includes("Talent Acquisition"),
    "a live denial message naming the retired role must survive comment-stripping too",
  );
  assert.ok(
    !stripComments(retirementComment).includes("Talent Acquisition"),
    "a `//` comment recording the retirement must be stripped, or every historical comment in " +
      "permissions.ts and the recruitment module fails this test",
  );
  // Job-title prose is not a comment, so stripComments correctly leaves it untouched — the
  // allowlist above, not the stripper, is what excuses app/privacy and app/terms. Asserted here so
  // the two mechanisms are never confused with each other.
  assert.ok(
    stripComments(jobTitleProse).includes("Talent Acquisition"),
    "job-title prose is not a comment and must not be silently eaten by the stripper — only the " +
      "explicit allowlist may excuse it",
  );
}

function testNoLiveRoleClaimNamesTalentAcquisition() {
  const files = scannedFiles();
  assert.ok(
    files.length >= SCANNED_FILE_FLOOR,
    `only ${files.length} files scanned under ${SCAN_ROOTS.join(", ")}, below the floor of ` +
      `${SCANNED_FILE_FLOOR}. The walker has stopped seeing the app/portal tree, so this test is no ` +
      "longer checking anything — fix walk()/SCAN_ROOTS, do not lower the floor.",
  );

  // Positive control: the two allowlisted pages must actually contain the string this test looks
  // for, or the allowlist is silently excusing nothing and the test above proves less than it claims.
  for (const allowlisted of JOB_TITLE_PROSE_ALLOWLIST) {
    assert.ok(
      files.includes(allowlisted),
      `${allowlisted} was not found by the walker — the allowlist path no longer matches a real file`,
    );
    assert.ok(
      stripComments(readFileSync(allowlisted, "utf8")).includes("Talent Acquisition"),
      `${allowlisted} no longer mentions Talent Acquisition at all — remove it from the allowlist ` +
        "rather than leaving a dead exception",
    );
  }

  const violations = findRoleClaimViolations(files);
  assert.deepEqual(
    violations,
    [],
    'these files present the retired "Talent Acquisition" role as if it were still grantable ' +
      '(a badge or a denial message naming it) — it was retired 2026-08-28 and replaced by ' +
      '"HR Advisory" / "HR Operations" (src/lib/auth/permissions.ts). Name the successor role(s) ' +
      "that actually hold the page's permission grant instead of the retired one.",
  );
}

export function runTalentAcquisitionRoleRetiredUiCopyTests() {
  testDetectorFiresOnARoleClaimButNotOnAComment();
  testNoLiveRoleClaimNamesTalentAcquisition();
}
