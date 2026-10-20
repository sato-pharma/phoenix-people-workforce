import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { stripComments } from "./support/comment-strip.ts";

const VISIBILITY_FN = "resolveEmployeePortalNavVisibility";
const REQUIRED_ARG_COUNT = 6; // roleLabel, accessRole, line, department, hrId, hasDeviceMapping

function appDir() {
  return fileURLToPath(new URL("../app/", import.meta.url));
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract the raw argument text of every `fnName(...)` call in `source`,
 * matching parentheses so nested calls don't truncate the slice.
 */
function extractCallArguments(source: string, fnName: string): string[] {
  const calls: string[] = [];
  const needle = `${fnName}(`;
  let cursor = 0;
  for (;;) {
    const start = source.indexOf(needle, cursor);
    if (start === -1) break;
    let i = start + needle.length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    calls.push(source.slice(start + needle.length, i - 1));
    cursor = i;
  }
  return calls;
}

/** Count top-level (comma-separated) arguments, ignoring commas nested in (), [], {}. */
function countTopLevelArgs(argText: string): number {
  if (argText.trim() === "") return 0;
  let depth = 0;
  let count = 1;
  for (const ch of argText) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/**
 * Regression guard for the A-3 "Fingerprint Report tab vanishes on Payslips" bug (PR #180).
 *
 * The portal sidebar is built from resolveEmployeePortalNavVisibility, whose 6th argument
 * (hasDeviceMapping) is the ONLY thing that gates the "Fingerprint Report" tab. Routes that
 * render their own portal chrome OUTSIDE the canonical EmployeePortalServerShell
 * (e.g. app/payslips) once forgot to pass it, so the tab silently disappeared for users with
 * an active device mapping. These tests pin the contract and fail if any app/ caller drops it.
 */
export function runEmployeePortalFingerprintVisibilityTests() {
  // 1. Behavioural contract: for an ordinary employee, hasDeviceMapping is what gates the
  //    Fingerprint Report tab. (It was asserted on the "Manager" seat until 2026-10-20, when that
  //    seat began getting the tab for its team — see the Manager assertion below.)
  const withMapping = resolveEmployeePortalNavVisibility("Employee", "Employee", null, null, "A-30", true);
  assert.equal(
    withMapping.showFingerprintReportTab,
    true,
    "an active device mapping must surface the Fingerprint Report tab",
  );

  const withoutMapping = resolveEmployeePortalNavVisibility("Employee", "Employee", null, null, "A-30", false);
  assert.equal(
    withoutMapping.showFingerprintReportTab,
    false,
    "no device mapping must hide the Fingerprint Report tab",
  );

  // Omitting the argument entirely (the original bug) must also hide it — never crash.
  const argOmitted = resolveEmployeePortalNavVisibility("Employee", "Employee", null, null, "A-30");
  assert.equal(
    argOmitted.showFingerprintReportTab,
    false,
    "omitting hasDeviceMapping defaults the tab off — which is exactly why callers must pass it",
  );

  // The generic "Manager" seat (the R&D Manager, who has reports) gets the tab without a device
  // mapping (owner, 2026-10-20): the page admits him by his attendance:read grant and its picker
  // lists his team. The tab and the page gate must agree, so the grant is asserted with it.
  const managerSeat = resolveEmployeePortalNavVisibility("Manager", "Manager", null, null, "A-3", false);
  assert.equal(managerSeat.showFingerprintReportTab, true, "the Manager seat must be offered Attendance Analytics for his team");
  assert.ok(
    permissionMatrix.Manager.attendance?.includes("read"),
    "the Manager seat must hold attendance:read, or the tab would open onto the page's redirect",
  );
  const pageSource = stripComments(readFileSync(fileURLToPath(new URL("../app/employee-portals/fingerprint-analytics/page.tsx", import.meta.url)), "utf8"));
  assert.match(pageSource, /canAccess\(access, "attendance", "read"\)/, "the page's gate is attendance:read — the grant asserted above");

  // 2. Source guard: every app/ caller must pass the 6th (hasDeviceMapping) argument.
  const files = walkTsFiles(appDir()).filter((file) =>
    readFileSync(file, "utf8").includes(`${VISIBILITY_FN}(`),
  );
  assert.ok(
    files.length > 0,
    `expected at least one app/ caller of ${VISIBILITY_FN} — did the function move or get renamed?`,
  );

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const argText of extractCallArguments(source, VISIBILITY_FN)) {
      if (countTopLevelArgs(argText) < REQUIRED_ARG_COUNT) {
        const relative = file.slice(file.indexOf("/app/") + 1);
        offenders.push(relative);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Every call to ${VISIBILITY_FN} must pass the 6th argument (hasDeviceMapping) so the ` +
      `Fingerprint Report tab cannot silently disappear (see PR #180). Offending files:\n` +
      offenders.join("\n"),
  );
}
