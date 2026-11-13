import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { compactDeductionsHrId, normalizeMonthKey } from "@/lib/deductions/candidate-key.ts";
import { attachCommentAttachments } from "@/lib/deductions/comment-attachments.ts";
import { isUndecidedDeductionStatus } from "@/lib/deductions/dispute-open.ts";
import { isDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { pushDeduction, withdrawDeduction } from "@/lib/deductions/push.ts";
import { recordDecision } from "@/lib/deductions/service.ts";
import type { DeductionsComment } from "@/lib/deductions/types.ts";
import { conflictError, notFoundError } from "@/lib/http/api-errors";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { roundCurrency } from "@/lib/payroll/money";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { payrollCharge } from "./charge.ts";
import { loadDayFacts, loadEmployeeProfileFacts } from "./day-evidence.ts";
import { compareCasesForReviewer, deriveDisputeCaseState, isDecidedByEvents, lastActivityAt } from "./state.ts";
import {
  claimDisputeDecision,
  captureDeductionDisputeState,
  DisputeUndoConflictError,
  releaseDisputeDecision,
  renewDisputeDecision,
  restoreDeductionDisputeState,
  stampDisputeDecisionSnapshot,
  type DeductionDisputeSnapshot,
} from "./decision-claim.ts";
import {
  eventsForViewer,
  listCaseEvents,
  nameFor,
  recordCaseEvent,
  recordCaseEvents,
  resolvePeopleNames,
  type CaseEventInput,
} from "./events.ts";
import { notifyDisputeCase, reviewerHrIdsFor } from "./notify.ts";
import { resolveCaseParticipant, viewerHrIdOf } from "./participants.ts";
import { monthKeyLabel, payrollMonthState } from "./payroll-month.ts";
import { cancelLiveRefund, listRefundsForCases, recommendDisputeRefund } from "./refunds.ts";
import { dayLabel, daysLabel, moneyLabel, tidyDisputeText } from "./text.ts";
import type { DisputeCase, DisputeCaseEvent, DisputeCaseFact, DisputeDecision, DisputeMessage } from "./types.ts";

// DEDUCTION DISPUTES in the Dispute Center's shape — and the decision the module never had.
//
// Until now a deduction dispute was a conversation with no verdict: the employee commented, the
// Super Admin replied, and whatever the reply said, the deduction stayed exactly as it was unless
// somebody separately went to the month's workspace and changed the decision there. The owner's
// ruling (2026-10-09) is three outcomes, decided in the dispute itself:
//
//   ACCEPT  the employee is right — the deduction is cancelled (Do Not Take Action) and its line
//           pulled off the payslip.
//   REJECT  the deduction stands exactly as it is.
//   REDUCE  fewer days (or a smaller amount) than were charged; the rest is cancelled.
//
// AND THE MONEY, when the month is already paid (his answer: "reopen to احتمال رد خصم الشهر
// القادم … in additions, other"): the month is NOT reopened and no payslip is rewritten. What the
// employee is owed is recommended into the next OPEN payroll's Additions → Other Additions, with the
// reason naming the month it came from, for HR to confirm like any other addition. Nothing here pays
// anybody; `dispute-refunds.ts` feeds the recommendation and HR still confirms the step.
//
// A case NEVER disappears: the list reads every candidate with a comment, including one whose line
// has been withdrawn or cancelled, which the admin Disputes tab deliberately hides.

type CommentRow = {
  author_hr_id: string | null;
  author_login_id: string;
  author_role: string | null;
  body: string;
  candidate_id: string;
  created_at: string;
  id: string;
};

type CandidateRow = {
  category: string | null;
  dates: unknown;
  employee_hr_id: string | null;
  employee_hr_id_compact: string | null;
  employee_name: string | null;
  estimated_amount: number | string | null;
  evidence: Record<string, unknown> | null;
  id: string;
  locked_at: string | null;
  month_key: string | null;
  raw_value: number | string;
  reason: string | null;
  severity: string | null;
  unit: string;
};

type DecisionRow = {
  applied_amount: number | string | null;
  applied_dates: unknown;
  applied_value: number | string | null;
  candidate_id: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  decision_status: string | null;
  hr_note: string | null;
};

type LineRow = {
  applied_amount: number | string;
  applied_value: number | string;
  candidate_id: string;
  employee_hr_id: string;
  employee_name: string | null;
  id: string;
  line_status: string;
  month_key: string;
};

const COMMENT_COLUMNS = "id, candidate_id, author_login_id, author_hr_id, author_role, body, created_at";
const CANDIDATE_COLUMNS =
  "id, category, month_key, unit, raw_value, estimated_amount, dates, reason, severity, evidence, employee_hr_id, employee_hr_id_compact, employee_name, locked_at";
const DECISION_COLUMNS =
  "candidate_id, decision_status, decision_reason, hr_note, applied_value, applied_amount, applied_dates, decided_by, decided_at";
const LINE_COLUMNS = "id, candidate_id, employee_hr_id, employee_name, month_key, applied_value, applied_amount, line_status";

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const CATEGORY_LABELS: Record<string, string> = {
  crm: "CRM visits",
  dsm_no_record: "No records for the day",
  field_review: "Field day (reviewed by HR)",
  fingerprint: "Fingerprint",
  holiday_bridge: "Holiday bridge",
  insufficient_balance_vacation: "Vacation over balance",
  loans: "Loan instalment",
  other: "Other deduction",
  unpaid_vacation: "Unpaid vacation",
};

function categoryLabel(category: string | null): string {
  if (!category) return "Deduction";
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, " ");
}

/** Every deduction comment in the system, uncapped and paged — a case must never fall off a limit. */
async function loadAllComments(candidateIds?: readonly string[]): Promise<CommentRow[]> {
  if (candidateIds && candidateIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  if (!candidateIds) {
    return fetchAllRows<CommentRow>(() => supabase.from("deductions_comments").select(COMMENT_COLUMNS), "id");
  }
  const rows: CommentRow[] = [];
  for (let i = 0; i < candidateIds.length; i += 100) {
    rows.push(
      ...(await fetchAllRows<CommentRow>(
        () => supabase.from("deductions_comments").select(COMMENT_COLUMNS).in("candidate_id", candidateIds.slice(i, i + 100)),
        "id",
      )),
    );
  }
  return rows;
}

function mapComment(row: CommentRow): DeductionsComment {
  return {
    authorHrId: row.author_hr_id,
    authorLoginId: row.author_login_id,
    authorName: null,
    authorRole: row.author_role,
    body: row.body,
    candidateId: row.candidate_id,
    createdAt: row.created_at,
    id: row.id,
  };
}

/** A reply is Super Admin only, so any other role on a comment is the employee's side. */
function sideOf(role: string | null): DisputeMessage["side"] {
  return isDeductionsDecisionActor({ role: (role ?? "") as AccessContext["role"] }) ? "reviewer" : "employee";
}

function toMessage(comment: DeductionsComment, names: Map<string, string>): DisputeMessage {
  return {
    attachments: (comment.attachments ?? []).map((attachment) => ({
      contentType: attachment.contentType,
      fileName: attachment.fileName,
      id: attachment.id,
      sizeBytes: attachment.sizeBytes,
      url: attachment.url,
    })),
    authorHrId: comment.authorHrId,
    authorName: comment.authorName ?? nameFor(names, comment.authorHrId),
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
    side: sideOf(comment.authorRole),
  };
}

/** The decision on record, in words — and whether it still counts as a decision on the dispute. */
function decisionOf(input: {
  decision: DecisionRow | null;
  decidedByName: string | null;
  unit: "days" | "amount";
  detectedValue: number;
}): DisputeDecision | null {
  const status = input.decision?.decision_status ?? "Pending";
  if (!input.decision || status === "Pending" || status === "Disputed") return null;
  const applied = input.decision.applied_value == null ? null : num(input.decision.applied_value);
  const reduced = applied != null && applied > 0 && applied < input.detectedValue;
  const label =
    status === "Do Not Take Action"
      ? "Accepted — the deduction is cancelled"
      : status === "Approved for Payroll" && reduced
        ? `Reduced to ${input.unit === "days" ? daysLabel(applied) : moneyLabel(applied)}`
        : status === "Approved for Payroll"
          ? "Rejected — the deduction stands"
          : status;
  return {
    decidedAt: input.decision.decided_at,
    decidedByName: input.decidedByName,
    favoursEmployee: status === "Do Not Take Action" || reduced,
    label,
    note: String(input.decision.hr_note ?? "").trim() || String(input.decision.decision_reason ?? "").trim() || null,
  };
}

function moneyFacts(input: {
  candidate: CandidateRow;
  charge: { amount: number; value: number };
  decision: DecisionRow | null;
  line: LineRow | null;
}): DisputeCaseFact[] {
  const unit = input.candidate.unit === "amount" ? "amount" : "days";
  const detected = num(input.candidate.raw_value);
  const facts: DisputeCaseFact[] = [
    { label: "Deduction", value: `${categoryLabel(input.candidate.category)} — ${monthKeyLabel(String(input.candidate.month_key ?? ""))}` },
    {
      label: "Detected",
      value: unit === "days" ? daysLabel(detected) : moneyLabel(detected),
    },
  ];
  if (input.candidate.reason) facts.push({ label: "Why it was raised", value: input.candidate.reason });
  const dates = Array.isArray(input.candidate.dates) ? (input.candidate.dates as unknown[]).map(String) : [];
  if (dates.length > 0) facts.push({ label: "Days detected", value: dates.map(dayLabel).join(", ") });
  if (input.line) {
    facts.push({
      label: input.line.line_status === "active" ? "On the payslip" : "Was on the payslip",
      tone: input.line.line_status === "active" ? "warning" : "info",
      value: `${moneyLabel(num(input.line.applied_amount))}${
        unit === "days" ? ` for ${daysLabel(num(input.line.applied_value))}` : ""
      }${input.line.line_status === "active" ? "" : " — withdrawn"}`,
    });
  } else {
    facts.push({ label: "On the payslip", tone: "info", value: "Never pushed to the employee's payslip." });
  }
  const status = input.decision?.decision_status ?? "Pending";
  facts.push({
    label: "Decision on record",
    tone: status === "Approved for Payroll" ? "warning" : status === "Do Not Take Action" ? "success" : "info",
    value: status,
  });
  // THE FIGURE THE DECISION IS ABOUT, beside the line the employee can see — the two differ whenever
  // a deduction was approved but never pushed, or its line was withdrawn by an earlier decision, and
  // this one is the money (payrollCharge).
  facts.push({
    label: "Charged by payroll",
    tone: input.charge.amount > 0 ? "warning" : "success",
    value:
      input.charge.amount > 0
        ? `${moneyLabel(input.charge.amount)}${unit === "days" ? ` for ${daysLabel(input.charge.value)}` : ""}`
        : "Nothing — the decision on record charges nothing.",
  });
  return facts;
}

async function buildCase(input: {
  candidate: CandidateRow;
  comments: DeductionsComment[];
  decision: DecisionRow | null;
  line: LineRow | null;
  events: DisputeCaseEvent[];
  names: Map<string, string>;
  refunds: DisputeCase["refunds"];
  viewer: { isOwner: boolean; isReviewer: boolean };
  withFacts: boolean;
}): Promise<DisputeCase> {
  const sorted = [...input.comments].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const messages = sorted.map((comment) => toMessage(comment, input.names));
  const opening = messages[0];
  if (!opening) throw notFoundError("That dispute no longer exists.");
  const rest = messages.slice(1);
  const unit = input.candidate.unit === "amount" ? ("amount" as const) : ("days" as const);
  const detectedValue = num(input.candidate.raw_value);
  const charge = payrollCharge(input.candidate, input.decision);
  const status = input.decision?.decision_status ?? "Pending";
  const decision = decisionOf({
    decidedByName: nameFor(input.names, input.decision?.decided_by),
    decision: input.decision,
    detectedValue,
    unit,
  });
  // Decided when the Dispute Center recorded a decision that has not been reopened since. A case
  // decided before this screen existed — a cancelled deduction with no event at all — still reads as
  // decided, so an old settled dispute does not reappear as waiting on somebody.
  const decided =
    isDecidedByEvents(input.events) ||
    (input.events.length === 0 && status === "Do Not Take Action" && input.line?.line_status !== "active");

  let facts: DisputeCaseFact[] = [];
  let factsIncomplete = false;
  if (input.withFacts) {
    const dates = Array.isArray(input.candidate.dates) ? (input.candidate.dates as unknown[]).map(String) : [];
    const [profile, days] = await Promise.all([
      loadEmployeeProfileFacts(input.candidate.employee_hr_id ?? ""),
      loadDayFacts(input.candidate.employee_hr_id ?? "", dates),
    ]);
    facts = [...profile, ...moneyFacts({ ...input, charge }), ...days.facts];
    factsIncomplete = days.incomplete;
  }

  const monthKey = String(input.candidate.month_key ?? "");
  return {
    canReply: input.viewer.isReviewer || !decided,
    decision,
    deduction: {
      // What the SHEET charges, not what the payslip line says — the reduce ceiling is measured
      // against this figure server-side, so the panel must offer the same one.
      chargedAmount: charge.amount,
      chargedValue: charge.value,
      decisionStatus: status,
      detectedValue,
      lineStatus: input.line ? (input.line.line_status === "active" ? "active" : "withdrawn") : "none",
      monthKey,
      unit,
    },
    employeeHrId: input.candidate.employee_hr_id ?? input.candidate.employee_hr_id_compact ?? "",
    // The display name (owner, 2026-11-03); both stored columns stay as they were stamped.
    employeeName:
      nameFor(input.names, input.candidate.employee_hr_id) ??
      input.candidate.employee_name ??
      input.line?.employee_name ??
      input.candidate.employee_hr_id ??
      "",
    // HR-only details (a needs-attention marker) never reach the employee's browser.
    events: eventsForViewer(input.events, input.viewer),
    facts,
    factsIncomplete,
    kind: "deduction",
    lastActivityAt: lastActivityAt({
      decidedAt: input.decision?.decided_at ?? null,
      events: input.events,
      messages,
      openedAt: opening.createdAt,
    }),
    messages: rest,
    opening,
    openedAt: opening.createdAt,
    ref: input.candidate.id,
    refunds: input.refunds,
    state: deriveDisputeCaseState({ decided, events: input.events, messages: rest, openedAt: opening.createdAt }),
    title: `${categoryLabel(input.candidate.category)} deduction — ${monthKeyLabel(monthKey)}`,
    viewer: input.viewer,
  };
}

async function loadParts(candidateIds: string[]): Promise<{
  candidates: Map<string, CandidateRow>;
  decisions: Map<string, DecisionRow>;
  lines: Map<string, LineRow>;
}> {
  const supabase = getSupabaseAdmin();
  const candidates = new Map<string, CandidateRow>();
  const decisions = new Map<string, DecisionRow>();
  const lines = new Map<string, LineRow>();
  for (let i = 0; i < candidateIds.length; i += 100) {
    const batch = candidateIds.slice(i, i + 100);
    const [candidateResult, decisionResult, lineResult] = await Promise.all([
      supabase.from("deductions_candidates").select(CANDIDATE_COLUMNS).in("id", batch),
      supabase.from("deductions_decisions").select(DECISION_COLUMNS).in("candidate_id", batch),
      // Every line, not only the active one: a cancelled deduction's case must still say what WAS
      // charged, which is exactly what the admin Disputes tab hides and the owner asked to keep.
      supabase.from("deductions_publication_lines").select(LINE_COLUMNS).in("candidate_id", batch),
    ]);
    if (candidateResult.error) throw candidateResult.error;
    if (decisionResult.error) throw decisionResult.error;
    if (lineResult.error) throw lineResult.error;
    for (const row of (candidateResult.data ?? []) as CandidateRow[]) candidates.set(row.id, row);
    for (const row of (decisionResult.data ?? []) as DecisionRow[]) decisions.set(row.candidate_id, row);
    for (const row of (lineResult.data ?? []) as LineRow[]) {
      const existing = lines.get(row.candidate_id);
      // An active line always wins; otherwise the newest withdrawn one.
      if (!existing || row.line_status === "active") lines.set(row.candidate_id, row);
    }
  }
  return { candidates, decisions, lines };
}

/**
 * Every deduction dispute the viewer may see, newest activity first. A reviewer (and the company-wide
 * readers) see all of them; an employee sees their own. Uncapped and including cancelled deductions.
 */
export async function listDeductionCases(access: AccessContext): Promise<DisputeCase[]> {
  // The registry row for every dispute-center route declares attendance:read with a
  // domain-helper guard, so the helper is where it has to be enforced. Measured on production
  // 2026-10-09: without this an UNAUTHENTICATED GET of /api/dispute-center/cases answered 200
  // with an empty list, where the private-calendar sibling answers 403. No row leaked — each
  // list self-scopes and an anonymous caller has no hr id — but an empty 200 is not a refusal,
  // and "the list came back empty" must never be what stands in for access control.
  await assertPermission(access, "attendance", "read");
  const viewerHrId = viewerHrIdOf(access);
  const isReviewer = isDeductionsDecisionActor(access);
  const viewerCompact = compactDeductionsHrId(viewerHrId);

  let candidateIdsFilter: string[] | undefined;
  if (!isReviewer) {
    if (!viewerCompact) return [];
    const { data, error } = await getSupabaseAdmin()
      .from("deductions_candidates")
      .select("id")
      .eq("employee_hr_id_compact", viewerCompact);
    if (error) throw error;
    candidateIdsFilter = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
    if (candidateIdsFilter.length === 0) return [];
  }

  const commentRows = await loadAllComments(candidateIdsFilter);
  if (commentRows.length === 0) return [];
  const byCandidate = new Map<string, DeductionsComment[]>();
  for (const row of commentRows) {
    const list = byCandidate.get(row.candidate_id) ?? [];
    list.push(mapComment(row));
    byCandidate.set(row.candidate_id, list);
  }
  const candidateIds = Array.from(byCandidate.keys());

  const [{ candidates, decisions, lines }, eventsByRef, refundsByRef, withPictures] = await Promise.all([
    loadParts(candidateIds),
    listCaseEvents("deduction", candidateIds),
    listRefundsForCases("deduction", candidateIds),
    attachCommentAttachments(commentRows.map(mapComment)).catch(() => commentRows.map(mapComment)),
  ]);
  const picturesById = new Map(withPictures.map((comment) => [comment.id, comment.attachments ?? []]));
  const names = await resolvePeopleNames([
    ...commentRows.map((row) => row.author_hr_id),
    ...Array.from(decisions.values()).map((row) => row.decided_by),
    ...Array.from(candidates.values()).map((row) => row.employee_hr_id),
  ]);

  const cases: DisputeCase[] = [];
  for (const candidateId of candidateIds) {
    const candidate = candidates.get(candidateId);
    if (!candidate) continue;
    const comments = (byCandidate.get(candidateId) ?? []).map((comment) => ({
      ...comment,
      attachments: picturesById.get(comment.id) ?? [],
    }));
    cases.push(
      await buildCase({
        candidate,
        comments,
        decision: decisions.get(candidateId) ?? null,
        events: eventsByRef.get(candidateId) ?? [],
        line: lines.get(candidateId) ?? null,
        names,
        refunds: refundsByRef.get(candidateId) ?? [],
        viewer: {
          isOwner: Boolean(viewerCompact) && viewerCompact === candidate.employee_hr_id_compact,
          isReviewer,
        },
        withFacts: false,
      }),
    );
  }
  return cases.sort(compareCasesForReviewer);
}

/** One deduction case in full, with the deduction's own record and its days' calendar beside it. */
export async function loadDeductionCase(access: AccessContext, candidateId: string): Promise<DisputeCase> {
  const participant = await resolveCaseParticipant(access, "deduction", candidateId);
  const [commentRows, { candidates, decisions, lines }, eventsByRef, refundsByRef] = await Promise.all([
    loadAllComments([candidateId]),
    loadParts([candidateId]),
    listCaseEvents("deduction", [candidateId]),
    listRefundsForCases("deduction", [candidateId]),
  ]);
  const candidate = candidates.get(candidateId);
  if (!candidate) throw notFoundError("That deduction no longer exists.");
  const comments = await attachCommentAttachments(commentRows.map(mapComment)).catch(() => commentRows.map(mapComment));
  const names = await resolvePeopleNames([
    ...commentRows.map((row) => row.author_hr_id),
    decisions.get(candidateId)?.decided_by ?? null,
    candidate.employee_hr_id,
  ]);
  return buildCase({
    candidate,
    comments,
    decision: decisions.get(candidateId) ?? null,
    events: eventsByRef.get(candidateId) ?? [],
    line: lines.get(candidateId) ?? null,
    names,
    refunds: refundsByRef.get(candidateId) ?? [],
    viewer: { isOwner: participant.isOwner, isReviewer: participant.isReviewer },
    withFacts: true,
  });
}

export type DeductionDisputeOutcome = "accept" | "reject" | "reduce";

export type DeductionDecisionResult = {
  outcome: DeductionDisputeOutcome;
  /** What the deduction charges after the decision. */
  chargedValue: number;
  chargedAmount: number;
  /** Where the money goes back, when the month was already paid. Null when nothing is owed. */
  refundSentence: string | null;
  /** Payroll could not be re-opened for this change — the decision stands and HR is told why. */
  payrollNotices: string[];
};

/** A push whose own notice is suppressed: this path sends the decision's notice itself, and two for
 * one decision is how an employee ends up reading "a deduction was added" after winning. */
const SILENT_PUSH = {
  notify: async () => ({ ccHrIds: [], employeeNotified: false, status: "skipped" as const }),
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Everything decideDeductionDispute reads and writes. The default is the real database; a test hands in
 * stand-ins so the claim and the undo are exercised without one (tests/dispute-and-deduction-atomic.test.ts).
 */
export type DecideDeductionDisputeDeps = {
  resolveParticipant: typeof resolveCaseParticipant;
  listEvents: typeof listCaseEvents;
  loadParts: (candidateIds: string[]) => Promise<{
    candidates: Map<string, CandidateRow>;
    decisions: Map<string, DecisionRow>;
    lines: Map<string, LineRow>;
  }>;
  payrollMonthState: typeof payrollMonthState;
  withdrawDeduction: typeof withdrawDeduction;
  recordDecision: typeof recordDecision;
  pushDeduction: typeof pushDeduction;
  recommendDisputeRefund: typeof recommendDisputeRefund;
  cancelLiveRefund: typeof cancelLiveRefund;
  recordEvents: typeof recordCaseEvents;
  notify: typeof notifyDisputeCase;
  claim: typeof claimDisputeDecision;
  stampSnapshot: typeof stampDisputeDecisionSnapshot;
  release: typeof releaseDisputeDecision;
  renewClaim: typeof renewDisputeDecision;
  capture: typeof captureDeductionDisputeState;
  restore: typeof restoreDeductionDisputeState;
};

const DATABASE_DEPS: DecideDeductionDisputeDeps = {
  cancelLiveRefund,
  capture: captureDeductionDisputeState,
  claim: claimDisputeDecision,
  listEvents: listCaseEvents,
  loadParts,
  notify: notifyDisputeCase,
  payrollMonthState,
  pushDeduction,
  recommendDisputeRefund,
  recordDecision,
  recordEvents: recordCaseEvents,
  release: releaseDisputeDecision,
  renewClaim: renewDisputeDecision,
  resolveParticipant: resolveCaseParticipant,
  restore: restoreDeductionDisputeState,
  stampSnapshot: stampDisputeDecisionSnapshot,
  withdrawDeduction,
};

const ALREADY_DECIDED = "This dispute is already decided. Reopen it first, then decide it again.";

/** Did a decision complete on this case after `since`? A lapsed claim whose decision finished only lost its release. */
function decidedSince(events: DisputeCaseEvent[], since: string | null): boolean {
  const from = Date.parse(String(since ?? ""));
  return events.some(
    (event) => event.eventType === "decided" && (!Number.isFinite(from) || Date.parse(event.createdAt) >= from),
  );
}

/**
 * Decide a deduction dispute: Accept (cancel it), Reject (it stands), or Reduce to a smaller figure.
 *
 * A deduction LOCKED by a publication cannot be re-decided while its line is live — that is the
 * module's own rule — so Accept and Reduce withdraw the line first, which clears the lock, then
 * record the decision; Reduce re-pushes the smaller figure so the employee's portal shows it.
 *
 * A DECIDED CASE IS RE-DECIDED ONLY AFTER A REOPEN, the same gate a weekly-review day has
 * (digest.ts: "Reopen it first, then decide it again").
 *
 * REJECT IS A STATEMENT ABOUT THE MONEY, not just a message. Where an earlier decision on this same
 * dispute lowered or cancelled the deduction, rejecting now PUTS IT BACK — otherwise the employee is
 * told it stands while payroll charges the reduced figure, or nothing at all.
 *
 * Money already paid is never un-paid here: when the month's payroll is published or its Part 2 is
 * confirmed, the difference is recommended into the next open month's Additions → Other additions
 * (owner, 2026-10-09). Nothing in this file pays anybody.
 *
 * 🔴 ONE DECISION AT A TIME, ALL OF IT OR NONE OF IT (F-PAY-005, 2026-11-13). The decision claims the
 * case before its first write (decision-claim.ts) — a second decide of the same case is refused with a
 * Conflict before it writes anything — and re-checks "already decided" under the claim. It captures the
 * before-state of the line, the decision, the lock and the refunds, and if anything fails after its
 * first write, all of that is put back in one transaction before the error is shown. Its refund events
 * and its "decided" event are written together as its LAST write, so a failure leaves no event behind.
 * If even the undo fails, the case is marked "needs attention" rather than reading open.
 */
export async function decideDeductionDispute(
  access: AccessContext,
  input: { candidateId: string; outcome: DeductionDisputeOutcome; reducedValue?: number | null; note: string },
  deps: DecideDeductionDisputeDeps = DATABASE_DEPS,
): Promise<DeductionDecisionResult> {
  // A real request always asks the shared participant check itself; only a test's stand-in deps
  // replace it (tests/dispute-center-participants.test.ts pins the direct call).
  const participant =
    deps === DATABASE_DEPS
      ? await resolveCaseParticipant(access, "deduction", input.candidateId)
      : await deps.resolveParticipant(access, "deduction", input.candidateId);
  if (!participant.isReviewer) throw new Error("Forbidden: only the Super Admin can decide a deduction dispute.");

  // ONE DECISION PER REOPEN. Without this a decided case could be decided again behind the
  // employee's back, and worse for the money: each decision measures what it owes against whatever
  // the previous one left, so deciding twice recommended a second refund on top of the first.
  // This read is the cheap refusal; it is asked again under the claim, where it is binding.
  const eventsBefore = (await deps.listEvents("deduction", [input.candidateId])).get(input.candidateId) ?? [];
  if (isDecidedByEvents(eventsBefore)) throw conflictError(ALREADY_DECIDED);

  const claim = await deps.claim({
    claimedBy: participant.viewerHrId ?? access.loginId ?? null,
    kind: "deduction",
    ref: input.candidateId,
  });
  if (!claim.held) {
    throw conflictError(
      "This dispute is being decided right now — in another window or by another reviewer. Wait a moment, reload it, and read what was decided before deciding again.",
    );
  }

  let outcome: Awaited<ReturnType<typeof decideUnderClaim>>;
  try {
    outcome = await decideUnderClaim(access, input, deps, participant, claim);
  } finally {
    // Only this decision's own claim, by its token. Release throws when the claim was no longer held;
    // by then this decision has either finished (its own "decided" event is what any later decision
    // sees) or already answered with its undo, so that refusal is not turned into a second error. A
    // release that fails for any other reason leaves a claim that lapses by itself.
    await deps.release({ kind: "deduction", ref: input.candidateId, token: claim.token }).catch(() => undefined);
  }

  await deps.notify(outcome.notice);
  return outcome.result;
}

async function decideUnderClaim(
  access: AccessContext,
  input: { candidateId: string; outcome: DeductionDisputeOutcome; reducedValue?: number | null; note: string },
  deps: DecideDeductionDisputeDeps,
  participant: Awaited<ReturnType<typeof resolveCaseParticipant>>,
  claim: Extract<Awaited<ReturnType<typeof claimDisputeDecision>>, { held: true }>,
): Promise<{ result: DeductionDecisionResult; notice: Parameters<typeof notifyDisputeCase>[0] }> {
  // The note is OPTIONAL (owner, 2026-10-18): the Super Admin may accept, reduce or reject with or
  // without words. Everything below that quotes the note does so only when there is one.
  const note = tidyDisputeText(input.note);
  const noteSuffix = note ? `: ${note}` : "";

  // Asked again UNDER the claim: a decision that finished between the first read and the claim is seen here.
  const events = (await deps.listEvents("deduction", [input.candidateId])).get(input.candidateId) ?? [];
  if (isDecidedByEvents(events)) throw conflictError(ALREADY_DECIDED);

  // A decision that died after capturing its before-state, and never wrote its "decided" event, may
  // have changed the money part-way. Its before-state may be stale by now (the month's workspace can
  // have moved since), so it is not replayed blindly: the case is marked and the reviewer looks first.
  if (claim.interrupted && !decidedSince(events, claim.interrupted.claimedAt)) {
    await deps.recordEvents([
      {
        actorHrId: participant.viewerHrId,
        actorRole: access.role,
        details: {
          claimedAt: claim.interrupted.claimedAt,
          reason: "An earlier decision stopped before it finished.",
          snapshot: claim.interrupted.snapshot,
        },
        eventType: "decision_interrupted",
        kind: "deduction",
        note: null,
        ref: input.candidateId,
      },
    ]);
    throw conflictError(
      "An earlier decision on this dispute stopped before it finished and may have changed the deduction part-way. The dispute is marked \"needs attention\": check its decision, payslip line and any money back in that month's Deductions workspace, then decide it again.",
    );
  }

  const { candidates, decisions, lines } = await deps.loadParts([input.candidateId]);
  const candidate = candidates.get(input.candidateId);
  if (!candidate) throw notFoundError("That deduction no longer exists.");
  const decisionBefore = decisions.get(input.candidateId) ?? null;
  const line = lines.get(input.candidateId) ?? null;
  const unit = candidate.unit === "amount" ? "amount" : "days";
  const activeLine = line && line.line_status === "active" ? line : null;
  // What payroll charges before this decision: the DECISION's figure, never the line's (payrollCharge).
  const before = payrollCharge(candidate, decisionBefore);
  const chargedBefore = before.amount;
  const monthKey = normalizeMonthKey(String(candidate.month_key ?? ""));
  const employeeHrId = candidate.employee_hr_id ?? candidate.employee_hr_id_compact ?? "";
  const inUnit = (value: number) => (unit === "days" ? daysLabel(value) : moneyLabel(value));
  // Nobody has decided the deduction yet — the employee disputed it before HR did.
  const undecided = isUndecidedDeductionStatus(decisionBefore?.decision_status);

  let reduced: number | null = null;
  if (input.outcome === "reduce") {
    reduced = Number(input.reducedValue);
    if (!Number.isFinite(reduced) || reduced <= 0) {
      throw new Error(
        unit === "days"
          ? "Validation: type how many days to charge. To cancel it completely, accept the dispute instead."
          : "Validation: type the amount to charge. To cancel it completely, accept the dispute instead.",
      );
    }
    // THE CEILING IS WHAT THE DEDUCTION CHARGES NOW, so the word "reduce" can only ever lower it —
    // except a deduction nobody has decided yet (owner, 2026-11-13: an employee may dispute before the
    // money is taken), whose one figure is what was detected: reducing it charges part of that.
    const ceiling = undecided ? num(candidate.raw_value) : before.value;
    if (!(ceiling > 0)) {
      throw conflictError(
        `This deduction charges nothing at the moment — the decision on record is "${
          decisionBefore?.decision_status ?? "Pending"
        }". There is nothing to reduce: reject the dispute to leave it as it is.`,
      );
    }
    if (reduced >= ceiling) {
      throw new Error(
        `Validation: ${inUnit(reduced)} is not less than the ${inUnit(
          ceiling,
        )} charged now. Reject the dispute to leave it as it is.`,
      );
    }
  }

  const actor = { hrId: access.hrId ?? null, loginId: access.loginId ?? null, role: access.role };
  const monthState = await deps.payrollMonthState(monthKey);
  const payrollNotices: string[] = [];
  let chargedValue = before.value;
  let chargedAmount = chargedBefore;

  // THE BEFORE-STATE, captured and kept on the claim before the first write — so a failure below can
  // put it all back, and a decision that dies outright is known to have died.
  const snapshot = await deps.capture(input.candidateId);
  await deps.stampSnapshot({ kind: "deduction", ref: input.candidateId, snapshot, token: claim.token });

  // Every write goes through here, so the undo knows whether there is anything to undo — and WHAT this
  // attempt left: the state is re-read after each write, so the undo puts a row back only while it is
  // still as this attempt left it, never over a change the Deductions workspace or a push made since.
  // A decision write is pinned to the updated_at its own write returned: if anybody wrote the decision
  // between that write and the re-read, the pin cannot match and the undo leaves the decision alone.
  let wrote = false;
  let left: DeductionDisputeSnapshot = snapshot;
  // The revision of the decision as THIS attempt last wrote it, held for every later re-read too, so a
  // write by somebody else after it is never taken as this attempt's own, however many writes follow.
  let decisionWeWrote: string | null = null;
  // A step that THREW, or whose re-read failed, may have committed anyway — a write whose reply was lost
  // is indistinguishable from one that never ran. Its outcome is UNKNOWN: the undo still puts back what
  // is known, but the reviewer is never told "put back", and the case is marked "needs attention" with
  // this step named. Never re-read after the failure and adopt what is there as this attempt's own —
  // that would revert a push or a workspace save somebody else made meanwhile.
  let uncertainStep: string | null = null;
  const write = async <T>(
    stepName: string,
    step: () => Promise<T>,
    revisionOf?: (result: T) => string | null | undefined,
  ): Promise<T> => {
    wrote = true;
    let result: T;
    try {
      result = await step();
    } catch (error) {
      uncertainStep ??= stepName;
      throw error;
    }
    decisionWeWrote = revisionOf?.(result) ?? decisionWeWrote;
    try {
      left = await deps.capture(input.candidateId);
    } catch (error) {
      uncertainStep ??= `${stepName} (it ran, but what it left could not be read back)`;
      throw error;
    }
    if (decisionWeWrote && left.decision && String(left.decision.updated_at ?? "") !== decisionWeWrote) {
      left = { ...left, decision: { ...left.decision, updated_at: decisionWeWrote } };
    }
    return result;
  };
  const decisionRevision = (decision: { updatedAt?: string | null }) => decision.updatedAt ?? null;
  // The refund events go out WITH the "decided" event, as one insert, as the last write.
  const deferredEvents: CaseEventInput[] = [];
  let refundSentence: string | null = null;

  try {
    if (input.outcome !== "reject") {
      // The line comes off first: it is what makes the candidate re-decidable, and for Accept it is
      // the change itself.
      if (activeLine) {
        const withdrawn = await write("taking the line off the payslip", () => deps.withdrawDeduction({ actor, lineId: activeLine.id }));
        if (!withdrawn.ok) throw conflictError(`This deduction could not be taken off the payslip: ${withdrawn.reason}`);
      }
      const decision = await write("recording the decision", () =>
        deps.recordDecision({
          actor,
          candidateId: input.candidateId,
          decisionReason:
            input.outcome === "accept"
              ? `Dispute accepted${noteSuffix}`
              : `Dispute accepted in part — charged ${inUnit(reduced as number)}${noteSuffix}`,
          decisionStatus: input.outcome === "accept" ? "Do Not Take Action" : "Approved for Payroll",
          hrNote: note,
          ...(input.outcome === "reduce" ? { appliedValue: reduced as number } : {}),
        }),
        decisionRevision,
      );
      payrollNotices.push(...decision.payrollNotices);
      chargedValue = input.outcome === "accept" ? 0 : num(decision.appliedValue);
      chargedAmount = input.outcome === "accept" ? 0 : roundCurrency(num(decision.appliedAmount));

      if (input.outcome === "reduce") {
        // Back on the payslip at the smaller figure.
        const pushed = await write("putting the line on the payslip", () =>
          deps.pushDeduction({ actor, candidateId: input.candidateId, deps: SILENT_PUSH, monthKey }),
        );
        chargedAmount = roundCurrency(num(pushed.appliedAmount));
      }
    } else if (undecided) {
      // REJECT ON A DEDUCTION NOBODY HAS DECIDED — owner, 2026-11-13: "if reject then deduct". Leaving it
      // Pending would charge nothing, so "the deduction stands" would be a sentence and not a figure: the
      // rejection approves it for payroll at what was detected, and puts it on the employee's payslip view.
      const approved = await write("recording the decision", () =>
        deps.recordDecision({
          actor,
          candidateId: input.candidateId,
          decisionReason: `Dispute rejected — the deduction is taken${noteSuffix}`,
          decisionStatus: "Approved for Payroll",
          hrNote: note,
        }),
        decisionRevision,
      );
      payrollNotices.push(...approved.payrollNotices);
      chargedValue = num(approved.appliedValue);
      chargedAmount = roundCurrency(num(approved.appliedAmount));
      const pushed = await write("putting the line on the payslip", () =>
        deps.pushDeduction({ actor, candidateId: input.candidateId, deps: SILENT_PUSH, monthKey }),
      ).catch(() => null);
      if (pushed) chargedAmount = roundCurrency(num(pushed.appliedAmount));
      else {
        payrollNotices.push(
          `The ${monthKeyLabel(monthKey)} deduction is approved for payroll at ${moneyLabel(
            chargedAmount,
          )}, but its line could not be put on the employee's payslip view — push it from that month's Deductions workspace.`,
        );
      }
    } else {
      // REJECT — "the deduction stands". Where an earlier decision on THIS dispute lowered it, that
      // sentence is only true if the charge goes back: the first decision's own event recorded what
      // was charged before the dispute touched it, which is the one honest basis for restoring it.
      const firstDecision = events.find((event) => event.eventType === "decided");
      const details = (firstDecision?.details ?? {}) as Record<string, unknown>;
      const rawAmount = Number(details.chargedBefore ?? Number.NaN);
      const amountBefore = Number.isFinite(rawAmount) ? roundCurrency(rawAmount) : Number.NaN;
      const valueBefore = Number(details.chargedValueBefore ?? Number.NaN);
      if (Number.isFinite(amountBefore) && amountBefore > chargedBefore) {
        if (Number.isFinite(valueBefore) && valueBefore > 0) {
          const restored = await write("recording the decision", () =>
            deps.recordDecision({
              actor,
              appliedValue: valueBefore,
              candidateId: input.candidateId,
              decisionReason: `Dispute rejected — the deduction stands as it was charged${noteSuffix}`,
              decisionStatus: "Approved for Payroll",
              hrNote: note,
            }),
            decisionRevision,
          );
          payrollNotices.push(...restored.payrollNotices);
          chargedValue = num(restored.appliedValue);
          chargedAmount = roundCurrency(num(restored.appliedAmount));
          if (!activeLine) {
            // The earlier decision took the line off; the money is charged again either way, but the
            // employee's portal has to show it again too.
            const pushed = await write("putting the line on the payslip", () =>
              deps.pushDeduction({ actor, candidateId: input.candidateId, deps: SILENT_PUSH, monthKey }),
            ).catch(() => null);
            if (pushed) chargedAmount = roundCurrency(num(pushed.appliedAmount));
            else {
              payrollNotices.push(
                `The ${monthKeyLabel(monthKey)} deduction is charged again at ${moneyLabel(
                  chargedAmount,
                )}, but its line could not be put back on the employee's payslip view — push it from that month's Deductions workspace.`,
              );
            }
          }
        } else {
          // An event written before this path recorded the day count: the amount is known and the days
          // are not, and charging a day count nobody decided is exactly what must not happen here.
          payrollNotices.push(
            `This dispute's first decision lowered the deduction from ${moneyLabel(amountBefore)} to ${moneyLabel(
              chargedBefore,
            )}. Rejecting does not put that back by itself — restore it in the ${monthKeyLabel(
              monthKey,
            )} Deductions workspace.`,
          );
        }
      }
    }

    // What the employee is owed, if the month's money is already final.
    const owed = roundCurrency(chargedBefore - chargedAmount);
    if (monthState === "paid" && owed > 0) {
      // The earlier live refund comes off as its OWN step, re-read like every other, before the new one
      // goes in. recommendDisputeRefund would cancel it itself, but inside the same step as the insert:
      // an insert that failed after that cancel left the earlier refund cancelled while the reviewer was
      // told nothing had changed. Its own cancel then finds nothing live (or the same paid refund).
      await write("cancelling the earlier refund", () =>
        deps.cancelLiveRefund({
          actorHrId: participant.viewerHrId,
          actorRole: access.role,
          deferEvents: deferredEvents,
          kind: "deduction",
          reason: "Replaced by a newer decision on the same dispute.",
          ref: input.candidateId,
        }),
      );
      const recommended = await write("recommending the refund", () =>
        deps.recommendDisputeRefund({
          actorHrId: participant.viewerHrId,
          actorRole: access.role,
          amount: owed,
          candidateId: input.candidateId,
          deferEvents: deferredEvents,
          employeeHrId,
          kind: "deduction",
          reason: `Refund of a ${monthKeyLabel(monthKey)} deduction${noteSuffix}`,
          ref: input.candidateId,
          sourceMonthKey: monthKey,
        }),
      );
      // A refund this case ALREADY had, whose own month has since been paid, cannot be replaced — one
      // live refund per case is a database rule, so nothing new is recommended and HR is told, rather
      // than this throwing a unique violation after the decision has already moved the money.
      if (recommended.refund) refundSentence = recommended.sentence;
      else payrollNotices.push(recommended.sentence);
    } else if (owed <= 0) {
      // A live refund from an earlier, more generous decision is cancelled rather than left to pay out.
      const cancelled = await write("cancelling the earlier refund", () =>
        deps.cancelLiveRefund({
          actorHrId: participant.viewerHrId,
          actorRole: access.role,
          deferEvents: deferredEvents,
          kind: "deduction",
          reason: `Replaced by a newer decision on the same dispute${noteSuffix}`,
          ref: input.candidateId,
        }),
      );
      if (cancelled.alreadyPaid) {
        payrollNotices.push(
          `${moneyLabel(cancelled.alreadyPaid.amount)} was already refunded in ${monthKeyLabel(cancelled.alreadyPaid.targetMonthKey)} payroll, which is now paid. Settle the difference by hand.`,
        );
      }
    }

    // Immediately before the last write, prove the claim is still this decision's (and renew it). One
    // that lapsed and was taken over stops here: what this attempt changed is put back below, and the
    // reviewer gets a Conflict — never a decision finished on a case somebody else now holds.
    await deps.renewClaim({ kind: "deduction", ref: input.candidateId, token: claim.token });

    // THE LAST WRITE: the refund events and the decision's own event, in one insert. Not re-read after:
    // once the "decided" event is in, the decision is whole and there is nothing to undo.
    wrote = true;
    const timelineBefore = new Set(events.map((event) => event.id));
    const lastWrite = deps.recordEvents([
      ...deferredEvents,
      {
        actorHrId: participant.viewerHrId,
        actorRole: access.role,
        details: {
          chargedAfter: chargedAmount,
          chargedBefore,
          // The FIGURE behind each amount, in the candidate's own unit. `chargedValueBefore` is what a
          // later REJECT restores the deduction to, and an amount alone cannot be restored: a day count
          // is what `recordDecision` takes, and it scales the money from the candidate's own estimate.
          chargedValueAfter: chargedValue,
          chargedValueBefore: before.value,
          monthKey,
          outcome: input.outcome,
          payrollMonthState: monthState,
          ...(reduced == null ? {} : { reducedTo: reduced }),
        },
        eventType: "decided",
        kind: "deduction",
        note,
        ref: input.candidateId,
      },
    ]);
    try {
      await lastWrite;
    } catch (insertError) {
      // A lost reply: the insert may have landed. Under the claim the case was not decided, so a
      // "decided" event that is new since then is this decision's own — and then the decision IS made,
      // and undoing it would take back money a recorded decision moved.
      let landed: boolean | null;
      try {
        const now = (await deps.listEvents("deduction", [input.candidateId])).get(input.candidateId) ?? [];
        landed = now.some((event) => event.eventType === "decided" && !timelineBefore.has(event.id));
      } catch {
        landed = null;
      }
      if (landed !== true) {
        if (landed === null) uncertainStep ??= "recording the decision on the case timeline";
        throw insertError;
      }
    }
  } catch (error) {
    // Nothing written yet: a plain refusal, exactly as it was raised.
    if (!wrote) throw error;
    throw await undoHalfDecision({ access, deps, error, input, left, monthKey, participant, snapshot, uncertainStep });
  }

  const headline =
    input.outcome === "accept"
      ? `Your dispute was accepted — the ${monthKeyLabel(monthKey)} deduction is cancelled.`
      : input.outcome === "reduce"
        ? `Your dispute was accepted in part — the ${monthKeyLabel(monthKey)} deduction is now ${
            unit === "days" ? daysLabel(chargedValue) : moneyLabel(chargedValue)
          } (${moneyLabel(chargedAmount)}).`
        : undecided
          ? `Your dispute was rejected — the ${monthKeyLabel(monthKey)} deduction is taken from your salary (${moneyLabel(
              chargedAmount,
            )}).`
          : `Your dispute was reviewed and the ${monthKeyLabel(monthKey)} deduction stands.`;

  return {
    notice: {
      actorHrId: participant.viewerHrId,
      audience: "employee",
      employeeHrId,
      eventKey: `decided:${new Date().toISOString()}`,
      kind: "deduction",
      message: [headline, note, refundSentence].filter(Boolean).join("\n\n"),
      recipientHrIds: [employeeHrId],
      ref: input.candidateId,
      title: `Deduction dispute decided — ${monthKeyLabel(monthKey)}`,
    },
    result: { chargedAmount, chargedValue, outcome: input.outcome, payrollNotices, refundSentence },
  };
}

/**
 * A decision failed after its first write. Put the before-state back in one transaction and say that
 * nothing changed; if that fails too, mark the case "needs attention" in its own timeline — never leave
 * it reading open while the money says otherwise. Returns the error to throw.
 */
async function undoHalfDecision(input: {
  access: AccessContext;
  deps: DecideDeductionDisputeDeps;
  error: unknown;
  input: { candidateId: string; outcome: DeductionDisputeOutcome };
  monthKey: string;
  participant: Awaited<ReturnType<typeof resolveCaseParticipant>>;
  snapshot: DeductionDisputeSnapshot;
  /** What this attempt left after its last successful write — the undo touches only rows still like this. */
  left: DeductionDisputeSnapshot;
  /** A step whose outcome is unknown (it threw, or its re-read failed): "put back" can never be said. */
  uncertainStep: string | null;
}): Promise<Error> {
  const reason = messageOf(input.error);
  let restoreFailure: unknown = null;
  try {
    await input.deps.restore({
      actor: input.participant.viewerHrId ?? input.access.loginId ?? null,
      left: input.left,
      snapshot: input.snapshot,
    });
  } catch (restoreError) {
    restoreFailure = restoreError;
  }
  if (restoreFailure == null && input.uncertainStep == null) {
    return conflictError(
      `The decision did not save (${reason}). Everything it had started to change was put back — the deduction, its payslip line and any money back are exactly as they were, and the dispute is still open. Decide again.`,
    );
  }
  if (restoreFailure == null) {
    // What is known was put back, but the failed step may have committed before it failed, and what it
    // did is exactly what the undo cannot see. Never "put back"; the case is marked.
    restoreFailure = new Error(
      `the step "${input.uncertainStep}" failed and may already have changed the deduction before it did; everything before it was put back`,
    );
  }
  await input.deps
    .recordEvents([
      {
        actorHrId: input.participant.viewerHrId,
        actorRole: input.access.role,
        details: {
          error: reason,
          monthKey: input.monthKey,
          outcome: input.input.outcome,
          // The rows somebody else changed after this attempt wrote them, which the undo left alone.
          ...(restoreFailure instanceof DisputeUndoConflictError ? { conflicts: restoreFailure.conflicts } : {}),
          ...(input.uncertainStep ? { uncertainStep: input.uncertainStep } : {}),
          left: input.left,
          restoreError: messageOf(restoreFailure),
          snapshot: input.snapshot,
        },
        eventType: "decision_interrupted",
        kind: "deduction",
        note: null,
        ref: input.input.candidateId,
      },
    ])
    .catch(() => undefined);
  return conflictError(
    `The decision stopped half-way${input.uncertainStep ? ` while ${input.uncertainStep}` : ""} (${reason}) and what it had already changed could NOT be put back (${messageOf(
      restoreFailure,
    )}). The dispute is marked "needs attention": check this deduction's decision, payslip line and any money back in the ${monthKeyLabel(
      input.monthKey,
    )} Deductions workspace, then decide it again.`,
  );
}

/** The employee asks for a decided deduction dispute to be looked at again. */
export async function requestDeductionReopen(
  access: AccessContext,
  input: { candidateId: string; reason: string },
): Promise<void> {
  const participant = await resolveCaseParticipant(access, "deduction", input.candidateId);
  if (!participant.isOwner) throw new Error("Forbidden: only the employee this deduction belongs to can ask for it to be looked at again.");
  const reason = tidyDisputeText(input.reason);
  if (!reason) throw new Error("Validation: say why it should be looked at again.");
  const events = (await listCaseEvents("deduction", [input.candidateId])).get(input.candidateId) ?? [];
  if (!isDecidedByEvents(events)) throw conflictError("This dispute is still open — reply in the conversation instead.");
  const latest = events.filter((event) => ["reopen_requested", "reopened", "reopen_declined"].includes(event.eventType)).at(-1);
  if (latest?.eventType === "reopen_requested") {
    throw conflictError("You have already asked for this to be looked at again. It is with the reviewer.");
  }

  const { candidates } = await loadParts([input.candidateId]);
  const candidate = candidates.get(input.candidateId);
  if (!candidate) throw notFoundError("That deduction no longer exists.");
  const shownName = nameFor(await resolvePeopleNames([candidate.employee_hr_id]), candidate.employee_hr_id);
  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: { monthKey: candidate.month_key },
    eventType: "reopen_requested",
    kind: "deduction",
    note: reason,
    ref: input.candidateId,
  });
  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "reviewer",
    employeeHrId: candidate.employee_hr_id ?? "",
    eventKey: `reopen_requested:${new Date().toISOString()}`,
    kind: "deduction",
    message: `${shownName ?? candidate.employee_name ?? "An employee"} asked you to look again at the ${monthKeyLabel(String(candidate.month_key ?? ""))} ${categoryLabel(candidate.category)} deduction: "${reason}"`,
    recipientHrIds: await reviewerHrIdsFor("deduction", candidate.employee_hr_id ?? null),
    ref: input.candidateId,
    title: `Reopen asked — ${categoryLabel(candidate.category)} deduction`,
  });
}

/**
 * The reviewer reopens a decided deduction dispute, or declines. Reopening changes no money: it puts
 * the case back to waiting on the reviewer, and the next decision does whatever it does — including
 * recommending a refund if the month has since been paid.
 */
export async function decideDeductionReopen(
  access: AccessContext,
  input: { candidateId: string; grant: boolean; note: string },
): Promise<void> {
  const participant = await resolveCaseParticipant(access, "deduction", input.candidateId);
  if (!participant.isReviewer) throw new Error("Forbidden: only the Super Admin can reopen a deduction dispute.");
  // The note is OPTIONAL (owner, 2026-10-18).
  const note = tidyDisputeText(input.note);
  const { candidates } = await loadParts([input.candidateId]);
  const candidate = candidates.get(input.candidateId);
  if (!candidate) throw notFoundError("That deduction no longer exists.");
  const employeeHrId = candidate.employee_hr_id ?? "";
  const monthLabel = monthKeyLabel(String(candidate.month_key ?? ""));

  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: { monthKey: candidate.month_key },
    eventType: input.grant ? "reopened" : "reopen_declined",
    kind: "deduction",
    note,
    ref: input.candidateId,
  });
  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "employee",
    employeeHrId,
    eventKey: `${input.grant ? "reopened" : "reopen_declined"}:${new Date().toISOString()}`,
    kind: "deduction",
    message: (input.grant
      ? `The ${monthLabel} ${categoryLabel(candidate.category)} deduction is being looked at again. ${note}`
      : `The decision on the ${monthLabel} ${categoryLabel(candidate.category)} deduction stands. ${note}`
    ).trim(),
    recipientHrIds: [employeeHrId],
    ref: input.candidateId,
    title: input.grant ? `Reopened — ${categoryLabel(candidate.category)} deduction` : `Decision stands — ${categoryLabel(candidate.category)} deduction`,
  });
}

/** Exported for the inbox badge and the tests: whose turn it is, by canonical HR id. */
export function isOwnDeductionCase(viewerHrId: string | null, candidateOwnerHrId: string | null): boolean {
  return Boolean(canonicalHrIdKey(viewerHrId)) && compactDeductionsHrId(viewerHrId) === compactDeductionsHrId(candidateOwnerHrId);
}
