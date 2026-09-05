// Recruitment / ATS — everything the screening workstation renders, resolved on the server.
//
// ── WHY A SECOND LOADER ─────────────────────────────────────────────────────────────────────────
//
// `screening-queue.ts` hands the browser the whole `Candidate[]`. That type carries ~60 columns
// including `positionSpecificFields` — the repeating CV blocks: work history, education history,
// certifications, skills, languages — so opening the screening page ships every applicant's entire
// parsed CV to the client in order to draw a list of names. The workstation shows a candidate list
// beside a CV, so it needs the list to be cheap and the CV to be lazy, which is the exact opposite
// of that shape.
//
// So this loader returns a ROW: the twenty-odd values the list and the header actually print. The
// full profile — every field, the files, the applications, the interviews — is fetched for the ONE
// candidate on screen through the route that already exists (`GET /api/recruitment/candidates/{id}`,
// which the session prefetches the next candidate through), and never for the other 743.
//
// AND IT NO LONGER READS THEM EITHER. Until 2026-09-05 the slimming stopped at the browser: the
// database read was still `select("*")`, so the repeating blocks were pulled Frankfurt to Amsterdam
// on every load and every filter change and then thrown away — 1,221 kB of the 2,053 kB moved, for
// nothing. It now asks for the columns it maps and leaves that one out.
//
// ── EVERY DERIVED VALUE IS DERIVED ONCE, HERE ───────────────────────────────────────────────────
//
// The band, the role family, the region, the duplicate key, the work-queue membership, the vacancy
// attribution and the role-fit read all come off the SAME functions the existing screening session
// uses — imported, never re-implemented. That is the whole reason `screening-describe.ts` exists:
// two screens that order one pool by two copies of a rule will eventually disagree about who is at
// the top of the queue, with nothing on either screen to say which one is right.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────────
//
// It writes nothing, it hides nothing a filter did not ask it to hide, and it invents no facts: a
// row whose CV was never read comes back with nulls, which the list renders as "not on file"
// rather than as a zero.
//
// SERVER ONLY. Reaches the database; the pure halves it depends on are all importable by clients.

import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { candidateRedFlagsFor } from "@/lib/recruitment/red-flag";
import { candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateScreeningFacts, formatYearsOfExperience } from "@/lib/recruitment/candidate-screening-facts";
import { describeForOrder } from "@/lib/recruitment/screening-describe";
import { duplicateSets, orderForScreening, screeningBand } from "@/lib/recruitment/screening-order";
import { isFiledCandidate } from "@/lib/recruitment/candidate-folder";
import { listCandidateIdsWithInterviewToday } from "@/lib/recruitment/interviews";
import {
  listCandidateViews,
  listOtherViewersByCandidate,
  resolveViewerNames,
} from "@/lib/recruitment/candidate-views";
import { listCandidates, loadDecisionHistory, loadRowFindings } from "@/lib/recruitment/candidates";
import { countRowFindings } from "@/lib/recruitment/cv-findings";
import { buildThroughput, type ThroughputSummary } from "@/lib/recruitment/candidate-throughput";
import { listHiringManagerOptions, type HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import {
  listOpenVacancyOptions,
  listUsedPositionText,
  type VacancyOption,
} from "@/lib/recruitment/vacancy-options";
import { matchesScreeningNarrowing, screeningAreaOptions, screeningSourceOptions } from "@/lib/recruitment/screening-filter";
import { normalizeCandidateStatus, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import { normalizeNameForMatch, normalizePhone } from "@/lib/recruitment/candidate-matching";
import {
  parseScreeningFilters,
  type ScreeningNotifiedFilter,
  type ScreeningQueueFilters,
  type ScreeningReceivedFilter,
  type ScreeningRegionFilter,
  type ScreeningRoleFilter,
  type ScreeningSeenFilter,
} from "@/lib/recruitment/screening-link";
import { intakeSourceLabel } from "@/lib/recruitment/intake-source";
import { positionFolderLabel } from "@/lib/recruitment/position-folder";
import { hiringTargetFamily, readRoleFit, roleFitVerdict } from "@/lib/recruitment/role-fit";
import {
  emptyWorkQueueCounts,
  tallyWorkQueues,
  workQueuesFor,
  type WorkQueueCounts,
  type WorkQueueInput,
} from "@/lib/recruitment/screening-queues";
import { summarizeCommentsByCandidate } from "@/lib/recruitment/candidate-comments";
import {
  tallyVacancyApplicants,
  vacanciesForCandidate,
  type VacancyApplicantStats,
} from "@/lib/recruitment/vacancy-applicants";
import type { CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import type { Candidate } from "@/lib/recruitment/types";

import type { DuplicateReason, WorkspaceCandidateRow } from "@/lib/recruitment/screening-workspace-types";

export type {
  DuplicateReason,
  RowFact,
  WorkspaceCandidateRow,
  WorkspaceManager,
  WorkspaceVacancy,
} from "@/lib/recruitment/screening-workspace-types";

export type ScreeningWorkspace = {
  rows: WorkspaceCandidateRow[];
  counts: WorkQueueCounts;
  /** Of the pending manager sends, how many are past the nudge threshold. Beside, never instead. */
  overdueManagerFeedback: number;
  vacancies: VacancyOption[];
  vacancyStats: VacancyApplicantStats[];
  hiringManagers: HiringManagerOption[];
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  areaOptions: string[];
  sourceOptions: string[];
  /** How many the URL filters dropped, so the page can say so instead of silently shrinking. */
  filteredOut: number;
  /** The whole live pool, before the URL filters. The denominator every count is honest about. */
  poolSize: number;
  /**
   * Is the backlog growing or shrinking, in the only terms that matter — CVs in against CVs decided,
   * over four weeks rather than one.
   *
   * The rail could say how big each pile is and nothing could say whether the reader is winning.
   * Measured 2026-09-05: 597 in the pool, 438 never opened by anybody, 153 arrived in seven days
   * against an average 12.8 days to a first decision. The queue was correct and losing, and no
   * number on the page said so.
   *
   * THE COUNTING MOVED, AND SO DID THE COST. The first version of this read the pool's own status
   * stamps, which cost no extra round trip and was wrong in both directions once measured against
   * the real history: it counted a re-decision as this week's output (93 against a true 71) and lost
   * older decisions whose only stamp had moved forward (140 against a true 216 over thirty days). A
   * single week's figure survives that; a trend built on it draws a confident line out of an
   * artefact. It now costs one extra read of the decision history — see loadDecisionHistory, and
   * candidate-throughput.ts for the arithmetic and for why an uncovered span reads as unknown
   * rather than as zero.
   */
  throughput: ThroughputSummary;
  canSendToManagers: boolean;

  seen: ScreeningSeenFilter;
  notified: ScreeningNotifiedFilter;
  status: CandidateStatus | null;
  area: string | null;
  role: ScreeningRoleFilter | null;
  region: ScreeningRegionFilter | null;
  received: ScreeningReceivedFilter | null;
  source: string | null;
};

function text(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * When somebody answered a send, or null while it is still open.
 *
 * TWO SOURCES, both real. A comment written after the send is a manager saying something about the
 * CV; a status move after the send is a decision recorded against it. Either closes the pile.
 *
 * Keyed on the SEND STAMP rather than on the status alone, because production carries sends whose
 * status was later moved by hand — and a pile that empties because somebody re-labelled a row is a
 * pile that has lost the candidate it was tracking. It is also why a comment written BEFORE the
 * send does not count: it is not an answer to a question that had not been asked yet.
 */
function answeredAtFor(
  candidate: Candidate,
  sentAt: string | null,
  latestCommentAt: string | null,
): string | null {
  if (!sentAt) return null;
  const answers: string[] = [];
  if (latestCommentAt && latestCommentAt > sentAt) answers.push(latestCommentAt);
  const movedAt = text(candidate.statusChangedAt);
  // `sent_to_manager` is the status the send itself sets, so a move INTO it is the send, not a
  // reply. Only a move to something else counts.
  if (movedAt && movedAt > sentAt && normalizeCandidateStatus(candidate.status) !== "sent_to_manager") {
    answers.push(movedAt);
  }
  if (answers.length === 0) return null;
  return answers.sort()[0] ?? null;
}

/** Where this person is, in the words the list should print. Their answer first, the CV second. */
function locationOf(
  facts: ReturnType<typeof candidateScreeningFacts>,
): { declared: boolean; label: string | null; regionCode: CandidateRegionCode | null } {
  if (facts.area) return { declared: true, label: facts.area.value, regionCode: null };
  const region = facts.region;
  if (!region) return { declared: false, label: null, regionCode: null };
  const code = region.value.code;
  return {
    declared: region.value.declared,
    label: region.value.label,
    regionCode: code && code in candidateRegionLabels ? (code as CandidateRegionCode) : null,
  };
}

/**
 * Load the workstation for one screener, narrowed by the link they followed.
 *
 * The view map is loaded for the CALLER, never for an HR_ID in the URL — "have I seen this" is a
 * question about the person asking, and a viewer id in a query string would let one person open a
 * link that reports somebody else's reading as their own. Same rule, same reason, as the queue
 * loader this replaces on the workstation route.
 *
 * The manager list and the vacancy list are loaded only when the caller holds `recruitment: update`,
 * because both exist to feed a send the route would otherwise answer 403 to. `canSendToManagers` is
 * the one thing the pages must still decide, since only they hold the AccessContext.
 */
export async function loadScreeningWorkspace(
  viewerHrId: string | null | undefined,
  filters: ScreeningQueueFilters = {},
  options: { canSendToManagers?: boolean } = {},
): Promise<ScreeningWorkspace> {
  const canSendToManagers = Boolean(options.canSendToManagers);

  // Fired together, not in sequence: six of these seven are independent, and awaiting them one at a
  // time is the difference between one round trip and seven on a page that is already the slowest in
  // the module.
  const [
    allCandidates,
    views,
    otherViewers,
    hiringManagers,
    openVacancies,
    positionSuggestions,
    interviewToday,
    decisionHistory,
    rowFindings,
  ] = await Promise.all([
    // WITHOUT the repeating CV blocks. Nothing below reads them, and on production they are 59%
    // of the bytes this read moves — see CANDIDATE_COLUMNS_WITHOUT_REPEATING_BLOCKS.
    listCandidates({ withRepeatingCvBlocks: false }),
    listCandidateViews(viewerHrId),
    // Who ELSE has opened each CV. A separate read from the caller's own map, deliberately — see
    // listOtherViewersByCandidate for why the two facts must not be merged.
    listOtherViewersByCandidate(viewerHrId),
    canSendToManagers ? listHiringManagerOptions() : Promise.resolve<HiringManagerOption[]>([]),
    canSendToManagers ? listOpenVacancyOptions() : Promise.resolve<VacancyOption[]>([]),
    canSendToManagers
      ? listUsedPositionText()
      : Promise.resolve<{ jobTitles: string[]; areas: string[] }>({ areas: [], jobTitles: [] }),
    listCandidateIdsWithInterviewToday(),
    // The decision history, for the throughput trend. A separate read because the pool's own status
    // stamps cannot answer "when was this candidate FIRST decided" — they hold only the latest move.
    loadDecisionHistory(),
    // Three CV findings per candidate, projected rather than read whole — 105 kB against the
    // 1,549 kB the full extraction blob would cost. See loadRowFindings.
    loadRowFindings(),
  ]);

  // A shelved CV leaves the workstation exactly as it leaves the queue: the whole purpose of the
  // shelf is that a good-but-not-now CV stops being offered for review again. Taken off BEFORE
  // `filteredOut` is counted, so that number means the filters and never the archive.
  const pool = allCandidates.filter((candidate) => !isFiledCandidate(candidate));

  // WHO HAS THIS CV is already resolved — listCandidates overlays the send trail onto every
  // candidate it returns, so `managerNotified` and `sentFor` are the newest of (row stamp, send
  // trail) before this function sees them. This loader used to do that overlay itself, which meant
  // the pool and this page answered "was it sent, and to whom" from different sources. One rule,
  // one place: src/lib/recruitment/candidates.ts.
  // The other SCREENERS, not the pool — a tiny set by construction, so one targeted read names them
  // all. A raw HR_ID must never reach a screen (owner's standing rule), and a viewer with no
  // employee row keeps their id rather than being given an invented name.
  //
  // Together with the comments: neither reads the other, and this page already waits on one Atlantic
  // round trip more than it should.
  const [comments, viewerNames] = await Promise.all([
    summarizeCommentsByCandidate(pool.map((candidate) => candidate.id)),
    resolveViewerNames([...otherViewers.values()].flat()),
  ]);

  // Stamped once. This is a `force-dynamic` page, so one `Date.now()` here is the same instant every
  // "how recently" question is measured against — a second reading mid-loop would let two rows on
  // one screen disagree about what "today" means.
  const now = new Date();
  const asOf = now.getTime();

  const narrowing = parseScreeningFilters(filters);

  // Duplicate SETS over the whole live pool, never over the filtered view: "2 CVs from this number"
  // must stay true when one of the two is filtered out of sight, or the warning quietly becomes a
  // lie at exactly the moment a recruiter narrows down to act on it.
  const twins = duplicateSets(pool, describeForOrder);

  // The same pool indexed by NORMALIZED NAME — the second half of the rule the candidate pool has
  // always used. Built over the whole live pool for the reason the phone index is: a pair that stops
  // being reported the moment one of the two is filtered out of sight is a warning that quietly
  // becomes a lie at exactly the moment a recruiter narrows down to act on it.
  const nameTwins = new Map<string, Candidate[]>();
  for (const candidate of pool) {
    const key = normalizeNameForMatch(candidate.fullName);
    if (!key) continue;
    const group = nameTwins.get(key);
    if (group) group.push(candidate);
    else nameTwins.set(key, [candidate]);
  }
  for (const [key, group] of nameTwins) if (group.length < 2) nameTwins.delete(key);

  const rowFor = (candidate: Candidate): WorkspaceCandidateRow => {
    const facts = candidateScreeningFacts(candidate);
    const appliedFor = candidateRowAppliedFor(candidate);
    const order = describeForOrder(candidate);
    const place = locationOf(facts);

    // Read against the job they are applying FOR, never against their own current title — reading a
    // district manager's CV against "district manager" because that is what they already are scores
    // everybody against themselves and always comes back excellent. `hiringTargetFamily` is the
    // helper that enforces that order, and it is deliberately NOT `candidateScreeningRoleFamily`,
    // which answers the other question and reads the current title first.
    const family: CandidateRoleFamily | null = hiringTargetFamily(appliedFor.text, facts);
    const fit = readRoleFit(facts, family, appliedFor.text);

    // ── TWO KINDS OF EVIDENCE, NEITHER OF THEM PROOF ────────────────────────────────────────────
    //
    // The pile keyed on the phone alone, so it could not see the same person arriving twice under
    // one name with two numbers — and 58 of the 597 candidates on 2026-09-05 carry no phone or
    // WhatsApp at all, so they could never enter it. The candidate pool has always flagged BOTH
    // (findDuplicateFlags: phone-tail, then normalized name); this brings the rail up to the same
    // rule rather than inventing a third one.
    //
    // NEITHER SIDE IS PROOF, and the strength is carried through to the screen rather than
    // flattened away. candidate-matching.ts marks the identity rule LOCKED — national ID, then
    // email, and nothing else merges a record — because phone matching once "merged three different
    // applicants into one record". Families share a handset and Egypt has common names, so this
    // reports a pair and names the evidence; a person decides.
    const phoneKey = normalizePhone(candidate.phone ?? candidate.whatsapp) ?? "";
    const nameKey = normalizeNameForMatch(candidate.fullName) ?? "";
    const byPhone = phoneKey ? (twins.get(phoneKey) ?? []) : [];
    const byName = nameKey ? (nameTwins.get(nameKey) ?? []) : [];

    const seenIds = new Set<string>([candidate.id]);
    const others: Array<{ candidate: Candidate; reason: DuplicateReason }> = [];
    for (const other of byPhone) {
      if (seenIds.has(other.id)) continue;
      seenIds.add(other.id);
      others.push({ candidate: other, reason: "phone" });
    }
    for (const other of byName) {
      if (seenIds.has(other.id)) continue;
      seenIds.add(other.id);
      others.push({ candidate: other, reason: "name" });
    }
    const duplicateNames = others.map((other) => candidateDisplayName(other.candidate.fullName));
    const duplicateIds = others.map((other) => other.candidate.id);
    // The STRONGEST evidence in the group, for the one line the row has room for. A shared number is
    // the stronger of the two — it is at least a fact about the record rather than about a spelling.
    const duplicateReason: DuplicateReason | null = others.some((other) => other.reason === "phone")
      ? "phone"
      : others.length > 0
        ? "name"
        : null;

    const sentAt = candidate.managerNotified?.sentAt ?? null;
    const comment = comments.get(candidate.id) ?? { count: 0, latestAt: null };
    const answeredAt = answeredAtFor(candidate, sentAt, comment.latestAt);
    const status = normalizeCandidateStatus(candidate.status);
    const redFlags = candidateRedFlagsFor(candidate);

    const queueInput: WorkQueueInput = {
      answeredAt,
      band: screeningBand(order),
      // 1 + the others, so a candidate with no phone AND no twin reads 1 like everybody else. It
      // used to read 0 for them, because the group was empty rather than containing themselves —
      // harmless while every render guarded on `> 1`, and a trap for the first one that does not.
      duplicateCount: 1 + others.length,
      interviewToday: interviewToday.has(candidate.id),
      redFlagged: redFlags.length > 0,
      sentToManagerAt: sentAt,
      status,
      // Counted by listUnappliedCvFields through a narrowed schema, so the badge and the CV
      // Data tab can never disagree about what counts as a finding still owed to the record.
      unsavedFindings: countRowFindings(rowFindings.get(candidate.id), candidate),
    };

    return {
      answeredAt,
      appliedForSource: appliedFor.source,
      appliedForText: appliedFor.text,
      band: queueInput.band,
      createdAt: candidate.createdAt,
      currentEmployer: facts.employer,
      currentRole: facts.roleTitle,
      declaredExperience: facts.declaredExperience?.value ?? null,
      duplicateCount: queueInput.duplicateCount,
      duplicateIds,
      duplicateNames,
      duplicateReason,
      email: text(candidate.email),
      experienceConfirmed: facts.years?.confirmed ?? false,
      experienceLabel: facts.years ? formatYearsOfExperience(facts.years.value) : null,
      fitRoleLabel: fit.roleLabel,
      fitScore: fit.score,
      fitVerdict: roleFitVerdict(fit.score),
      fullName: candidateDisplayName(candidate.fullName),
      id: candidate.id,
      interviewToday: queueInput.interviewToday,
      locationDeclared: place.declared,
      locationLabel: place.label,
      notACv: candidate.notACv === true,
      noteCount: comment.count,
      phone: text(candidate.phone ?? candidate.whatsapp),
      queues: workQueuesFor(queueInput),
      redFlags,
      regionCode: place.regionCode,
      alsoReadBy: (otherViewers.get(candidate.id) ?? []).map((hrId) => viewerNames.get(hrId) ?? hrId),
      seen: Boolean(views[candidate.id]),
      unsavedFindings: queueInput.unsavedFindings,
      sentForLabel: candidate.sentFor ? positionFolderLabel(candidate.sentFor) : null,
      sentForVacancyId: candidate.sentFor?.vacancyId ?? null,
      sentToManagerAt: sentAt,
      sentToManagerName: candidate.managerNotified?.name ?? null,
      source: intakeSourceLabel(text(candidate.source)) || null,
      status,
      statusChangedAt: text(candidate.statusChangedAt),
      statusNote: text(candidate.statusNote),
      statusRaw: String(candidate.status ?? ""),
      vacancyIds: [],
    };
  };

  // ORDERED FIRST, THEN NARROWED. The queue order is a property of the pool — best band first,
  // pharma experience first inside it, then the more experienced, then newest, with near-duplicates
  // pulled up beside their twin — and applying it after the filters would reshuffle the list every
  // time a recruiter changed a dropdown.
  const orderedPool = orderForScreening(pool, describeForOrder);
  const byId = new Map(orderedPool.map((candidate) => [candidate.id, candidate] as const));

  const visible = orderedPool.filter((candidate) =>
    matchesScreeningNarrowing(candidate, narrowing, { asOf, seenByViewer: Boolean(views[candidate.id]) }),
  );

  const rows = visible.map(rowFor);

  // Vacancy attribution runs over the VISIBLE rows, because the rail's counts have to agree with the
  // list beside it: a seat reading "12 waiting" that shows 3 when clicked is a rail nobody trusts.
  // The seats themselves are every OPEN vacancy, including the ones nobody matches — "nobody has
  // applied for this yet" is the most actionable thing the rail can say, and a seat that vanishes
  // when its pile empties cannot be told from a seat that was filled.
  const vacancyStatsById = tallyVacancyApplicants(rows, openVacancies, (row) => {
    const candidate = byId.get(row.id);
    return {
      address: candidate?.address ?? null,
      appliedForJobTitle: row.appliedForText,
      currentJobTitle: row.currentRole?.value ?? null,
      governorate: candidate?.governorate ?? null,
      hasMedicalRepExperience: candidate?.hasMedicalRepExperience ?? null,
      managerReview: row.queues.includes("manager_feedback"),
      recommended: row.queues.includes("recommended"),
      sentForVacancyId: row.sentForVacancyId,
      unreviewed: row.queues.includes("new"),
    };
  });

  // The reverse index, so the client filters by seat without re-running the place matcher. Built
  // from the same call the counts came from rather than from a second pass, so a row can never
  // appear under a seat whose count did not include it.
  for (const row of rows) {
    const candidate = byId.get(row.id);
    if (!candidate) continue;
    row.vacancyIds = vacancyIdsFor(row, candidate, openVacancies, vacancyStatsById);
  }

  const { counts, overdueManagerFeedback } = tallyWorkQueues(
    rows,
    (row) => ({
      answeredAt: row.answeredAt,
      band: row.band,
      duplicateCount: row.duplicateCount,
      interviewToday: row.interviewToday,
      redFlagged: row.redFlags.length > 0,
      sentToManagerAt: row.sentToManagerAt,
      status: row.status,
      unsavedFindings: row.unsavedFindings,
    }),
    now,
  );

  // ARRIVALS COME FROM EVERY CANDIDATE, not from the pool. A CV that arrived and was then filed to
  // a shelf did arrive, and dropping it would make the "in" side shrink every time somebody tidied
  // up — so the strip would report the backlog improving because work was hidden rather than done.
  // `unread` stays a question about the POOL, because that is the pile still in front of the reader.
  const throughput = buildThroughput({
    arrivals: allCandidates.map((candidate) => candidate.createdAt),
    firstDecisions: [...decisionHistory.firstDecisionAt.values()],
    historyStartsAt: decisionHistory.startsAt,
    now: asOf,
    unread: pool.filter((candidate) => !views[candidate.id]).length,
  });

  return {
    ...narrowing,
    // Built from the WHOLE pool, never from the narrowed list: a dropdown that loses its own options
    // the moment you pick one is a dropdown you cannot change your mind in.
    areaOptions: screeningAreaOptions(pool),
    canSendToManagers,
    counts: rows.length === 0 ? emptyWorkQueueCounts() : counts,
    filteredOut: pool.length - rows.length,
    hiringManagers,
    overdueManagerFeedback,
    poolSize: pool.length,
    positionSuggestions,
    rows,
    sourceOptions: screeningSourceOptions(pool),
    // Over everything, never the narrowed view: "am I keeping up" is a question about the backlog,
    // and a figure that shrank because a filter was applied would answer a different one.
    throughput,
    vacancies: openVacancies,
    vacancyStats: openVacancies
      .map((vacancy) => vacancyStatsById.get(vacancy.id))
      .filter((stats): stats is VacancyApplicantStats => Boolean(stats)),
  };
}

/**
 * Which seats one row sits under.
 *
 * Recomputed through the same `tallyVacancyApplicants` inputs rather than through a second matching
 * rule — see `vacancy-applicants.ts` for why there must only ever be one.
 */
function vacancyIdsFor(
  row: WorkspaceCandidateRow,
  candidate: Candidate,
  vacancies: readonly VacancyOption[],
  stats: Map<number, VacancyApplicantStats>,
): number[] {
  if (vacancies.length === 0) return [];
  const single = row.sentForVacancyId;
  if (typeof single === "number" && stats.has(single)) return [single];
  return vacanciesForCandidate(
    {
      address: candidate.address,
      appliedForJobTitle: row.appliedForText,
      currentJobTitle: row.currentRole?.value ?? null,
      governorate: candidate.governorate,
      hasMedicalRepExperience: candidate.hasMedicalRepExperience,
    },
    vacancies,
  );
}
