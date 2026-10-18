import { writeAuditLog } from "@/lib/admin/audit";
import { canReviewDisputes, reviewDispute } from "@/lib/attendance/digest-service.ts";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { conflictError, notFoundError, validationError } from "@/lib/http/api-errors";
import { hrIdForStorage, hrIdsMatch } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { listDisputeCenterAttachments, storeDisputeCenterAttachments } from "./attachment-store.ts";
import type { CheckedDisputeImage } from "./attachment-rules.ts";
import { loadDayFacts, loadEmployeeProfileFacts } from "./day-evidence.ts";
import { applyDigestRevisionToDeduction } from "./digest-money.ts";
import { listCaseEvents, nameFor, recordCaseEvent, resolvePeopleNames } from "./events.ts";
import { notifyDisputeCase, reviewerHrIdsFor } from "./notify.ts";
import { resolveCaseParticipant, viewerHrIdOf } from "./participants.ts";
import { listRefundsForCases } from "./refunds.ts";
import { compareCasesForReviewer, deriveDisputeCaseState, lastActivityAt, reopenedSince } from "./state.ts";
import { dayLabel, daysLabel, moneyLabel, picturesNotice, picturesOnlyBody, tidyDisputeText } from "./text.ts";
import type { DisputeCase, DisputeCaseEvent, DisputeCaseFact, DisputeMessage } from "./types.ts";

// WEEKLY ATTENDANCE REVIEW DISPUTES in the Dispute Center's shape — the third module the owner named
// ("And something you are forgetting, the weekly digest disputes", 2026-10-09).
//
// What it had: the employee typed a reason into the line, a reviewer upheld or rejected it, and that
// was the end — no conversation, no pictures, no way back once decided, and `listPendingDisputes`
// only ever showed days still waiting (capped at 200), so a decided dispute vanished from both sides.
//
// What it has now: a two-way thread with pictures (`attendance_digest_dispute_messages` +
// `dispute_attachments`), every dispute listed whatever its outcome, and a reopen the employee asks
// for and the reviewer grants. A revised decision cannot re-settle the day — a settlement is
// immutable and one per day — so it moves the LINE through `phx_attendance_revise_digest_dispute`,
// which also gives back a leave day spent on it, and the money side goes through digest-money.ts.

const MESSAGE_COLUMNS = "id, line_id, author_hr_id, author_is_reviewer, body, created_at";
const MESSAGE_MAX_LENGTH = 2000;

type MessageRow = {
  author_hr_id: string;
  author_is_reviewer: boolean;
  body: string;
  created_at: string;
  id: string;
  line_id: number;
};

type LineRow = {
  acted_at: string | null;
  action: string;
  chosen_method: string | null;
  deduct: boolean;
  deduction_days: number | string;
  deduction_value: number | string | null;
  detected_days: number | string | null;
  digest_id: number;
  dispute_reason: string | null;
  evidence: Record<string, unknown> | null;
  id: number;
  late_minutes: number | string;
  reason: string | null;
  review_notes: string | null;
  short_minutes: number | string;
  status: string;
  work_date: string;
  attendance_weekly_digests?: unknown;
};

const LINE_COLUMNS =
  "id, digest_id, work_date, status, late_minutes, short_minutes, deduction_days, deduction_value, detected_days, reason, evidence, action, chosen_method, dispute_reason, review_notes, deduct, acted_at, attendance_weekly_digests!inner(employee_hr_id, week_start, week_end, dry_run)";

type DigestHead = { dryRun: boolean; employeeHrId: string; weekEnd: string; weekStart: string };

function digestHeadOf(row: LineRow): DigestHead {
  const nested = row.attendance_weekly_digests as
    | { dry_run?: boolean; employee_hr_id?: string; week_end?: string; week_start?: string }
    | Array<{ dry_run?: boolean; employee_hr_id?: string; week_end?: string; week_start?: string }>
    | null
    | undefined;
  const head = Array.isArray(nested) ? nested[0] : nested;
  return {
    dryRun: head?.dry_run !== false,
    employeeHrId: String(head?.employee_hr_id ?? ""),
    weekEnd: String(head?.week_end ?? ""),
    weekStart: String(head?.week_start ?? ""),
  };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Replies on a set of disputed days, oldest first, with their pictures. */
export async function listDigestDisputeMessages(lineIds: number[]): Promise<Map<number, DisputeMessage[]>> {
  const byLine = new Map<number, DisputeMessage[]>();
  const ids = Array.from(new Set(lineIds.filter((id) => Number.isInteger(id))));
  if (ids.length === 0) return byLine;
  const rows: MessageRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await getSupabaseAdmin()
      .from("attendance_digest_dispute_messages")
      .select(MESSAGE_COLUMNS)
      .in("line_id", ids.slice(i, i + 200))
      .order("created_at", { ascending: true });
    if (error) {
      const code = String((error as { code?: unknown }).code ?? "");
      if (code === "PGRST205" || code === "42P01") return byLine;
      throw error;
    }
    rows.push(...((data ?? []) as MessageRow[]));
  }
  const [names, pictures] = await Promise.all([
    resolvePeopleNames(rows.map((row) => row.author_hr_id)),
    listDisputeCenterAttachments("digest", ids.map(String)),
  ]);
  for (const row of rows) {
    const list = byLine.get(row.line_id) ?? [];
    list.push({
      attachments: pictures.byMessage.get(row.id) ?? [],
      authorHrId: row.author_hr_id,
      authorName: nameFor(names, row.author_hr_id),
      body: row.body,
      createdAt: row.created_at,
      id: row.id,
      side: row.author_is_reviewer ? "reviewer" : "employee",
    });
    byLine.set(row.line_id, list);
  }
  return byLine;
}

function dayFacts(row: LineRow, head: DigestHead): DisputeCaseFact[] {
  const facts: DisputeCaseFact[] = [
    { label: "Week reviewed", value: `${dayLabel(head.weekStart)} to ${dayLabel(head.weekEnd)}` },
    { label: "What the review found", tone: "warning", value: row.reason || row.status },
    {
      label: "Charged",
      tone: "warning",
      value: `${daysLabel(num(row.deduction_days))}${row.deduction_value == null ? " (not priced)" : ` — ${moneyLabel(num(row.deduction_value))}`}`,
    },
  ];
  const detected = row.detected_days == null ? null : num(row.detected_days);
  if (detected != null && Math.abs(detected - num(row.deduction_days)) > 1e-9) {
    facts.push({ label: "Detected before the reviewer changed it", value: daysLabel(detected) });
  }
  if (num(row.late_minutes) > 0) facts.push({ label: "Late by", value: `${num(row.late_minutes)} minutes` });
  if (num(row.short_minutes) > 0) facts.push({ label: "Short by", value: `${num(row.short_minutes)} minutes` });
  for (const [key, value] of Object.entries(row.evidence ?? {})) {
    if (value == null || String(value).trim() === "") continue;
    facts.push({ label: key.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase()), value: String(value) });
  }
  facts.push({
    label: "Where it is taken from",
    value:
      row.chosen_method === "annual_balance"
        ? "The employee chose their annual leave balance"
        : row.chosen_method === "salary"
          ? "The employee chose salary"
          : "Not chosen",
  });
  return facts;
}

function decisionFor(row: LineRow, decidedByName: string | null): DisputeCase["decision"] {
  if (row.action === "dispute_upheld") {
    return {
      decidedAt: row.acted_at,
      decidedByName,
      favoursEmployee: true,
      label: "Upheld — the day is not deducted",
      note: row.review_notes,
    };
  }
  if (row.action === "dispute_rejected") {
    return {
      decidedAt: row.acted_at,
      decidedByName,
      favoursEmployee: false,
      label:
        row.chosen_method === "annual_balance"
          ? "Rejected — taken from the annual leave balance"
          : "Rejected — deducted from salary",
      note: row.review_notes,
    };
  }
  return null;
}

async function buildCase(input: {
  row: LineRow;
  head: DigestHead;
  events: DisputeCaseEvent[];
  messages: DisputeMessage[];
  openingAttachments: DisputeMessage["attachments"];
  employeeName: string;
  refunds: DisputeCase["refunds"];
  viewer: { isOwner: boolean; isReviewer: boolean };
  withFacts: boolean;
}): Promise<DisputeCase> {
  const { head, row } = input;
  const openedAt = row.acted_at ?? row.work_date;
  const decided = (row.action === "dispute_upheld" || row.action === "dispute_rejected") && !reopenedSince(input.events, row.acted_at);
  const opening: DisputeMessage = {
    attachments: input.openingAttachments,
    authorHrId: head.employeeHrId,
    authorName: input.employeeName,
    body: row.dispute_reason ?? "(no reason was recorded)",
    createdAt: openedAt,
    id: `digest-opening-${row.id}`,
    side: "employee",
  };
  let facts: DisputeCaseFact[] = [];
  let factsIncomplete = false;
  if (input.withFacts) {
    const [profile, days] = await Promise.all([
      loadEmployeeProfileFacts(head.employeeHrId),
      loadDayFacts(head.employeeHrId, [row.work_date]),
    ]);
    facts = [...profile, ...dayFacts(row, head), ...days.facts];
    factsIncomplete = days.incomplete;
  }
  return {
    canReply: input.viewer.isReviewer || !decided,
    decision: decided ? decisionFor(row, null) : null,
    deduction: undefined,
    digest: {
      action: row.action,
      chosenMethod: row.chosen_method === "annual_balance" ? "annual_balance" : row.chosen_method === "salary" ? "salary" : null,
      deductionDays: num(row.deduction_days),
      deductionValue: row.deduction_value == null ? null : num(row.deduction_value),
      workDate: row.work_date,
    },
    employeeHrId: head.employeeHrId,
    employeeName: input.employeeName,
    events: input.events,
    facts,
    factsIncomplete,
    kind: "digest",
    lastActivityAt: lastActivityAt({
      decidedAt: row.acted_at,
      events: input.events,
      messages: input.messages,
      openedAt,
    }),
    messages: input.messages,
    opening,
    openedAt,
    ref: String(row.id),
    refunds: input.refunds,
    state: deriveDisputeCaseState({ decided, events: input.events, messages: input.messages, openedAt }),
    title: `Weekly attendance — ${dayLabel(row.work_date)}`,
    viewer: input.viewer,
  };
}

async function loadLineOrThrow(lineId: number): Promise<{ head: DigestHead; row: LineRow }> {
  const { data, error } = await getSupabaseAdmin().from("attendance_digest_lines").select(LINE_COLUMNS).eq("id", lineId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That day was not found.");
  const row = data as LineRow;
  return { head: digestHeadOf(row), row };
}

/** Names for a set of HR ids, falling back to the id so a row never renders blank. */
async function employeeNames(hrIds: string[]): Promise<Map<string, string>> {
  return resolvePeopleNames(hrIds);
}

/**
 * Every weekly-review dispute the viewer may see — upheld, rejected and still open alike, uncapped
 * (the old reviewer read showed only `disputed`, 200 at a time). A reviewer sees the company's
 * disputes; anybody else sees their own.
 */
export async function listDigestCases(access: AccessContext): Promise<DisputeCase[]> {
  // The registry row for every dispute-center route declares attendance:read with a
  // domain-helper guard, so the helper is where it has to be enforced. Measured on production
  // 2026-10-09: without this an UNAUTHENTICATED GET of /api/dispute-center/cases answered 200
  // with an empty list, where the private-calendar sibling answers 403. No row leaked — each
  // list self-scopes and an anonymous caller has no hr id — but an empty 200 is not a refusal,
  // and "the list came back empty" must never be what stands in for access control.
  await assertPermission(access, "attendance", "read");
  const viewerHrId = viewerHrIdOf(access);
  const isReviewer = await canReviewDisputes({ hrId: viewerHrId, role: access.role });
  if (!isReviewer && !viewerHrId) return [];

  const rows: LineRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let query = getSupabaseAdmin()
      .from("attendance_digest_lines")
      .select(LINE_COLUMNS)
      // A dispute exists iff the employee wrote a reason: the action then moves between disputed,
      // upheld and rejected, and reading the reason keeps every outcome in the list.
      .not("dispute_reason", "is", null)
      .eq("attendance_weekly_digests.dry_run", false)
      .order("work_date", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (!isReviewer) query = query.eq("attendance_weekly_digests.employee_hr_id", viewerHrId as string);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as LineRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  if (rows.length === 0) return [];

  const lineIds = rows.map((row) => row.id);
  const refs = lineIds.map(String);
  const [messagesByLine, eventsByRef, refundsByRef, pictures, names] = await Promise.all([
    listDigestDisputeMessages(lineIds),
    listCaseEvents("digest", refs),
    listRefundsForCases("digest", refs),
    listDisputeCenterAttachments("digest", refs),
    employeeNames(rows.map((row) => digestHeadOf(row).employeeHrId)),
  ]);

  const cases = await Promise.all(
    rows.map((row) => {
      const head = digestHeadOf(row);
      const isOwner = hrIdsMatch(viewerHrId, head.employeeHrId);
      return buildCase({
        employeeName: nameFor(names, head.employeeHrId) ?? head.employeeHrId,
        events: eventsByRef.get(String(row.id)) ?? [],
        head,
        messages: messagesByLine.get(row.id) ?? [],
        openingAttachments: pictures.opening.get(String(row.id)) ?? [],
        refunds: refundsByRef.get(String(row.id)) ?? [],
        row,
        viewer: { isOwner, isReviewer: isReviewer && (access.role === "Super Admin" || !isOwner) },
        withFacts: false,
      });
    }),
  );
  return cases.sort(compareCasesForReviewer);
}

/** One weekly-review dispute in full, with the day's own record beside it. */
export async function loadDigestCase(access: AccessContext, lineId: number): Promise<DisputeCase> {
  const participant = await resolveCaseParticipant(access, "digest", String(lineId));
  const { head, row } = await loadLineOrThrow(lineId);
  const ref = String(lineId);
  const [messagesByLine, eventsByRef, refundsByRef, pictures, names] = await Promise.all([
    listDigestDisputeMessages([lineId]),
    listCaseEvents("digest", [ref]),
    listRefundsForCases("digest", [ref]),
    listDisputeCenterAttachments("digest", [ref]),
    employeeNames([head.employeeHrId]),
  ]);
  return buildCase({
    employeeName: nameFor(names, head.employeeHrId) ?? head.employeeHrId,
    events: eventsByRef.get(ref) ?? [],
    head,
    messages: messagesByLine.get(lineId) ?? [],
    openingAttachments: pictures.opening.get(ref) ?? [],
    refunds: refundsByRef.get(ref) ?? [],
    row,
    viewer: { isOwner: participant.isOwner, isReviewer: participant.isReviewer },
    withFacts: true,
  });
}

/** Post a reply on a weekly-review dispute, from either side, with pictures. */
export async function addDigestDisputeMessage(
  access: AccessContext,
  input: { lineId: number; body: string; images?: CheckedDisputeImage[] },
): Promise<DisputeMessage> {
  const participant = await resolveCaseParticipant(access, "digest", String(input.lineId));
  if (!participant.isOwner && !participant.isReviewer) {
    throw new Error("Forbidden: only the employee this day belongs to, or its reviewer, can write here.");
  }
  const images = input.images ?? [];
  let body = tidyDisputeText(input.body);
  if (!body && images.length === 0) throw validationError("Write something before sending.");
  if (!body) body = picturesOnlyBody(images.length);
  if (body.length > MESSAGE_MAX_LENGTH) throw validationError(`Keep a reply under ${MESSAGE_MAX_LENGTH} characters.`);
  const authorHrId = participant.viewerHrId;
  if (!authorHrId) throw new Error("Your employee profile is not linked. Contact HR.");

  const { head, row } = await loadLineOrThrow(input.lineId);
  const { data, error } = await getSupabaseAdmin()
    .from("attendance_digest_dispute_messages")
    .insert({
      author_hr_id: hrIdForStorage(authorHrId) ?? authorHrId,
      author_is_reviewer: participant.isReviewer && !participant.isOwner,
      body,
      line_id: input.lineId,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;
  const inserted = data as MessageRow;

  // Pictures hang off the reply's id, so they go after it; a reply whose pictures cannot be stored is
  // removed again rather than reaching the other side as half a message.
  let attachments: DisputeMessage["attachments"] = [];
  if (images.length > 0) {
    try {
      attachments = await storeDisputeCenterAttachments({
        images,
        kind: "digest",
        messageId: inserted.id,
        ref: String(input.lineId),
        uploadedByHrId: hrIdForStorage(authorHrId) ?? authorHrId,
      });
    } catch (storeError) {
      await getSupabaseAdmin().from("attendance_digest_dispute_messages").delete().eq("id", inserted.id);
      throw storeError;
    }
  }

  const names = await resolvePeopleNames([authorHrId, head.employeeHrId]);
  const authorName = nameFor(names, authorHrId);
  const toReviewer = participant.isOwner;
  await notifyDisputeCase({
    actorHrId: authorHrId,
    audience: toReviewer ? "reviewer" : "employee",
    employeeHrId: head.employeeHrId,
    eventKey: `message:${inserted.id}`,
    kind: "digest",
    message: [`${authorName ?? "Somebody"} wrote about ${dayLabel(row.work_date)}:`, body, picturesNotice(attachments.length)]
      .filter(Boolean)
      .join("\n\n"),
    recipientHrIds: toReviewer ? await reviewerHrIdsFor("digest", head.employeeHrId) : [head.employeeHrId],
    ref: String(input.lineId),
    title: `Weekly attendance dispute — ${dayLabel(row.work_date)}`,
  });

  return {
    attachments,
    authorHrId,
    authorName,
    body,
    createdAt: inserted.created_at,
    id: inserted.id,
    side: participant.isReviewer && !participant.isOwner ? "reviewer" : "employee",
  };
}

export type DigestDecisionResult = {
  upheld: boolean;
  /** What happened to the money, in one sentence. Empty on a first decision, which the module handles. */
  moneySentence: string | null;
  refundSentence: string | null;
  notices: string[];
};

/**
 * Decide a weekly-review dispute — the first time through the module's own `reviewDispute` (which
 * settles the day), a revised one through the revise RPC plus the money side here.
 *
 * The two paths are deliberately NOT merged: a first decision must write a settlement (the record
 * the leave ledger and the bridge both hang off), and a settlement is immutable and one per day, so a
 * revision cannot write a second one. It moves the line instead, and carries the month-end deduction
 * itself because the bridge only ever touches a day nobody has decided.
 */
export async function decideDigestDispute(
  access: AccessContext,
  input: { lineId: number; uphold: boolean; note: string },
): Promise<DigestDecisionResult> {
  const participant = await resolveCaseParticipant(access, "digest", String(input.lineId));
  if (!participant.isReviewer) throw new Error("Forbidden: only a dispute reviewer can decide this day.");
  const reviewerHrId = participant.viewerHrId;
  if (!reviewerHrId) throw new Error("Your employee profile is not linked. Contact HR.");
  // The note is OPTIONAL (owner, 2026-10-18).
  const note = tidyDisputeText(input.note);

  const { head, row } = await loadLineOrThrow(input.lineId);

  if (row.action === "disputed") {
    // First decision: the module's own path, unchanged. It settles the day, charges or clears it, and
    // tells the employee.
    const decided = await reviewDispute({
      lineId: input.lineId,
      notes: note,
      reviewerHrId,
      reviewerRole: access.role,
      uphold: input.uphold,
    });
    await recordCaseEvent({
      actorHrId: reviewerHrId,
      actorRole: access.role,
      details: { appliedMethod: decided.appliedMethod, first: true, upheld: input.uphold, workDate: row.work_date },
      eventType: "decided",
      kind: "digest",
      note,
      ref: String(input.lineId),
    });
    return {
      moneySentence: null,
      notices: decided.balanceRefusal
        ? [`The annual balance no longer covered ${dayLabel(row.work_date)}, so it was taken from salary.`]
        : [],
      refundSentence: null,
      upheld: input.uphold,
    };
  }

  if (row.action !== "dispute_upheld" && row.action !== "dispute_rejected") {
    throw conflictError("That day is not under dispute.");
  }

  // A revision. The reopen must have been granted first, so a decided case cannot be re-decided
  // behind the employee's back.
  const events = (await listCaseEvents("digest", [String(input.lineId)])).get(String(input.lineId)) ?? [];
  if (!reopenedSince(events, row.acted_at)) {
    throw conflictError("This day is already decided. Reopen it first, then decide it again.");
  }

  const { data, error } = await getSupabaseAdmin().rpc("phx_attendance_revise_digest_dispute", {
    p_line_id: input.lineId,
    p_notes: note,
    p_reviewer_hr_id: hrIdForStorage(reviewerHrId) ?? reviewerHrId,
    p_uphold: input.uphold,
  });
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    const message = String((error as { message?: unknown }).message ?? "The day could not be revised.");
    if (code === "40001" || code === "22023") throw conflictError(message);
    if (code === "P0002") throw notFoundError(message);
    throw new Error(message);
  }
  const result = (data ?? {}) as { changed?: boolean; restoredDays?: number | string };
  if (result.changed !== true) {
    throw conflictError(`${dayLabel(row.work_date)} is already decided that way. Choose the other outcome, or close the case as it stands.`);
  }
  const restoredDays = Number(result.restoredDays) || 0;

  const money = await applyDigestRevisionToDeduction({
    actor: { hrId: reviewerHrId, loginId: access.loginId ?? null, role: access.role },
    employeeHrId: head.employeeHrId,
    lineId: input.lineId,
    note,
    reviewerHrId,
    upheld: input.uphold,
    workDate: row.work_date,
  });

  await writeAuditLog({
    actorLoginId: access.loginId ?? reviewerHrId,
    entityId: String(input.lineId),
    entityType: "attendance_digest_dispute_review",
    newValues: { previousAction: row.action, restoredDays, revised: true, upheld: input.uphold },
    summary: `Weekly attendance dispute for ${row.work_date} revised to ${input.uphold ? "upheld" : "rejected"}`,
  });
  await recordCaseEvent({
    actorHrId: reviewerHrId,
    actorRole: access.role,
    details: {
      previousAction: row.action,
      restoredDays,
      revised: true,
      upheld: input.uphold,
      workDate: row.work_date,
    },
    eventType: "decided",
    kind: "digest",
    note,
    ref: String(input.lineId),
  });

  const leaveSentence =
    restoredDays > 0 ? `${daysLabel(restoredDays)} of annual leave is given back to the employee's balance.` : null;
  await notifyDisputeCase({
    actorHrId: reviewerHrId,
    audience: "employee",
    employeeHrId: head.employeeHrId,
    eventKey: `decided:${new Date().toISOString()}`,
    kind: "digest",
    message: [
      input.uphold
        ? `${dayLabel(row.work_date)} was looked at again and your dispute is upheld — the day is not deducted.`
        : `${dayLabel(row.work_date)} was looked at again and the deduction stands.`,
      note,
      money.sentence,
      leaveSentence,
      money.refundSentence,
    ]
      .filter(Boolean)
      .join("\n\n"),
    recipientHrIds: [head.employeeHrId],
    ref: String(input.lineId),
    title: `Weekly attendance dispute decided — ${dayLabel(row.work_date)}`,
  });

  return {
    moneySentence: [money.sentence, leaveSentence].filter(Boolean).join(" "),
    notices: money.notices,
    refundSentence: money.refundSentence,
    upheld: input.uphold,
  };
}

/** The employee asks for a decided weekly-review dispute to be looked at again. */
export async function requestDigestReopen(access: AccessContext, input: { lineId: number; reason: string }): Promise<void> {
  const participant = await resolveCaseParticipant(access, "digest", String(input.lineId));
  if (!participant.isOwner) throw new Error("Forbidden: only the employee this day belongs to can ask for it to be looked at again.");
  const reason = tidyDisputeText(input.reason);
  if (!reason) throw validationError("Say why it should be looked at again.");
  const { head, row } = await loadLineOrThrow(input.lineId);
  if (row.action === "disputed") throw conflictError("This day is still waiting for a decision.");
  if (row.action !== "dispute_upheld" && row.action !== "dispute_rejected") throw conflictError("This day was never disputed.");

  const events = (await listCaseEvents("digest", [String(input.lineId)])).get(String(input.lineId)) ?? [];
  const latest = events.filter((event) => ["reopen_requested", "reopened", "reopen_declined"].includes(event.eventType)).at(-1);
  if (latest?.eventType === "reopen_requested") {
    throw conflictError("You have already asked for this to be looked at again. It is with the reviewer.");
  }
  if (latest?.eventType === "reopened") throw conflictError("This day is already being looked at again.");

  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: { actionAtRequest: row.action, workDate: row.work_date },
    eventType: "reopen_requested",
    kind: "digest",
    note: reason,
    ref: String(input.lineId),
  });
  const names = await resolvePeopleNames([head.employeeHrId]);
  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "reviewer",
    employeeHrId: head.employeeHrId,
    eventKey: `reopen_requested:${new Date().toISOString()}`,
    kind: "digest",
    message: `${nameFor(names, head.employeeHrId) ?? "An employee"} asked you to look again at ${dayLabel(row.work_date)}: "${reason}"`,
    recipientHrIds: await reviewerHrIdsFor("digest", head.employeeHrId),
    ref: String(input.lineId),
    title: `Reopen asked — weekly attendance ${dayLabel(row.work_date)}`,
  });
}

/**
 * The reviewer reopens a decided weekly-review dispute, or declines.
 *
 * Reopening changes nothing by itself — no settlement is undone, no money moves. It records that the
 * case is open again, which is what lets `decideDigestDispute` take a revised decision; until a
 * revision is taken the day stands exactly as it was decided.
 */
export async function decideDigestReopen(
  access: AccessContext,
  input: { lineId: number; grant: boolean; note: string },
): Promise<void> {
  const participant = await resolveCaseParticipant(access, "digest", String(input.lineId));
  if (!participant.isReviewer) throw new Error("Forbidden: only a dispute reviewer can reopen this day.");
  // The note is OPTIONAL (owner, 2026-10-18).
  const note = tidyDisputeText(input.note);
  const { head, row } = await loadLineOrThrow(input.lineId);
  if (row.action !== "dispute_upheld" && row.action !== "dispute_rejected") throw conflictError("This day is not decided.");

  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: {
      previousAction: row.action,
      previousDecidedAt: row.acted_at,
      previousMethod: row.chosen_method,
      workDate: row.work_date,
    },
    eventType: input.grant ? "reopened" : "reopen_declined",
    kind: "digest",
    note,
    ref: String(input.lineId),
  });
  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "employee",
    employeeHrId: head.employeeHrId,
    eventKey: `${input.grant ? "reopened" : "reopen_declined"}:${new Date().toISOString()}`,
    kind: "digest",
    message: (input.grant
      ? `${dayLabel(row.work_date)} is being looked at again. ${note}`
      : `The decision on ${dayLabel(row.work_date)} stands. ${note}`
    ).trim(),
    recipientHrIds: [head.employeeHrId],
    ref: String(input.lineId),
    title: input.grant
      ? `Reopened — weekly attendance ${dayLabel(row.work_date)}`
      : `Decision stands — weekly attendance ${dayLabel(row.work_date)}`,
  });
}
