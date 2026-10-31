/**
 * Which CRM contacts a person registering a direct-order venue may declare it to be.
 *
 * ## Why this exists at all
 *
 * `contact-trade.ts` decides whether a row on a rep's CRM contact list has been traded with, and it
 * has three rules in order: an explicit CRM id wins outright; else an exact name in the same sales
 * area; else a prefix unique in that area. Marketing fires rule 1 because
 * `marketing_customer_contacts.crm_code` carries an id a human wrote down. The direct-order side
 * carried no id anywhere, so it could only ever reach the two INFERRED rules — and measured against
 * production on 2026-09-03, exactly ONE of 63 live venues linked to a CRM contact.
 *
 * That is not a matcher problem and cannot be fixed by better matching. Drop the area gate entirely
 * and ask only whether a venue name has ANY twin among all 1,872 CRM pharmacies and the answer is 4.
 * The names do not meet. So the venue now carries a DECLARED contact id, and this module is what the
 * submitter picks it from.
 *
 * ## The scope is self UNION subtree, and both halves are load-bearing
 *
 * Venue creators are almost entirely District Sales Managers — 10 of the 12 people who have ever
 * registered one, and 63 of the 72 venues — and a DM's own CRM account carries NO contact list at
 * all. The lists belong to the 44 medical reps beneath them. So:
 *
 *  - SELF alone would offer nothing for 63 of 72 venues. A Medical Rep registering her own venue
 *    (4 of the 72) does have her own list, which is why self is in the union rather than replaced.
 *  - SUBTREE alone would exclude that rep's own list, because `isWithinManagerHierarchy` answers
 *    "is this person BELOW the viewer" and is deliberately false for the viewer themselves. It is
 *    shared with the security-sensitive Doctor List and Plan Verification boards and is NOT widened
 *    here — the union is composed in this module instead, where only this picker sees it.
 *
 * Measured team-scoped on 2026-09-03, how many of the 72 venues would have had a non-empty picker:
 * pharmacy lists only, 33; including the PM/AM doctor lists, 66. Both kinds are therefore offered.
 * That is not a stretch — a venue row carries a REQUIRED doctor name, and six of the nine most
 * active registering DMs have team doctor lists but no team pharmacy list whatsoever.
 *
 * ## A picker is never wider than its viewer
 *
 * The scope bounds the READ and the WRITE by the same resolution. `assertVenueContactInScope` is
 * what the create path calls, so a caller cannot POST a contact id belonging to a rep in another
 * district: doing that would put a trade badge reading "1 direct order" on a contact list belonging
 * to someone who never sold to them, which is the expensive direction of wrong. A board that hides
 * a row while its route still accepts a write for it is not scoped, it is merely tidy.
 *
 * ## Where the contacts come from
 *
 * The CONTACT MASTER's open assignments — `crm_contact_assignments` where `effective_to is null`,
 * joined to `crm_contacts` (see src/lib/crm/contact-master.ts). They state the same lists the mirror
 * states today, under contact ids that survive a list change. Until the master's migration reaches
 * an environment, the mirror answers instead: a deploy applies no migrations, and an empty picker in
 * that window would read as a broken form rather than as a pending migration. The scope is applied
 * to the assignment's own rep exactly as it was applied to the mirror row's, and is not widened.
 *
 * Phone numbers are deliberately not returned. Picking which shop a venue is does not need one, and
 * the narrower the projection the less a widened scope could ever leak.
 */

import type { DoctorListRow } from "@/lib/crm/contact-lists";
import { getManagerScope, scopeAllowsAgent, type CrmManagerScope } from "@/lib/crm/manager-scope";
import { doctorListBasisForRole } from "@/lib/crm/doctor-list-access";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { loadContactPlacements } from "@/lib/crm/reps-list";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CONTACT_ASSIGNMENTS_TABLE, CRM_CONTACT_MASTER_TABLE, CRM_CONTACTS_TABLE } from "@/lib/crm/tables";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { canManagePharmacyRegistry } from "@/lib/direct-orders/registry-access";
import { ApiError } from "@/lib/http/api-errors";

/** PostgREST caps a page at 1000. The widest team measured holds 223 pharmacies and 531 doctors. */
const PAGE_SIZE = 1000;

/** What the picker shows for one candidate. No phone — see the header. */
export type VenueContactOption = {
  /** The CRM's own contact numbering. What gets written to `direct_order_pharmacies.crm_contact_id`. */
  contactCrmId: number;
  /** Whose list this contact sits on, as a human-readable name (owner rule: never a raw id). */
  agentName: string;
  agentHrId: string | null;
  address: string | null;
  grade: string | null;
  /** `Pharmacy`, `PM` or `AM` — shown so a DM can tell a shop from a doctor at a glance. */
  listType: string;
  name: string;
  nameAr: string | null;
  region: string | null;
  speciality: string | null;
};

export type VenueContactOptions = {
  options: VenueContactOption[];
  /** How the scope was resolved, for the empty state to explain itself rather than read as broken. */
  scopeLabel: string;
  /** Set when the scope resolved to nobody. The UI shows this instead of an empty dropdown. */
  unavailableReason: string | null;
  /** True when the result was cut at `limit` — the UI says so rather than implying it is the whole set. */
  truncated: boolean;
};

/**
 * The viewer's reach, as self UNION org subtree — or company for a role that already has company
 * CRM reach.
 *
 * `basis` comes from `doctorListBasisForRole`, the same table the Doctor List board uses, so this
 * picker cannot silently be wider than the board that shows the very same contacts. A role with no
 * entry there is not refused: it falls to `team`, which for a Medical Rep resolves to their own list
 * alone. Refusing would block the one person who most obviously knows which shop she just visited.
 */
export async function resolveVenueContactScope(access: AccessContext): Promise<CrmManagerScope> {
  const viewerKey = normalizeHrIdForAccess(access.hrId);
  const basis = doctorListBasisForRole(access.role);
  if (access.scope === "system" || basis === "company") {
    return { kind: "company", label: `${access.role} · all reps` };
  }
  if (!viewerKey) {
    return {
      kind: "none",
      reason: "Your account is not linked to an employee record, so your CRM contacts cannot be resolved.",
    };
  }

  const subtree = await getManagerScope({
    basis: "team",
    label: `${access.role} · own team`,
    viewerHrId: access.hrId,
  });

  // The union. A `none` subtree is NOT an error here — a Medical Rep has no reports and must still
  // reach her own list, which is exactly the case `resolveTeamScope` returns `none` for.
  const agentHrIds = new Set<string>([access.hrId!.trim()]);
  if (subtree.kind === "agents") {
    for (const hrId of subtree.agentHrIds) agentHrIds.add(hrId);
  }
  return {
    kind: "agents",
    agentHrIds: Array.from(agentHrIds),
    label: subtree.kind === "agents" ? `${access.role} · own team` : `${access.role} · own contacts`,
  };
}

/** Case-insensitive, accent-naive contains. Arabic and English names both flow through it. */
function matchesSearch(option: VenueContactOption, needle: string): boolean {
  if (!needle) return true;
  const hay = `${option.name} ${option.nameAr ?? ""} ${option.address ?? ""} ${option.region ?? ""}`.toLowerCase();
  return hay.includes(needle);
}

/**
 * Where each option is, from Phoenix CRM first (owner, 2026-10-31: "any data anywhere depending on data
 * from ireports must shift to pulling its data from phoenix crm"): the Reps List's own placement —
 * "Brick · Area · Region" and the validated place's address — with the iReports360 contact master's
 * values kept when Phoenix has none. Display only: the write gate below never reads either field.
 * Never throws; a failed read leaves every option as it was built.
 */
async function placeOptions(options: readonly VenueContactOption[]): Promise<VenueContactOption[]> {
  const placements = await loadContactPlacements(options.map((option) => ({ contactCrmId: option.contactCrmId, region: option.region })));
  return options.map((option) => {
    const placement = placements.get(option.contactCrmId);
    return placement ? { ...option, address: placement.address ?? option.address, region: placement.label } : option;
  });
}

/** Pharmacies first for a pharmacy venue, then doctors; alphabetical inside each band. */
function compareOptions(a: VenueContactOption, b: VenueContactOption): number {
  const rank = (listType: string) => (listType === "Pharmacy" ? 0 : listType === "PM" ? 1 : 2);
  const byRank = rank(a.listType) - rank(b.listType);
  if (byRank !== 0) return byRank;
  return a.name.localeCompare(b.name);
}

function toOption(row: DoctorListRow, agentName: string): VenueContactOption {
  return {
    address: row.address,
    agentHrId: row.agentHrId,
    agentName,
    contactCrmId: row.contactCrmId,
    grade: row.grade,
    listType: row.listType,
    name: row.name,
    nameAr: row.nameAr,
    region: row.region,
    speciality: row.speciality,
  };
}

export type ContactRecord = {
  address: string | null;
  agent_crm_id: number;
  agent_hr_id: string | null;
  contact_crm_id: number;
  contact_grade: string | null;
  contact_name: string | null;
  contact_name_ar: string | null;
  crm_region_name: string | null;
  list_type: string | null;
  speciality: string | null;
};

const SELECT_COLUMNS =
  "agent_crm_id, agent_hr_id, contact_crm_id, contact_name, contact_name_ar, contact_grade, " +
  "speciality, address, crm_region_name, list_type";

/**
 * The master's projection. `!inner` because an assignment always has its contact (a foreign key),
 * and an inner embed is what lets PostgREST return the parent rows with it. No phone — same rule as
 * SELECT_COLUMNS above.
 */
const MASTER_SELECT_COLUMNS =
  "id, agent_crm_id, agent_hr_id, contact_crm_id, list_type, grade, " +
  `contact:${CRM_CONTACT_MASTER_TABLE}!inner(name, name_ar, speciality, address, crm_region_name)`;

type MasterContactEmbed = {
  address: string | null;
  crm_region_name: string | null;
  name: string | null;
  name_ar: string | null;
  speciality: string | null;
};

export type MasterAssignmentRecord = {
  agent_crm_id: number;
  agent_hr_id: string | null;
  contact: MasterContactEmbed | MasterContactEmbed[] | null;
  contact_crm_id: number;
  grade: string | null;
  list_type: string | null;
};

/** One open master assignment, as the ContactRecord every reader below already consumes. */
export function contactRecordFromMasterAssignment(row: MasterAssignmentRecord): ContactRecord {
  // A to-one embed arrives as an object. An array is tolerated too, so a client upgrade that changes
  // the embed's shape cannot blank every contact's name at once.
  const contact = Array.isArray(row.contact) ? row.contact[0] ?? null : row.contact;
  return {
    address: contact?.address ?? null,
    agent_crm_id: row.agent_crm_id,
    agent_hr_id: row.agent_hr_id,
    contact_crm_id: row.contact_crm_id,
    contact_grade: row.grade,
    contact_name: contact?.name ?? null,
    contact_name_ar: contact?.name_ar ?? null,
    crm_region_name: contact?.crm_region_name ?? null,
    list_type: row.list_type,
    speciality: contact?.speciality ?? null,
  };
}

type ContactFilter = { agentHrIds?: readonly string[]; contactCrmIds?: readonly number[] };

/**
 * One page of contact rows — from the master, or from the mirror while the master's migration has
 * not reached this environment. Every read in this module goes through here.
 *
 * Only a MISSING TABLE falls back. Any other error on the master is thrown: quietly answering from
 * the mirror would hide a broken master behind a picker that still looks right.
 *
 * The master is paged on the assignment's own id, which is total. The mirror fallback adds the rest
 * of its key behind the name, because a page boundary inside a run of equal names skips or repeats
 * a row.
 */
async function readContactRecordsPage(filter: ContactFilter, from: number): Promise<ContactRecord[]> {
  const supabase = getSupabaseAdmin();

  let master = supabase.from(CRM_CONTACT_ASSIGNMENTS_TABLE).select(MASTER_SELECT_COLUMNS).is("effective_to", null);
  if (filter.agentHrIds) master = master.in("agent_hr_id", filter.agentHrIds as string[]);
  if (filter.contactCrmIds) master = master.in("contact_crm_id", filter.contactCrmIds as number[]);
  const fromMaster = await master.order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
  if (!fromMaster.error) {
    return ((fromMaster.data ?? []) as unknown as MasterAssignmentRecord[]).map(contactRecordFromMasterAssignment);
  }
  if (!isCrmSchemaMissingError(fromMaster.error)) {
    throw new Error(`Could not read the CRM contact master: ${fromMaster.error.message}`);
  }

  let mirror = supabase.from(CRM_CONTACTS_TABLE).select(SELECT_COLUMNS);
  if (filter.agentHrIds) mirror = mirror.in("agent_hr_id", filter.agentHrIds as string[]);
  if (filter.contactCrmIds) mirror = mirror.in("contact_crm_id", filter.contactCrmIds as number[]);
  const fromMirror = await mirror
    .order("contact_name", { ascending: true })
    .order("agent_crm_id", { ascending: true })
    .order("contact_crm_id", { ascending: true })
    .order("list_type", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (fromMirror.error) {
    // Before the CRM migrations reach an environment the table is absent. An empty picker is
    // correct there; a 500 on the whole venue form is not.
    if (isCrmSchemaMissingError(fromMirror.error)) return [];
    throw new Error(`Could not read CRM contacts: ${fromMirror.error.message}`);
  }
  return (fromMirror.data ?? []) as unknown as ContactRecord[];
}

/**
 * Read every contact inside the scope.
 *
 * HR ids are MIXED CASE in this database, so both sides of the comparison are lowered — a plain
 * `.eq` on an hr id has silently under-returned by 28% elsewhere in this codebase, and here that
 * would look like "this rep has no contacts" rather than like a bug.
 *
 * A company-scoped viewer reads the whole table; a scoped one reads only their own allow-list. The
 * `.in()` is chunked at 50 because a PostgREST `.in()` carrying several hundred ids returns ZERO
 * rows with NO error — the widest team here is nowhere near that, but the chunking is what stops a
 * future company with larger districts from getting a silent empty picker.
 */
async function readScopedContacts(scope: CrmManagerScope): Promise<ContactRecord[]> {
  const rows: ContactRecord[] = [];

  const runs: Array<readonly string[] | null> = [];
  if (scope.kind === "company") {
    runs.push(null);
  } else if (scope.kind === "agents") {
    // Both spellings of every hr id, because the mirror stores whatever the CRM sent and the
    // directory stores the canonical form. `.in()` is an exact match; it does not lower for us.
    const spellings = new Set<string>();
    for (const hrId of scope.agentHrIds) {
      const trimmed = hrId.trim();
      if (!trimmed) continue;
      spellings.add(trimmed);
      spellings.add(trimmed.toLowerCase());
      spellings.add(trimmed.toUpperCase());
    }
    const all = Array.from(spellings);
    for (let index = 0; index < all.length; index += 50) runs.push(all.slice(index, index + 50));
  } else {
    return [];
  }

  for (const agentHrIds of runs) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const page = await readContactRecordsPage(agentHrIds ? { agentHrIds } : {}, from);
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }
  return rows;
}

/**
 * Every row carrying one contact id, regardless of whose list it sits on.
 *
 * The caller decides whether the viewer may see it — this only answers "who lists this contact".
 * The table is keyed `(agent_crm_id, contact_crm_id, list_type)`, so one contact CAN legitimately
 * appear on several reps' lists; all of them are returned and the caller needs only one to pass.
 *
 * Same missing-table tolerance as the scoped read: before the CRM migrations reach an environment
 * the table is absent, and refusing every link there would be wrong in the expensive direction.
 * An absent table means nothing can be validated, so nothing is accepted — the caller turns an
 * empty result into a refusal, which is the safe way round.
 */
async function readContactsById(contactCrmId: number): Promise<ContactRecord[]> {
  return readContactRecordsPage({ contactCrmIds: [contactCrmId] }, 0);
}

/** Every rep's display name by canonical hr id — human-readable names, never raw ids (owner rule). */
async function agentNameLookup(): Promise<(hrId: string | null) => string | null> {
  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const nameByHrId = new Map<string, string>();
  for (const employee of employees) {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) nameByHrId.set(key, employee.displayName || employee.fullName);
  }
  return (hrId: string | null) => {
    const key = normalizeHrIdForAccess(hrId);
    return key ? nameByHrId.get(key) ?? null : null;
  };
}

/**
 * One CRM row as the picker shows it.
 *
 * Shared by the picker and by the registry's label resolver ON PURPOSE. Two copies of this mapping
 * would drift on the first field either side adds, and the drift would show as the SAME contact
 * described two different ways on two screens — which reads as two different shops.
 *
 * A contact whose agent is not on the roster still resolves, naming the CRM account instead of
 * being dropped: a venue linked to a leaver's list must not silently lose its label.
 */
function buildOption(record: ContactRecord, resolveAgentName: (hrId: string | null) => string | null): VenueContactOption {
  const agentName = resolveAgentName(record.agent_hr_id) ?? `CRM account ${record.agent_crm_id} — not on the roster`;
  return toOption(
    {
      address: record.address,
      agentCrmId: record.agent_crm_id,
      agentHrId: record.agent_hr_id,
      contactCrmId: record.contact_crm_id,
      firstSeenAt: null,
      grade: record.contact_grade,
      listType: (record.list_type === "Pharmacy" || record.list_type === "AM" ? record.list_type : "PM") as
        DoctorListRow["listType"],
      name: record.contact_name?.trim() || `Contact ${record.contact_crm_id}`,
      nameAr: record.contact_name_ar,
      phone: null,
      region: record.crm_region_name,
      speciality: record.speciality,
      syncedAt: null,
    },
    agentName,
  );
}

/**
 * Name the contacts a set of venues are ALREADY declared to be.
 *
 * The registry stores a bare `crm_contact_id`, and the owner's rule is that a screen shows
 * human-readable names and never a raw id. So the board resolves its declared links through here
 * before rendering them, rather than printing the number the column holds.
 *
 * SCOPED, exactly like the picker. Both registry roles resolve to `company` today, so in practice
 * every label resolves — but the scope is applied rather than assumed, so that widening who may
 * manage the registry can never turn this into a way to read a contact the viewer may not see. A
 * link outside the viewer's reach simply has no entry in the map, and the board says the link
 * exists without naming it.
 *
 * The `.in()` is chunked at 50: several hundred ids in one PostgREST `.in()` returns ZERO rows with
 * no error, and here that would silently unname every link at once.
 */
export async function describeVenueContacts(
  access: AccessContext,
  contactCrmIds: readonly number[],
): Promise<Map<number, VenueContactOption>> {
  const wanted = Array.from(new Set(contactCrmIds.filter((id) => Number.isFinite(id) && id > 0)));
  const described = new Map<number, VenueContactOption>();
  if (wanted.length === 0) return described;

  const scope = await resolveVenueContactScope(access);
  if (scope.kind === "none") return described;

  const records: ContactRecord[] = [];
  for (let index = 0; index < wanted.length; index += 50) {
    // Same tolerance as every other read here: an absent table reads as no rows, because 500ing the
    // whole registry over a display label would be wrong.
    records.push(...(await readContactRecordsPage({ contactCrmIds: wanted.slice(index, index + 50) }, 0)));
  }

  const resolveAgentName = await agentNameLookup();
  for (const record of records) {
    if (!scopeAllowsAgent(scope, record.agent_hr_id)) continue;
    const option = buildOption(record, resolveAgentName);
    const existing = described.get(option.contactCrmId);
    // One contact can sit on several reps' lists. Rank deterministically rather than taking
    // whichever row the database returned first, so a label does not change between two loads.
    if (!existing || compareOptions(option, existing) < 0) described.set(option.contactCrmId, option);
  }
  for (const option of await placeOptions([...described.values()])) described.set(option.contactCrmId, option);
  return described;
}

/**
 * Who may enumerate CRM contacts in order to declare one against a venue.
 *
 * TWO doors reach this picker and they do NOT share a permission, which is why this is a helper
 * rather than a bare assertPermission:
 *
 *  - the SUBMIT FORM, where the authority is `direct_orders:create` — enumerating contacts in
 *    order to declare one is only useful to someone who may raise the order that creates the
 *    venue; and
 *  - the ADMIN REGISTRY, where the authority is `canManagePharmacyRegistry` (Super Admin or SFE
 *    Manager). This is the RETROACTIVE door: the venues that already exist were registered before
 *    the column did, so linking one is an EDIT by an admin, never a submission.
 *
 * The SFE Manager is exactly why this cannot stay a single assert. Their `direct_orders` grants are
 * `read, export, approve` — there is no `create` — yet they are one of only two roles the owner
 * allowed to manage the registry (2026-08-04). Gating this on `create` alone would have 403'd the
 * picker for the very person the registry exists for, and it would have read as a broken page
 * rather than as a permission decision.
 *
 * Neither door widens the SCOPE. Both still go through `resolveVenueContactScope`, and for both
 * registry roles that resolves to `company` on their own merits — both sit in the doctor list's
 * COMPANY_ROLES — so an admin sees every rep's contacts because an admin already may, not because
 * this gate let them in.
 */
async function assertMayDeclareVenueContact(access: AccessContext): Promise<void> {
  if (canManagePharmacyRegistry(access)) return;
  await assertPermission(access, "direct_orders", "create");
}

/**
 * The picker's contents for one viewer.
 *
 * `limit` caps what crosses the wire; `truncated` says whether it bit, so the UI can tell the
 * submitter to narrow the search instead of letting them believe they have seen everything.
 */
export async function listVenueContactOptions(
  access: AccessContext,
  input?: { search?: string | null; limit?: number | null },
): Promise<VenueContactOptions> {
  await assertMayDeclareVenueContact(access);
  const scope = await resolveVenueContactScope(access);
  if (scope.kind === "none") {
    return { options: [], scopeLabel: "", truncated: false, unavailableReason: scope.reason };
  }
  const scopeLabel = scope.label;

  const [records, resolveAgentName] = await Promise.all([readScopedContacts(scope), agentNameLookup()]);

  const needle = (input?.search ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(input?.limit ?? 50, 200));

  const seen = new Set<string>();
  const matched: VenueContactOption[] = [];
  for (const record of records) {
    // `scopeAllowsAgent` is re-applied to every row rather than trusted from the query. The query
    // filter and the membership test are the same answer computed twice, on purpose: a company
    // read has no filter at all, and this is what keeps the two from drifting apart.
    if (!scopeAllowsAgent(scope, record.agent_hr_id)) continue;
    if (!Number.isFinite(record.contact_crm_id) || record.contact_crm_id <= 0) continue;
    // One contact can sit on several reps' lists. Deduplicate on (contact, list kind) so the
    // picker offers each shop once — whichever rep's row was read first names it.
    const key = `${record.contact_crm_id}::${record.list_type ?? ""}`;
    if (seen.has(key)) continue;
    const option = buildOption(record, resolveAgentName);
    if (!matchesSearch(option, needle)) continue;
    seen.add(key);
    matched.push(option);
  }

  matched.sort(compareOptions);
  return {
    options: await placeOptions(matched.slice(0, limit)),
    scopeLabel,
    truncated: matched.length > limit,
    unavailableReason: null,
  };
}

/**
 * The WRITE gate. Called by the create path before a declared contact id is stored.
 *
 * Refuses anything outside the caller's own reach. Without it the read scope would be decoration:
 * the form would offer one district's contacts while the route accepted any id in the CRM, and a
 * mistyped or forged id would put a "1 direct order" badge on a contact list belonging to a rep who
 * never sold to them. Under-reporting is recoverable; a false trade record is not.
 */
export async function assertVenueContactInScope(
  access: AccessContext,
  contactCrmId: number | null,
): Promise<void> {
  if (contactCrmId === null) return;
  const scope = await resolveVenueContactScope(access);
  if (scope.kind === "none") {
    throw new ApiError(403, "forbidden", scope.reason);
  }
  // Ask about the ONE id, rather than reading the scope and searching it.
  //
  // The behaviour is identical; the cost is not. A company-scoped viewer's scope is the whole
  // table — 9,698 rows on production as of 2026-09-03 — so the read-then-search form paged through
  // all of it to answer a yes/no about a single contact, on every save. That was invisible while
  // only District Managers reached this (a team is a few hundred rows), and the admin registry
  // added on 2026-09-03 is exactly the door where the scope IS company-wide.
  const records = await readContactsById(contactCrmId);
  const found = records.some((record) => scopeAllowsAgent(scope, record.agent_hr_id));
  if (!found) {
    throw new ApiError(
      400,
      "bad_request",
      "That CRM contact is not on your own list or your team's, so it cannot be linked to this venue. " +
        "Pick one from the list, or leave the link empty.",
    );
  }
}

/**
 * Parse whatever a client sent into a contact id or nothing.
 *
 * Blank, absent, zero, negative and non-numeric all mean "not declared" — never an error. The
 * picker is optional (see the migration header: the 2026-08-04 rule that refusing a field with
 * nothing valid to put in it produces an invented value, not a correct one), so a malformed value
 * must degrade to no link rather than fail the whole registration.
 */
export function parseVenueContactId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
