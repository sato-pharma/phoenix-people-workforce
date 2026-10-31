// Pins src/lib/recruitment/workspace/role-tabs.ts — the tabs the owner named on 20 Oct 2026 (Personnel joined 31 Oct), the
// bot-family -> tab map that files every applicant from their OWN reply, and who sees which tab.
//
// Why each case matters:
//   * human_resources -> no tab. The retired Human Resources tap fits neither HR tab; guessing one
//     would put an applicant in front of the wrong person (or hide them from the right one).
//   * The Talent Acquisition seat (`HR Resourcing`) never sees the two HR tabs, and is fenced by
//     PERSON (`hidesHrPeople`): her own seat and her manager's are being recruited there.
//   * The CEO reads the workspace and writes nothing — and he is admitted by this named gate, never
//     by `candidates: read` (tests/ceo-account-contract.test.ts pins that he never holds it).
//   * `personVisibleToViewer` is the TypeScript twin of the SQL fence in `ats_workspace_filter`.

import assert from "node:assert/strict";

import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import { scopeForRole } from "../src/lib/auth/permissions.ts";
import {
  allowedTabsForViewer,
  FOLDERS_TAB,
  HR_ROLE_TABS,
  isWorkspaceRoleTab,
  isWorkspaceTabKey,
  NEEDS_PLACING,
  personVisibleToViewer,
  roleTabForFamily,
  workspaceRoleTabLabels,
  workspaceRoleTabs,
  workspaceViewer,
} from "../src/lib/recruitment/workspace/role-tabs.ts";

const EXPECTED_MAP: Record<string, string | null> = {
  area_regional_manager: "rm_am_nsm",
  district_manager: "district_manager",
  finance: "other",
  hr_section_head: "hr_section_head",
  human_resources: null,
  medical_rep: "medical_rep",
  national_sales_manager: "rm_am_nsm",
  office_coordinator: "office_coordinator",
  other: "other",
  personnel: "personnel",
  pharmacist: "other",
  product_manager: "product_manager",
  sales: "other",
  talent_acquisition: "talent_acquisition",
};

function viewerFor(role: Parameters<typeof scopeForRole>[0]) {
  return workspaceViewer({ role, scope: scopeForRole(role) });
}

export function runRecruitmentRoleTabsTests() {
  // ── The tabs, in his order, each with a label ──
  assert.deepEqual(
    [...workspaceRoleTabs],
    ["medical_rep", "district_manager", "product_manager", "rm_am_nsm", "hr_section_head", "talent_acquisition", "office_coordinator", "personnel", "other"],
    "the nine tabs, in the owner's order (Personnel added 2026-10-31 with its opening)",
  );
  for (const tab of workspaceRoleTabs) assert.ok(workspaceRoleTabLabels[tab], `${tab} has a label`);
  assert.equal(workspaceRoleTabLabels.rm_am_nsm, "RM/AM + NSM");

  // ── The family -> tab map, every family the bot offers ──
  assert.deepEqual(
    [...candidateRoleFamilies].sort(),
    Object.keys(EXPECTED_MAP).sort(),
    "every bot role family is pinned here — a new family must be filed deliberately",
  );
  for (const [family, tab] of Object.entries(EXPECTED_MAP)) {
    assert.equal(roleTabForFamily(family), tab, `${family} files into ${tab ?? "Needs placing"}`);
  }
  assert.equal(roleTabForFamily("human_resources"), null, "the retired Human Resources tap waits in Needs placing");
  assert.equal(roleTabForFamily(null), null);
  assert.equal(roleTabForFamily(""), null);
  assert.equal(roleTabForFamily("not_a_family"), null, "an unknown family is never guessed into a tab");

  assert.equal(isWorkspaceRoleTab("medical_rep"), true);
  assert.equal(isWorkspaceRoleTab(NEEDS_PLACING), false, "Needs placing is not a role tab");
  assert.equal(isWorkspaceTabKey(NEEDS_PLACING), true);
  assert.equal(isWorkspaceTabKey(FOLDERS_TAB), true);
  assert.equal(isWorkspaceTabKey("hr"), false);

  // ── Who sees which tab ──
  const superAdmin = viewerFor("Super Admin");
  assert.equal(superAdmin.canRead, true);
  assert.equal(superAdmin.canWork, true);
  assert.equal(superAdmin.hidesHrPeople, false);
  assert.deepEqual(superAdmin.roleTabs, [...workspaceRoleTabs], "the Super Admin sees all nine");

  const ta = viewerFor("HR Resourcing");
  assert.equal(ta.canRead, true);
  assert.equal(ta.canWork, true, "Talent Acquisition works the workspace");
  assert.equal(ta.hidesHrPeople, true, "and is fenced by person");
  assert.equal(ta.roleTabs.length, 6, "six role tabs");
  for (const hidden of HR_ROLE_TABS) {
    assert.equal(ta.roleTabs.includes(hidden), false, `Talent Acquisition never sees ${hidden}`);
  }
  assert.deepEqual(
    allowedTabsForViewer(ta),
    ["medical_rep", "district_manager", "product_manager", "rm_am_nsm", "office_coordinator", "other", NEEDS_PLACING],
    "her allowed tabs: six role tabs plus Needs placing, never an HR tab",
  );

  const ceo = viewerFor("CEO");
  assert.equal(ceo.canRead, true, "the CEO reads the workspace");
  assert.equal(ceo.canWork, false, "and writes nothing through it");
  assert.equal(ceo.hidesHrPeople, false);
  assert.deepEqual(ceo.roleTabs, [...workspaceRoleTabs]);

  for (const role of ["Medical Rep", "District Manager", "HR Operations", "Finance Manager", "Employee"] as const) {
    const viewer = viewerFor(role);
    assert.equal(viewer.canRead, false, `${role} does not open the workspace`);
    assert.equal(viewer.canWork, false);
    assert.deepEqual(viewer.roleTabs, []);
    assert.deepEqual(allowedTabsForViewer(viewer), [], `${role} is handed no tab at all`);
  }

  // ── The fence, by person ──
  const visible = (viewer: ReturnType<typeof viewerFor>, declaredRoleFamily: string | null, placementTabs: string[]) =>
    personVisibleToViewer(viewer, { declaredRoleFamily, placementTabs });

  assert.equal(visible(ta, "medical_rep", ["medical_rep"]), true, "a Medical Rep applicant is hers");
  assert.equal(visible(ta, null, []), true, "an unplaced applicant with no declared role is hers");
  assert.equal(visible(ta, "hr_section_head", []), false, "an HR Section Head applicant is hidden before placing");
  assert.equal(visible(ta, "talent_acquisition", []), false, "a Talent Acquisition applicant is hidden");
  assert.equal(visible(ta, "human_resources", []), false, "the retired Human Resources tap is hidden too");
  assert.equal(visible(ta, "medical_rep", ["medical_rep", "talent_acquisition"]), false, "ANY HR placement hides the whole person");
  assert.equal(visible(ta, null, ["hr_section_head"]), false);
  assert.equal(visible(superAdmin, "talent_acquisition", ["talent_acquisition"]), true, "the Super Admin sees HR applicants");
  assert.equal(visible(ceo, "hr_section_head", ["hr_section_head"]), true, "the CEO sees HR applicants");
  assert.equal(visible(viewerFor("Medical Rep"), "medical_rep", ["medical_rep"]), false, "a non-reader sees nobody");
}
