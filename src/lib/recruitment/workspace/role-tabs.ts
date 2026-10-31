// Recruitment workspace — the nine role tabs, and who may see which.
//
// WHY THIS IS ITS OWN VOCABULARY. The owner named the tabs himself on 20 Oct 2026 — "a tab for med
// rep and another DM and another PM and another for RM/AM and NSM same tab another one for HRSH and
// another for TA" plus Office Coordinator on its own and "last tab called Other" — Personnel joined on
// 31 Oct 2026 with its opening ("add to whatsapp bot") — and they are NOT
// the bot's thirteen role families (`candidateRoleFamilies`). Two families share a tab (RM/AM and
// NSM), four fold into Other, and the retired Human Resources tap fits no tab at all, so it waits in
// Needs placing rather than being guessed into Talent Acquisition or HR Section Head.
//
// FILING IS FROM THE APPLICANT'S REPLY ONLY (owner, 2026-10-20: "we do not look at the cv we folder
// based on whatsapp replies"). Nothing in this file reads a CV field; `roleTabForFamily` is handed
// the family the applicant TAPPED, and returns null when that tap fits no tab.
//
// Pure — no database, so the map and the access rules stay testable (`tests/recruitment-role-tabs`).

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import type { CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";

export const workspaceRoleTabs = [
  "medical_rep",
  "district_manager",
  "product_manager",
  "rm_am_nsm",
  "hr_section_head",
  "talent_acquisition",
  "office_coordinator",
  "personnel",
  "other",
] as const;

export type WorkspaceRoleTab = (typeof workspaceRoleTabs)[number];

/** Candidates whose role is not known from their own reply. Not a role tab: it has no placement row. */
export const NEEDS_PLACING = "needs_placing" as const;
/** The hand-built folder tree and the managers' folders. Not a role tab either. */
export const FOLDERS_TAB = "folders" as const;

export type WorkspaceTabKey = WorkspaceRoleTab | typeof NEEDS_PLACING | typeof FOLDERS_TAB;

export const workspaceRoleTabLabels: Record<WorkspaceRoleTab, string> = {
  medical_rep: "Medical Rep",
  district_manager: "District Manager",
  product_manager: "Product Manager",
  rm_am_nsm: "RM/AM + NSM",
  hr_section_head: "HR Section Head",
  talent_acquisition: "Talent Acquisition",
  office_coordinator: "Office Coordinator",
  personnel: "Personnel",
  other: "Other",
};

export const workspaceTabLabels: Record<WorkspaceTabKey, string> = {
  ...workspaceRoleTabLabels,
  [NEEDS_PLACING]: "Needs placing",
  [FOLDERS_TAB]: "Folders",
};

/** Tabs that carry region sub-tabs; Medical Rep alone goes one level further, into AU areas. */
export const tabsWithRegions: readonly WorkspaceRoleTab[] = ["medical_rep", "district_manager"];
export const tabsWithAreas: readonly WorkspaceRoleTab[] = ["medical_rep"];

/**
 * The tabs the Talent Acquisition seat never sees: her manager's seat and her own (owner, 2026-10-20),
 * and the Personnel seat beside hers (2026-10-31) — his rule is that she never sees an HR applicant.
 */
export const HR_ROLE_TABS: readonly WorkspaceRoleTab[] = ["hr_section_head", "talent_acquisition", "personnel"];
/**
 * Role families that make a PERSON an HR applicant for the fence, even before they are placed.
 * `human_resources` is the menu row retired on 6 Oct 2026 and the careers form's old mapping for a
 * Talent Acquisition Specialist — such a person sits in Needs placing, and is still hidden from her.
 */
export const HR_ROLE_FAMILIES: readonly string[] = ["hr_section_head", "talent_acquisition", "personnel", "human_resources"];

const FAMILY_TO_TAB: Record<CandidateRoleFamily, WorkspaceRoleTab | null> = {
  medical_rep: "medical_rep",
  district_manager: "district_manager",
  product_manager: "product_manager",
  area_regional_manager: "rm_am_nsm",
  national_sales_manager: "rm_am_nsm",
  hr_section_head: "hr_section_head",
  talent_acquisition: "talent_acquisition",
  office_coordinator: "office_coordinator",
  personnel: "personnel",
  other: "other",
  finance: "other",
  sales: "other",
  pharmacist: "other",
  // The retired Human Resources tap: neither HR tab is a safe guess, so Needs placing.
  human_resources: null,
};

/** The tab an applicant's own role reply files them in, or null for Needs placing. */
export function roleTabForFamily(family: string | null | undefined): WorkspaceRoleTab | null {
  if (!family) return null;
  return (FAMILY_TO_TAB as Record<string, WorkspaceRoleTab | null>)[family] ?? null;
}

export function isWorkspaceRoleTab(value: unknown): value is WorkspaceRoleTab {
  return typeof value === "string" && (workspaceRoleTabs as readonly string[]).includes(value);
}

export function isWorkspaceTabKey(value: unknown): value is WorkspaceTabKey {
  return isWorkspaceRoleTab(value) || value === NEEDS_PLACING || value === FOLDERS_TAB;
}

// ---------------------------------------------------------------------------------------------
// Who sees which tab. Enforced on the SERVER: the allowed tabs are computed here from the session and
// handed to the database filter, never read from a request.
// ---------------------------------------------------------------------------------------------

/** Roles that WORK the workspace (decide, send, file). The Super Admin and the Talent Acquisition seat. */
const WORKSPACE_WORK_ROLES: readonly PhoenixRole[] = ["Super Admin", "HR Resourcing"];
/**
 * Roles that READ it only. The CEO has no `candidates:read` in the permission matrix and
 * `tests/ceo-account-contract.test.ts` pins that, so he is admitted by THIS named gate — on the
 * workspace page and its rows, counts and search routes only — and every write refuses him.
 */
const WORKSPACE_READ_ONLY_ROLES: readonly PhoenixRole[] = ["CEO"];

export type WorkspaceViewer = {
  /** May open the workspace at all. */
  canRead: boolean;
  /** May decide, send, file, edit answers. False for the CEO. */
  canWork: boolean;
  /** The role tabs this viewer sees, in the owner's order. */
  roleTabs: WorkspaceRoleTab[];
  /** Needs placing is visible to anyone who works the workspace, and read by the CEO. */
  seesNeedsPlacing: boolean;
  /** The Talent Acquisition fence: hide every HR applicant as a whole person. */
  hidesHrPeople: boolean;
};

export function workspaceViewer(access: Pick<AccessContext, "role" | "scope">): WorkspaceViewer {
  const system = access.scope === "system";
  const works = system || WORKSPACE_WORK_ROLES.includes(access.role);
  const reads = works || WORKSPACE_READ_ONLY_ROLES.includes(access.role);
  if (!reads) {
    return { canRead: false, canWork: false, roleTabs: [], seesNeedsPlacing: false, hidesHrPeople: false };
  }
  const hidesHrPeople = !system && access.role === "HR Resourcing";
  const roleTabs = workspaceRoleTabs.filter((tab) => !(hidesHrPeople && HR_ROLE_TABS.includes(tab)));
  return { canRead: true, canWork: works, roleTabs, seesNeedsPlacing: true, hidesHrPeople };
}

/** The `allowed_tabs` array the database filter receives — role tabs plus needs_placing when visible. */
export function allowedTabsForViewer(viewer: WorkspaceViewer): string[] {
  return viewer.seesNeedsPlacing ? [...viewer.roleTabs, NEEDS_PLACING] : [...viewer.roleTabs];
}

/**
 * Whether one person may be shown to this viewer, from what is stored about them. The same rule as
 * the SQL fence in `ats_workspace_filter` — kept here for the boundaries that read one candidate by id
 * (the profile, a file download, a timeline), where calling the filter would be a round trip too many.
 */
export function personVisibleToViewer(
  viewer: WorkspaceViewer,
  person: { declaredRoleFamily: string | null; placementTabs: readonly string[] },
): boolean {
  if (!viewer.canRead) return false;
  if (!viewer.hidesHrPeople) return true;
  if (person.declaredRoleFamily && HR_ROLE_FAMILIES.includes(person.declaredRoleFamily)) return false;
  return !person.placementTabs.some((tab) => (HR_ROLE_TABS as readonly string[]).includes(tab));
}
