import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalPersonHrId,
  isSamePerson,
  isSharedIdentityAlias,
  sharedIdentityDisplayName,
  sharedIdentityGroups,
  sharedIdentityKeys,
} from "../src/lib/auth/identity-aliases.ts";
import { resolveEmployeeDisplayName } from "../src/lib/employees/display-name.ts";
import { isManagerOptionalHrId } from "../src/lib/employees/hierarchy-governance.ts";
import { defaultPrivateCalendarGlobalHrIds } from "../src/lib/private-calendar/logic.ts";
import { CAP_EXEMPT_HR_IDS } from "../src/lib/probation/intelligence/notification-cap.ts";

export function runIdentityAliasesTests() {
  // ── The declared group ───────────────────────────────────────────────────────
  // B-10 (HR Manager) and PHX-1 / login admin-HR (the system-administrator console) are one
  // person. Owner confirmation 2026-07-04, re-confirmed system-wide 2026-07-25.
  const group = sharedIdentityGroups.find((candidate) => candidate.canonicalHrId === "B-10");
  assert.ok(group, "the HR Manager / System Administrator group must be declared");
  assert.deepEqual([...group.aliasHrIds], ["PHX-1", "admin-HR"]);

  // ── Group membership ─────────────────────────────────────────────────────────
  const expected = new Set(["b-10", "phx-1", "admin-hr"]);
  for (const id of ["B-10", "PHX-1", "admin-HR", "ADMIN-HR", "phx-1", "b-10"]) {
    assert.deepEqual(sharedIdentityKeys(id), expected, `${id} resolves to the whole group`);
  }

  // Casing must never matter: "admin-HR" and "ADMIN-HR" are the same stored account.
  assert.equal(isSamePerson("admin-HR", "ADMIN-HR"), true);
  assert.equal(isSamePerson("PHX-1", "B-10"), true);
  assert.equal(isSamePerson("B-10", "phx-1"), true);
  assert.equal(isSamePerson("B-10", "B-10"), true, "plain equality still holds");

  // ── Everyone else is untouched ───────────────────────────────────────────────
  assert.deepEqual(sharedIdentityKeys("A-12"), new Set(["a-12"]), "a non-grouped ID is only itself");
  assert.equal(isSamePerson("A-12", "B-10"), false);
  assert.equal(isSamePerson("AA", "B-10"), false, "the CEO is a different person");
  // Substring trap: B-1 must never absorb B-10 (the recurring HR_ID prefix bug in this repo).
  assert.equal(isSamePerson("B-1", "B-10"), false, "B-1 is not B-10");
  assert.deepEqual(sharedIdentityKeys("B-1"), new Set(["b-1"]));
  // Blank/unparseable input yields an empty set so callers can use it unconditionally.
  assert.deepEqual(sharedIdentityKeys(null), new Set());
  assert.deepEqual(sharedIdentityKeys("   "), new Set());
  assert.equal(isSamePerson(null, "B-10"), false);
  assert.equal(isSamePerson("B-10", null), false);

  // ── Canonical HR_ID ──────────────────────────────────────────────────────────
  assert.equal(canonicalPersonHrId("PHX-1"), "B-10");
  assert.equal(canonicalPersonHrId("admin-HR"), "B-10");
  assert.equal(canonicalPersonHrId("B-10"), "B-10");
  assert.equal(canonicalPersonHrId("A-12"), "A-12", "non-grouped IDs pass through, canonically cased");
  assert.equal(canonicalPersonHrId(null), null);

  // ── Display name ─────────────────────────────────────────────────────────────
  // Only the SECONDARY accounts are relabelled; the person's own row keeps its stored name.
  assert.equal(sharedIdentityDisplayName("PHX-1"), "Omar Anwar Gawish");
  assert.equal(sharedIdentityDisplayName("admin-HR"), "Omar Anwar Gawish");
  assert.equal(sharedIdentityDisplayName("B-10"), null, "the canonical row keeps its stored full name");
  assert.equal(sharedIdentityDisplayName("A-12"), null);
  assert.equal(isSharedIdentityAlias("PHX-1"), true);
  assert.equal(isSharedIdentityAlias("B-10"), false);

  assert.equal(
    resolveEmployeeDisplayName("Phoenix System Administrator", null, "PHX-1"),
    "Omar Anwar Gawish",
    "a console row renders as the human who operates it",
  );
  assert.equal(
    resolveEmployeeDisplayName("Omar Anwar Ibrahim Ahmed Gawish", null, "B-10"),
    "Omar Anwar Ibrahim Ahmed Gawish",
    "the real employee row is never rewritten",
  );
  assert.equal(
    resolveEmployeeDisplayName("Ahmed Samir", "Ahmed", "M-1"),
    "Ahmed",
    "nickname handling is unchanged for everyone else",
  );
  assert.equal(
    resolveEmployeeDisplayName("Ahmed Samir", "Ahmed"),
    "Ahmed",
    "the hrId argument stays optional — existing call sites keep working",
  );

  // ── Every consumer derives from the primitive ────────────────────────────────
  // These five lists used to be hardcoded per module and disagreed with each other.
  assert.deepEqual(
    new Set(defaultPrivateCalendarGlobalHrIds),
    expected,
    "private-calendar global viewers cover the whole person (it previously missed PHX-1)",
  );
  assert.deepEqual(
    new Set(CAP_EXEMPT_HR_IDS),
    expected,
    "the probation cap exemption covers the whole person (it previously exempted PHX-1 but capped B-10)",
  );
  assert.equal(isManagerOptionalHrId("PHX-1"), true, "console accounts sit outside the org chart");
  assert.equal(isManagerOptionalHrId("ADMIN-HR"), true);
  assert.equal(isManagerOptionalHrId("AA"), true, "the CEO reports to nobody");
  assert.equal(isManagerOptionalHrId("B-10"), false, "the real employee row still needs a manager");

  const weeklyAccess = readFileSync("src/lib/sales/weekly/access.ts", "utf8");
  assert.match(
    weeklyAccess,
    /\[\.\.\.sharedIdentityKeys\("B-10"\), canonicalHrIdKey\("aa"\)\]/,
    "weekly-sales full access derives the HR Manager's IDs from the primitive, keeping the CEO separate",
  );

  // The primitive must stay OUT of the HR_ID normalization layer: collapsing the aliases there
  // would make the system-admin employee row unreachable and would rewrite persisted HR_IDs.
  const hrIdSource = readFileSync("src/lib/hr-id.ts", "utf8");
  assert.doesNotMatch(hrIdSource, /identity-aliases/, "hr-id.ts must not depend on the person-identity groups");
  assert.doesNotMatch(hrIdSource, /phx-1|admin-hr/i, "hr-id.ts must not alias the system-admin accounts");

  // ── Approvals resolve to the person, not the login ───────────────────────────
  // A decision recorded from the system console (PHX-1) and one recorded from the employee login
  // (B-10) are the same person's history; matching only the signed-in HR_ID hid half of it.
  const actionCenter = readFileSync("src/lib/action-center/service.ts", "utf8");
  assert.match(
    actionCenter,
    /const actorHrIds = Array\.from\(sharedIdentityKeys\(hrId\)\)/,
    "approval history queries every HR_ID of the signed-in person",
  );
  assert.match(
    actionCenter,
    /columns\.flatMap\(\(column\) => actorHrIds\.map\(\(id\) => quotedOrClause\(column, "ilike", id\)\)\)/,
    "each decider column is matched case-insensitively against all of the person's HR_IDs",
  );
  assert.doesNotMatch(
    actionCenter,
    /\.ilike\.\$\{hrId\}/,
    "no approval-history query may filter on the single signed-in HR_ID any more",
  );
  assert.doesNotMatch(
    actionCenter,
    /_by(_hr_id)? \?\? ""\)\.toUpperCase\(\) === hrId/,
    "no per-row decider check may compare against the single signed-in HR_ID any more",
  );

  // The self-approval guard must hold across logins — otherwise the same human could approve
  // their own request simply by switching to their other account.
  const approvalsHub = readFileSync("src/lib/approvals-hub/service.ts", "utf8");
  assert.match(
    approvalsHub,
    /function isViewer\(candidate: string \| null \| undefined, viewerHrId: string \| null \| undefined\)/,
    "the approvals hub resolves the viewer to a person",
  );
  assert.match(approvalsHub, /const own = isViewer\(/, "own-request detection is person-based");
  assert.doesNotMatch(
    approvalsHub,
    /const own = hrIdsMatch\(/,
    "own-request detection must not fall back to single-HR_ID matching",
  );
  assert.match(
    approvalsHub,
    /employees\.find\(\(e\) => hrIdsMatch\(e\.hrId, canonicalPersonHrId\(hrId\)\)\)/,
    "a decision recorded by the console account renders the person's name, not a bare code",
  );

  // The directory's system-account filter must match by HR_ID, not only by the name string —
  // otherwise relabelling the display name would leak console rows into the employee directory.
  const directorySource = readFileSync("src/lib/employees/employee-directory.ts", "utf8");
  assert.match(
    directorySource,
    /systemAdminDirectoryHrIdKeys\.has\(hrId\)/,
    "system/console rows are excluded from the directory by HR_ID",
  );
  assert.doesNotMatch(
    directorySource,
    /hrId === "ADMIN-HR"/,
    "the dead uppercase comparison (normalizeHrId returns lowercase) must not come back",
  );
}
