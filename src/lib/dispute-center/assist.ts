import { createOpenAiResponseText, resolveOpenAiCopilotModel } from "@/lib/ai/openai-client";
import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { factsFingerprint, verifyAssistAnswer, type AssistStatement, type VerifiedAnswer } from "./assist-verify.ts";
import { loadCalendarCase } from "./calendar.ts";
import { loadDailyCase } from "./daily.ts";
import { loadDeductionCase } from "./deduction.ts";
import { loadDigestCase } from "./digest.ts";
import { viewerHrIdOf } from "./participants.ts";
import { cairoTimeLabel, tidyDisputeText } from "./text.ts";
import type { DisputeCase, DisputeCaseFact, DisputeCaseKind } from "./types.ts";

// THE CASE BRIEFING — "he tell me what happened in details so he can make me able to detect any
// fraud … and be able to reply on any question first without re-getting back to any data but he must
// be accurate hundred percent" (owner, 2026-10-09). SUPER ADMIN ONLY, his own answer to who may use
// it ("only me").
//
// HOW IT IS KEPT HONEST. The model never queries anything and is never asked to remember anything.
// It is handed a NUMBERED PACK of facts read from Phoenix's own records — the day's calendar from all
// seven sources, the deduction's own figures, the conversation, the history — and it must answer in
// statements that each name the fact numbers they rest on. Every statement is then CHECKED
// (assist-verify.ts): a number, time or date that is not in the facts it cited gets the statement
// dropped, and the count of what was dropped is shown. A reader sees each statement beside the
// records it came from.
//
// It judges nothing and decides nothing. The words "fraud", "lying" and "guilty" are refused in the
// instructions: it reports what the record says and what does not line up, and the decision is his.

export type AssistEntryKind = "briefing" | "question";

export type AssistAnswer = VerifiedAnswer & {
  caseKind: DisputeCaseKind;
  caseRef: string;
  createdAt: string;
  entryKind: AssistEntryKind;
  /** The pack the answer was built from, so the screen can show a cited fact in full. */
  facts: DisputeCaseFact[];
  factsFingerprint: string;
  id: string | null;
  model: string | null;
  question: string | null;
  /** True when the saved answer's pack no longer matches the case's record. */
  stale?: boolean;
};

const MAX_QUESTION_LENGTH = 500;

const INSTRUCTIONS =
  "You are helping the owner of an HR system read one employee dispute. You are given numbered FACTS " +
  "taken from the company's own records, and the conversation between the employee and the reviewer. " +
  "Answer ONLY from those facts.\n\n" +
  "Rules, all of them absolute:\n" +
  "1. Every statement must list the fact numbers it rests on, in `fact_ids`. A statement citing no " +
  "fact is thrown away before anybody reads it.\n" +
  "2. Never state a number, a time, a date or an amount that does not appear in the facts you cite. " +
  "Do not convert, round, add up or re-phrase figures — quote them as they are written.\n" +
  "3. Never guess, never fill a gap, never assume what is 'usual'. When the records do not answer " +
  "something, say that they do not, citing the fact that shows the gap.\n" +
  "4. Do not accuse anybody and do not decide anything. Never use the words fraud, lying, guilty, " +
  "innocent, or suspect. Point out what does not line up and leave the judgement to the reader.\n" +
  "5. Names, never codes. Cairo times, as the facts give them.\n" +
  "6. Write plainly, for a business owner who is not an engineer. Short statements, one point each.";

const TEXT_FORMAT = {
  format: {
    name: "phoenix_dispute_briefing",
    schema: {
      additionalProperties: false,
      properties: {
        statements: {
          items: {
            additionalProperties: false,
            properties: {
              fact_ids: { items: { type: "integer" as const }, type: "array" as const },
              text: { type: "string" as const },
            },
            required: ["text", "fact_ids"],
            type: "object" as const,
          },
          type: "array" as const,
        },
      },
      required: ["statements"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

/** The conversation and the history as facts, so a statement about them is checkable too. */
function conversationFacts(dispute: DisputeCase): DisputeCaseFact[] {
  const facts: DisputeCaseFact[] = [
    { label: "Employee", value: dispute.employeeName },
    { label: "Case", value: dispute.title },
    { label: `What ${dispute.employeeName} says`, value: `${dispute.opening.body} (written ${cairoTimeLabel(dispute.opening.createdAt)})` },
  ];
  if (dispute.opening.attachments.length > 0) {
    facts.push({
      label: "Pictures attached to the claim",
      value: `${dispute.opening.attachments.length} — they are on the screen and have NOT been read here.`,
    });
  }
  for (const message of dispute.messages) {
    facts.push({
      label: `Reply from ${message.authorName ?? (message.side === "reviewer" ? "the reviewer" : dispute.employeeName)}`,
      value: `${message.body} (${cairoTimeLabel(message.createdAt)})${
        message.attachments.length > 0 ? ` — with ${message.attachments.length} picture(s), not read here` : ""
      }`,
    });
  }
  for (const event of dispute.events) {
    facts.push({
      label: `History — ${event.eventType.replace(/_/g, " ")}`,
      value: `${event.note ?? "(no note)"} (${event.actorName ?? "system"}, ${cairoTimeLabel(event.createdAt)})`,
    });
  }
  if (dispute.decision) {
    facts.push({
      label: "Decision on record",
      value: `${dispute.decision.label}${dispute.decision.note ? ` — ${dispute.decision.note}` : ""}${
        dispute.decision.decidedAt ? ` (${cairoTimeLabel(dispute.decision.decidedAt)})` : ""
      }`,
    });
  }
  for (const refund of dispute.refunds) {
    facts.push({
      label: `Refund ${refund.status}`,
      value: `${refund.amount.toFixed(2)} EGP from ${refund.sourceMonthKey} into ${refund.targetMonthKey} — ${refund.reason}`,
    });
  }
  return facts;
}

/** The whole pack, in the order the model sees it: fact 1 is the first entry. */
export function buildEvidencePack(dispute: DisputeCase): DisputeCaseFact[] {
  const facts = [...conversationFacts(dispute), ...dispute.facts];
  if (dispute.factsIncomplete) {
    facts.push({
      label: "Warning",
      tone: "warning",
      value: "Part of the record could not be read. Anything missing below is UNKNOWN, not absent.",
    });
  }
  return facts;
}

function renderPack(facts: DisputeCaseFact[]): string {
  return facts.map((fact, index) => `${index + 1}. ${fact.label}: ${fact.value}`).join("\n");
}

export async function loadDisputeCaseForAssist(
  access: AccessContext,
  kind: DisputeCaseKind,
  ref: string,
): Promise<DisputeCase> {
  if (kind === "calendar") return loadCalendarCase(access, ref);
  if (kind === "deduction") return loadDeductionCase(access, ref);
  if (kind === "daily") return loadDailyCase(access, ref);
  const lineId = Number(ref);
  if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("That day was not found.");
  return loadDigestCase(access, lineId);
}

/** His own rule: "only me". Not a permission in the matrix — the one named role. */
export function assertAssistActor(access: Pick<AccessContext, "role">) {
  if (access.role !== "Super Admin") {
    throw forbiddenError("Only the Super Admin can use the case briefing.");
  }
}

async function ask(input: {
  facts: DisputeCaseFact[];
  question: string | null;
}): Promise<{ model: string; statements: AssistStatement[] }> {
  const prompt = [
    "FACTS",
    renderPack(input.facts),
    "",
    input.question
      ? `QUESTION FROM THE OWNER: ${input.question}`
      : "TASK: brief the owner on this case. Say what the records show happened, what the employee claims, " +
        "where the two agree, and where they do not line up — each as its own statement with its fact numbers. " +
        "End with what the records do NOT answer, if anything.",
  ].join("\n");

  const response = await createOpenAiResponseText({
    component: "dispute_case_briefing",
    input: prompt,
    instructions: INSTRUCTIONS,
    maxOutputTokens: 2400,
    model: resolveOpenAiCopilotModel(),
    purpose: input.question ? "dispute_case_question" : "dispute_case_briefing",
    reasoning: { effort: "medium" },
    text: TEXT_FORMAT,
    // The pack is long and the reasoning is not the nano tier's; the shared default (25s) is
    // calibrated for a short email prompt and would time out on this.
    timeoutMs: 120_000,
  });

  let parsed: { statements?: Array<{ fact_ids?: unknown; text?: unknown }> } = {};
  try {
    parsed = JSON.parse(response.outputText || "{}");
  } catch {
    parsed = {};
  }
  return {
    model: response.model,
    statements: (parsed.statements ?? []).map((statement) => ({
      factIds: Array.isArray(statement.fact_ids) ? statement.fact_ids.map((id) => Number(id)) : [],
      text: String(statement.text ?? ""),
    })),
  };
}

/**
 * Write a briefing, or answer one question, about a case — and SAVE it, so the owner can read it
 * again without paying for it again and without the answer quietly changing under him. Saving is
 * best-effort: an answer he can read now is worth more than one that failed because its row did not
 * insert.
 */
export async function runDisputeAssist(
  access: AccessContext,
  input: { kind: DisputeCaseKind; ref: string; question?: string | null },
): Promise<AssistAnswer> {
  assertAssistActor(access);
  const question = input.question == null ? null : tidyDisputeText(input.question);
  if (question != null && !question) throw validationError("Type a question first.");
  if (question && question.length > MAX_QUESTION_LENGTH) {
    throw validationError(`Keep a question under ${MAX_QUESTION_LENGTH} characters.`);
  }

  const dispute = await loadDisputeCaseForAssist(access, input.kind, input.ref);
  const facts = buildEvidencePack(dispute);
  const asked = await ask({ facts, question });
  const verified = verifyAssistAnswer(asked.statements, facts);
  const fingerprint = factsFingerprint(facts);
  const createdAt = new Date().toISOString();

  let id: string | null = null;
  try {
    const { data } = await getSupabaseAdmin()
      .from("dispute_assist_entries")
      .insert({
        answer: { dropped: verified.dropped, statements: verified.statements } as unknown as Record<string, unknown>,
        asked_by_hr_id: viewerHrIdOf(access) ?? access.loginId ?? "unknown",
        case_kind: input.kind,
        case_ref: input.ref,
        entry_kind: question ? "question" : "briefing",
        fact_count: facts.length,
        facts_fingerprint: fingerprint,
        model: asked.model,
        question,
      })
      .select("id")
      .single();
    id = (data as { id?: string } | null)?.id ?? null;
  } catch {
    id = null;
  }

  return {
    caseKind: input.kind,
    caseRef: input.ref,
    createdAt,
    dropped: verified.dropped,
    entryKind: question ? "question" : "briefing",
    facts,
    factsFingerprint: fingerprint,
    id,
    model: asked.model,
    question,
    statements: verified.statements,
  };
}

type EntryRow = {
  answer: { dropped?: VerifiedAnswer["dropped"]; statements?: VerifiedAnswer["statements"] } | null;
  case_kind: DisputeCaseKind;
  case_ref: string;
  created_at: string;
  entry_kind: AssistEntryKind;
  facts_fingerprint: string;
  id: string;
  model: string | null;
  question: string | null;
};

/**
 * Everything already written about a case, newest first. Each is marked `stale` when the case's
 * record has changed since — a saved briefing is a point-in-time note, never current state.
 */
export async function listDisputeAssistEntries(
  access: AccessContext,
  input: { kind: DisputeCaseKind; ref: string },
): Promise<AssistAnswer[]> {
  assertAssistActor(access);
  const dispute = await loadDisputeCaseForAssist(access, input.kind, input.ref);
  const facts = buildEvidencePack(dispute);
  const fingerprint = factsFingerprint(facts);

  const { data, error } = await getSupabaseAdmin()
    .from("dispute_assist_entries")
    .select("id, case_kind, case_ref, entry_kind, question, answer, facts_fingerprint, model, created_at")
    .eq("case_kind", input.kind)
    .eq("case_ref", input.ref)
    .order("created_at", { ascending: false });
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "PGRST205" || code === "42P01") return [];
    throw error;
  }

  return ((data ?? []) as EntryRow[]).map((row) => ({
    caseKind: row.case_kind,
    caseRef: row.case_ref,
    createdAt: row.created_at,
    dropped: row.answer?.dropped ?? [],
    entryKind: row.entry_kind,
    facts,
    factsFingerprint: row.facts_fingerprint,
    id: row.id,
    model: row.model,
    question: row.question,
    stale: row.facts_fingerprint !== fingerprint,
    statements: row.answer?.statements ?? [],
  }));
}
