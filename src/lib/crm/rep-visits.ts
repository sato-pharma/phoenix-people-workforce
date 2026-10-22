// ─────────────────────────────────────────────────────────────────────────────
// The drill-down behind one rep's call rate: the individual visits the number on
// Reps Plans is made of.
//
// THE POINT OF THIS FILE IS THAT NOTHING IN IT IS FREE TEXT. The owner's
// instruction, 2026-08-28: "I don't want visits to be a raw text. I want
// everything to be connected to the organogram and the bricks and the areas and
// the regions of the users. I want a linkage in every single thing."
//
// So every column resolves through a real record and says where it came from:
//
//   rep          -> au_v_org_tree seat, tier, line, region   (organogram)
//   doctor       -> contact_crm_id + name + speciality       (CRM contact)
//   territory    -> crm_region_id -> brick -> area -> region (Phoenix geography)
//   visit type   -> classifyVisit(), the shared code->label  (CRM visit type)
//   AM / PM      -> normalizeSession()                       (CRM ampm flag)
//   proof        -> classifyCallProof() against the GPS feed (check-ins)
//   partner      -> double_hr_id -> employee directory       (HR)
//
// PURE. The reads live in rep-visits-data.ts, for the same reason org-placement.ts
// is kept apart from org-placement-data.ts: this stays testable without a database.
//
// ── RECONCILIATION ──────────────────────────────────────────────────────────────
// The proof and the session are computed with `classifyCallProof` and
// `normalizeSession` — THE SAME two functions the board's own rate is computed
// with, not a re-implementation of them. That is deliberate and load-bearing: a
// drill-down whose rows add up to a different number than the row that opened it
// is worse than no drill-down at all, and the only way to guarantee they agree is
// to make it impossible for them to disagree. `summarizeRepVisits` below counts
// the rendered rows back up so the page can show the reconciliation rather than
// assert it.
// ─────────────────────────────────────────────────────────────────────────────

import {
  phoenixRowSight,
  phoenixVisitDetail,
  phoenixVisitDetailColumns,
  type PhoenixDetailViewer,
  type PhoenixVisitDetail,
  type PhoenixVisitDetailRow,
} from "@/lib/crm/phoenix-visit-detail";
import {
  callRateExclusionOf,
  classifyCallProof,
  normalizeSession,
  type CallProof,
  type CallRateExclusion,
  type CallRateHolidays,
  type CallSession,
  type VisitForCallRate,
} from "@/lib/crm/call-rate";
import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { isPharmacyListType, PHARMACY_LIST_TYPE } from "@/lib/phoenix-crm/pharmacy-call-rules";
import {
  matchCampaignNote,
  type CampaignContactMatch,
  type KnownContactIndex,
} from "@/lib/crm/campaign-contact-match";
import {
  applyAssist,
  campaignHeadline,
  readCampaignNote,
  type CampaignAssistReading,
  type CampaignNoteReading,
} from "@/lib/crm/campaign-note";
import { classifyVisit, type VisitBucket } from "@/lib/crm/visit-types";
import type { CheckinForMatch } from "@/lib/crm/checkin-match";
import { indexCheckinsByAgentContactDay } from "@/lib/crm/checkin-match";

/**
 * Where a visit sits in the Phoenix geography.
 *
 * Three states, and the difference between the last two matters:
 *   mapped    the CRM region has been tied to a brick, so area and region are real
 *   unmapped  the CRM region is a real coded region, nobody has tied it to a brick YET
 *   none      the CRM row carries no region at all — there is nothing to tie
 *
 * "unmapped" is a TODO with a name and an id attached, not a data fault, and it must never render
 * as a blank or a zero. On 2026-08-28 every visit in production was in that state:
 * `ireports360_crm_region_brick_resolutions` held 0 rows against 239 distinct CRM regions.
 *
 * That is no longer true, and "mapped" is NOT dead code: re-measured 2026-09-03 the table holds 105
 * resolutions covering 100 of 261 contact regions, so all three states occur in production.
 */
export type RepVisitTerritory =
  | {
      status: "mapped";
      brickId: string;
      brickName: string | null;
      areaCode: string | null;
      areaName: string | null;
      regionCode: string | null;
      regionName: string | null;
    }
  | { status: "unmapped" }
  | { status: "none" };

/** A visit's standing in the KPI: one of the three proof buckets, or excluded from it entirely. */
export type RepVisitStanding = CallProof | "excluded";

export type RepVisitRow = {
  /** The CRM's own visit id — the record this row IS, not a description of it. */
  visitCrmId: number | null;
  dateIso: string;
  session: CallSession;
  /** The doctor's CRM contact id. Stable across renames, which a name is not. */
  contactCrmId: number | null;
  contactName: string | null;
  /** The account the contact was seen at — a clinic, pharmacy or hospital. */
  customerName: string | null;
  speciality: string | null;
  grade: string | null;
  crmRegionId: number | null;
  crmRegionName: string | null;
  territory: RepVisitTerritory;
  visitTypeCode: number | null;
  /** "Regular visit", "Campaign" — the shared label, never the raw code. */
  visitTypeLabel: string;
  bucket: VisitBucket;
  standing: RepVisitStanding;
  /**
   * Why this FIELD call is listed but not in the rate above it — Thursday or Friday, a national
   * holiday, or the catch-all contact — or null when it counts. Read from `callRateExclusionOf`,
   * the gate `computeCallRate` itself applies, so the rows marked here are exactly the ones the rate
   * left out. Always null on a row that is not field work: a day off is not a call to exclude.
   */
  unscored: CallRateExclusion | null;
  partnerHrId: string | null;
  partnerName: string | null;
  /** The chain visit's second manager, named the same way the first is — directory, then CRM handle. */
  partner2HrId: string | null;
  partner2Name: string | null;
  comment: string | null;
  /**
   * The Phoenix field set, shaped for THIS reader's sight tier, or null on a vendor row.
   *
   * Null is the honest answer for iReports360: it recorded no products, no samples, no GPS and no
   * evidence, and a zero there would read as a measurement that was taken and came back empty.
   */
  phoenix: PhoenixVisitDetail | null;
  /**
   * The same field set FLAT, one cell per column, for the XLSX — keyed by the sheet's own header.
   *
   * Shaped here rather than in the renderer because the renderer is a CLIENT component and the shaper
   * reads a tier: a sheet built in the browser would need both the raw measurements and the sight rule
   * in the bundle, which is the one thing golden rule #1 does not allow. A column this reader may not
   * read is ABSENT rather than empty, so a blank cell never reads as "there was no reading".
   */
  phoenixColumns: Record<string, string | number | null> | null;
  /**
   * Set only on a campaign row whose named doctor turned out to be on the registered list already.
   *
   * This is a READING, never an edit. The visit still has no `contactCrmId` and still counts
   * exactly as it did before — nothing about the call rate moves. What it changes is what the
   * screen is allowed to claim: without it, every campaign row is labelled "Prospect · not on his
   * list", and for 3,126 of production's campaign visits that sentence is false.
   */
  knownContact: CampaignContactMatch | null;
};

/** The mirror columns this module needs, on top of the ones the rate already reads. */
export type VisitForRepDrilldown = VisitForCallRate &
  PhoenixVisitDetailRow & {
    crm_visit_id: number | null;
    contact_name: string | null;
    customer_name: string | null;
    speciality: string | null;
    crm_contact_grade: string | null;
    crm_region_id: number | null;
    crm_region_name: string | null;
    double_hr_id: string | null;
    double_name: string | null;
    /** A chain visit's SECOND manager. Slot 1 is `coalesce(manager, product_manager, senior)`, so a row
     * carrying somebody here carries somebody there too — the slots never hold one person. */
    double2_hr_id: string | null;
    double2_name: string | null;
  };

/** A resolved CRM region, keyed by `crm_region_id`. Empty map = nothing mapped yet. */
export type CrmRegionTerritoryIndex = ReadonlyMap<
  number,
  {
    brickId: string;
    brickName: string | null;
    areaCode: string | null;
    areaName: string | null;
    regionCode: string | null;
    regionName: string | null;
  }
>;

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * The CRM contact id, with the vendor's own null spelled out.
 *
 * A campaign call has NO contact, and iReports360 sends that as `contact_crm_id: 0` rather than a
 * null — the same convention `call-rate.ts` fixtures a campaign row with, and the reason
 * `classifyCallProof` can route a campaign row without ever looking for a check-in.
 *
 * Left as 0 it becomes a FAKE RECORD, and it did: measured on this page against production on
 * 2026-08-28, one rep's August read "Contact 0" on 85 of 153 rows, and the distinct-doctor count
 * turned all 85 campaign calls into one phantom doctor and counted it as real (60 where the truth
 * was 59). Zero is not an id. It is the absence of one, and it is normalised here — once, at the
 * edge — so nothing downstream has to remember the vendor's convention.
 */
const contactId = (value: number | null): number | null => (value != null && value > 0 ? value : null);

/**
 * Resolve one visit's territory.
 *
 * A CRM region with no resolution is `unmapped`, NOT `none`: the region is a real record with an id
 * and a name, and the screen says so and names it. Conflating the two would tell the reader the CRM
 * recorded nothing when in fact it recorded a place nobody has tied to the map yet.
 */
export function resolveVisitTerritory(
  crmRegionId: number | null,
  index: CrmRegionTerritoryIndex,
): RepVisitTerritory {
  if (crmRegionId == null) return { status: "none" };
  const hit = index.get(crmRegionId);
  if (!hit) return { status: "unmapped" };
  return {
    status: "mapped",
    brickId: hit.brickId,
    brickName: hit.brickName,
    areaCode: hit.areaCode,
    areaName: hit.areaName,
    regionCode: hit.regionCode,
    regionName: hit.regionName,
  };
}

/**
 * Shape one mirror row into a drill-down row.
 *
 * `standing` comes from {@link classifyCallProof}, which returns null for anything that is not field
 * work — leave, meetings, training, admin. That null becomes "excluded" here rather than dropping
 * the row: a rep's month contains those days, and hiding them would make the drill-down disagree
 * with his calendar even while it agrees with his rate. The summary counts them separately.
 */
/**
 * The rules' reading of a campaign row's note, or null when this row is not one.
 *
 * ONE predicate, deliberately, used by both readers below. `collectCampaignFragments` decides which
 * notes are sent to the model and `toRepVisitRow` decides which notes get the answers folded back
 * in. If those two ever disagreed the assist would resolve fragments nobody looks up — no error, no
 * log, a paid call whose answer is silently discarded and a screen that never changes.
 */
function campaignReading(visit: VisitForRepDrilldown, bucket: VisitBucket): CampaignNoteReading | null {
  return bucket === "campaign" && !text(visit.contact_name) ? readCampaignNote(visit.comment) : null;
}

/**
 * What the rules could not read across a rep's period — the input to the cheap-model assist.
 *
 * PURE, so the IO shell can ask this question before it awaits anything, and so a test can pin
 * exactly which fragments would be sent without an API key anywhere near it.
 *
 * De-duplicated here as well as in the assist: one rep's month repeats the same abbreviation many
 * times over — the same hospital, the same pharmacy, written the same way — and the model is billed
 * per fragment, not per row.
 */
export function collectCampaignFragments(visits: readonly VisitForRepDrilldown[]): string[] {
  const seen = new Set<string>();
  for (const visit of visits) {
    const { bucket } = classifyVisit(visit.visit_type, visit.comment, visit.visit_type_description);
    const reading = campaignReading(visit, bucket);
    if (!reading) continue;
    for (const fragment of reading.unread) {
      const trimmed = fragment.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen];
}

export function toRepVisitRow<C extends CheckinForMatch>(
  visit: VisitForRepDrilldown,
  checkinIndex: Map<string, C[]>,
  territoryIndex: CrmRegionTerritoryIndex,
  partnerNameByHrId?: ReadonlyMap<string, string>,
  contactDirectory?: KnownContactIndex,
  /** What the cheap model read, keyed by fragment. Omitted → the rules' answer, unchanged. */
  assisted?: ReadonlyMap<string, CampaignAssistReading>,
  /** The national holidays the rate took out of its denominator. Omitted → the weekday rule only. */
  holidays?: CallRateHolidays,
  /**
   * Who is reading, so the Phoenix field set can be shaped to his sight tier (golden rule #1's three
   * tiers, owner 2026-10-02). Omitted → no Phoenix half at all, which is what every caller that has
   * not opted in gets and is exactly the behaviour before 2026-10-07.
   */
  viewer?: PhoenixDetailViewer,
): RepVisitRow {
  const { label, bucket } = classifyVisit(visit.visit_type, visit.comment, visit.visit_type_description);
  const partnerHrId = text(visit.double_hr_id);
  const partner2HrId = text(visit.double2_hr_id);
  // A CAMPAIGN row carries no contact, no speciality and no customer — the doctor exists only inside
  // the rep's own sentence. OWNER, 2026-08-28: *"in the campaign you must be able to separate the
  // doctor name, the specialty, and the clinic. The first one is not a doctor, it is a hospital, and
  // its address is in its name. Another doctor has his specialty in his name, which is GB."*
  //
  // So the note is pulled apart HERE, once, into the same three fields a regular visit already fills
  // — and the row then sorts, searches and exports like any other.
  //
  // The rules run at this layer and the cheap-model assist is folded in on top of them. The model
  // call itself cannot happen here — it is async and this function is pure and synchronous — so
  // rep-visits-data.ts awaits it once for the whole period and hands the answers down as
  // `assisted`, exactly as it already hands down the contact directory and the territory index.
  // Nothing about this function's purity changes, and with no map it behaves as it always did.
  //
  // ASSIST FIRST, THEN MATCH. `knownContact` below looks the named doctor up in the rep's own
  // registered list, so a name only the model could read has to be in `note.people` BEFORE that
  // lookup runs. In the other order the assist would fill the screen's text and the row would still
  // say "Prospect · not on his list" about a doctor the rep has registered — a worse reading than
  // the one it replaced, because it looks researched.
  const rules = campaignReading(visit, bucket);
  const note = rules && assisted ? applyAssist(rules, assisted) : rules;
  const dateIso = (visit.visit_date ?? "").slice(0, 10);
  const standing: RepVisitStanding = classifyCallProof(visit, checkinIndex) ?? "excluded";
  return {
    visitCrmId: visit.crm_visit_id,
    dateIso,
    session: normalizeSession(visit.ampm),
    contactCrmId: contactId(visit.contact_crm_id),
    contactName: text(visit.contact_name),
    // The clinic, hospital or pharmacy the campaign call was made in, when the rep named one. A
    // regular visit's own customer always wins — that is a record, and this is a reading of prose.
    customerName: text(visit.customer_name) ?? note?.accounts[0]?.name ?? null,
    // "GB" comes back as WRITTEN, never mapped to a speciality the taxonomy does not hold — the
    // owner named that row himself and inventing an expansion for it would be a guess printed as a
    // fact. `resolveSpeciality` canonicalises the ones that ARE known ("IM", "باطنا" -> internal
    // medicine) through contact-taxonomy, so this column stays one vocabulary and not two.
    // A Phoenix pharmacy call says so through its list (`ampm = 'Pharmacy'`), often with no speciality on
    // the pharmacy a rep added himself — it reads "Pharmacy" here, so the row says what it is and the
    // summary below files it under Pharmacies, never under "unspecified" (re-audit, 2026-10-22).
    speciality:
      text(visit.speciality) ??
      (isPharmacyListType(visit.ampm) ? PHARMACY_LIST_TYPE : null) ??
      note?.people[0]?.speciality?.written ??
      null,
    grade: text(visit.crm_contact_grade),
    crmRegionId: visit.crm_region_id,
    crmRegionName: text(visit.crm_region_name),
    territory: resolveVisitTerritory(visit.crm_region_id, territoryIndex),
    visitTypeCode: visit.visit_type,
    visitTypeLabel: label,
    bucket,
    standing,
    // The visit itself goes in, so a Phoenix CRM visit to a customer not validated yet reads "not
    // scored" here exactly as the rate above left it out (crm/phoenix-team-starts.ts).
    unscored: standing === "excluded" ? null : callRateExclusionOf(dateIso, visit.contact_crm_id, holidays, visit),
    partnerHrId,
    // The directory names the person; the CRM's `double_name` is a login handle. Same waterfall as
    // the board's own rep column — directory first, CRM handle second, never a bare code.
    partnerName: partnerHrId
      ? (partnerNameByHrId?.get(partnerHrId.toLowerCase()) ?? text(visit.double_name))
      : text(visit.double_name),
    partner2HrId,
    // Same waterfall for the second manager, so a chain visit names both people it carried rather
    // than one of them — the door has returned both since #5477.
    partner2Name: partner2HrId
      ? (partnerNameByHrId?.get(partner2HrId.toLowerCase()) ?? text(visit.double2_name))
      : text(visit.double2_name),
    // The field set, at the tier this reader's role earns — resolved PER ROW, because golden rule #1's
    // own-row half is absolute: a reader looking at a visit whose AGENT is himself reads no distance,
    // no flag and no capture timing. A visit he merely rode along on is the REP's row and keeps them.
    phoenix: viewer ? phoenixVisitDetail(visit, phoenixRowSight(viewer, visit.agent_hr_id)) : null,
    phoenixColumns: viewer ? phoenixVisitDetailColumns(visit, phoenixRowSight(viewer, visit.agent_hr_id)) : null,
    comment: text(visit.comment),
    // The doctor the rep named, looked up in his own registered list. Only a campaign row can carry
    // this — a regular visit already HAS its contact, and re-deriving one from prose beside a real
    // record would put a guess next to a fact. Null whenever the directory is empty, which is what
    // every caller that does not load one gets, and is exactly today's behaviour.
    knownContact: note && contactDirectory ? matchCampaignNote(note, text(visit.agent_hr_id), contactDirectory) : null,
  };
}

export type RepVisitsSummary = {
  /** Every row rendered, field work or not. */
  rows: number;
  /** verified + unverified + campaign — the rows the rate is computed from. */
  fieldCalls: number;
  verified: number;
  unverified: number;
  campaign: number;
  /** Leave, meetings, training, admin — present on the screen, absent from the KPI. */
  excluded: number;
  /**
   * Field calls listed but left out of the rate: Thursday or Friday, a national holiday, or the
   * catch-all contact. `fieldCalls` + this = every field-work row on the screen.
   */
  unscored: number;
  am: number;
  pm: number;
  /**
   * Pharmacy calls, separate from AM/PM entirely (owner, 2026-09-05) — see crm/call-rate.ts's
   * `isPharmacyVisit`. A pharmacy row is never also counted in am/pm/unspecified, whatever AM/PM
   * flag it carries.
   */
  pharmacy: number;
  unspecified: number;
  /** Distinct doctors seen, by CRM contact id. */
  distinctContacts: number;
  /** Distinct CRM regions touched. */
  distinctRegions: number;
  /** Field-work rows whose CRM region is not tied to a brick yet. */
  unmappedTerritory: number;
  /** Field-work rows the CRM left without any region at all. */
  noTerritory: number;
  /**
   * Campaign rows whose doctor is already on this rep's registered list — a coding mistake, not
   * prospecting. Counted so the page can state the size of it instead of leaving the reader to
   * spot the markers row by row.
   */
  campaignAlreadyKnown: number;
};

/**
 * Count the rendered rows back up.
 *
 * The page shows this beside the board's own figures so the reconciliation is VISIBLE — "these 214
 * rows are the 214 calls behind that rate" — rather than claimed. `fieldCalls` here must equal the
 * rep's reported calls on the board for the same month; both are derived from the same rows through
 * the same classifier, so a mismatch means a filter diverged and the screen will show it.
 *
 * THE 2026-09-05 GATE. `fieldCalls`, the proof totals and every session (including `pharmacy`) now
 * exclude Thursday/Friday rows, mirroring the exact gate `computeCallRate` applies before it will
 * add a visit to any slice (owner: "visists to be counted from sat to wednesday only") — and, since
 * 2026-09-21, national holidays and the catch-all contact too, because each row now carries that
 * gate's own answer as `unscored` and this counts them as `unscored` instead. Such a row is still
 * RENDERED above, and marked — it is real field work — but it must not inflate the numbers this
 * function reconciles against the board, which no longer counts it either. `excluded`,
 * `distinctContacts`, `distinctRegions`, `unmappedTerritory`, `noTerritory` and
 * `campaignAlreadyKnown` are deliberately NOT gated: they describe data quality across whatever
 * range was browsed, a different question from "what counts toward the call rate".
 */
export function summarizeRepVisits(rows: readonly RepVisitRow[]): RepVisitsSummary {
  const contacts = new Set<number>();
  const regions = new Set<number>();
  const summary: RepVisitsSummary = {
    rows: rows.length,
    fieldCalls: 0,
    verified: 0,
    unverified: 0,
    campaign: 0,
    excluded: 0,
    unscored: 0,
    am: 0,
    pm: 0,
    pharmacy: 0,
    unspecified: 0,
    distinctContacts: 0,
    distinctRegions: 0,
    unmappedTerritory: 0,
    noTerritory: 0,
    campaignAlreadyKnown: 0,
  };
  for (const row of rows) {
    if (!isFieldWork(row)) {
      summary.excluded += 1;
      continue;
    }
    // Doctors and places are counted over FIELD WORK only, for the same reason the sessions below
    // are: a day off is not a place visited, and a training day is not a doctor seen. NOT gated by
    // working day — see the header — because these describe data quality across the whole browsed
    // range, not the call rate.
    if (row.contactCrmId != null) contacts.add(row.contactCrmId);
    if (row.crmRegionId != null) regions.add(row.crmRegionId);
    if (row.territory.status === "unmapped") summary.unmappedTerritory += 1;
    else if (row.territory.status === "none") summary.noTerritory += 1;
    // "own" only. A doctor on a COLLEAGUE's list is a territory question, not a mis-coded call, and
    // counting the two together would put a number in front of the owner that mixes a mistake he
    // can tell a rep to stop making with one he cannot.
    if (row.knownContact?.scope === "own") summary.campaignAlreadyKnown += 1;

    // THE 2026-09-05 GATE — see the header. A Thursday/Friday row is real field work (counted
    // above) but must not reach fieldCalls, the proof totals or any session, because the board no
    // longer counts it either. Since 2026-09-21 the row carries the gate's own answer (`unscored`),
    // holidays and the catch-all contact included, instead of this function re-deriving the weekday
    // half of it and missing the rest.
    if (row.unscored) {
      summary.unscored += 1;
      continue;
    }

    summary.fieldCalls += 1;
    summary[row.standing] += 1;
    // Pharmacy is ORTHOGONAL to AM/PM, not a third value of it — a pharmacy row is pulled out
    // regardless of which flag it carries, exactly as computeCallRate does.
    const isPharmacy = isPharmacySpeciality(row.speciality) || row.visitTypeLabel === "Pharmacy Visit";
    if (isPharmacy) summary.pharmacy += 1;
    else if (row.session === "am") summary.am += 1;
    else if (row.session === "pm") summary.pm += 1;
    else summary.unspecified += 1;
  }
  summary.distinctContacts = contacts.size;
  summary.distinctRegions = regions.size;
  return summary;
}

/** Newest first, then AM before PM within a day, then by contact so a day reads in a stable order. */
export function sortRepVisitRows(rows: readonly RepVisitRow[]): RepVisitRow[] {
  const sessionRank = (session: CallSession): number => (session === "am" ? 0 : session === "pm" ? 1 : 2);
  return [...rows].sort((a, b) => {
    if (a.dateIso !== b.dateIso) return a.dateIso < b.dateIso ? 1 : -1;
    const bySession = sessionRank(a.session) - sessionRank(b.session);
    if (bySession !== 0) return bySession;
    return (a.contactName ?? "").localeCompare(b.contactName ?? "");
  });
}

/**
 * One rep's month, assembled.
 *
 * Takes the raw mirror rows and the check-ins exactly as the rate does, so the caller cannot
 * accidentally hand this a differently-filtered set.
 */
export function buildRepVisits<C extends CheckinForMatch>(
  visits: readonly VisitForRepDrilldown[],
  checkins: readonly C[],
  options: {
    territoryIndex: CrmRegionTerritoryIndex;
    partnerNameByHrId?: ReadonlyMap<string, string>;
    /** The rep's registered doctors. Omitted → no campaign row claims to know anyone. */
    contactDirectory?: KnownContactIndex;
    /**
     * The national holidays the board's rate took out of its denominator, so a call made on one is
     * marked "not scored" here exactly as it is left out there. Omitted → the weekday rule only.
     */
    holidays?: CallRateHolidays;
    /**
     * What the cheap model read of the fragments the rules could not, keyed by fragment.
     *
     * Omitted → the rules' answer, unchanged, which is what every caller got before 2026-09-02 and
     * what every caller still gets when the assist is unavailable. The drill-down is correct
     * without this; it is only less complete.
     */
    assisted?: ReadonlyMap<string, CampaignAssistReading>;
    /** Who is reading — see `toRepVisitRow`. Omitted → no Phoenix half on any row. */
    viewer?: PhoenixDetailViewer;
  },
): { rows: RepVisitRow[]; summary: RepVisitsSummary } {
  const checkinIndex = indexCheckinsByAgentContactDay(checkins);
  const rows = sortRepVisitRows(
    visits.map((visit) =>
      toRepVisitRow(
        visit,
        checkinIndex,
        options.territoryIndex,
        options.partnerNameByHrId,
        options.contactDirectory,
        options.assisted,
        options.holidays,
        options.viewer,
      ),
    ),
  );
  return { rows, summary: summarizeRepVisits(rows) };
}

/**
 * Is this row a CALL, or a day the rep was not calling?
 *
 * The single question the whole page is split on. Leave, public holidays, meetings, training and
 * admin days all arrive down the same CRM feed as a visit, with a date, an AM/PM flag and a comment
 * — and a public holiday sitting in a list headed "visits" reads as a visit. OWNER'S RULE,
 * 2026-08-28: separate them. Everything downstream — the two lists, the export, the summary strip,
 * the doctor label — asks this one function rather than re-deriving it, so they cannot disagree.
 */
export function isFieldWork(row: RepVisitRow): boolean {
  return row.standing !== "excluded";
}

/**
 * Split a rep's month into the calls and the days off, in one pass.
 *
 * Returned as two arrays rather than a filter at each call site, so nothing can render a list built
 * from a different predicate than the one the summary counted.
 */
export function partitionRepVisitRows(rows: readonly RepVisitRow[]): {
  fieldRows: RepVisitRow[];
  offDutyRows: RepVisitRow[];
} {
  const fieldRows: RepVisitRow[] = [];
  const offDutyRows: RepVisitRow[] = [];
  for (const row of rows) (isFieldWork(row) ? fieldRows : offDutyRows).push(row);
  return { fieldRows, offDutyRows };
}

/**
 * What a non-calling day actually was, in the rep's own words.
 *
 * The comment on a leave row is the reason ("اجازة بمناسبة المولد النبوي الشريف" — Prophet's
 * Birthday). It is genuinely useful, so it is shown — under its own "Reason" label, in its own list,
 * never in a column headed Doctor.
 */
export function offDutyReason(row: RepVisitRow): string | null {
  const reason = row.comment?.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).join(" · ");
  return reason ? reason : null;
}

/** Human labels, said once so the table, the cards and the export cannot drift apart. */
export const REP_VISIT_STANDING_LABELS: ReadonlyMap<RepVisitStanding, string> = new Map<RepVisitStanding, string>([
  ["verified", "Proved"],
  ["unverified", "No proof"],
  ["campaign", "Campaign"],
  ["excluded", "Not field work"],
]);

/**
 * Why a listed call is not in the rate, in words — or null when it is. The table, the card and the
 * export all read this, so the three cannot word it differently (an export must match the screen).
 * The weekday is NAMED, because "Thursday" answers the reader's next question and "weekend" does not.
 */
export function unscoredLabel(row: RepVisitRow): string | null {
  if (row.unscored === "catch-all") return "Not scored · the CRM's catch-all contact, not a doctor";
  if (row.unscored === "holiday") return "Not scored · public holiday";
  // Phoenix CRM's own words for the same visit ("not counting yet"), never a doubt about the visit.
  if (row.unscored === "not-validated") return "Not scored · customer not validated yet";
  if (row.unscored === "weekend") {
    const weekday = /^\d{4}-\d{2}-\d{2}$/.test(row.dateIso) ? new Date(`${row.dateIso}T00:00:00Z`).getUTCDay() : null;
    return weekday === 4 ? "Not scored · Thursday" : weekday === 5 ? "Not scored · Friday" : "Not scored · not a working day";
  }
  return null;
}

export const REP_VISIT_SESSION_LABELS: ReadonlyMap<CallSession, string> = new Map<CallSession, string>([
  ["am", "AM"],
  ["pm", "PM"],
  ["unspecified", "—"],
]);

/**
 * WHO was seen, as one readable string.
 *
 * A CAMPAIGN call is a visit to a REAL doctor who is not on the rep's registered contact list —
 * the owner's own words, 2026-08-28 — so the CRM has no contact record to point at and sends
 * `contact_crm_id: 0`. It is not an empty visit, and printing "no contact" of it says the rep saw
 * nobody, which is false.
 *
 * The only record of who was seen is the COMMENT, and it is always there: all 1,779 August campaign
 * rows in production carry one, while contact name, customer name, speciality and region are empty
 * on every single one. So the comment is what this shows. Measured on those 1,779: 863 name a doctor
 * (many with speciality and visiting hours), 229 a pharmacy, 57 a hospital, 29 a store or company,
 * 580 something else, and 21 are not visits at all ("Interviews", "Sales day").
 *
 * Newlines are folded to " · " rather than cut: the second line is usually the doctor's visiting
 * hours or what he promised to prescribe, which is the most valuable thing in the row. Nothing is
 * truncated and nothing wraps (owner's standing rule) — the cell is nowrap and the table scrolls.
 */
export function campaignReadingOf(row: RepVisitRow): CampaignNoteReading | null {
  if (row.bucket !== "campaign" || row.contactName) return null;
  return readCampaignNote(row.comment);
}

export function contactLabel(row: RepVisitRow): string {
  // A day off has no doctor. Its comment is the leave reason — "اجازة بمناسبة المولد النبوي الشريف"
  // — and letting that fall through to the doctor's name puts a public holiday in the same column as
  // a clinic call, which reads as a visit. OWNER'S RULE, 2026-08-28: vacations and visits are kept
  // apart. The screen separates them into two lists; this line is the guard that makes it impossible
  // for a leave row to be labelled as a person even if one ever reaches the visit table again.
  if (!isFieldWork(row)) return row.visitTypeLabel;
  if (row.contactName) return row.contactName;
  // WHO, pulled out of the sentence — the doctor's name alone, or the place when the rep named no
  // person (the owner's own first example: a hospital with its address inside its name). The
  // speciality and the clinic have their own columns now, so repeating them here would print the
  // same words three times in one row.
  const headline = campaignHeadline(readCampaignNote(row.comment));
  if (headline) return headline;
  // Nothing the parser could resolve. The rep's own words, whole and unaltered, are still a better
  // answer than "No contact recorded" — 15.2% of production's campaign notes land here, and every
  // one of them is something a human reads instantly.
  const prospect = row.comment?.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).join(" · ");
  if (prospect) return prospect;
  if (row.contactCrmId != null) return `Contact ${row.contactCrmId}`;
  return "No contact recorded";
}

/**
 * True when the person seen is named only by the rep's own free text — a prospect, not a record.
 *
 * Drives the marker beside the name. THIS IS THE ONE PLACE IN THE DRILL-DOWN THAT IS STILL FREE
 * TEXT, and it is marked as such rather than dressed up as a resolved contact.
 */
export function isProspectRow(row: RepVisitRow): boolean {
  // CAMPAIGN ONLY. Leave, meetings and training rows also arrive with no contact and often with a
  // comment ("Sales day", "Interviews"), and marking one of those "a doctor not on his list" would
  // invent a prospecting call out of a day off.
  //
  // AND ONLY WHEN IT IS TRUE. `knownContact` means the doctor was found on a registered list, so
  // "not on his list" is a false statement about him and the row says something else instead. This
  // is the whole point of the match: 3,126 of production's campaign visits were labelled prospects
  // while the rep was visiting that same doctor on his normal rounds.
  return (
    row.bucket === "campaign" &&
    !row.contactName &&
    !row.contactCrmId &&
    !row.knownContact &&
    Boolean(row.comment?.trim())
  );
}

/**
 * The territory, as one readable string.
 *
 * Shared by the desktop cell, the mobile card and the export, because the owner's standing rule is
 * that an export must MATCH the screen. Never returns an empty string — an unmapped region still
 * names itself, so the reader always sees WHERE the visit was even when the map cannot place it.
 */
export function territoryLabel(row: RepVisitRow): string {
  if (row.territory.status === "mapped") {
    const parts = [row.territory.brickName ?? row.territory.brickId, row.territory.areaName, row.territory.regionName];
    return parts.filter((part): part is string => Boolean(part)).join(" · ");
  }
  if (row.territory.status === "unmapped") return row.crmRegionName ?? `CRM region ${row.crmRegionId ?? ""}`.trim();
  return "No region recorded";
}
