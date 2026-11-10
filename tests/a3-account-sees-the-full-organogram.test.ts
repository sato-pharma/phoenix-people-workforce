import { strict as assert } from "node:assert";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import {
  buildPermissionLookup,
  canAccess,
  createAccessContext,
  permissionMatrix,
} from "../src/lib/auth/permissions.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import {
  canAccessCompanyOrganogram,
  canAccessHeadOffice,
  canViewOrganogramSensitiveFields,
  isFullOrganogramPinnedAccount,
  isLineScopedOrganogramRole,
} from "../src/lib/reports/organogram.ts";
import { FULL_ORGANOGRAM_PINNED_HR_IDS } from "../src/lib/reports/organogram-pinned-accounts.ts";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * ONE account — HR_ID A-3 — sees the full company organogram; the rest of its rung does not.
 *
 * Owner instruction, 2026-09-02: "show the full organogram to sama mosaad account". Samaa Mosaad
 * Khalil is A-3, QPPV, Head Office, and her app role is the legacy Head-Office `Manager` rung.
 *
 * ## Why this needed a pin and not the usual role edit
 *
 * `Manager` holds THREE accounts in production — A-3, A-14 (Regulatory Affairs) and AB (R&D
 * Manager). Every previous grant of this page named a ROLE (Finance Manager, SFE Manager, both HR
 * seats), which here would have handed the whole company chart to two people the owner did not
 * name. He was asked directly and chose her account alone.
 *
 * On 2026-10-20 the owner named a SECOND account: AB, Dr. Sahar Khalil, then the R&D Manager (the Toll Manufacturing Manager since 2026-11-10) the QPPV
 * reports to, gets the same company chart, Head Office included (block 5). Still by HR_ID — A-14
 * stays outside, and blocks 2 and 4 still hold for her.
 *
 * ## The shape that results, and why each half is deliberate
 *
 * The permission matrix has no per-user layer — `role_permission_overrides` keys on role_name —
 * so `organogram: ["read"]` is granted to the RUNG, while the two enforcing gates are pinned to
 * the HR_ID. That is normally the "granted on paper, bounced in practice" bug this repo has paid
 * for three times; here it is the intended state, and blocks 2 and 3 below are what keep it
 * honest — the paper grant must stay inert for a Manager who is not A-3, in the gates AND in the
 * sidebar.
 *
 * ## What breaks this test
 *
 * Removing the pin from either gate (block 1), widening it to the role (blocks 2/3), or adding
 * "Manager" to system-navigation.ts's portal Organogram entry (block 4, which would also fail
 * organogram-nav-link-exists-for-every-role-that-can-open-it as a dead link for the other two).
 */
export async function runA3FullOrganogramTests() {
  const samaa = createAccessContext({ hrId: "A-3", role: "Manager" });
  const colleague = createAccessContext({ hrId: "A-14", role: "Manager" });

  // ── 1. Samaa: all three gates open ───────────────────────────────────────────────────────────
  assert.equal(
    await canAccess(samaa, "organogram", "read"),
    true,
    "A-3 holds no organogram:read — assertPermission is the FIRST gate on the portal page and " +
      "every /api/reports/organogram route, so nothing below matters without it",
  );
  assert.equal(
    canAccessCompanyOrganogram(samaa),
    true,
    "A-3 must read the chart in COMPANY mode. Without this the portal page falls to " +
      'redirect("/employee-portals") — granted and still bounced, the two-gate trap',
  );
  assert.equal(
    canAccessHeadOffice(samaa),
    true,
    "A-3 must keep the Head Office rows. She IS Head Office (QPPV), so stripHeadOfficeRows would " +
      "silently remove the one part of the tree she sits in and the chart would still look whole",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("Manager", "Manager", null, null, "A-3").showOrganogramTab,
    true,
    "A-3 must be OFFERED the Organogram tab. The portal builds its own sidebar from these flags, " +
      "so a grant with no flag is a page she cannot find — the 2026-08-25 Talent Acquisition bug",
  );

  // HR_IDs are stored mixed-case in production (`A-3`). A `===` comparison against a lowercase
  // literal matches nobody, with no error — which reads as "the change never shipped".
  for (const spelling of ["A-3", "a-3", " a-3 "]) {
    assert.equal(
      isFullOrganogramPinnedAccount({ hrId: spelling, loginId: null }),
      true,
      `the pin must survive the spelling ${JSON.stringify(spelling)}`,
    );
  }
  assert.equal(
    isFullOrganogramPinnedAccount({ hrId: null, loginId: "A-3" }),
    true,
    "loginId must be honoured too — user_access_profiles carries A-3 in BOTH columns for her",
  );

  // ── 2. The rest of the rung: the paper grant must stay inert ─────────────────────────────────
  // This is the block that fails if someone "tidies" the pin into `access.role === "Manager"`.
  assert.equal(
    await canAccess(colleague, "organogram", "read"),
    true,
    "the grant is role-keyed by necessity, so A-14 does hold it — blocks below are why that is safe",
  );
  assert.equal(
    canAccessCompanyOrganogram(colleague),
    false,
    "A-14 (Regulatory Affairs) must NOT reach the company chart — the owner named accounts, not the rung",
  );
  assert.equal(
    isLineScopedOrganogramRole(colleague),
    false,
    "…and must not fall through to a LINE slice either, which would render a sales line and read " +
      "as a working page rather than as access she was never given",
  );
  assert.equal(
    canAccessHeadOffice(colleague),
    false,
    "…and must not reach Head Office, where every other Manager on this rung actually sits",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("Manager", "Manager", null, null, "A-14").showOrganogramTab,
    false,
    "A-14 must be offered NO link. With both gates shut a link is a dead row that redirects",
  );

  // ── 3. Samaa gets the chart, never the payroll behind it ─────────────────────────────────────
  assert.equal(
    canViewOrganogramSensitiveFields(samaa),
    false,
    "A-3 must NOT see the Personal + Compensation sections of the node popup. The owner asked for " +
      "the org chart; salary and national ID are a separate, narrower allowlist (admins/HR/finance)",
  );

  // ── 4. system-navigation.ts must stay silent about this rung ─────────────────────────────────
  // Her sidebar row comes from showOrganogramTab alone. That file gates by ROLE and cannot express
  // an HR_ID, so listing "Manager" there would offer A-14 a link the page bounces.
  // buildPermissionLookup, never a hand-rolled double loop: tests/permission-lookup-totality
  // ratchets the number of files that copy it, and a copy that drifts fails OPEN — every
  // unlisted key reads as false, so a link would silently vanish and the assertion would pass
  // for the wrong reason.
  const offered = getSections(
    getNavigationSections("employee-portal"),
    "employee-portal",
    buildPermissionLookup(permissionMatrix, "Manager"),
    "Manager",
  ).some((section) => section.items.some((item) => item.href === "/employee-portals/organogram"));
  assert.equal(
    offered,
    false,
    'system-navigation.ts must not list "Manager" on the portal Organogram entry: it would be a ' +
      "dead link for the Manager who is not pinned (A-14), and the pinned accounts already have " +
      "their row from showOrganogramTab",
  );

  // ── 5. AB, the Toll Manufacturing Manager the QPPV reports to: the same chart (owner, 2026-10-20) ────────────
  const sahar = createAccessContext({ hrId: "AB", role: "Manager" });
  assert.deepEqual([...FULL_ORGANOGRAM_PINNED_HR_IDS], ["A-3", "AB"], "exactly two pinned accounts — never the rung");
  assert.equal(await canAccess(sahar, "organogram", "read"), true, "AB holds the rung's organogram:read");
  assert.equal(canAccessCompanyOrganogram(sahar), true, "AB reads the chart in COMPANY mode, like the QPPV");
  assert.equal(canAccessHeadOffice(sahar), true, "AB keeps the Head Office rows — the branch she and the QPPV sit in");
  assert.equal(canViewOrganogramSensitiveFields(sahar), false, "AB gets the chart, never the pay behind it");
  for (const spelling of ["AB", "ab", " ab "]) {
    assert.equal(
      isFullOrganogramPinnedAccount({ hrId: spelling, loginId: null }),
      true,
      `the AB pin must survive the spelling ${JSON.stringify(spelling)}`,
    );
  }
  assert.equal(isFullOrganogramPinnedAccount({ hrId: null, loginId: "AB" }), true, "loginId is honoured for AB too");
  const saharNav = resolveEmployeePortalNavVisibility("Manager", "Manager", null, null, "AB");
  assert.equal(saharNav.showOrganogramTab, true, "AB is OFFERED the Organogram tab — the page and the link agree");
  // The pin grants the organogram and nothing else: AB does not inherit the QPPV's other carve-outs.
  const colleagueNav = resolveEmployeePortalNavVisibility("Manager", "Manager", null, null, "A-14");
  for (const key of ["showExpenseActionTab", "showExpenseDashboardTab", "showIncentiveTab", "showMyPerformanceTab"] as const) {
    assert.equal(saharNav[key], colleagueNav[key], `AB's ${key} follows the rung, not the QPPV's carve-out`);
  }

  // The gate and the link read ONE list, so they cannot drift apart.
  const organogramCode = stripComments(readFileSync("src/lib/reports/organogram.ts", "utf8"));
  const navigationCode = stripComments(readFileSync("src/lib/employee-portal/navigation.ts", "utf8"));
  assert.ok(
    organogramCode.includes('from "@/lib/reports/organogram-pinned-accounts"'),
    "the two organogram gates read the shared pinned list",
  );
  assert.ok(
    /showOrganogramTab:\s*isFullOrganogramPinnedHrId\(viewerHrId\)/.test(navigationCode),
    "the portal Organogram link reads the same shared pinned list",
  );
}
