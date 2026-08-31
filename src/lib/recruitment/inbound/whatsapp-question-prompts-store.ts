// Recruitment / ATS — reading and writing the owner's wording, answer labels, and which answers are
// offered, for the six built-in questions.
//
// The DB-touching half of whatsapp-question-prompts.ts. Read by the bot on every prompt it sends and
// by the admin screen; written only by the admin screen, behind `admin:update` (Super Admin only).
//
// READS ARE BEST-EFFORT AND NEVER THROW. A failed read returns an empty override map, which means
// every question falls back to its code default — the exact behaviour before this feature existed.
// A database hiccup must never stop an applicant being asked a question.

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  answerConfigViolations,
  isBuiltInPromptKey,
  optionLabelViolations,
  promptViolations,
  type BuiltInPromptKey,
  type OptionLabel,
  type PromptOverride,
} from "@/lib/recruitment/inbound/whatsapp-question-prompts";

const PROMPTS_TABLE = "ats_whatsapp_question_prompts";

/** Same TTL-cache shape as the area list in whatsapp-classify-session.ts. Short on purpose: an
 *  owner who rewords a question expects to see it on the very next applicant, not in an hour. */
const CACHE_TTL_MS = 30_000;
let promptCache: { at: number; byKey: Map<string, PromptOverride> } | null = null;

/** Called after any write so the next send picks the new wording up immediately. */
export function invalidateQuestionPromptCache(): void {
  promptCache = null;
}

/**
 * Anything stored under `option_labels` is display text an admin typed, so it is re-checked on the
 * way OUT as well as on the way in — a hand-edited row, or one written before a later validation
 * rule existed, must not be able to put a malformed label in front of an applicant. Unknown shapes
 * are dropped rather than repaired: a dropped label falls back to the code's own, which is safe.
 */
function readOptionLabels(raw: unknown): Record<string, OptionLabel> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, OptionLabel> = {};
  for (const [value, label] of Object.entries(raw as Record<string, unknown>)) {
    if (!label || typeof label !== "object" || Array.isArray(label)) continue;
    const { title, description } = label as { title?: unknown; description?: unknown };
    const entry: OptionLabel = {};
    if (typeof title === "string" && title.trim().length > 0) entry.title = title.trim();
    if (typeof description === "string" && description.trim().length > 0) {
      entry.description = description.trim();
    }
    if (entry.title !== undefined || entry.description !== undefined) out[value] = entry;
  }
  return out;
}

/**
 * A stored list of answer VALUES, cleaned the same way on the way in and on the way out. Anything
 * that is not a non-blank string is dropped, and duplicates are collapsed — `applyAnswerConfig`
 * treats a repeat as a no-op anyway, so removing it here keeps the stored row honest about what it
 * actually does.
 */
function readValueList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/**
 * The saved overrides, keyed by step. An absent key means "use the code default" — this map is
 * deliberately sparse, and is empty on a fresh system and after any read failure.
 */
export async function loadQuestionPromptOverrides(): Promise<Map<string, PromptOverride>> {
  if (promptCache && Date.now() - promptCache.at < CACHE_TTL_MS) return promptCache.byKey;

  const byKey = new Map<string, PromptOverride>();
  try {
    const supabase = recruitmentDb();
    const { data, error } = await supabase
      .from(PROMPTS_TABLE)
      .select("question_key,body_text,option_labels,hidden_options,option_order");
    if (error) throw error;
    for (const row of (data ?? []) as {
      question_key: string;
      body_text: string | null;
      option_labels: unknown;
      hidden_options: unknown;
      option_order: unknown;
    }[]) {
      if (!isBuiltInPromptKey(row.question_key)) continue;
      const body = typeof row.body_text === "string" ? row.body_text.trim() : "";
      const optionLabels = readOptionLabels(row.option_labels);
      const hiddenOptions = readValueList(row.hidden_options);
      const optionOrder = readValueList(row.option_order);
      // A row overriding nothing at all is skipped, so `overrides.has(key)` stays a truthful answer
      // to "has this question been customised?" on the admin screen.
      if (
        !body &&
        Object.keys(optionLabels).length === 0 &&
        hiddenOptions.length === 0 &&
        optionOrder.length === 0
      ) {
        continue;
      }
      byKey.set(row.question_key, { body: body || null, hiddenOptions, optionLabels, optionOrder });
    }
  } catch (error) {
    // Deliberately not rethrown — see the file header. Every question falls back to its default.
    logError("WhatsApp question wording failed to load", {
      error,
      labels: { event: "whatsapp_question_prompts_load_failed" },
    });
    return new Map();
  }

  promptCache = { at: Date.now(), byKey };
  return byKey;
}

export type QuestionPromptSaveInput = {
  key: string;
  /** The new wording. Blank means "keep the code default for the prompt". */
  bodyText: string;
  /** The new answer labels, keyed by option value. Blank fields mean "keep the code's own". */
  optionLabels?: Record<string, OptionLabel>;
  /** Answer values to switch OFF. */
  hiddenOptions?: readonly string[];
  /** The order to show answers in; also what switches ON an answer not offered by default. */
  optionOrder?: readonly string[];
  /** Every answer value this question could offer — anything else is refused. */
  allowedValues?: readonly string[];
  /** The answers offered when nothing is configured. Tells "switched on" from "already on". */
  defaultOfferedValues?: readonly string[];
  actorHrId: string | null;
};

/**
 * Saves one question's wording, answer labels and answer set, or clears it back to the code defaults
 * when the admin has left nothing overridden.
 *
 * Validated BEFORE any write, with the same validators the client runs — so a prompt, an answer, or
 * an answer set that would 400 for a real applicant can never be persisted in the first place. Meta
 * refuses the whole message on an over-long body or row title, or on more than ten rows, so a bad
 * save here would not look untidy; it would stop the conversation dead for that applicant.
 */
export async function saveQuestionPrompt(input: QuestionPromptSaveInput): Promise<void> {
  if (!isBuiltInPromptKey(input.key)) {
    throw new Error(`"${input.key}" is not one of the six built-in questions.`);
  }

  const body = input.bodyText.trim();
  // Blank titles and descriptions are dropped rather than stored: an empty string here would mean
  // "show nothing", and the intent is always "go back to the default".
  const optionLabels = readOptionLabels(input.optionLabels ?? {});
  const hiddenOptions = readValueList(input.hiddenOptions ?? []);
  const optionOrder = readValueList(input.optionOrder ?? []);

  // Nothing overridden at all is the reset gesture, not a violation — drop the row and the defaults
  // return. The table's own not-empty CHECK refuses such a row anyway; this is the readable path to
  // the same outcome.
  if (
    !body &&
    Object.keys(optionLabels).length === 0 &&
    hiddenOptions.length === 0 &&
    optionOrder.length === 0
  ) {
    await resetQuestionPrompt({ key: input.key });
    return;
  }

  const problems = [
    ...(body ? promptViolations({ bodyText: body, key: input.key }) : []),
    ...optionLabelViolations({
      allowedValues: input.allowedValues ?? Object.keys(optionLabels),
      key: input.key,
      optionLabels,
    }),
  ];

  if (hiddenOptions.length > 0 || optionOrder.length > 0) {
    // Refused rather than waved through when the caller did not say what this question can offer:
    // without both lists there is nothing to check an answer set against, and an unchecked set is
    // exactly the one that empties a menu or runs it past Meta's ten rows.
    if (!input.allowedValues || !input.defaultOfferedValues) {
      throw new Error("Cannot change which answers are shown without this question's answer list.");
    }
    problems.push(
      ...answerConfigViolations({
        allowedValues: input.allowedValues,
        defaultOfferedValues: input.defaultOfferedValues,
        hiddenOptions,
        key: input.key,
        optionOrder,
      }),
    );
  }

  if (problems.length > 0) throw new Error(problems.join(" "));

  const supabase = recruitmentDb();
  const { error } = await supabase.from(PROMPTS_TABLE).upsert(
    {
      body_text: body || null,
      hidden_options: hiddenOptions,
      option_labels: optionLabels,
      option_order: optionOrder,
      question_key: input.key,
      updated_at: new Date().toISOString(),
      updated_by_hr_id: input.actorHrId,
    },
    { onConflict: "question_key" },
  );
  if (error) throw error;
  invalidateQuestionPromptCache();
}

/** Removes an override so the question goes back to its wording and answers in the code. */
export async function resetQuestionPrompt(input: { key: BuiltInPromptKey }): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from(PROMPTS_TABLE).delete().eq("question_key", input.key);
  if (error) throw error;
  invalidateQuestionPromptCache();
}
