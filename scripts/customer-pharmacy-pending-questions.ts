/**
 * The pending customer-pharmacy pairings, as the owner's ruling sheet.
 *
 * WHY THIS EXISTS. `/admin/customer-pharmacy-mapping` lists every customer and the pharmacies it is
 * linked to, and lets a Super Admin approve or reject one link at a time. A link's
 * `validation_status` is not cosmetic: `assertMarketingCustomerHasValidatedVenue` accepts a customer
 * only while one of its active links is `system_validated` or `sfe_validated`, and a request can
 * target only a validated link's pharmacy. A PENDING link therefore works like a rejected one — the
 * pharmacy cannot be targeted for that customer, and a customer with nothing validated cannot be used
 * on a marketing request at all.
 *
 * WHAT THE QUEUE HELD, measured on production 2026-09-17: 163 pending links across 71 customers. The
 * 118 this sheet carries had not changed since 2026-09-08 19:19 Cairo; the only later edits are the
 * six hold notes described below, written 2026-09-17 18:11 Cairo.
 *   - 131 were written by the 2026-07-02 backfill. The 92 not on hold carry "Inferred from
 *     pending/rejected historical marketing requests": ROI-sheet requests that were never approved,
 *     which Phoenix itself never held.
 *   - 24 are second distributor codes, backfilled by hand 2026-09-08 onto pairings those links
 *     already named, inheriting their status. Their note starts `SECOND_CODE_BACKFILL_PREFIX` and
 *     carries neither backfill marker, so without that check they read as field captures.
 *   - 8 were captured by reps in the app (2026-08-25 to 09-07) and wait for proof on both sides.
 * 45 carry the owner's hold (`MARKETING_MANUAL_HOLD_MARKER`): the 39 held 2026-08-21, and the 6
 * second codes of those same pairings, held 2026-09-17 on his instruction. THIS SHEET LEAVES THEM
 * OUT — they wait for his release, not for a ruling. The other 118 links make 99 pairings.
 *
 * WHY NOTHING MOVED. No note carries an "Approved" stamp, so no approval has ever been recorded; the
 * only decisions on record are two rejections, 2026-09-03 07:19 Cairo, for distributor codes
 * registered to shops in other governorates. The page's own loader was failing for every caller
 * until PR #3627 (merged 2026-09-10 00:40 Cairo). The other exit is field capture — the completion
 * sweeps promote a pending link once BOTH the customer and the pharmacy are captured — and no capture
 * has ever been attempted for a backfilled customer, so neither sweep has released a single link.
 *
 * WHY A WORKBOOK. Owner rule (AGENTS.md §4): business questions are asked IN CHAT as multiple choice,
 * and an XLSX with dropdowns is only for a long per-item list — which 99 pairings are. He chose this
 * route in chat on 2026-09-17, with the context he was promised on each row: CRM visits, whether the
 * owning rep still works here, and whether the pharmacy sits in the customer's area.
 *
 * THE ROW ASKS FOR AREAS, NOT A DECISION. The first build carried an Approve / Reject / Leave pending
 * list; the same evening he asked to pick the AREA from a list instead, and chose, in chat, two lists
 * side by side with their records: the customer's area and the pharmacy's area. There is no decision
 * column. Each list is pre-filled with the area on file — a fact, not a proposal — so an untouched row
 * means "keep it", and the hidden on-file columns let a read-back tell a change from a keep. The list
 * is every active area that is not a line's own (those hold no pending record); an area on file that
 * is missing from it is added, so no pre-filled value is ever outside its own list. A customer and a
 * pharmacy filed in different areas turn their two area cells red, live, as he edits. The filter
 * range runs through the hidden columns, so a sort carries them with their row; a read-back still
 * matches each returned row to the sent file by its visible cells, because a pasted or re-typed
 * sheet can move a row by other means.
 *
 * AN ADDRESS BESIDE EACH AREA, at his next request, so the area can be judged from where the record
 * is. A pharmacy shows the address each distributor registered for its code, read from the LIVE
 * `source_of_sales_customer_map` (the registered code outranks GPS, §4.1) by the distributor's map
 * codes and the pharmacy code itself — never the cached mapped_* pair, which stays empty for a code
 * the resolver called unresolved before the map gained it; a customer shows its CRM
 * contact's address, which is usually a town or district. Either adds the address captured in the
 * app when a rep captured one. Every line is led by its source, and nothing is geocoded or guessed.
 *
 * ONE ROW PER PAIRING, NOT PER LINK. A link is customer + distributor code, so one pharmacy reached
 * through two distributors is two links — but "does this pharmacy serve this customer" is one
 * question. The hidden Reference column carries every link id a row covers.
 *
 * NO RECOMMENDATION, deliberately. Where a record belongs is the owner's call; the context columns
 * inform it and stop there.
 *
 * SAME-NAME RECORDS ARE SHOWN, NEVER RESOLVED. Reps re-capture venues the backfill already wrote, so
 * a pending pharmacy often has a same-name twin in its area — sometimes one already approved for
 * this very customer, which is what makes the pending row a likely duplicate. "Check first" states
 * the twin and where it stands for the customer; it never merges or rules (AGENTS.md §2.3).
 *
 * NO DISTRIBUTOR-CODE VERDICT. `marketing_pharmacy_distributor_codes.reference_status` is a cache,
 * and a `not_found` there is routinely stale (AGENTS.md §2.3), so the sheet names the distributor
 * and says nothing about whether its code resolves.
 *
 * READ-ONLY. One read-only transaction and a file. Nothing reads the sheet back into the database:
 * the areas he changes are read back to him in chat before anything is touched, and a link's approve
 * or reject stays his own click on the mapping page — never a script or a session, and never a status
 * written in SQL.
 *
 * Run from a worktree with node directly (never pnpm there):
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/customer-pharmacy-pending-questions.ts [output.xlsx]
 *
 * Reads PRODUCTION through `SUPABASE_DB_URL` in `.env.local`.
 *
 * HOUSE IDENTITY (SATO-DIS-2026-01 v1.0) through the shared `house-xlsx-identity` helpers, and the
 * ExcelJS repair traps (docs/agents-session-traps.md) handled rather than hoped away:
 *   - no outline group, so `<outlinePr/>` and `<pageSetUpPr/>` can never be written out of order;
 *   - ONE validation rule over each whole area column — per-cell rules coalesce into overlapping
 *     `sqref` ranges — reading a list on a very hidden sheet, since the area names overflow the
 *     255 characters an inline list may hold;
 *   - every conditional-format rule has its own priority (a duplicate one is a repair);
 *   - the masthead's mark is anchored by ExcelJS with `editAs` on `<xdr:oneCellAnchor>`, an attribute
 *     that element does not declare, so `stripOneCellAnchorEditAs` removes it from the written zip.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import postgres from "postgres";

import { systemDocuments } from "@/config/system-settings";
import { DESK_VALIDATION_MARKER, INFERRED_HISTORY_MARKER } from "@/lib/customer-pharmacy-mapping/readiness";
import {
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseCalloutStyle,
  houseGeneratedAt,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";
import { MARKETING_MANUAL_HOLD_MARKER } from "@/lib/marketing-requests/types";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "customer-pharmacy-pending-questions",
  entry: import.meta.url,
  known: [],
});

/** The hand-run 2026-09-08 backfill opened every note with this; no code path writes it. */
const SECOND_CODE_BACKFILL_PREFIX = "Backfilled 2026-09-08";

/** CRM's catch-all contact. It is not a doctor, and a name match against it proves nothing. */
const CRM_CATCH_ALL_CONTACT_ID = 100000;

/**
 * The same name, spelled the way CRM and the ROI sheet each spell it. Alef forms, ta marbuta,
 * alef maksura, tatweel and harakat are folded, then a leading doctor's title is dropped. Every
 * title alternative needs a dot, a slash or a space after it, so a name that merely STARTS with
 * those letters (ادهم, دعاء) is left whole.
 */
function foldSql(expression: string): string {
  const from = "أإآٱةىـًٌٍَُِّْ";
  const to = "ااااهي";
  const title = "^\\s*(ا\\s*\\.\\s*د\\s*[./]?\\s*|د\\s*[./]\\s*|دكتوره?\\s+|د\\s+)";
  return (
    `trim(regexp_replace(regexp_replace(translate(coalesce(${expression}, ''), '${from}', '${to}'), ` +
    `'${title}', ''), '\\s+', ' ', 'g'))`
  );
}

const LINKS_SQL = `
select
  l.id::text                                    as link_id,
  l.customer_id::text                           as customer_id,
  l.pharmacy_id::text                           as pharmacy_id,
  l.created_at,
  l.validation_notes,
  c.display_name                                as customer_name,
  c.area_id::text                               as customer_area_id,
  coalesce(ca.name, c.extracted_area_name)      as customer_area,
  (c.area_id is not null)                       as customer_has_area,
  c.evidence_status                             as customer_evidence,
  nullif(trim(c.captured_address), '')          as customer_captured_address,
  o.full_name                                   as owner_name,
  o.employment_status                           as owner_status,
  to_char(o.last_working_date, 'YYYY-MM-DD')    as owner_last_day,
  p.display_name                                as pharmacy_name,
  (p.active and p.merged_into_pharmacy_id is null) as pharmacy_live,
  p.area_id::text                               as pharmacy_area_id,
  coalesce(pa.name, p.extracted_area_name)      as pharmacy_area,
  (p.area_id is not null)                       as pharmacy_has_area,
  coalesce(p.area_id = c.area_id, false)        as same_area,
  p.evidence_status                             as pharmacy_evidence,
  nullif(trim(p.captured_address), '')          as pharmacy_captured_address,
  (p.captured_latitude is not null)             as pharmacy_gps,
  (p.evidence_photo_name is not null)           as pharmacy_photo,
  exists (
    select 1 from public.marketing_evidence_files f
    where f.entity_type = 'pharmacy' and f.entity_id = p.id and f.evidence_type = 'pharmacy_license'
  )                                             as pharmacy_licence,
  d.display_name                                as distributor_name,
  (l.distributor_code_id is not null)           as has_code,
  -- The address the distributor registered for this code, from the LIVE customer map, matched the
  -- way the resolver matches (the distributor's family of map codes, then the code exactly or with
  -- its leading zeros dropped). Never through the cache's mapped_* pair: a code the resolver once
  -- called unresolved keeps null there after the map gains it (AGENTS.md §2.3), and the sheet then
  -- said "No address on file" for a pharmacy the distributor had registered.
  (select nullif(trim(m.address), '') from public.source_of_sales_customer_map m
     where m.distributor_code in (
             select ru.sos_distributor_code from public.marketing_roi_distributor_rollup ru
             where ru.marketing_normalized_name = d.normalized_name)
       and (lower(btrim(m.customer_code)) = dc.normalized_pharmacy_code
            or (dc.normalized_pharmacy_code ~ '^[0-9]+$' and btrim(m.customer_code) ~ '^[0-9]+$'
                and ltrim(btrim(m.customer_code), '0') = ltrim(dc.normalized_pharmacy_code, '0')))
       and m.active and nullif(trim(m.address), '') is not null
     order by (lower(btrim(m.customer_code)) = dc.normalized_pharmacy_code) desc,
              m.confidence desc nulls last, m.updated_at desc
     limit 1)                                   as registered_address
from public.marketing_customer_pharmacies l
join public.marketing_customers c on c.id = l.customer_id and c.active
join public.marketing_pharmacies p on p.id = l.pharmacy_id
left join public.areas ca on ca.id = c.area_id
left join public.areas pa on pa.id = p.area_id
left join public.employees o on o.hr_id = c.owner_hr_id
left join public.marketing_pharmacy_distributor_codes dc on dc.id = l.distributor_code_id
left join public.marketing_distributors d on d.id = dc.distributor_id
where l.active
  and l.validation_status = 'pending'
  and position($1 in coalesce(l.validation_notes, '')) = 0
`;

/**
 * Per customer: what is already approved, and the CRM calls logged on it.
 *
 * Calls are counted two ways and the sheet says which it used. The exact way follows the CRM contact
 * id on the customer's contact rows. The fallback — for a customer with no contact id, or whose
 * contact has no calls — joins the folded name, which is worthless alone for a common name. "By this
 * area's reps" means the calling rep's own area is the customer's; that test is what separates a
 * real doctor from a namesake.
 */
const CUSTOMERS_SQL = `
with open_customers as (
  select distinct c.id, c.area_id, c.display_name
  from public.marketing_customer_pharmacies l
  join public.marketing_customers c on c.id = l.customer_id and c.active
  where l.active
    and l.validation_status = 'pending'
    and position($1 in coalesce(l.validation_notes, '')) = 0
),
crm_contacts as (
  select distinct mc.customer_id, trim(mc.crm_code)::bigint as crm_contact_id
  from public.marketing_customer_contacts mc
  join open_customers oc on oc.id = mc.customer_id
  where mc.active and trim(coalesce(mc.crm_code, '')) ~ '^[0-9]{1,15}$'
),
contact_visits as (
  select k.customer_id, v.visit_date, coalesce(e.area_id = oc.area_id, false) as in_area
  from crm_contacts k
  join open_customers oc on oc.id = k.customer_id
  join public.ireports360_visits v on v.contact_crm_id = k.crm_contact_id
  left join public.employees e on upper(e.hr_id) = upper(v.agent_hr_id)
  where k.crm_contact_id <> ${CRM_CATCH_ALL_CONTACT_ID}
),
name_visits as (
  select fc.id as customer_id, fv.visit_date, coalesce(fv.agent_area_id = fc.area_id, false) as in_area
  from (select oc.id, oc.area_id, ${foldSql("oc.display_name")} as folded from open_customers oc) fc
  join (
    select v.visit_date, e.area_id as agent_area_id, ${foldSql("v.contact_name")} as folded
    from public.ireports360_visits v
    left join public.employees e on upper(e.hr_id) = upper(v.agent_hr_id)
    where v.contact_name is not null and coalesce(v.contact_crm_id, 0) <> ${CRM_CATCH_ALL_CONTACT_ID}
  ) fv on fv.folded = fc.folded
  where fc.folded <> ''
)
select
  oc.id::text as customer_id,
  (select count(distinct s.pharmacy_id) from public.marketing_customer_pharmacies s
     where s.customer_id = oc.id and s.active
       and s.validation_status in ('system_validated', 'sfe_validated'))::int       as approved_pharmacies,
  exists (select 1 from crm_contacts k where k.customer_id = oc.id)                 as has_crm_contact,
  (select string_agg(distinct trim(cc.address), chr(10)) from crm_contacts k
     join public.crm_contacts cc on cc.contact_crm_id = k.crm_contact_id
     where k.customer_id = oc.id and k.crm_contact_id <> ${CRM_CATCH_ALL_CONTACT_ID}
       and nullif(trim(cc.address), '') is not null)                                  as crm_address,
  (select count(*) from contact_visits x where x.customer_id = oc.id)::int           as contact_visits,
  (select count(*) from contact_visits x where x.customer_id = oc.id and x.in_area)::int as contact_in_area,
  (select to_char(max(x.visit_date), 'YYYY-MM-DD') from contact_visits x
     where x.customer_id = oc.id and x.in_area)                                      as contact_last_in_area,
  (select to_char(max(x.visit_date), 'YYYY-MM-DD') from contact_visits x
     where x.customer_id = oc.id)                                                    as contact_last_any,
  (select count(*) from name_visits x where x.customer_id = oc.id)::int              as name_visits,
  (select count(*) from name_visits x where x.customer_id = oc.id and x.in_area)::int as name_in_area,
  (select to_char(max(x.visit_date), 'YYYY-MM-DD') from name_visits x
     where x.customer_id = oc.id and x.in_area)                                      as name_last_in_area,
  (select to_char(max(x.visit_date), 'YYYY-MM-DD') from name_visits x
     where x.customer_id = oc.id)                                                    as name_last_any
from open_customers oc
`;

/** Every live pharmacy, for the same-name check. Merged rows are gone and are not candidates. */
const PHARMACIES_SQL = `
select id::text as id, display_name, area_id::text as area_id
from public.marketing_pharmacies
where active and merged_into_pharmacy_id is null
`;

/** Every live customer, for the same-name check. */
const CUSTOMER_NAMES_SQL = `
select id::text as id, display_name, area_id::text as area_id
from public.marketing_customers
where active and merged_into_customer_id is null
`;

/** Every active link of a customer on the sheet, whatever its status — where a twin already stands. */
const CUSTOMER_LINKS_SQL = `
select
  l.customer_id::text as customer_id,
  l.pharmacy_id::text as pharmacy_id,
  l.validation_status,
  position($1 in coalesce(l.validation_notes, '')) > 0 as held
from public.marketing_customer_pharmacies l
where l.active
  and l.customer_id in (
    select s.customer_id from public.marketing_customer_pharmacies s
    where s.active and s.validation_status = 'pending'
      and position($1 in coalesce(s.validation_notes, '')) = 0
  )
`;

/**
 * The areas a customer or pharmacy can be filed in: every active area that is not a line's own.
 * Line areas (Delta (1), Giza, Head office …) are a sales line's regions, and no pending record sits
 * in one.
 */
const AREAS_SQL = `
select name from public.areas where is_active and line_id is null order by name
`;

const QUEUE_SQL = `
select
  count(*)::int                                                                  as pending_links,
  count(distinct l.customer_id)::int                                             as pending_customers,
  (count(*) filter (where position($1 in coalesce(l.validation_notes, '')) > 0))::int as held_links,
  (count(distinct l.customer_id) filter (
     where position($1 in coalesce(l.validation_notes, '')) > 0))::int           as held_customers
from public.marketing_customer_pharmacies l
join public.marketing_customers c on c.id = l.customer_id and c.active
where l.active and l.validation_status = 'pending'
`;

type LinkRow = {
  link_id: string;
  customer_id: string;
  pharmacy_id: string;
  created_at: Date;
  validation_notes: string | null;
  customer_name: string | null;
  customer_area_id: string | null;
  customer_area: string | null;
  customer_has_area: boolean;
  customer_evidence: string | null;
  customer_captured_address: string | null;
  owner_name: string | null;
  owner_status: string | null;
  owner_last_day: string | null;
  pharmacy_name: string | null;
  pharmacy_live: boolean;
  pharmacy_area_id: string | null;
  pharmacy_area: string | null;
  pharmacy_has_area: boolean;
  same_area: boolean;
  pharmacy_evidence: string | null;
  pharmacy_captured_address: string | null;
  pharmacy_gps: boolean;
  pharmacy_photo: boolean;
  pharmacy_licence: boolean;
  distributor_name: string | null;
  has_code: boolean;
  registered_address: string | null;
};

type CustomerRow = {
  customer_id: string;
  approved_pharmacies: number;
  has_crm_contact: boolean;
  crm_address: string | null;
  contact_visits: number;
  contact_in_area: number;
  contact_last_in_area: string | null;
  contact_last_any: string | null;
  name_visits: number;
  name_in_area: number;
  name_last_in_area: string | null;
  name_last_any: string | null;
};

type NamedRow = { id: string; display_name: string | null; area_id: string | null };

type IndexedRow = NamedRow & { folded: string };

type CustomerLinkRow = { customer_id: string; pharmacy_id: string; validation_status: string; held: boolean };

type QueueRow = { pending_links: number; pending_customers: number; held_links: number; held_customers: number };

type Origin = "backfill-2026-07-02" | "second-code-2026-09-08" | "desk" | "field";

type Standing = "approved" | "held" | "pending" | "rejected";

type Registry = {
  customersByArea: Map<string, IndexedRow[]>;
  linksByCustomer: Map<string, Map<string, CustomerLinkRow[]>>;
  pharmaciesByArea: Map<string, IndexedRow[]>;
};

type Pairing = {
  links: LinkRow[];
  customer: CustomerRow | undefined;
  checks: string[];
};

/** Read from the note, because there is no source column. The 8 Sept prefix is checked first: it
 *  carries neither backfill marker, and without this check it read as a rep's field capture. */
function classifyOrigin(notes: string | null): Origin {
  const text = notes ?? "";
  if (text.startsWith(SECOND_CODE_BACKFILL_PREFIX)) return "second-code-2026-09-08";
  if (text.includes(INFERRED_HISTORY_MARKER)) return "backfill-2026-07-02";
  if (text.includes(DESK_VALIDATION_MARKER)) return "desk";
  return "field";
}

const CAIRO_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

/** A date-only value (`YYYY-MM-DD`) is a calendar day, so it is rendered in UTC — never shifted. */
function calendarDay(value: string | null): string {
  if (!value) return "";
  const at = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" });
}

function cairoTodayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" })
    .format(new Date());
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The letter forms `foldSql` folds, so one name spelled two ways compares equal. */
function foldLetters(value: string | null): string {
  return (value ?? "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ـً-ْ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A person's name without a leading doctor's title — `د.سيد` and `سيد` are one name. */
function foldPersonName(value: string | null): string {
  return foldLetters(value).replace(/^(ا\s*\.\s*د\s*[./]?\s*|د\s*[./]\s*|دكتوره?\s+|د\s+)/, "").trim();
}

/** A pharmacy's name without the word "pharmacy" in front of it. */
function foldPharmacyName(value: string | null): string {
  return foldLetters(value).replace(/^صيدليه\s+/, "").trim();
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

function indexByArea(rows: NamedRow[], fold: (value: string | null) => string): Map<string, IndexedRow[]> {
  const byArea = new Map<string, IndexedRow[]>();
  for (const row of rows) {
    if (!row.area_id) continue;
    const list = byArea.get(row.area_id) ?? [];
    list.push({ ...row, folded: fold(row.display_name) });
    byArea.set(row.area_id, list);
  }
  return byArea;
}

function indexLinks(rows: CustomerLinkRow[]): Map<string, Map<string, CustomerLinkRow[]>> {
  const byCustomer = new Map<string, Map<string, CustomerLinkRow[]>>();
  for (const row of rows) {
    const byPharmacy = byCustomer.get(row.customer_id) ?? new Map<string, CustomerLinkRow[]>();
    const list = byPharmacy.get(row.pharmacy_id) ?? [];
    list.push(row);
    byPharmacy.set(row.pharmacy_id, list);
    byCustomer.set(row.customer_id, byPharmacy);
  }
  return byCustomer;
}

/** Where a pharmacy stands for one customer. Approved outranks a hold, which outranks pending. */
function standingFor(links: CustomerLinkRow[] | undefined): Standing | null {
  const rows = links ?? [];
  if (rows.some((row) => row.validation_status === "system_validated" || row.validation_status === "sfe_validated")) {
    return "approved";
  }
  if (rows.some((row) => row.validation_status === "pending" && row.held)) return "held";
  if (rows.some((row) => row.validation_status === "pending")) return "pending";
  if (rows.some((row) => row.validation_status === "rejected")) return "rejected";
  return null;
}

const STANDING_ORDER: Standing[] = ["approved", "held", "pending", "rejected"];

const STANDING_WORDS: Record<Standing, string> = {
  approved: "already approved for this customer",
  held: "on hold for this customer",
  pending: "also pending for this customer",
  rejected: "already rejected for this customer",
};

/**
 * Facts that could make a pairing wrong — never a verdict. A same-name record in the area is a
 * pharmacy whose name is the same once spelling is folded, or one letter away; a customer must match
 * exactly. Flagged, never merged: a name is not proof two records are one (AGENTS.md §2.3).
 *
 * A venue filed as `nursery` is NOT flagged. That type is the owner's own filing for any venue no
 * distributor vouches for, and his rule is that it is never flagged in a sweep (AGENTS.md §4.1); the
 * Distributor column already reads "No distributor account" for it.
 */
function buildChecks(link: LinkRow, registry: Registry): string[] {
  const checks: string[] = [];
  if (!link.pharmacy_live) checks.push("This pharmacy record is retired or merged");

  const pharmacyName = foldPharmacyName(link.pharmacy_name);
  const pharmacyTwins =
    pharmacyName.length < 3 || !link.pharmacy_area_id
      ? []
      : (registry.pharmaciesByArea.get(link.pharmacy_area_id) ?? []).filter(
          (other) =>
            other.id !== link.pharmacy_id &&
            (other.folded === pharmacyName ||
              (Math.min(other.folded.length, pharmacyName.length) >= 5 && editDistance(other.folded, pharmacyName) === 1)),
        );
  if (pharmacyTwins.length > 0) {
    const customerLinks = registry.linksByCustomer.get(link.customer_id);
    const standings = pharmacyTwins.map((twin) => ({ standing: standingFor(customerLinks?.get(twin.id)), twin }));
    const closest = STANDING_ORDER.map((standing) => standings.find((entry) => entry.standing === standing)).find(
      (entry) => entry !== undefined,
    );
    const allExact = pharmacyTwins.every((twin) => twin.folded === pharmacyName);
    if (closest?.standing) {
      const kind = closest.twin.folded === pharmacyName ? "Same-name" : "Near-identical";
      const likeness = allExact ? "the same name" : "the same or a near-identical name";
      const others = pharmacyTwins.length > 1 ? ` (${pharmacyTwins.length} other records in this area have ${likeness})` : "";
      checks.push(`${kind} pharmacy ${STANDING_WORDS[closest.standing]}: ${closest.twin.display_name ?? ""}${others}`);
    } else {
      const likeness = allExact ? "Same name" : "Same or near-identical name";
      const names = Array.from(new Set(pharmacyTwins.map((twin) => twin.display_name ?? ""))).join(" / ");
      const records = pharmacyTwins.length === 1 ? "another pharmacy record" : `${pharmacyTwins.length} other pharmacy records`;
      checks.push(`${likeness} as ${records} in this area: ${names}`);
    }
  }

  const customerName = foldPersonName(link.customer_name);
  if (customerName.length >= 3 && link.customer_area_id) {
    const customerTwins = (registry.customersByArea.get(link.customer_area_id) ?? []).filter(
      (other) => other.id !== link.customer_id && other.folded === customerName,
    );
    if (customerTwins.length > 0) {
      const records = customerTwins.length === 1 ? "another customer record" : `${customerTwins.length} other customer records`;
      checks.push(`Same name as ${records} in this area`);
    }
  }
  return checks;
}

function describeOrigins(links: LinkRow[]): string {
  const origins = new Set(links.map((link) => classifyOrigin(link.validation_notes)));
  const firstCreated = links.reduce(
    (earliest, link) => (link.created_at < earliest ? link.created_at : earliest),
    links[0].created_at,
  );
  const parts: string[] = [];
  if (origins.has("backfill-2026-07-02")) parts.push("Old ROI-sheet request, never approved (2 July backfill)");
  if (origins.has("second-code-2026-09-08")) {
    parts.push(origins.has("backfill-2026-07-02") ? "+ a second distributor code, 8 Sept" : "Second distributor code, 8 Sept");
  }
  if (origins.has("field")) parts.push(`Rep capture in the app, ${CAIRO_DAY.format(firstCreated)}`);
  if (origins.has("desk")) parts.push(`Desk entry, ${CAIRO_DAY.format(firstCreated)}`);
  return parts.join(" ");
}

function describeOwner(link: LinkRow): string {
  if (!link.owner_name) return "No owner";
  if ((link.owner_status ?? "active") === "active") return link.owner_name;
  const lastDay = link.owner_last_day ? `, last day ${calendarDay(link.owner_last_day)}` : "";
  return `${link.owner_name} — ${link.owner_status}${lastDay}`;
}

function describeUsable(customer: CustomerRow | undefined): string {
  const approved = customer?.approved_pharmacies ?? 0;
  return approved > 0 ? `Yes — ${plural(approved, "approved pharmacy", "approved pharmacies")}` : "No — nothing approved";
}

function describeVisits(customer: CustomerRow | undefined): string {
  if (!customer) return "";
  const byContact = customer.has_crm_contact && customer.contact_visits > 0;
  const total = byContact ? customer.contact_visits : customer.name_visits;
  const inArea = byContact ? customer.contact_in_area : customer.name_in_area;
  const lastInArea = byContact ? customer.contact_last_in_area : customer.name_last_in_area;
  const lastAny = byContact ? customer.contact_last_any : customer.name_last_any;
  const suffix = byContact ? "" : " (name match only)";
  if (total === 0) return customer.has_crm_contact ? "None logged" : "None logged under this name";
  if (inArea === 0) {
    return `${plural(total, "call", "calls")}, none by this area's reps · last ${calendarDay(lastAny)}${suffix}`;
  }
  const elsewhere = total - inArea;
  const tail = elsewhere > 0 ? `, ${elsewhere} elsewhere` : "";
  return `${inArea} by this area's reps${tail} · last ${calendarDay(lastInArea)}${suffix}`;
}

/** The area on file, as its list spells it. A record with no area starts blank, never "No area". */
function customerAreaOnFile(link: LinkRow): string {
  return link.customer_has_area ? link.customer_area ?? "" : "";
}

function pharmacyAreaOnFile(link: LinkRow): string {
  return link.pharmacy_has_area ? link.pharmacy_area ?? "" : "";
}

/**
 * Every address on file, one per line, each led by where it came from. The label goes FIRST so an
 * Arabic address after it cannot flip the line's direction and swallow the label.
 */
function describeCustomerAddress(link: LinkRow, customer: CustomerRow | undefined): string {
  const lines = (customer?.crm_address ?? "")
    .split("\n")
    .filter(Boolean)
    .map((address) => `CRM: ${address}`);
  if (link.customer_captured_address) lines.push(`Captured in the app: ${link.customer_captured_address}`);
  return lines.length > 0 ? lines.join("\n") : "No address on file";
}

/** The distributors' registered addresses — the registered code outranks live GPS (AGENTS.md §4.1). */
function describePharmacyAddress(links: LinkRow[]): string {
  const distributorsByAddress = new Map<string, Set<string>>();
  for (const link of links) {
    if (!link.registered_address) continue;
    const names = distributorsByAddress.get(link.registered_address) ?? new Set<string>();
    names.add(link.distributor_name ?? "Distributor");
    distributorsByAddress.set(link.registered_address, names);
  }
  const lines = Array.from(
    distributorsByAddress,
    ([address, names]) => `${Array.from(names).sort((a, b) => a.localeCompare(b, "en")).join(" · ")}: ${address}`,
  );
  if (links[0].pharmacy_captured_address) lines.push(`Captured in the app: ${links[0].pharmacy_captured_address}`);
  return lines.length > 0 ? lines.join("\n") : "No address on file";
}

function describeEvidence(link: LinkRow): string {
  const customer =
    link.customer_evidence === "complete"
      ? "Customer captured"
      : link.customer_evidence === "pending"
        ? "Customer partly captured"
        : "Customer not captured";
  const pharmacy =
    link.pharmacy_evidence === "complete"
      ? "pharmacy captured"
      : link.pharmacy_gps && link.pharmacy_photo
        ? "pharmacy GPS and photo, not complete"
        : link.pharmacy_gps
          ? "pharmacy GPS, no photo"
          : link.pharmacy_photo
            ? "pharmacy photo, no GPS"
            : "pharmacy not captured";
  if (customer === "Customer not captured" && pharmacy === "pharmacy not captured" && !link.pharmacy_licence) {
    return "Nothing captured";
  }
  const licence = link.pharmacy_licence ? " · licence on file" : "";
  return `${customer} · ${pharmacy}${licence}`;
}

function describeDistributors(links: LinkRow[]): string {
  const names = links.map((link) => (link.has_code ? link.distributor_name ?? "Unknown distributor" : "No distributor account"));
  return Array.from(new Set(names))
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
    .join(" · ");
}

function buildPairings(links: LinkRow[], customers: CustomerRow[], registry: Registry): Pairing[] {
  const customersById = new Map(customers.map((row) => [row.customer_id, row]));
  const byKey = new Map<string, LinkRow[]>();
  for (const link of links) {
    const key = `${link.customer_id}|${link.pharmacy_id}`;
    const group = byKey.get(key) ?? [];
    group.push(link);
    byKey.set(key, group);
  }
  const pairings = Array.from(byKey.values()).map(
    (group): Pairing => ({
      checks: buildChecks(group[0], registry),
      customer: customersById.get(group[0].customer_id),
      links: group.sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
    }),
  );
  // Customer order, so he can work down it the way he reads it — nothing is floated to the top.
  return pairings.sort(
    (a, b) =>
      (a.links[0].customer_name ?? "").localeCompare(b.links[0].customer_name ?? "", "ar") ||
      (a.links[0].pharmacy_name ?? "").localeCompare(b.links[0].pharmacy_name ?? "", "ar"),
  );
}

type Column = { header: string; width: number; value: (pairing: Pairing) => string };

const COLUMNS: Column[] = [
  { header: "Customer", width: 26, value: (p) => p.links[0].customer_name ?? "(unnamed customer)" },
  { header: "Customer's area", width: 20, value: (p) => customerAreaOnFile(p.links[0]) },
  { header: "Customer's address", width: 28, value: (p) => describeCustomerAddress(p.links[0], p.customer) },
  { header: "Owner rep", width: 24, value: (p) => describeOwner(p.links[0]) },
  { header: "Customer usable today", width: 17, value: (p) => describeUsable(p.customer) },
  { header: "CRM calls on this customer", width: 28, value: (p) => describeVisits(p.customer) },
  { header: "Pharmacy", width: 24, value: (p) => p.links[0].pharmacy_name ?? "(unnamed pharmacy)" },
  { header: "Pharmacy's area", width: 20, value: (p) => pharmacyAreaOnFile(p.links[0]) },
  { header: "Pharmacy's address", width: 34, value: (p) => describePharmacyAddress(p.links) },
  { header: "Distributor", width: 18, value: (p) => describeDistributors(p.links) },
  { header: "Field evidence", width: 26, value: (p) => describeEvidence(p.links[0]) },
  { header: "Came from", width: 26, value: (p) => describeOrigins(p.links) },
  { header: "Check first", width: 30, value: (p) => p.checks.join("\n") },
  { header: "Note", width: 34, value: () => "" },
];

/** A column's 1-based position, found by its header so a column added in front cannot shift it. */
function columnOf(header: string): number {
  const index = COLUMNS.findIndex((column) => column.header === header);
  if (index < 0) throw new Error(`No column headed "${header}".`);
  return index + 1;
}

const CUSTOMER_AREA_COLUMN = columnOf("Customer's area");
const USABLE_COLUMN = columnOf("Customer usable today");
const PHARMACY_AREA_COLUMN = columnOf("Pharmacy's area");
const CHECKS_COLUMN = columnOf("Check first");
/** Hidden, after the visible columns: every link id the row covers, then the two areas as filed. */
const HIDDEN_COLUMNS = ["Reference", "Customer's area on file", "Pharmacy's area on file"];
const REFERENCE_COLUMN = COLUMNS.length + 1;
const HEADER_ROW = 5;
const AREA_LIST_SHEET = "Area list";

function rowHeight(values: string[]): number {
  let lines = 1;
  values.forEach((value, index) => {
    const perLine = Math.max(8, (COLUMNS[index]?.width ?? 20) - 2);
    const wrapped = value.split("\n").reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / perLine)), 0);
    lines = Math.max(lines, wrapped);
  });
  return Math.max(20, lines * 13 + 7);
}

/** The list both area dropdowns read. Very hidden: it is the dropdown's source, not a page to read. */
function buildAreaList(workbook: ExcelJS.Workbook, areaNames: string[]): void {
  const sheet = workbook.addWorksheet(AREA_LIST_SHEET, { state: "veryHidden" });
  sheet.getColumn(1).width = 32;
  areaNames.forEach((name, index) => {
    const cell = sheet.getCell(index + 1, 1);
    cell.value = name;
    cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
  });
}

function buildRulingSheet(workbook: ExcelJS.Workbook, pairings: Pairing[], areaCount: number, generatedIso: string): void {
  const sheet = workbook.addWorksheet("Waiting for you", { properties: { defaultRowHeight: 18 } });
  COLUMNS.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });
  HIDDEN_COLUMNS.forEach((_, index) => {
    sheet.getColumn(REFERENCE_COLUMN + index).width = index === 0 ? 40 : 22;
  });

  const linkCount = pairings.reduce((sum, pairing) => sum + pairing.links.length, 0);
  writeHouseMasthead(workbook, sheet, {
    columns: COLUMNS.length,
    provenance: [houseGeneratedAt(generatedIso), `${pairings.length} pairings · ${linkCount} links`],
    subtitle:
      "One row per customer and pharmacy. Both areas are lists, filled with the area on file: pick another only where it is wrong. The two turn red when they differ.",
    title: "Customer Pharmacy Pairings — Waiting For You",
  });
  sheet.getRow(4).height = 6;

  const header = sheet.getRow(HEADER_ROW);
  header.height = 30;
  [...COLUMNS.map((column) => column.header), ...HIDDEN_COLUMNS].forEach((label, index) => {
    const cell = header.getCell(index + 1);
    cell.value = label;
    houseHeaderStyle(cell, { size: 9.5 });
  });

  pairings.forEach((pairing, index) => {
    const excelRow = sheet.getRow(HEADER_ROW + 1 + index);
    const values = COLUMNS.map((column) => column.value(pairing));
    const zebra = index % 2 === 1;
    values.forEach((value, valueIndex) => {
      const cell = excelRow.getCell(valueIndex + 1);
      cell.value = value;
      houseBodyStyle(cell, { size: 9.5, zebra });
      cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    });
    const hiddenValues = [
      pairing.links.map((link) => link.link_id).join("\n"),
      customerAreaOnFile(pairing.links[0]),
      pharmacyAreaOnFile(pairing.links[0]),
    ];
    hiddenValues.forEach((value, hiddenIndex) => {
      const cell = excelRow.getCell(REFERENCE_COLUMN + hiddenIndex);
      cell.value = value;
      houseBodyStyle(cell, { size: 8, zebra });
      cell.alignment = { vertical: "top", wrapText: true };
    });

    // Emphasis in TYPE, never a fill: a customer nobody can use yet, and anything to check first.
    if ((pairing.customer?.approved_pharmacies ?? 0) === 0) {
      excelRow.getCell(USABLE_COLUMN).font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 9.5 };
    }
    if (values[CHECKS_COLUMN - 1]) {
      excelRow.getCell(CHECKS_COLUMN).font = { color: { argb: HOUSE_XLSX_COLORS.flag }, name: HOUSE_XLSX_FONT, size: 9.5 };
    }
    // Each area cell carries a Brand Blue leading rule, so the places to answer are findable without
    // the tinted box the ink rule forbids.
    for (const column of [CUSTOMER_AREA_COLUMN, PHARMACY_AREA_COLUMN]) {
      const answer = excelRow.getCell(column);
      answer.border = { ...answer.border, left: { style: "medium", color: { argb: HOUSE_XLSX_COLORS.blue } } };
    }
    excelRow.height = rowHeight(values);
  });

  const firstRow = HEADER_ROW + 1;
  const lastRow = HEADER_ROW + pairings.length;
  if (pairings.length > 0 && areaCount > 0) {
    const customerLetter = sheet.getColumn(CUSTOMER_AREA_COLUMN).letter;
    const pharmacyLetter = sheet.getColumn(PHARMACY_AREA_COLUMN).letter;
    // ONE rule over each whole answer column — never one per cell (overlapping sqref = repair prompt).
    const validations = (sheet as ExcelJS.Worksheet & {
      dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
    }).dataValidations;
    for (const letter of [customerLetter, pharmacyLetter]) {
      validations.add(`${letter}${firstRow}:${letter}${lastRow}`, {
        allowBlank: true,
        error: "Choose an area from the list. Anything else goes in the Note column.",
        errorTitle: "Pick an area from the list",
        formulae: [`'${AREA_LIST_SHEET}'!$A$1:$A$${areaCount}`],
        showErrorMessage: true,
        type: "list",
      });
    }
    // Both area cells turn red while the customer and the pharmacy sit in different areas — live, so
    // a change he makes clears or raises it. Type only, never a fill; each rule its own priority.
    const differ = `AND($${customerLetter}${firstRow}<>"",$${pharmacyLetter}${firstRow}<>"",$${customerLetter}${firstRow}<>$${pharmacyLetter}${firstRow})`;
    [customerLetter, pharmacyLetter].forEach((letter, index) => {
      sheet.addConditionalFormatting({
        ref: `${letter}${firstRow}:${letter}${lastRow}`,
        rules: [
          {
            formulae: [differ],
            priority: index + 1,
            style: { font: { bold: true, color: { argb: HOUSE_XLSX_COLORS.flag } } },
            type: "expression",
          },
        ],
      });
    });
  }

  HIDDEN_COLUMNS.forEach((_, index) => {
    sheet.getColumn(REFERENCE_COLUMN + index).hidden = true;
  });
  sheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: HEADER_ROW }];
  // The filter spans the hidden columns too. Excel sorts only the filter's own columns, so a filter
  // that stopped at the last visible one let the owner's sort move every answer away from its hidden
  // Reference and on-file areas (the 2026-09-17 return), and a read-back by position read nonsense.
  sheet.autoFilter = {
    from: { column: 1, row: HEADER_ROW },
    to: { column: REFERENCE_COLUMN + HIDDEN_COLUMNS.length - 1, row: Math.max(lastRow, HEADER_ROW) },
  };
}

type ReadMeFacts = {
  pairings: number;
  links: number;
  customers: number;
  unusableCustomers: number;
  differentAreas: number;
  queue: QueueRow;
  origins: { backfill: number; backfillWithSecondCode: number; field: number };
};

function buildReadMe(workbook: ExcelJS.Workbook, facts: ReadMeFacts, generatedIso: string): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { defaultRowHeight: 18 } });
  sheet.views = [{ showGridLines: false }];
  sheet.getColumn(1).width = 4;
  sheet.getColumn(2).width = 26;
  sheet.getColumn(3).width = 100;

  writeHouseMasthead(workbook, sheet, {
    columns: 3,
    provenance: [houseGeneratedAt(generatedIso), "Read from production"],
    subtitle: "Which area each customer and each pharmacy on a pending pairing belongs to.",
    title: "Customer Pharmacy Pairings — Areas",
  });

  let row = 5;

  const heading = (text: string) => {
    row += 1;
    sheet.mergeCells(row, 2, row, 3);
    const cell = sheet.getCell(row, 2);
    cell.value = text;
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 11 };
    cell.border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
    sheet.getRow(row).height = 20;
    row += 1;
  };

  const line = (label: string, body: string, emphasis = false) => {
    const labelCell = sheet.getCell(row, 2);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
    labelCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    const bodyCell = sheet.getCell(row, 3);
    bodyCell.value = body;
    if (emphasis) {
      houseCalloutStyle(bodyCell, { emphasis: true });
    } else {
      bodyCell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
      bodyCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    }
    // The label wraps too — a 30-character label in a 26-wide column is two lines under a one-line body.
    const lines = Math.max(Math.ceil(label.length / 24), Math.ceil(body.length / 105));
    sheet.getRow(row).height = Math.max(18, lines * 13 + 6);
    row += 1;
  };

  heading("What is waiting");
  line(
    "On the next tab",
    `${plural(facts.pairings, "pairing", "pairings")} of a customer and a pharmacy (${facts.links} links), across ${facts.customers} customers.`,
    true,
  );
  line(
    "Why it matters",
    `A pending pairing cannot be picked on a marketing request. ${facts.unusableCustomers} of these ${facts.customers} customers have nothing approved, so they cannot be used at all today. ` +
      `On ${plural(facts.differentAreas, "row", "rows")} the customer and the pharmacy are filed in different areas.`,
  );
  line(
    "Left out",
    `${plural(facts.queue.held_links, "link", "links")} you put on hold (${facts.queue.held_customers} customers). They wait for your release.`,
  );

  heading("Your answers");
  line("Customer's area", "A list, filled with the customer's area on file. Pick another area only if the customer belongs elsewhere.", true);
  line("Pharmacy's area", "A list, filled with the pharmacy's area on file. Pick another area only if the pharmacy belongs elsewhere.", true);
  line("Red areas", "The customer and the pharmacy are in different areas. The red clears as soon as the two match.");
  line("Left as it is", "An area you do not change stays as it is.");
  line(
    "Several rows, one record",
    "A customer or pharmacy on more than one row should get the same area on each. If your rows disagree, you are asked which one you meant.",
  );
  line("Note", "Anything else about the row.");

  heading("Reading a row");
  line("Customer usable today", "\"No\" means no marketing request can use this customer until one of its pairings is approved.");
  line(
    "CRM calls",
    "Calls logged on this customer. \"By this area's reps\" means the rep who called works the customer's own area. \"Name match only\" means the customer has no CRM contact with calls to follow, so calls were matched on the name.",
  );
  line(
    "Customer's address",
    "The address on the customer's CRM contact, and the one captured in the app if a rep captured it. \"No address on file\" when there is neither.",
  );
  line(
    "Pharmacy's address",
    "The address each distributor has registered for the pharmacy, led by the distributor's name, and the one captured in the app if a rep captured it.",
  );
  line("Owner rep", "Who owns the customer, and whether they still work here.");
  line("Distributor", "The distributor accounts this pharmacy is linked through. One answer covers them all.");
  line("Field evidence", "What a rep has actually captured in the app, for the customer and for the pharmacy.");
  line(
    "Came from",
    `Old ROI-sheet request: written on 2 July from a request on the ROI sheet that was pending or rejected (${facts.origins.backfill} pairings; ` +
      `${facts.origins.backfillWithSecondCode} of them got a second distributor code on 8 Sept). ` +
      `Rep capture: a rep linked them in the app (${facts.origins.field} pairings).`,
  );
  line(
    "Check first",
    "Facts that could make the pairing wrong: another pharmacy or customer record with the same name in the area, and where that pharmacy already stands for this customer. A pairing whose twin is already approved for the same customer may be a duplicate record.",
  );

  heading("What happens next");
  line(
    "Nothing changes from this file",
    "Send it back in a session. The areas you changed are read back to you in chat before anything is touched.",
  );
  line(
    "Approvals stay your click",
    "Approving or rejecting a pairing is still done by you on the Customer Pharmacy Mapping page. No session records one for you.",
  );

  row += 1;
  sheet.mergeCells(row, 2, row, 3);
  const footer = sheet.getCell(row, 2);
  footer.value = systemDocuments.workbookExportScopeNote;
  footer.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 8 };
}

/**
 * ExcelJS anchors every image with `<xdr:oneCellAnchor editAs="oneCell">` whether or not `editAs`
 * is passed, and `CT_OneCellAnchor` declares no attributes — Excel then "repairs" the drawing on
 * open. The attribute carries nothing a one-cell anchor can use, so it is removed from the zip.
 */
async function stripOneCellAnchorEditAs(bytes: ArrayBuffer): Promise<{ bytes: Buffer; stripped: number }> {
  const zip = await JSZip.loadAsync(bytes);
  let stripped = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(name)) continue;
    const part = zip.file(name);
    if (!part) continue;
    const xml = await part.async("string");
    const fixed = xml.replace(/<xdr:oneCellAnchor\s+editAs="[^"]*"\s*>/g, () => {
      stripped += 1;
      return "<xdr:oneCellAnchor>";
    });
    if (fixed !== xml) zip.file(name, fixed);
  }
  return { bytes: await zip.generateAsync({ compression: "DEFLATE", type: "nodebuffer" }), stripped };
}

async function main(): Promise<void> {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error("SUPABASE_DB_URL is not set — run with --env-file-if-exists=.env.local.");

  const outputPath = resolve(process.argv[2] ?? `xlsx/customer-pharmacy-areas-${cairoTodayKey()}.xlsx`);
  const marker = MARKETING_MANUAL_HOLD_MARKER;

  const sql = postgres(connectionString, { max: 1, prepare: false });
  type Snapshot = [LinkRow[], CustomerRow[], NamedRow[], NamedRow[], CustomerLinkRow[], QueueRow[], { name: string }[]];
  let snapshot: Snapshot;
  try {
    // One read-only snapshot, so every answer describes the same moment.
    snapshot = await sql.begin(
      "isolation level repeatable read read only",
      async (tx): Promise<Snapshot> => [
        (await tx.unsafe(LINKS_SQL, [marker])) as unknown as LinkRow[],
        (await tx.unsafe(CUSTOMERS_SQL, [marker])) as unknown as CustomerRow[],
        (await tx.unsafe(PHARMACIES_SQL)) as unknown as NamedRow[],
        (await tx.unsafe(CUSTOMER_NAMES_SQL)) as unknown as NamedRow[],
        (await tx.unsafe(CUSTOMER_LINKS_SQL, [marker])) as unknown as CustomerLinkRow[],
        (await tx.unsafe(QUEUE_SQL, [marker])) as unknown as QueueRow[],
        (await tx.unsafe(AREAS_SQL)) as unknown as { name: string }[],
      ],
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  const [links, customers, pharmacies, customerNames, customerLinks, queueRows, areaRows] = snapshot;
  const queue = queueRows[0];

  // An area on file that the list lacks is added, so no pre-filled cell is outside its own list.
  const listedAreas = new Set(areaRows.map((row) => row.name));
  const areasOnFile = links.flatMap((link) => [customerAreaOnFile(link), pharmacyAreaOnFile(link)]).filter(Boolean);
  const addedAreas = Array.from(new Set(areasOnFile.filter((name) => !listedAreas.has(name))));
  const areaNames = [...listedAreas, ...addedAreas].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

  const registry: Registry = {
    customersByArea: indexByArea(customerNames, foldPersonName),
    linksByCustomer: indexLinks(customerLinks),
    pharmaciesByArea: indexByArea(pharmacies, foldPharmacyName),
  };
  const pairings = buildPairings(links, customers, registry);
  const originsOf = (pairing: Pairing) => new Set(pairing.links.map((link) => classifyOrigin(link.validation_notes)));
  const facts: ReadMeFacts = {
    customers: new Set(pairings.map((pairing) => pairing.links[0].customer_id)).size,
    links: links.length,
    origins: {
      backfill: pairings.filter((pairing) => originsOf(pairing).has("backfill-2026-07-02")).length,
      backfillWithSecondCode: pairings.filter((pairing) => {
        const origins = originsOf(pairing);
        return origins.has("backfill-2026-07-02") && origins.has("second-code-2026-09-08");
      }).length,
      field: pairings.filter((pairing) => originsOf(pairing).has("field")).length,
    },
    differentAreas: pairings.filter((pairing) => {
      const link = pairing.links[0];
      return link.customer_has_area && link.pharmacy_has_area && !link.same_area;
    }).length,
    pairings: pairings.length,
    queue,
    unusableCustomers: customers.filter((customer) => customer.approved_pharmacies === 0).length,
  };

  const generatedIso = new Date().toISOString();
  const workbook = new ExcelJS.Workbook();
  workbook.company = systemDocuments.workbookCompany;
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date(generatedIso);
  workbook.title = "Customer Pharmacy Pairings — Areas";
  buildReadMe(workbook, facts, generatedIso);
  buildRulingSheet(workbook, pairings, areaNames.length, generatedIso);
  buildAreaList(workbook, areaNames);

  const { bytes, stripped } = await stripOneCellAnchorEditAs(await workbook.xlsx.writeBuffer());
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes);

  // Pairings the two known origins do not explain. Zero is the expected answer; anything else means
  // a new kind of note reached the queue and `classifyOrigin` needs to learn it.
  const unexplained = pairings.filter((pairing) => {
    const origins = originsOf(pairing);
    return origins.has("desk") || (origins.has("second-code-2026-09-08") && !origins.has("backfill-2026-07-02"));
  }).length;
  console.log(`pending links (all)          : ${queue.pending_links} across ${queue.pending_customers} customers`);
  console.log(`held, left out               : ${queue.held_links} links, ${queue.held_customers} customers`);
  console.log(`on the sheet                 : ${pairings.length} pairings, ${links.length} links, ${facts.customers} customers`);
  console.log(`  old ROI-sheet request      : ${facts.origins.backfill} (with an 8 Sept second code: ${facts.origins.backfillWithSecondCode})`);
  console.log(`  rep capture                : ${facts.origins.field}`);
  console.log(`  unexplained origin         : ${unexplained}`);
  console.log(`customers with none approved : ${facts.unusableCustomers}`);
  console.log(`rows in two different areas  : ${facts.differentAreas}`);
  console.log(
    `rows with an address         : customer ${pairings.filter((p) => describeCustomerAddress(p.links[0], p.customer) !== "No address on file").length}` +
      `, pharmacy ${pairings.filter((p) => describePharmacyAddress(p.links) !== "No address on file").length} of ${pairings.length}`,
  );
  console.log(`areas in the list            : ${areaNames.length} (added from records on file: ${addedAreas.join(", ") || "none"})`);
  console.log(`rows with a check-first flag : ${pairings.filter((pairing) => pairing.checks.length > 0).length}`);
  for (const pairing of pairings.filter((entry) => entry.checks.length > 0)) {
    console.log(`  ${pairing.links[0].customer_name} × ${pairing.links[0].pharmacy_name}: ${pairing.checks.join(" | ")}`);
  }
  console.log(`image anchors repaired       : ${stripped}`);
  console.log(`written                      : ${outputPath}`);
}

await main();
