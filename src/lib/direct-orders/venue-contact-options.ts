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
 * Phone numbers are deliberately not returned. Picking which shop a venue is does not need one, and
 * the narrower the projection the less a widened scope could ever leak.
 */

import type { DoctorListRow } from "@/lib/crm/contact-lists";
import { getManagerScope, scopeAllowsAgent, type CrmManagerScope } from "@/lib/crm/manager-scope";
import { doctorListBasisForRole } from "@/lib/crm/doctor-list-access";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CONTACTS_TABLE } from "@/lib/crm/tables";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
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

type ContactRecord = {
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
  const supabase = getSupabaseAdmin();
  const rows: ContactRecord[] = [];

  const readPage = async (from: number, agentHrIds: readonly string[] | null) => {
    let query = supabase.from(CRM_CONTACTS_TABLE).select(SELECT_COLUMNS);
    if (agentHrIds) query = query.in("agent_hr_id", agentHrIds as string[]);
    return query.order("contact_name", { ascending: true }).range(from, from + PAGE_SIZE - 1);
  };

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
      const { data, error } = await readPage(from, agentHrIds);
      if (error) {
        // Before the CRM migrations reach an environment the table is absent. An empty picker is
        // correct there; a 500 on the whole venue form is not.
        if (isCrmSchemaMissingError(error)) return [];
        throw new Error(`Could not read CRM contacts: ${error.message}`);
      }
      const page = (data ?? []) as unknown as ContactRecord[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }
  return rows;
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
  // Same authority as registering the venue this picker feeds. The service is the boundary, so a
  // caller reaching the route directly gets the same answer the form would have got.
  await assertPermission(access, "direct_orders", "create");
  const scope = await resolveVenueContactScope(access);
  if (scope.kind === "none") {
    return { options: [], scopeLabel: "", truncated: false, unavailableReason: scope.reason };
  }
  const scopeLabel = scope.label;

  const [records, employees] = await Promise.all([
    readScopedContacts(scope),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);

  // Human-readable names, never raw ids (owner rule). A contact whose agent is not on the roster
  // still shows — with the CRM account named — rather than being dropped from the picker.
  const nameByHrId = new Map<string, string>();
  for (const employee of employees) {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) nameByHrId.set(key, employee.displayName || employee.fullName);
  }

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
    const agentKey = normalizeHrIdForAccess(record.agent_hr_id);
    const agentName =
      (agentKey ? nameByHrId.get(agentKey) : null) ?? `CRM account ${record.agent_crm_id} — not on the roster`;
    const option = toOption(
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
    if (!matchesSearch(option, needle)) continue;
    seen.add(key);
    matched.push(option);
  }

  matched.sort(compareOptions);
  return {
    options: matched.slice(0, limit),
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
  const records = await readScopedContacts(scope);
  const found = records.some(
    (record) => record.contact_crm_id === contactCrmId && scopeAllowsAgent(scope, record.agent_hr_id),
  );
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
