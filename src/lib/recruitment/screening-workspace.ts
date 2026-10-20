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
import {
  candidateFolderKindLabels,
  candidateFolderLabel,
  isCandidateFolderKind,
  isInCvFolder,
  isShelvedFromReview,
} from "@/lib/recruitment/candidate-folder";
import {
  candidateMatchesDecisionTab,
  countCandidatesByDecisionTab,
  decisionTabForStatusFilter,
  type CandidateDecisionTab,
} from "@/lib/recruitment/candidate-decision-tabs";
import { listCandidateIdsWithInterviewToday } from "@/lib/recruitment/interviews";
import {
  listCandidateViews,
  listLiveClaimsByCandidate,
  listOtherViewersByCandidate,
  resolveViewerNames,
} from "@/lib/recruitment/candidate-views";
import { listCandidates, loadDecisionHistory, loadRowFindings } from "@/lib/recruitment/candidates";
import { linkedInProfileHref } from "@/lib/recruitment/linkedin-profile";
import { countRowFindings } from "@/lib/recruitment/cv-findings";
import { buildThroughput, type ThroughputSummary } from "@/lib/recruitment/candidate-throughput";
import { listHiringManagerOptions, type HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import {
  listOpenVacancyOptions,
  listUsedPositionText,
  type VacancyOption,
} from "@/lib/recruitment/vacancy-options";
import { matchesScreeningNarrowing, screeningAreaOptions, screeningSourceOptions } from "@/lib/recruitment/screening-filter";
import {
  screeningFilterCounts,
  type ScreeningFilterCounts,
} from "@/lib/recruitment/screening-filter-counts";
import { normalizeCandidateStatus, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import { normalizeNameForMatch, normalizePhone } from "@/lib/recruitment/candidate-matching";
import {
  parseOpenCandidateId,
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
import {
  readSeatQueueReason,
  seatPlaceName,
  statedSeatQueueMatch,
  type SeatQueueCandidate,
  type SeatQueueMatch,
} from "@/lib/recruitment/vacancy-seat-queue";
import {
  parseWhatsAppApplicantSearch,
  whatsAppApplicantSearchCandidateIds,
  whatsAppApplicantSearchLabel,
  whatsAppApplicantSearchParam,
  type WhatsAppApplicantSearchLabel,
  type WhatsAppApplicantsView,
} from "@/lib/recruitment/whatsapp-applicant-filters";
import { loadWhatsAppApplicantsView } from "@/lib/recruitment/whatsapp-applicants-loader";
import { fenceRowsByCandidate } from "@/lib/recruitment/workspace/fence";
import type { AccessContext } from "@/lib/auth/permissions";
import type { CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import type { ScreeningRatingFilter } from "@/lib/recruitment/candidate-rating";
import { loadRequisitionMatchInputs } from "@/lib/recruitment/requisition-attach";
import { recommendRequisition } from "@/lib/recruitment/requisition-match";
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
  /**
   * THE CV THE LINK NAMES, built whether or not the pile still holds it. Null when the link names
   * none, or names a record that no longer exists at all.
   *
   * A CV pressed in the list opens in its OWN TAB (owner, 2026-09-18), and that tab has to show the
   * CV that was pressed — never a neighbour. The pile cannot promise that: the link carries the
   * list's filters, and between the press and this read the CV can leave them. The "not opened yet"
   * pile is the owner's own bookmark, and reading a CV is exactly what takes it out of that pile; a
   * decision takes it out of "New"; filing takes it off the pool. Each of those used to land the new
   * tab on whichever CV was first in the pile instead.
   *
   * Its own field rather than a row slipped into `rows`, because every count on the page is taken
   * over `rows` and this row must not move any of them — `candidate` says which CV is OPEN, never
   * which CVs EXIST (see screening-link.ts).
   */
  openRow: WorkspaceCandidateRow | null;
  counts: WorkQueueCounts;
  /** Of the pending manager sends, how many are past the nudge threshold. Beside, never instead. */
  overdueManagerFeedback: number;
  vacancies: VacancyOption[];
  vacancyStats: VacancyApplicantStats[];
  hiringManagers: HiringManagerOption[];
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  areaOptions: string[];
  sourceOptions: string[];
  /**
   * How many CVs each filter option would return, so the bar can say "District Manager (161)"
   * instead of making him pick blind and wait out the round trip to find out.
   */
  filterCounts: ScreeningFilterCounts;
  /**
   * How many CVs each decision tab holds, over the pool narrowed by every OTHER filter on the page —
   * so each number on the tab strip is the list that tab opens. "All" is their sum.
   */
  decisionCounts: Record<CandidateDecisionTab, number>;
  /** The tab this link opened — "new" ("Not decided yet") unless the link named another. */
  decisionTab: CandidateDecisionTab;
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
  /** The star filter, as "this many OR MORE" — or `unrated`. Echoed back so the bar can show it. */
  rating: ScreeningRatingFilter | null;
  source: string | null;
  /** The open seat being screened, or null for the ordinary whole-pool queue. */
  vacancy: number | null;
  /**
   * That seat in words - "Menoufia 1 · Medical Representative" - so the page can say which seat it
   * is showing without the client looking an id up in a list. Null outside seat mode.
   */
  seatLabel: string | null;
  /**
   * The WhatsApp Applicants search this pile was narrowed to, as the link carries it, or null.
   * Echoed so every link the page builds keeps it. Null as well when the link carried one naming no
   * job title, because then it narrowed nothing. See `whatsAppApplicantSearchParam`.
   */
  whatsapp: string | null;
  /** That search in words, for the header. Null when there is none. */
  whatsAppSearchLabel: WhatsAppApplicantSearchLabel | null;
};

function text(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Where this CV is filed, in words - or null when it is filed nowhere.
 *
 * A shelved CV is in this queue, decided or not (isShelvedFromReview), so the row has to be able to
 * say where it came from. Two shapes answer that, and only the first has a name to print: the four
 * shelves carry a kind and a key, while a hand-built folder is a membership id this loader never
 * resolves to a name. The second says so in words rather than printing the id, which is the owner's
 * standing rule - a screen shows names, never raw codes.
 *
 * An unrecognised kind falls through to the same wording. `candidateFolderLabel` itself refuses to
 * invent a label, and the duplicate archive never reaches here at all: those rows are shelved from
 * review whatever their status, so they are not in this pool to be labelled.
 */
function filedLabelFor(candidate: Candidate): string | null {
  const folder = candidate.folder;
  if (folder && isCandidateFolderKind(folder.kind)) {
    const place = candidateFolderLabel(folder.kind, folder.key);
    const kind = candidateFolderKindLabels[folder.kind];
    return place ? `${kind} · ${place}` : kind;
  }
  if (folder || (candidate.cvFolderIds?.length ?? 0) > 0) return "Filed in a folder";
  return null;
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
  options: {
    canSendToManagers?: boolean;
    canAttachToRequisition?: boolean;
    /** Who is reading — REQUIRED, so no page can forget the Talent Acquisition fence (owner, 2026-10-20). */
    access: Pick<AccessContext, "role" | "scope">;
  },
): Promise<ScreeningWorkspace> {
  const canSendToManagers = Boolean(options.canSendToManagers);
  // Admin or Talent Acquisition only (owner, 2026-10-16). The page decides, holding the AccessContext.
  const canAttach = Boolean(options.canAttachToRequisition);
  // READ FIRST, because the pool itself now depends on it: a link naming one vacant seat builds a
  // different pool from the ordinary queue. Pure, cheap, and no round trip - see screening-link.ts.
  const narrowing = parseScreeningFilters(filters);
  // Which CV the link opens, if any. Never part of `narrowing` — see `openRow` on the return type.
  const openCandidateId = parseOpenCandidateId(filters.candidate);
  // A search carried over from the WhatsApp Applicants page, or null. Read here, where the page's
  // rows can be loaded, because screening-link.ts may not import anything that reaches a database.
  const whatsAppSearch = parseWhatsAppApplicantSearch(narrowing.whatsapp);

  // Fired together, not in sequence: six of these seven are independent, and awaiting them one at a
  // time is the difference between one round trip and seven on a page that is already the slowest in
  // the module.
  const [
    everyCandidate,
    views,
    otherViewers,
    liveClaims,
    hiringManagers,
    openVacancies,
    positionSuggestions,
    interviewToday,
    everyDecision,
    rowFindings,
    whatsAppView,
  ] = await Promise.all([
    // WITHOUT the repeating CV blocks. Nothing below reads them, and on production they are 59%
    // of the bytes this read moves — see CANDIDATE_COLUMNS_WITHOUT_REPEATING_BLOCKS.
    listCandidates({ withRepeatingCvBlocks: false }),
    listCandidateViews(viewerHrId),
    // Who ELSE has opened each CV. A separate read from the caller's own map, deliberately — see
    // listOtherViewersByCandidate for why the two facts must not be merged.
    listOtherViewersByCandidate(viewerHrId),
    // Who has a CV OPEN right now, excluding the caller. A third fact again, not a slice of the
    // second: "has read" is permanent history, "is reading" is a five-minute lease that expires.
    listLiveClaimsByCandidate(viewerHrId),
    canSendToManagers ? listHiringManagerOptions() : Promise.resolve<HiringManagerOption[]>([]),
    canSendToManagers || canAttach ? listOpenVacancyOptions() : Promise.resolve<VacancyOption[]>([]),
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
    // The WhatsApp Applicants page's own rows, and only when the link carries a search from it. The
    // same loader that page uses, so both pages find the same people.
    whatsAppSearch ? loadWhatsAppApplicantsView({ access: options.access }) : Promise.resolve<WhatsAppApplicantsView | null>(null),
  ]);

  // THE TALENT ACQUISITION FENCE (owner, 2026-10-20). Every candidate this page shows, counts or opens
  // comes from `allCandidates`, so the HR applicants leave it here, once, before any pile is built —
  // and the throughput trend below drops their decisions too. Free for every viewer it does not apply to.
  const allCandidates = await fenceRowsByCandidate(options.access, everyCandidate, (candidate) => candidate.id);
  const keptIds = allCandidates.length === everyCandidate.length ? null : new Set(allCandidates.map((candidate) => candidate.id));
  const hiddenIds = new Set(keptIds ? everyCandidate.map((candidate) => candidate.id).filter((id) => !keptIds.has(id)) : []);
  const decisionHistory =
    hiddenIds.size === 0
      ? everyDecision
      : {
          ...everyDecision,
          firstDecisionAt: new Map([...everyDecision.firstDecisionAt].filter(([candidateId]) => !hiddenIds.has(candidateId))),
        };

  // The open requisitions a CV can be attached to, named from the seats just read. After the batch
  // rather than inside it, because the names come from that batch's vacancy list.
  // A failed read costs the band, never the page: the screen works without a recommendation.
  let requisitionInputs: Awaited<ReturnType<typeof loadRequisitionMatchInputs>> | null = null;
  if (canAttach) {
    try {
      requisitionInputs = await loadRequisitionMatchInputs(openVacancies);
    } catch (error) {
      console.error("[screening] requisition recommendation read failed", error);
    }
  }

  // A SHELF TAKES NOBODY OFF THIS PAGE, since 2026-10-19. A DECIDED shelved CV used to leave it, so
  // the shelf's "stops being offered for review again" held — but the decision tabs already do that
  // (the page opens on "Not decided yet"), and the exclusion left only its harm: a CV shortlisted
  // here vanished from Shortlisted too. 11 of the 19 shortlisted in the three days to 19 Oct were on
  // a shelf and none of them could be found. Only the duplicate archive and the hand-built folders
  // are taken off, BEFORE `filteredOut` is counted, so that number means the filters and never them.
  //
  // AN UNDECIDED ONE STAYED first, since 2026-09-18, and that is the bug this queue was reported for. The
  // owner's complaint was "cvs lost ... i cannot reach what i want", and filing was the mechanism:
  // 417 of 1,121 production candidates were filed and 371 of them were still `new`, so a fifth of
  // the whole pipeline had left this page unread — out of the pool, out of "New CVs" (252 against a
  // true 624) and out of the search, reachable only by opening one of 46 seats one at a time. See
  // isShelvedFromReview in candidate-folder.ts for the rule and for the applicant it was measured on.
  //
  // THE SEAT MODE IS UNCHANGED. What follows applies only when the link names one open seat, and it
  // is the whole point of "screen a vacant seat": the shelf is where the CVs for an open seat are
  // FILED, so for that one seat the shelf is read rather than skipped. See vacancy-seat-queue.ts for
  // the measured hour this cost.
  //
  // A FOLDER THE OWNER BUILT BY HAND IS DIFFERENT FROM A SHELF, on every pile here, the seat's
  // included. The owner, 2026-09-18: a CV he moves into one of his own folders ("Archive") appears
  // only inside that folder, so the page stays clean and a new CV is easy to see. isShelvedFromReview
  // takes those out of the review pool; the seat and the WhatsApp search read `outsideHandBuiltFolders`.
  //
  // WHAT HAS BEEN DECIDED no longer leaves any pile here — the DECISION TABS sort it instead. Every
  // pile opens on "Not decided yet", and Shortlisted, Sent to manager, Rejected, Hired and All sit one
  // click away, counted over the same pile. That replaced two rules that each hid a different subset:
  // the seat's (rejected, sent and hired, but not shortlisted) and the WhatsApp search's (all four).
  const reviewPool = allCandidates.filter((candidate) => !isShelvedFromReview(candidate));
  const outsideHandBuiltFolders = allCandidates.filter((candidate) => !isInCvFolder(candidate));

  const seat =
    narrowing.vacancy === null
      ? null
      : (openVacancies.find((vacancy) => vacancy.id === narrowing.vacancy) ?? null);

  /** Everything the seat attribution needs off one candidate, resolved once per candidate. */
  const seatInputFor = (candidate: Candidate): SeatQueueCandidate => {
    const context = candidate.sourceContext;
    return {
      address: candidate.address,
      appliedForJobTitle: candidate.appliedForJobTitle,
      // The RESOLVED applied-for text, which for an email applicant is usually the subject line
      // itself - see applied-for.ts. Read here for a PLACE, never for a title.
      appliedForText: candidateRowAppliedFor(candidate).text,
      currentJobTitle: candidate.currentJobTitle,
      emailSubject: context?.channel === "email" ? context.shortLabel : null,
      folderKey: candidate.folder?.key ?? null,
      governorate: candidate.governorate,
      hasMedicalRepExperience: candidate.hasMedicalRepExperience,
      preferredAreaName: candidate.preferredAreaName,
      sentForVacancyId: candidate.sentFor?.vacancyId ?? null,
    };
  };

  // A SEARCH FROM THE WHATSAPP APPLICANTS PAGE. The owner, 2026-09-18: "based on my filters, I can
  // go to screening page and only show those I filtered." The same match that page runs, over the
  // same rows, so the two pages name the same people. Null when the link carries no search.
  //
  // Drawn from every candidate, shelved and decided ones included, because that page lists everyone
  // who started the questions whatever has happened to their CV since — except a CV the owner moved
  // into a folder he built, which leaves that page too. Drawn from the review pool,
  // this pile would read fewer people than that page did, with nothing on screen to say why. This
  // page's own filters (status, stars and the rest) still narrow it after, like any other pile. With
  // a seat picked as well, the seat is read over these people only, so that pile and its count on
  // the rail both mean "of this search".
  const whatsAppIds =
    whatsAppSearch && whatsAppView ? whatsAppApplicantSearchCandidateIds(whatsAppView.rows, whatsAppSearch) : null;
  //
  // THE CVs ALREADY DECIDED ARE ON THEIR OWN TABS, not hidden. The owner asked on 2026-09-18 to stop
  // meeting a CV he had already shortlisted or rejected here; the pile opens on "Not decided yet", so
  // that is answered by the same tabs every other pile has, and the decided ones are one click away.
  const whatsAppMatches = whatsAppIds
    ? outsideHandBuiltFolders.filter((candidate) => whatsAppIds.has(candidate.id))
    : null;

  // WHY EACH CV IS IN THIS SEAT'S PILE, in the words the row prints. Empty outside seat mode.
  const seatReasons = new Map<string, string>();
  let seatQueue: Candidate[] | null = null;
  if (seat) {
    seatQueue = [];
    // Every CV the seat reads, whatever was decided about it: the decision tabs narrow this pile like
    // any other, and "Not decided yet" is the one it opens on.
    for (const candidate of whatsAppMatches ?? outsideHandBuiltFolders) {
      const input = seatInputFor(candidate);
      const match: SeatQueueMatch | null =
        statedSeatQueueMatch(input, seat) ??
        (vacanciesForCandidate(input, [seat]).includes(seat.id)
          ? { reason: readSeatQueueReason(seat), source: "read" as const }
          : null);
      if (!match) continue;
      seatReasons.set(candidate.id, match.reason);
      seatQueue.push(candidate);
    }
  }

  const pool = seatQueue ?? whatsAppMatches ?? reviewPool;

  // THE WIDER BASIS, for everything that must not shrink because one seat or one WhatsApp search was
  // picked: the duplicate index, the filter dropdowns and the vacancy rail. In the default mode this
  // IS the pool, so nothing about that path changes.
  const poolBasis =
    pool === reviewPool
      ? reviewPool
      : [...new Map([...reviewPool, ...pool].map((candidate) => [candidate.id, candidate])).values()];

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
  //
  // The CV the link opens is looked up in EVERY candidate, not in the pool — see `openRow`.
  const openCandidate = openCandidateId
    ? (allCandidates.find((candidate) => candidate.id === openCandidateId) ?? null)
    : null;
  const [comments, viewerNames] = await Promise.all([
    // Plus the CV the link opens, which may have left the pool — or its tab says "no notes" on a CV
    // that has them. Only once it is known to EXIST: the id arrives from a URL, and a string that is
    // not a real candidate must never reach a query.
    summarizeCommentsByCandidate(
      [...new Set([...pool.map((candidate) => candidate.id), ...(openCandidate ? [openCandidate.id] : [])])],
    ),
    // Claim holders too, or 'B-10 is reading this' shows a code where the owner's rule is names.
    resolveViewerNames([...otherViewers.values()].flat().concat([...liveClaims.values()].map((c) => c.viewerHrId))),
  ]);

  // Stamped once. This is a `force-dynamic` page, so one `Date.now()` here is the same instant every
  // "how recently" question is measured against — a second reading mid-loop would let two rows on
  // one screen disagree about what "today" means.
  const now = new Date();
  const asOf = now.getTime();

  // Duplicate SETS over the whole live pool, never over the filtered view: "2 CVs from this number"
  // must stay true when one of the two is filtered out of sight, or the warning quietly becomes a
  // lie at exactly the moment a recruiter narrows down to act on it.
  const twins = duplicateSets(poolBasis, describeForOrder);

  // The same pool indexed by NORMALIZED NAME — the second half of the rule the candidate pool has
  // always used. Built over the whole live pool for the reason the phone index is: a pair that stops
  // being reported the moment one of the two is filtered out of sight is a warning that quietly
  // becomes a lie at exactly the moment a recruiter narrows down to act on it.
  const nameTwins = new Map<string, Candidate[]>();
  for (const candidate of poolBasis) {
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
      folderLabel: filedLabelFor(candidate),
      fullName: candidateDisplayName(candidate.fullName),
      id: candidate.id,
      interviewToday: queueInput.interviewToday,
      linkedinUrl: linkedInProfileHref(candidate.linkedinUrl),
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
      // "Somebody is reading this RIGHT NOW", by name. Null when nobody is, which is the normal
      // case - a claim lasts five minutes and expires on its own.
      beingReadBy: (() => {
        const claim = liveClaims.get(candidate.id);
        if (!claim) return null;
        return viewerNames.get(claim.viewerHrId) ?? claim.viewerHrId;
      })(),
      unsavedFindings: queueInput.unsavedFindings,
      sentForLabel: candidate.sentFor ? positionFolderLabel(candidate.sentFor) : null,
      sentForVacancyId: candidate.sentFor?.vacancyId ?? null,
      sentToManagerAt: sentAt,
      sentToManagerName: candidate.managerNotified?.name ?? null,
      source: intakeSourceLabel(text(candidate.source)) || null,
      // Straight off the record. Nothing here derives or defaults it — a star is somebody's opinion
      // and the absence of one is not a zero.
      rating: candidate.rating,
      status,
      statusChangedAt: text(candidate.statusChangedAt),
      statusNote: text(candidate.statusNote),
      seatReason: seatReasons.get(candidate.id) ?? null,
      statusRaw: String(candidate.status ?? ""),
      vacancyIds: [],
      requisitionRecommendation: requisitionInputs
        ? recommendRequisition({
            attachedRequisitionIds: requisitionInputs.attachedByCandidate.get(candidate.id) ?? [],
            candidate: { ...seatInputFor(candidate), status },
            requisitions: requisitionInputs.requisitions,
            vacancies: openVacancies,
          })
        : null,
    };
  };

  // ORDERED FIRST, THEN NARROWED. The queue order is a property of the pool — best band first,
  // pharma experience first inside it, then the more experienced, then newest, with near-duplicates
  // pulled up beside their twin — and applying it after the filters would reshuffle the list every
  // time a recruiter changed a dropdown.
  const orderedPool = orderForScreening(pool, describeForOrder);
  const byId = new Map(orderedPool.map((candidate) => [candidate.id, candidate] as const));

  // EVERY FILTER BUT THE DECISION TAB first, then the tab. The middle list is what the tab strip
  // counts: "Rejected 12" has to mean the twelve rejected CVs the OTHER filters on the page keep, so
  // pressing it shows twelve. Counted over the whole pool instead, a tab would promise people a
  // region filter had already taken away. The same matcher either way — the tab is only its status
  // half, asked second.
  const decisionTab = decisionTabForStatusFilter(narrowing.status);
  const acrossTabs = orderedPool.filter((candidate) =>
    matchesScreeningNarrowing(
      candidate,
      { ...narrowing, status: null },
      {
        asOf,
        seenByViewer: Boolean(views[candidate.id]),
        // BOTH halves. `untouched` means nobody has opened it, and the caller's own map answers only
        // for the caller - on a two-person queue that is most of the wrong answer.
        seenByAnyone: Boolean(views[candidate.id]) || (otherViewers.get(candidate.id)?.length ?? 0) > 0,
      },
    ),
  );
  const decisionCounts = countCandidatesByDecisionTab(acrossTabs);
  const visible = acrossTabs.filter((candidate) => candidateMatchesDecisionTab(candidate.status, decisionTab));

  // WHAT EACH FILTER OPTION WOULD GIVE HIM, over the decision tab he is on and NOT over the rest of
  // the narrowed list — a dropdown whose numbers all collapse the moment you pick one of them cannot
  // be used to change your mind, which is the reason `areaOptions` is built from the whole pool too.
  // The tab is the one narrowing applied first, because it is not on the bar: on "Not decided yet",
  // "District Manager (40)" has to mean the forty undecided ones picking it will show, not every
  // district manager ever decided. One pass, reusing the resolvers the matcher just used; see
  // screening-filter-counts.ts.
  const inDecisionTab = pool.filter((candidate) => candidateMatchesDecisionTab(candidate.status, decisionTab));
  const filterCounts = screeningFilterCounts(inDecisionTab, {
    asOf,
    seenByViewer: (candidate) => Boolean(views[candidate.id]),
    seenByAnyone: (candidate) =>
      Boolean(views[candidate.id]) || (otherViewers.get(candidate.id)?.length ?? 0) > 0,
  });

  const rows = visible.map(rowFor);
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  // Vacancy attribution runs over the VISIBLE rows, because the rail's counts have to agree with the
  // list beside it: a seat reading "12 waiting" that shows 3 when clicked is a rail nobody trusts.
  // The seats themselves are every OPEN vacancy, including the ones nobody matches — "nobody has
  // applied for this yet" is the most actionable thing the rail can say, and a seat that vanishes
  // when its pile empties cannot be told from a seat that was filled.
  const defaultVacancyStats = () =>
    tallyVacancyApplicants(rows, openVacancies, (row) => {
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

  // -- AND IN SEAT MODE, THE COUNT HAS TO BE THE QUEUE --------------------------------------------
  //
  // A seat reading "3 waiting" that shows 17 when clicked is worse than no rail at all, so the
  // counts are taken over the SAME attribution and the SAME population the seat queue offers: every
  // candidate on the decision tab being shown, shelved ones included, matched through the stated sources and then through
  // the existing place reader. That reader is asked ONCE per candidate against every seat at a time
  // - never once per pair - which is what keeps this a single pass over the pool.
  const seatVacancyStats = () => {
    const stats = new Map<number, VacancyApplicantStats>();
    for (const vacancy of openVacancies) {
      stats.set(vacancy.id, {
        applicants: 0,
        managerReview: 0,
        recommended: 0,
        unreviewed: 0,
        vacancyId: vacancy.id,
      });
    }
    // Over the WhatsApp search's people when there is one, the same population the seat queue was
    // read from above, and on the decision tab the page is showing, so a seat's count on the rail is
    // the pile it opens.
    for (const candidate of whatsAppMatches ?? poolBasis) {
      if (!candidateMatchesDecisionTab(candidate.status, decisionTab)) continue;
      const input = seatInputFor(candidate);
      const read = new Set(vacanciesForCandidate(input, openVacancies));
      const row = rowsById.get(candidate.id) ?? null;
      for (const vacancy of openVacancies) {
        if (!read.has(vacancy.id) && !statedSeatQueueMatch(input, vacancy)) continue;
        const tally = stats.get(vacancy.id);
        if (!tally) continue;
        tally.applicants += 1;
        // The three work-state figures come off the row when this candidate is one the page built a
        // row for. Outside that only the pile size is known, and an invented breakdown would be a
        // number nobody could check against anything.
        if (row?.queues.includes("new")) tally.unreviewed += 1;
        if (row?.queues.includes("recommended")) tally.recommended += 1;
        if (row?.queues.includes("manager_feedback")) tally.managerReview += 1;
      }
    }
    return stats;
  };

  const vacancyStatsById = seat ? seatVacancyStats() : defaultVacancyStats();

  // The reverse index, so the client filters by seat without re-running the place matcher. Built
  // from the same call the counts came from rather than from a second pass, so a row can never
  // appear under a seat whose count did not include it.
  for (const row of rows) {
    const candidate = byId.get(row.id);
    if (!candidate) continue;
    row.vacancyIds = vacancyIdsFor(row, candidate, openVacancies, vacancyStatsById);
    // AND THE SEAT BEING SCREENED IS ALWAYS ONE OF THEM. This index is what the list filters on in
    // the browser, and `vacancyIdsFor` only ever reads an address and a job title — so a CV that
    // reached this seat because it was FILED here, or because the applicant named the area on
    // WhatsApp or in an email subject, would carry an index without the seat in it and be filtered
    // straight back out of the queue the server just built for it. Seat mode only: in the ordinary
    // queue this index is exactly what it has always been.
    if (seat && seatReasons.has(row.id) && !row.vacancyIds.includes(seat.id)) {
      row.vacancyIds = [seat.id, ...row.vacancyIds];
    }
  }

  // THE CV THE LINK OPENS: the row the list already built when the pile still holds it, otherwise
  // the same `rowFor` over the record itself, so its tab reads exactly as its row would have. Built
  // AFTER the counts' inputs and outside `rows`, so no figure on the page moves because of it.
  let openRow: WorkspaceCandidateRow | null = null;
  if (openCandidate) {
    openRow = rowsById.get(openCandidate.id) ?? rowFor(openCandidate);
    if (!rowsById.has(openCandidate.id)) {
      openRow.vacancyIds = vacancyIdsFor(openRow, openCandidate, openVacancies, vacancyStatsById);
    }
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
    // The BACKLOG, never the seat: "am I keeping up" is a question about the whole pool, and a
    // figure that shrank because one seat was picked would answer a different one.
    unread: reviewPool.filter((candidate) => !views[candidate.id]).length,
  });

  return {
    ...narrowing,
    // Built from the WHOLE pool, never from the narrowed list: a dropdown that loses its own options
    // the moment you pick one is a dropdown you cannot change your mind in.
    areaOptions: screeningAreaOptions(poolBasis),
    canSendToManagers,
    counts: rows.length === 0 ? emptyWorkQueueCounts() : counts,
    decisionCounts,
    decisionTab,
    filterCounts,
    // What the FILTERS took away, never the tab: a CV on another decision tab is one press away on
    // the strip, not hidden, and counting it here would tell the reader to clear filters he never set.
    filteredOut: pool.length - acrossTabs.length,
    hiringManagers,
    openRow,
    overdueManagerFeedback,
    poolSize: pool.length,
    positionSuggestions,
    rows,
    seatLabel: seat ? `${seatPlaceName(seat)} · ${seat.jobTitle}` : null,
    sourceOptions: screeningSourceOptions(poolBasis),
    // Over everything, never the narrowed view: "am I keeping up" is a question about the backlog,
    // and a figure that shrank because a filter was applied would answer a different one.
    throughput,
    vacancies: openVacancies,
    vacancyStats: openVacancies
      .map((vacancy) => vacancyStatsById.get(vacancy.id))
      .filter((stats): stats is VacancyApplicantStats => Boolean(stats)),
    // Spelled back the one way the WhatsApp page spells it, so a link edited by hand is tidied rather
    // than carried on as typed. Null when it named no job title, since then it narrowed nothing.
    whatsapp: whatsAppSearch ? whatsAppApplicantSearchParam(whatsAppSearch.title, whatsAppSearch.selections) : null,
    whatsAppSearchLabel:
      whatsAppSearch && whatsAppView ? whatsAppApplicantSearchLabel(whatsAppView, whatsAppSearch) : null,
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
