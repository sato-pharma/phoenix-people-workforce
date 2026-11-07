// Recruitment / Medical Rep hiring — every Medical Rep candidate with everything their step is
// worked out from, in one read.
//
// SERVER ONLY. Reaches the database with the service-role client; whoever calls it has already been
// gated (access.ts), and the salary it returns is stripped for anyone who may not see it before it
// leaves the server (`redactRecommendationsFor` in access.ts) — never hidden in the browser.
//
// WHO IS A MEDICAL REP CANDIDATE. The workspace's own filing: a placement in the `medical_rep` tab,
// plus a candidate who declared the Medical Rep role and is not filed in any tab yet (measured
// 7 Nov 2026: 98 filed and 14 such declared-only candidates in the 30 days before). Archived
// candidates are left out, as the workspace leaves them out.
//
// CVs FROM 7 NOVEMBER ONLY. A candidate received before Saturday 7 November 2026 00:00 Cairo is not in
// the workflow: the page does not list them, their journey is not offered, and no step can be recorded
// or booked for them — they finish in the workspace as before (owner, 7 Nov 2026: "all the cvs recieved
// starting from 7 nov"). Without it the page listed 54 candidates the old flow had already shortlisted
// or sent to a manager as "Screen the CV".
//
// NEVER STOPS AT A PAGE. Every list read goes through `fetchAllRows` and every id filter through
// `fetchRowsInBatches`, so a growing table can never return a silently short answer.

import { chunkIds, fetchRowsInBatches } from "@/lib/recruitment/db-batch";
import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { recruitmentDb } from "@/lib/recruitment/db";
import { loadPeople, personName } from "@/lib/recruitment/interview-calendar";
import { loadPediaAreasUnderRsm, mrFoldAreaName } from "@/lib/recruitment/mr-hiring/area-manager";
import type { MrIntakeEventFact } from "@/lib/recruitment/mr-hiring/official-line";
import { isOfficialWhatsAppEvent, officialLineIds } from "@/lib/recruitment/mr-hiring/official-line";
import {
  mrConfirmedArea,
  mrConfirmedLine,
  type MrBookingFact,
  type MrCandidateFacts,
  type MrOfferFact,
  type MrRecommendationFact,
  type MrStepResultFact,
} from "@/lib/recruitment/mr-hiring/stage";
import {
  isInMrWorkflow,
  isMrInterviewRound,
  isMrLine,
  type MrLine,
  isMrRecommendation,
  isMrResult,
  isMrResultStep,
} from "@/lib/recruitment/mr-hiring/vocabulary";
import { isIsoDate, parseLetterDate } from "@/lib/offers/dates";
import { fetchAllRows } from "@/lib/supabase/paginated";

export const MR_ROLE_TAB = "medical_rep";
export const MR_ROLE_FAMILY = "medical_rep";

/** Everything a row on the page, the drawer and the portal section needs about one candidate. */
export type MrCandidateRecord = {
  facts: MrCandidateFacts;
  name: string;
  governorate: string | null;
  /**
   * The area HR confirmed at the 1st interview; before that, the area the candidate is filed under, or
   * the one they asked for.
   */
  area: string | null;
  /** The line HR confirmed at the 1st interview, or null before it. */
  line: MrLine | null;
  source: string | null;
  offerId: string | null;
  intake: MrIntakeEventFact[];
  /** Every interview booked for the candidate, with who is on it, for the access checks. */
  bookingPeople: Array<{ bookingId: string; round: string | null; hrIds: string[] }>;
  /** The manager the CV was last sent to, by the name stored at send time. */
  sentToName: string | null;
  sentToHrId: string | null;
};

type CandidateRow = {
  id: string;
  full_name: string | null;
  status: string | null;
  created_at: string;
  governorate: string | null;
  preferred_area_name: string | null;
  source: string | null;
  offer_id: string | null;
  manager_notified_hr_id: string | null;
  manager_notified_name: string | null;
  archived_at: string | null;
};

type PlacementRow = { candidate_id: string; area_name: string | null; role_tab: string };

type BookingRow = {
  id: string;
  candidate_id: string | null;
  interview_round: string | null;
  starts_at: string;
  duration_minutes: number | null;
  platform: string | null;
  location: string | null;
  zoom_join_url: string | null;
  outcome: string | null;
  interviewer_hr_id: string | null;
  panelist_hr_ids: string[] | null;
  shared_with_hr_ids: string[] | null;
};

type ResultRow = {
  id: number | string;
  candidate_id: string;
  booking_id: string | null;
  step: string;
  result: string;
  rating: number | null;
  comment: string;
  decided_without_dsm: boolean | null;
  confirmed_area_name: string | null;
  confirmed_line: string | null;
  by_hr_id: string;
  created_at: string;
};

type RecommendationRow = {
  id: number | string;
  candidate_id: string;
  booking_id: string | null;
  recommendation: string;
  proposed_salary: number | string | null;
  proposed_joining_date: string | null;
  note: string | null;
  by_hr_id: string;
  created_at: string;
};

type OfferRow = { id: string; status: string | null; date_of_issue: string | null; valid_until: string | null; start_date: string | null };

type IntakeRow = { candidate_id: string | null; channel: string | null; delivered: string | null; created_at: string };

const CANDIDATE_COLUMNS =
  "id,full_name,status,created_at,governorate,preferred_area_name,source,offer_id,manager_notified_hr_id,manager_notified_name,archived_at";
const BOOKING_COLUMNS =
  "id,candidate_id,interview_round,starts_at,duration_minutes,platform,location,zoom_join_url,outcome,interviewer_hr_id,panelist_hr_ids,shared_with_hr_ids";
const RESULT_COLUMNS =
  "id,candidate_id,booking_id,step,result,rating,comment,decided_without_dsm,confirmed_area_name,confirmed_line,by_hr_id,created_at";
const RECOMMENDATION_COLUMNS = "id,candidate_id,booking_id,recommendation,proposed_salary,proposed_joining_date,note,by_hr_id,created_at";

/** An offer's free-text date as YYYY-MM-DD, or null when it cannot be read. */
function offerDay(value: string | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return isIsoDate(text) ? text : parseLetterDate(text);
}

function offerStatus(value: string | null): MrOfferFact["status"] {
  const text = String(value ?? "").toLowerCase();
  return text === "sent" || text === "accepted" || text === "declined" || text === "withdrawn" ? text : "draft";
}

/** The ids of every Medical Rep candidate, or of the given ones that are Medical Rep candidates. */
async function medicalRepCandidateIds(only: readonly string[] | null): Promise<{ ids: string[]; areaById: Map<string, string | null> }> {
  const placements = only
    ? await fetchRowsInBatches<PlacementRow>(only, (batch) =>
        recruitmentDb().from("ats_candidate_placements").select("candidate_id,area_name,role_tab").in("candidate_id", batch),
      )
    : await fetchAllRows<PlacementRow>(
        () => recruitmentDb().from("ats_candidate_placements").select("candidate_id,area_name,role_tab").eq("role_tab", MR_ROLE_TAB),
        "id",
      );
  const areaById = new Map<string, string | null>();
  const placedAnywhere = new Set<string>();
  for (const row of placements) {
    placedAnywhere.add(row.candidate_id);
    if (row.role_tab === MR_ROLE_TAB && !areaById.get(row.candidate_id)) areaById.set(row.candidate_id, row.area_name ?? null);
  }

  const declared = only
    ? await fetchRowsInBatches<{ id: string }>(only, (batch) =>
        recruitmentDb().from("ats_candidates").select("id").eq("declared_role_family", MR_ROLE_FAMILY).in("id", batch),
      )
    : await fetchAllRows<{ id: string }>(
        () => recruitmentDb().from("ats_candidates").select("id").eq("declared_role_family", MR_ROLE_FAMILY).is("archived_at", null),
        "id",
      );
  // A declared Medical Rep who is filed somewhere is in THAT tab — filed elsewhere is somebody's decision.
  const declaredIds = declared.map((row) => row.id);
  if (!only && declaredIds.length > 0) {
    const theirPlacements = await fetchRowsInBatches<{ candidate_id: string }>(declaredIds, (batch) =>
      recruitmentDb().from("ats_candidate_placements").select("candidate_id").in("candidate_id", batch),
    );
    for (const row of theirPlacements) placedAnywhere.add(row.candidate_id);
  }
  const ids = new Set(areaById.keys());
  for (const id of declaredIds) if (!placedAnywhere.has(id)) ids.add(id);
  return { areaById, ids: Array.from(ids) };
}

/**
 * Every Medical Rep candidate received from the start of the workflow (or just the given ones, when
 * they are such candidates), newest CV first. Archived candidates are left out.
 */
export async function loadMrCandidates(options: { candidateIds?: readonly string[] } = {}): Promise<MrCandidateRecord[]> {
  const only = options.candidateIds ? Array.from(new Set(options.candidateIds.filter(Boolean))) : null;
  if (only && only.length === 0) return [];
  const { ids, areaById } = await medicalRepCandidateIds(only);
  if (ids.length === 0) return [];

  const [candidates, bookings, results, recommendations, intake] = await Promise.all([
    fetchRowsInBatches<CandidateRow>(ids, (batch) => recruitmentDb().from("ats_candidates").select(CANDIDATE_COLUMNS).in("id", batch)),
    fetchRowsInBatches<BookingRow>(ids, (batch) => recruitmentDb().from("ats_interview_bookings").select(BOOKING_COLUMNS).in("candidate_id", batch)),
    fetchRowsInBatches<ResultRow>(ids, (batch) => recruitmentDb().from("ats_mr_hiring_step_results").select(RESULT_COLUMNS).in("candidate_id", batch)),
    fetchRowsInBatches<RecommendationRow>(ids, (batch) =>
      recruitmentDb().from("ats_mr_hiring_recommendations").select(RECOMMENDATION_COLUMNS).in("candidate_id", batch),
    ),
    fetchRowsInBatches<IntakeRow>(ids, (batch) =>
      recruitmentDb()
        .from("ats_cv_intake_events")
        .select("candidate_id,channel,delivered:raw_metadata->>deliveredToPhoneNumberId,created_at")
        .in("candidate_id", batch),
    ),
  ]);

  const live = candidates.filter((row) => !row.archived_at && isInMrWorkflow(row.created_at));
  const offerIds = Array.from(new Set(live.map((row) => row.offer_id).filter((id): id is string => Boolean(id))));
  const offers = offerIds.length
    ? await fetchRowsInBatches<OfferRow>(offerIds, (batch) =>
        recruitmentDb().from("offers").select("id,status,date_of_issue,valid_until,start_date").in("id", batch),
      )
    : [];
  const offerById = new Map(offers.map((row) => [row.id, row]));

  const people = await loadPeople([
    ...bookings.map((row) => row.interviewer_hr_id),
    ...results.map((row) => row.by_hr_id),
    ...recommendations.map((row) => row.by_hr_id),
  ]);

  const byCandidate = <T extends { candidate_id: string | null }>(rows: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.candidate_id) continue;
      const list = map.get(row.candidate_id) ?? [];
      list.push(row);
      map.set(row.candidate_id, list);
    }
    return map;
  };
  const bookingsOf = byCandidate(bookings);
  const resultsOf = byCandidate(results);
  const recommendationsOf = byCandidate(recommendations);
  const intakeOf = byCandidate(intake);
  const official = officialLineIds();

  const records = live.map((row): MrCandidateRecord => {
    const candidateBookings = bookingsOf.get(row.id) ?? [];
    const events: MrIntakeEventFact[] = (intakeOf.get(row.id) ?? []).map((event) => ({
      candidateId: row.id,
      channel: event.channel,
      createdAt: event.created_at,
      deliveredToPhoneNumberId: event.delivered ?? null,
    }));
    const offerRow = row.offer_id ? offerById.get(row.offer_id) : undefined;
    const facts: MrCandidateFacts = {
      bookings: candidateBookings.map(
        (booking): MrBookingFact => ({
          durationMinutes: Number(booking.duration_minutes ?? 30),
          id: booking.id,
          interviewerHrId: booking.interviewer_hr_id,
          interviewerName: personName(people, booking.interviewer_hr_id),
          location: booking.location,
          outcome: booking.outcome,
          panelistHrIds: booking.panelist_hr_ids ?? [],
          platform: booking.platform === "zoom" ? "zoom" : booking.platform === "phone" ? "phone" : "in_office",
          round: isMrInterviewRound(booking.interview_round) ? booking.interview_round : null,
          startsAt: booking.starts_at,
          zoomJoinUrl: booking.zoom_join_url,
        }),
      ),
      candidateId: row.id,
      offer: offerRow
        ? {
            id: offerRow.id,
            issuedOn: offerDay(offerRow.date_of_issue),
            startDate: offerDay(offerRow.start_date),
            status: offerStatus(offerRow.status),
            validUntil: offerDay(offerRow.valid_until),
          }
        : null,
      onOfficialLine: events.some((event) => isOfficialWhatsAppEvent(event, official)),
      // Filled in below, from the organogram, once every candidate's confirmed area is known.
      pediaAreaUnderRsm: false,
      receivedAt: row.created_at,
      recommendations: (recommendationsOf.get(row.id) ?? [])
        .filter((rec) => isMrRecommendation(rec.recommendation))
        .map(
          (rec): MrRecommendationFact => ({
            bookingId: rec.booking_id,
            byHrId: rec.by_hr_id,
            byName: personName(people, rec.by_hr_id),
            createdAt: rec.created_at,
            id: String(rec.id),
            note: rec.note,
            proposedJoiningDate: rec.proposed_joining_date,
            proposedSalary: rec.proposed_salary === null ? null : Number(rec.proposed_salary),
            recommendation: rec.recommendation as MrRecommendationFact["recommendation"],
          }),
        ),
      results: (resultsOf.get(row.id) ?? [])
        .filter((result) => isMrResultStep(result.step) && isMrResult(result.result))
        .map(
          (result): MrStepResultFact => ({
            bookingId: result.booking_id,
            byHrId: result.by_hr_id,
            byName: personName(people, result.by_hr_id),
            comment: result.comment,
            confirmedArea: result.confirmed_area_name,
            confirmedLine: isMrLine(result.confirmed_line) ? result.confirmed_line : null,
            createdAt: result.created_at,
            decidedWithoutDsm: Boolean(result.decided_without_dsm),
            id: String(result.id),
            rating: result.rating,
            result: result.result as MrStepResultFact["result"],
            step: result.step as MrStepResultFact["step"],
          }),
        ),
      status: normalizeCandidateStatus(row.status) ?? "new",
    };
    return {
      // What HR confirmed at the 1st interview wins over the filing and over the area asked for.
      area: mrConfirmedArea(facts) ?? areaById.get(row.id) ?? row.preferred_area_name ?? null,
      bookingPeople: candidateBookings.map((booking) => ({
        bookingId: booking.id,
        hrIds: [booking.interviewer_hr_id, ...(booking.panelist_hr_ids ?? []), ...(booking.shared_with_hr_ids ?? [])].filter(
          (id): id is string => Boolean(id),
        ),
        round: booking.interview_round,
      })),
      facts,
      governorate: row.governorate,
      intake: events,
      line: mrConfirmedLine(facts),
      name: String(row.full_name ?? "").trim() || "Unnamed candidate",
      offerId: row.offer_id,
      sentToHrId: row.manager_notified_hr_id,
      sentToName: row.manager_notified_name,
      source: row.source,
    };
  });

  // The RSM interview is only for a Pedia candidate inside the regional manager's regions (owner,
  // 7 Nov 2026) — one organogram read for every confirmed Pedia area on the page.
  const pediaAreas = records.flatMap((record) => (record.line === "pedia" && record.area ? [record.area] : []));
  if (pediaAreas.length > 0) {
    const underRsm = await loadPediaAreasUnderRsm(pediaAreas);
    for (const record of records) {
      record.facts.pediaAreaUnderRsm = record.line === "pedia" && Boolean(record.area) && underRsm.has(mrFoldAreaName(record.area!));
    }
  }

  return records.sort((left, right) => right.facts.receivedAt.localeCompare(left.facts.receivedAt));
}

/** One Medical Rep candidate, or null when the id is not one. */
export async function loadMrCandidate(candidateId: string): Promise<MrCandidateRecord | null> {
  const [record] = await loadMrCandidates({ candidateIds: [candidateId] });
  return record ?? null;
}

/** The ids of the candidates whose interviews this person is on, as lead, panel or shared manager. */
export async function mrCandidateIdsInterviewedBy(hrIdKeys: readonly string[]): Promise<string[]> {
  if (hrIdKeys.length === 0) return [];
  const ids = new Set<string>();
  for (const batch of chunkIds([...hrIdKeys])) {
    const [lead, panel, shared] = await Promise.all([
      fetchAllRows<{ candidate_id: string | null }>(
        () => recruitmentDb().from("ats_interview_bookings").select("candidate_id").not("interview_round", "is", null).in("interviewer_hr_id", batch),
        "id",
      ),
      fetchAllRows<{ candidate_id: string | null }>(
        () => recruitmentDb().from("ats_interview_bookings").select("candidate_id").not("interview_round", "is", null).overlaps("panelist_hr_ids", batch),
        "id",
      ),
      fetchAllRows<{ candidate_id: string | null }>(
        () => recruitmentDb().from("ats_interview_bookings").select("candidate_id").not("interview_round", "is", null).overlaps("shared_with_hr_ids", batch),
        "id",
      ),
    ]);
    for (const row of [...lead, ...panel, ...shared]) if (row.candidate_id) ids.add(row.candidate_id);
  }
  return Array.from(ids);
}
