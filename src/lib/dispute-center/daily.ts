import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { getActiveDailyPublication, mapDailyLineRow } from "@/lib/daily-deductions/service.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { isDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { deductionsCategoryNames, type DeductionsCategory } from "@/lib/deductions/types.ts";
import { withdrawDailyLine } from "@/lib/daily-deductions/release.ts";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { hrIdForStorage } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { listDisputeCenterAttachments, storeDisputeCenterAttachments } from "./attachment-store.ts";
import type { CheckedDisputeImage } from "./attachment-rules.ts";
import { loadDayFacts, loadEmployeeProfileFacts } from "./day-evidence.ts";
import { listCaseEvents, nameFor, recordCaseEvent, resolvePeopleNames } from "./events.ts";
import { notifyDisputeCase, reviewerHrIdsFor } from "./notify.ts";
import { resolveCaseParticipant, viewerHrIdOf } from "./participants.ts";
import { compareCasesForReviewer, deriveDisputeCaseState, lastActivityAt, reopenedSince } from "./state.ts";
import { dayLabel, daysLabel, moneyLabel, picturesNotice, picturesOnlyBody, tidyDisputeText } from "./text.ts";
import type { DisputeCase, DisputeCaseEvent, DisputeCaseFact, DisputeMessage } from "./types.ts";

// DAILY DEDUCTION DISPUTES in the Dispute Center's shape (owner, 2026-11-13).
//
// The employee's Deductions page lists the daily deductions the Super Admin RELEASED during the month,
// and the release email sends the employee there with the amount — but the page had no Dispute button
// on them. This is that dispute: opened by the employee on a released line, answered and decided by the
// Super Admin (the only person who releases or withdraws a daily line), read by the Deductions module's
// company-wide readers.
//
// His decision on ACCEPT, asked as multiple choice the same day: "Withdraw + never charge" — the released
// line is withdrawn, the days show verified on his calendar (`accepted-deduction-days.ts`), and the
// month-end collection never charges those days for that type again
// (`@/lib/daily-deductions/accepted-dispute-days.ts`). REJECT keeps the line; it is charged at month end
// as usual. A decided case is reopened only by the reviewer, on the employee's request, exactly as the
// other three kinds.
//
// The dispute keeps its own copy of the line — a withdrawn line is deleted from the snapshot, and the
// case must outlive it.

export const DAILY_DISPUTE_MESSAGE_MAX_LENGTH = 4000;

const DISPUTE_COLUMNS =
  "id,line_id,publication_id,employee_hr_id,employee_hr_id_compact,employee_name,category,unit,days_count,amount,dates,range_start,range_end,reason,claim_text,status,decided_by_hr_id,decision_note,decided_at,created_by_hr_id,created_at,updated_at";
const MESSAGE_COLUMNS = "id,dispute_id,author_hr_id,author_is_reviewer,body,created_at";

type DisputeRow = {
  amount: number | string;
  category: string;
  claim_text: string;
  created_at: string;
  created_by_hr_id: string | null;
  dates: unknown;
  days_count: number | string;
  decided_at: string | null;
  decided_by_hr_id: string | null;
  decision_note: string | null;
  employee_hr_id: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  id: string;
  line_id: string;
  publication_id: string | null;
  range_end: string | null;
  range_start: string | null;
  reason: string | null;
  status: "open" | "accepted" | "rejected";
  unit: string;
  updated_at: string;
};

type MessageRow = {
  author_hr_id: string;
  author_is_reviewer: boolean;
  body: string;
  created_at: string;
  dispute_id: string;
  id: string;
};

/** What the employee's own Deductions page needs about the dispute on each released line. */
export type DailyLineDispute = {
  id: string;
  lineId: string;
  status: DisputeRow["status"];
};

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function datesOf(row: Pick<DisputeRow, "dates">): string[] {
  return Array.isArray(row.dates) ? (row.dates as unknown[]).map((value) => String(value).slice(0, 10)) : [];
}

function categoryName(category: string): string {
  return deductionsCategoryNames[category as DeductionsCategory] ?? category;
}

function titleOf(row: DisputeRow): string {
  const dates = datesOf(row);
  const when = dates.length === 1 ? dayLabel(dates[0]!) : dates.length > 1 ? `${dayLabel(dates[0]!)} – ${dayLabel(dates.at(-1)!)}` : "";
  return `Daily ${categoryName(row.category)} deduction${when ? ` — ${when}` : ""}`;
}

function datesSentence(row: DisputeRow): string {
  const dates = datesOf(row);
  return dates.length > 0 ? dates.map(dayLabel).join(", ") : "no days listed";
}

async function loadDisputeOrThrow(disputeId: string): Promise<DisputeRow> {
  const { data, error } = await getSupabaseAdmin().from("daily_deductions_disputes").select(DISPUTE_COLUMNS).eq("id", disputeId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That dispute no longer exists.");
  return data as DisputeRow;
}

async function listMessages(disputeIds: string[]): Promise<Map<string, MessageRow[]>> {
  const out = new Map<string, MessageRow[]>();
  if (disputeIds.length === 0) return out;
  for (let index = 0; index < disputeIds.length; index += 100) {
    const chunk = disputeIds.slice(index, index + 100);
    const { data, error } = await getSupabaseAdmin()
      .from("daily_deductions_dispute_messages")
      .select(MESSAGE_COLUMNS)
      .in("dispute_id", chunk)
      .order("created_at", { ascending: true });
    if (error) throw error;
    for (const row of (data ?? []) as MessageRow[]) {
      const list = out.get(row.dispute_id) ?? [];
      list.push(row);
      out.set(row.dispute_id, list);
    }
  }
  return out;
}

function decisionLabel(status: DisputeRow["status"]): string {
  if (status === "accepted") return "Accepted — the deduction is withdrawn and those days are never charged";
  if (status === "rejected") return "Rejected — the deduction stands and is charged at month end";
  return "";
}

/** The live MONTH deductions that already hold any of the disputed days — the reviewer decides those himself. */
async function loadMonthLinesHoldingDays(row: DisputeRow): Promise<Array<{ monthKey: string; dates: string[]; status: string }>> {
  const disputed = new Set(datesOf(row));
  if (disputed.size === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_candidates")
    .select("id,month_key,dates,superseded_at,deductions_decisions(decision_status)")
    .eq("employee_hr_id_compact", row.employee_hr_id_compact)
    .eq("category", row.category)
    .is("superseded_at", null);
  if (error) throw error;
  const out: Array<{ monthKey: string; dates: string[]; status: string }> = [];
  for (const candidate of (data ?? []) as Array<{ month_key: string; dates: unknown; deductions_decisions?: unknown }>) {
    const dates = Array.isArray(candidate.dates) ? (candidate.dates as unknown[]).map((value) => String(value).slice(0, 10)) : [];
    const overlap = dates.filter((date) => disputed.has(date));
    if (overlap.length === 0) continue;
    const decision = Array.isArray(candidate.deductions_decisions) ? candidate.deductions_decisions[0] : candidate.deductions_decisions;
    const status = String((decision as { decision_status?: string } | null | undefined)?.decision_status ?? "").trim() || "Pending";
    out.push({ dates: overlap, monthKey: candidate.month_key, status });
  }
  return out;
}

async function lineStillReleased(lineId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin().from("daily_deductions_lines").select("id").eq("id", lineId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

function buildCase(input: {
  row: DisputeRow;
  events: DisputeCaseEvent[];
  messages: DisputeMessage[];
  openingAttachments: DisputeMessage["attachments"];
  viewer: { isOwner: boolean; isReviewer: boolean };
  decidedByName: string | null;
  facts: DisputeCaseFact[];
  factsIncomplete: boolean;
}): DisputeCase {
  const { row } = input;
  const decided = row.status !== "open" && !reopenedSince(input.events, row.decided_at);
  const opening: DisputeMessage = {
    attachments: input.openingAttachments,
    authorHrId: row.employee_hr_id,
    authorName: row.employee_name,
    body: row.claim_text,
    createdAt: row.created_at,
    id: `daily-opening-${row.id}`,
    side: "employee",
  };
  return {
    canReply: input.viewer.isReviewer || !decided,
    decision: decided
      ? {
          decidedAt: row.decided_at,
          decidedByName: input.decidedByName,
          favoursEmployee: row.status === "accepted",
          label: decisionLabel(row.status),
          note: row.decision_note,
        }
      : null,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name ?? row.employee_hr_id,
    events: input.events,
    facts: input.facts,
    factsIncomplete: input.factsIncomplete,
    kind: "daily",
    lastActivityAt: lastActivityAt({ decidedAt: row.decided_at, events: input.events, messages: input.messages, openedAt: row.created_at }),
    messages: input.messages,
    opening,
    openedAt: row.created_at,
    ref: row.id,
    refunds: [],
    state: deriveDisputeCaseState({ decided, events: input.events, messages: input.messages, openedAt: row.created_at }),
    title: titleOf(row),
    viewer: input.viewer,
  };
}

function lineFacts(row: DisputeRow): DisputeCaseFact[] {
  const facts: DisputeCaseFact[] = [
    { label: "Deduction", value: categoryName(row.category) },
    { label: "Days released", value: datesSentence(row) },
    { label: "Released amount", value: `${moneyLabel(num(row.amount))}${row.unit === "days" ? ` for ${daysLabel(num(row.days_count))}` : ""}` },
  ];
  if (row.reason) facts.push({ label: "Why it was raised", value: row.reason });
  return facts;
}

function toMessages(rows: MessageRow[], names: Map<string, string>, pictures: Map<string, DisputeMessage["attachments"]>): DisputeMessage[] {
  return rows.map((message) => ({
    attachments: pictures.get(message.id) ?? [],
    authorHrId: message.author_hr_id,
    authorName: nameFor(names, message.author_hr_id),
    body: message.body,
    createdAt: message.created_at,
    id: message.id,
    side: message.author_is_reviewer ? ("reviewer" as const) : ("employee" as const),
  }));
}

/**
 * The employee disputes one of HIS released daily lines. Only a line in the active snapshot can be
 * disputed, and only once — a decided dispute is reopened through the Dispute Center.
 */
export async function openDailyDeductionDispute(
  access: AccessContext,
  input: { lineId: string; body: string },
): Promise<{ id: string }> {
  await assertPermission(access, "employee_profile", "read");
  const viewerHrId = viewerHrIdOf(access);
  const viewerCompact = compactDeductionsHrId(viewerHrId ?? "");
  if (!viewerHrId || !viewerCompact) throw new Error("Your employee profile is not linked. Contact HR.");
  const claim = tidyDisputeText(input.body);
  if (!claim) throw validationError("Write why you dispute this deduction first.");
  if (claim.length > DAILY_DISPUTE_MESSAGE_MAX_LENGTH) {
    throw validationError(`Keep it under ${DAILY_DISPUTE_MESSAGE_MAX_LENGTH} characters.`);
  }
  if (!input.lineId) throw validationError("Choose the deduction you dispute.");

  const publication = await getActiveDailyPublication();
  if (!publication) throw notFoundError("That deduction is no longer released.");
  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_lines")
    .select("*")
    .eq("id", input.lineId)
    .eq("publication_id", publication.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That deduction is no longer released.");
  const line = mapDailyLineRow(data as Record<string, unknown>);
  // Self-only, exactly as the page that shows the line: nobody disputes another person's deduction.
  if (compactDeductionsHrId(line.employeeHrIdCompact || line.employeeHrId) !== viewerCompact) {
    throw forbiddenError("You can only dispute your own deduction.");
  }

  const inserted = await getSupabaseAdmin()
    .from("daily_deductions_disputes")
    .insert({
      amount: line.amount,
      category: line.category,
      claim_text: claim,
      created_by_hr_id: hrIdForStorage(viewerHrId) ?? viewerHrId,
      dates: line.dates,
      days_count: line.daysCount,
      employee_hr_id: line.employeeHrId,
      employee_hr_id_compact: line.employeeHrIdCompact,
      employee_name: line.employeeName,
      line_id: line.id,
      publication_id: line.publicationId,
      range_end: line.rangeEnd || null,
      range_start: line.rangeStart || null,
      reason: line.reason,
      unit: line.unit,
    })
    .select("id")
    .single();
  if (inserted.error) {
    if ((inserted.error as { code?: string }).code === "23505") {
      throw conflictError("You already disputed this deduction. Open it in your Disputes to add to it.");
    }
    throw inserted.error;
  }
  const id = String((inserted.data as { id: string }).id);

  await notifyDisputeCase({
    actorHrId: viewerHrId,
    audience: "reviewer",
    employeeHrId: line.employeeHrId,
    eventKey: "opened",
    kind: "daily",
    message: `${line.employeeName ?? "An employee"} disputes the released ${categoryName(line.category)} deduction: "${claim}"`,
    recipientHrIds: await reviewerHrIdsFor("daily", line.employeeHrId),
    ref: id,
    title: `Daily deduction disputed — ${line.employeeName ?? "an employee"}`,
  });
  return { id };
}

/** The disputes on the viewer's OWN released lines, keyed by line id — for the Deductions page. */
export async function listOwnDailyLineDisputes(access: AccessContext): Promise<Map<string, DailyLineDispute>> {
  const out = new Map<string, DailyLineDispute>();
  const compact = compactDeductionsHrId(viewerHrIdOf(access) ?? "");
  if (!compact) return out;
  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_disputes")
    .select("id,line_id,status")
    .eq("employee_hr_id_compact", compact);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ id: string; line_id: string; status: DisputeRow["status"] }>) {
    out.set(String(row.line_id), { id: String(row.id), lineId: String(row.line_id), status: row.status });
  }
  return out;
}

/** Every daily-deduction dispute the viewer may see — open and decided alike. */
export async function listDailyCases(access: AccessContext): Promise<DisputeCase[]> {
  await assertPermission(access, "attendance", "read");
  const viewerHrId = viewerHrIdOf(access);
  const isReviewer = access.role === "Super Admin";
  const companyReader = isReviewer || isDeductionsReadActor(access);
  const compact = compactDeductionsHrId(viewerHrId ?? "");
  if (!companyReader && !compact) return [];

  const rows = await fetchAllRows<DisputeRow>(() => {
    const query = getSupabaseAdmin().from("daily_deductions_disputes").select(DISPUTE_COLUMNS).order("created_at", { ascending: false });
    return companyReader ? query : query.eq("employee_hr_id_compact", compact as string);
  }, "id");
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [messagesByDispute, eventsByRef, pictures] = await Promise.all([
    listMessages(ids),
    listCaseEvents("daily", ids),
    listDisputeCenterAttachments("daily", ids),
  ]);
  const names = await resolvePeopleNames([
    ...rows.map((row) => row.decided_by_hr_id),
    ...[...messagesByDispute.values()].flat().map((message) => message.author_hr_id),
  ]);

  return rows
    .map((row) => {
      const isOwner = Boolean(compact) && compactDeductionsHrId(row.employee_hr_id_compact) === compact;
      return buildCase({
        decidedByName: nameFor(names, row.decided_by_hr_id),
        events: eventsByRef.get(row.id) ?? [],
        facts: lineFacts(row),
        factsIncomplete: false,
        messages: toMessages(messagesByDispute.get(row.id) ?? [], names, pictures.byMessage),
        openingAttachments: pictures.opening.get(row.id) ?? [],
        row,
        viewer: { isOwner, isReviewer },
      });
    })
    .sort(compareCasesForReviewer);
}

/** One daily-deduction case in full, with the days' own record and any month deduction holding them. */
export async function loadDailyCase(access: AccessContext, disputeId: string): Promise<DisputeCase> {
  const participant = await resolveCaseParticipant(access, "daily", disputeId);
  const row = await loadDisputeOrThrow(disputeId);
  const [messagesByDispute, eventsByRef, pictures, profile, day, released, monthLines] = await Promise.all([
    listMessages([disputeId]),
    listCaseEvents("daily", [disputeId]),
    listDisputeCenterAttachments("daily", [disputeId]),
    loadEmployeeProfileFacts(row.employee_hr_id),
    loadDayFacts(row.employee_hr_id, datesOf(row)),
    lineStillReleased(row.line_id).catch(() => null),
    loadMonthLinesHoldingDays(row).catch(() => null),
  ]);
  const messages = messagesByDispute.get(disputeId) ?? [];
  const names = await resolvePeopleNames([row.decided_by_hr_id, ...messages.map((message) => message.author_hr_id)]);

  const facts: DisputeCaseFact[] = [...profile, ...lineFacts(row)];
  facts.push({
    label: "On the employee's page now",
    tone: released ? "warning" : undefined,
    value: released == null ? "Could not be read" : released ? "Yes — still released" : "No — withdrawn",
  });
  if (monthLines && monthLines.length > 0) {
    for (const line of monthLines) {
      facts.push({
        label: `Month deduction ${line.monthKey}`,
        tone: "warning",
        value: `${line.dates.map(dayLabel).join(", ")} — ${line.status}`,
      });
    }
  }
  facts.push(...day.facts);

  return buildCase({
    decidedByName: nameFor(names, row.decided_by_hr_id),
    events: eventsByRef.get(disputeId) ?? [],
    facts,
    factsIncomplete: day.incomplete || released == null || monthLines == null,
    messages: toMessages(messages, names, pictures.byMessage),
    openingAttachments: pictures.opening.get(disputeId) ?? [],
    row,
    viewer: { isOwner: participant.isOwner, isReviewer: participant.isReviewer },
  });
}

/** A reply from either side, with up to four pictures. */
export async function addDailyDisputeMessage(
  access: AccessContext,
  input: { disputeId: string; body: string; images?: CheckedDisputeImage[] },
): Promise<DisputeMessage> {
  const participant = await resolveCaseParticipant(access, "daily", input.disputeId);
  if (!participant.isOwner && !participant.isReviewer) {
    throw forbiddenError("Only the employee this deduction belongs to, or its reviewer, can write here.");
  }
  const row = await loadDisputeOrThrow(input.disputeId);
  const decided = row.status !== "open";
  if (decided && !participant.isReviewer) {
    throw conflictError("This dispute is decided. Ask for it to be looked at again instead.");
  }
  const images = input.images ?? [];
  let body = tidyDisputeText(input.body);
  if (!body && images.length === 0) throw validationError("Write something before sending.");
  if (!body) body = picturesOnlyBody(images.length);
  if (body.length > DAILY_DISPUTE_MESSAGE_MAX_LENGTH) {
    throw validationError(`Keep a reply under ${DAILY_DISPUTE_MESSAGE_MAX_LENGTH} characters.`);
  }
  const authorHrId = participant.viewerHrId;
  if (!authorHrId) throw new Error("Your employee profile is not linked. Contact HR.");
  const fromReviewer = participant.isReviewer && !participant.isOwner;

  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_dispute_messages")
    .insert({ author_hr_id: hrIdForStorage(authorHrId) ?? authorHrId, author_is_reviewer: fromReviewer, body, dispute_id: input.disputeId })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;
  const inserted = data as MessageRow;

  let attachments: DisputeMessage["attachments"] = [];
  if (images.length > 0) {
    try {
      attachments = await storeDisputeCenterAttachments({
        images,
        kind: "daily",
        messageId: inserted.id,
        ref: input.disputeId,
        uploadedByHrId: hrIdForStorage(authorHrId) ?? authorHrId,
      });
    } catch (storeError) {
      // A reply whose pictures cannot be stored is removed rather than reaching the other side as half a message.
      await getSupabaseAdmin().from("daily_deductions_dispute_messages").delete().eq("id", inserted.id);
      throw storeError;
    }
  }

  const names = await resolvePeopleNames([authorHrId]);
  const authorName = nameFor(names, authorHrId);
  await notifyDisputeCase({
    actorHrId: authorHrId,
    audience: fromReviewer ? "employee" : "reviewer",
    employeeHrId: row.employee_hr_id,
    eventKey: `message:${inserted.id}`,
    kind: "daily",
    message: [`${authorName ?? "Somebody"} wrote about the ${categoryName(row.category)} deduction:`, body, picturesNotice(attachments.length)]
      .filter(Boolean)
      .join("\n\n"),
    recipientHrIds: fromReviewer ? [row.employee_hr_id] : await reviewerHrIdsFor("daily", row.employee_hr_id),
    ref: input.disputeId,
    title: titleOf(row),
  });

  return {
    attachments,
    authorHrId,
    authorName,
    body,
    createdAt: inserted.created_at,
    id: inserted.id,
    side: fromReviewer ? "reviewer" : "employee",
  };
}

export type DailyDisputeDecisionResult = {
  moneySentence: string | null;
  notices: string[];
};

/**
 * The Super Admin's decision. ACCEPT withdraws the released line (if it is still released) and the
 * days are never charged again; REJECT keeps it. The status write is guarded on the status it read, so
 * two clicks cannot both decide.
 */
export async function decideDailyDispute(
  access: AccessContext,
  input: { disputeId: string; outcome: "accept" | "reject"; note: string },
): Promise<DailyDisputeDecisionResult> {
  const participant = await resolveCaseParticipant(access, "daily", input.disputeId);
  if (!participant.isReviewer) throw forbiddenError("Only the Super Admin decides a daily deduction dispute.");
  if (input.outcome !== "accept" && input.outcome !== "reject") throw validationError("Choose accept or reject.");
  const row = await loadDisputeOrThrow(input.disputeId);
  if (row.status !== "open") throw conflictError("This dispute is already decided. Reopen it first to decide it again.");
  const note = tidyDisputeText(input.note) || null;
  const notices: string[] = [];

  let withdrawn = false;
  if (input.outcome === "accept" && (await lineStillReleased(row.line_id))) {
    await withdrawDailyLine({ actor: access, lineId: row.line_id });
    withdrawn = true;
  }

  const now = new Date().toISOString();
  const status = input.outcome === "accept" ? "accepted" : "rejected";
  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_disputes")
    .update({ decided_at: now, decided_by_hr_id: participant.viewerHrId, decision_note: note, status, updated_at: now })
    .eq("id", input.disputeId)
    .eq("status", "open")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError("Somebody else decided this dispute while you were looking at it. Reload it.");

  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: { category: row.category, dates: datesOf(row), lineWithdrawn: withdrawn, outcome: input.outcome },
    eventType: "decided",
    kind: "daily",
    note,
    ref: input.disputeId,
  });
  await writeAuditLog({
    actorLoginId: access.loginId ?? participant.viewerHrId ?? "unknown",
    entityId: input.disputeId,
    entityType: "daily_deductions_dispute",
    newValues: { decidedAt: now, lineWithdrawn: withdrawn, status },
    summary: `Daily deduction dispute ${status}: ${row.employee_name ?? row.employee_hr_id} · ${row.category}`,
  }).catch(() => undefined);

  let moneySentence: string;
  if (input.outcome === "accept") {
    moneySentence = withdrawn
      ? `The released deduction is withdrawn, and ${datesSentence(row)} will not be charged at month end.`
      : `The deduction had already been withdrawn. ${datesSentence(row)} will not be charged at month end.`;
    const monthLines = await loadMonthLinesHoldingDays(row).catch(() => null);
    if (monthLines == null) {
      notices.push("Whether a month deduction already holds these days could not be read — check the Deductions module.");
    }
    for (const line of monthLines ?? []) {
      if (line.status === "Do Not Take Action") continue;
      notices.push(
        `The ${line.monthKey} month deduction already holds ${line.dates.map(dayLabel).join(", ")} (${line.status}). ` +
          "A collection that runs again drops these days; a line you already decided keeps your decision, so clear it in the Deductions module.",
      );
    }
  } else {
    moneySentence = "The released deduction stands, and it is charged at month end as usual.";
  }

  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "employee",
    employeeHrId: row.employee_hr_id,
    eventKey: `decided:${now}`,
    kind: "daily",
    message:
      input.outcome === "accept"
        ? `Your dispute was accepted: the ${categoryName(row.category)} deduction for ${datesSentence(row)} is cancelled.${note ? ` ${note}` : ""}`
        : `Your dispute was not accepted: the ${categoryName(row.category)} deduction for ${datesSentence(row)} stands.${note ? ` ${note}` : ""}`,
    recipientHrIds: [row.employee_hr_id],
    ref: input.disputeId,
    title: input.outcome === "accept" ? "Dispute accepted — daily deduction" : "Dispute rejected — daily deduction",
  });

  return { moneySentence, notices };
}

/** The employee asks for a decided dispute to be looked at again. It flags the case; only the reviewer reopens. */
export async function requestDailyReopen(access: AccessContext, input: { disputeId: string; reason: string }): Promise<void> {
  const participant = await resolveCaseParticipant(access, "daily", input.disputeId);
  if (!participant.isOwner) throw forbiddenError("Only the employee this dispute belongs to can ask for it to be looked at again.");
  const row = await loadDisputeOrThrow(input.disputeId);
  if (row.status === "open") throw conflictError("This dispute is already open — reply in the conversation instead.");
  const reason = tidyDisputeText(input.reason);
  if (!reason) throw validationError("Say why it should be looked at again.");
  const events = (await listCaseEvents("daily", [input.disputeId])).get(input.disputeId) ?? [];
  const pending = events.filter((event) => ["reopen_requested", "reopened", "reopen_declined"].includes(event.eventType)).at(-1);
  if (pending?.eventType === "reopen_requested") {
    throw conflictError("You have already asked for this to be looked at again. It is with the reviewer.");
  }
  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: { decisionAtRequest: row.status },
    eventType: "reopen_requested",
    kind: "daily",
    note: reason,
    ref: input.disputeId,
  });
  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "reviewer",
    employeeHrId: row.employee_hr_id,
    eventKey: `reopen_requested:${new Date().toISOString()}`,
    kind: "daily",
    message: `${row.employee_name ?? "An employee"} asked you to look again at the ${categoryName(row.category)} deduction: "${reason}"`,
    recipientHrIds: await reviewerHrIdsFor("daily", row.employee_hr_id),
    ref: input.disputeId,
    title: `Reopen asked — ${titleOf(row)}`,
  });
}

/**
 * The reviewer reopens a decided dispute, or declines the request. Reopening an ACCEPTED one puts its
 * days back in reach of month-end collection (only an accepted dispute spares days); the withdrawn
 * line is not re-released — that stays the Daily Deductions page's Release button.
 */
export async function decideDailyReopen(access: AccessContext, input: { disputeId: string; grant: boolean; note: string }): Promise<void> {
  const participant = await resolveCaseParticipant(access, "daily", input.disputeId);
  if (!participant.isReviewer) throw forbiddenError("Only the Super Admin can reopen a daily deduction dispute.");
  const row = await loadDisputeOrThrow(input.disputeId);
  const note = tidyDisputeText(input.note);

  if (!input.grant) {
    await recordCaseEvent({
      actorHrId: participant.viewerHrId,
      actorRole: access.role,
      details: { decision: row.status },
      eventType: "reopen_declined",
      kind: "daily",
      note,
      ref: input.disputeId,
    });
    await notifyDisputeCase({
      actorHrId: participant.viewerHrId,
      audience: "employee",
      employeeHrId: row.employee_hr_id,
      eventKey: `reopen_declined:${new Date().toISOString()}`,
      kind: "daily",
      message: `The decision on the ${categoryName(row.category)} deduction stands. ${note}`.trim(),
      recipientHrIds: [row.employee_hr_id],
      ref: input.disputeId,
      title: `Decision stands — ${titleOf(row)}`,
    });
    return;
  }

  if (row.status === "open") throw conflictError("This dispute is already open.");
  await recordCaseEvent({
    actorHrId: participant.viewerHrId,
    actorRole: access.role,
    details: {
      previousDecidedAt: row.decided_at,
      previousDecidedByHrId: row.decided_by_hr_id,
      previousDecision: row.status,
      previousNote: row.decision_note,
    },
    eventType: "reopened",
    kind: "daily",
    note: note || null,
    ref: input.disputeId,
  });
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_disputes")
    .update({ decided_at: null, decided_by_hr_id: null, decision_note: null, status: "open", updated_at: now })
    .eq("id", input.disputeId)
    .eq("status", row.status)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError("Somebody else changed this dispute while you were looking at it. Reload and try again.");
  await notifyDisputeCase({
    actorHrId: participant.viewerHrId,
    audience: "employee",
    employeeHrId: row.employee_hr_id,
    eventKey: `reopened:${now}`,
    kind: "daily",
    message: note
      ? `The ${categoryName(row.category)} deduction is being looked at again. ${note}`
      : `The ${categoryName(row.category)} deduction is being looked at again.`,
    recipientHrIds: [row.employee_hr_id],
    ref: input.disputeId,
    title: `Reopened — ${titleOf(row)}`,
  });
}
