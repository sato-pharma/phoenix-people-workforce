// Recruitment / ATS — reading and writing the owner's wording, answer labels, and which answers are
// offered, for the six built-in questions.
//
// The DB-touching half of whatsapp-question-prompts.ts. Read by the bot on every prompt it sends and
// by the admin screen; written only by the admin screen, behind `admin:update` (Super Admin only).
//
// READS ARE BEST-EFFORT AND NEVER THROW. A failed read returns an empty override map, which means
// every question falls back to its code default — the exact behaviour before this feature existed.
// A database hiccup must never stop an applicant being asked a question.

import { logError, logWarning } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  audienceViolations,
  type StoredAudience,
} from "@/lib/recruitment/inbound/whatsapp-question-audience";
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

/** The wording columns — everything this table held before audiences existed. */
const WORDING_COLUMNS = "question_key,body_text,option_labels,hidden_options,option_order";

/**
 * Postgres' "column does not exist". The one error code this module retries rather than swallows.
 *
 * THE DEPLOY-BEFORE-MIGRATION WINDOW IS REAL HERE, and it is wider than it looks. A merge to `main`
 * ships to production immediately while migrations are applied by hand, so there is always a period
 * where the new code is live against the old table. Without the fallback below, the audience column
 * being absent fails the WHOLE select — and because reads here are best-effort, the failure is
 * silent: every built-in question loses the owner's saved wording and answer order and reverts to
 * its code default, for as long as the window lasts, with nothing on screen saying so. Observed
 * exactly that way in dev on 2026-09-05 against production before the migration was applied.
 *
 * Retrying without the column degrades the RIGHT thing instead: the wording is served as saved, and
 * only the audiences read as unconfigured — which is the code default, the same direction every
 * other fallback in this feature takes.
 */
const UNDEFINED_COLUMN = "42703";

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
 * The audience column, read back into its THREE-state TypeScript form (see `StoredAudience`).
 *
 * The mapping is the whole reason this is a function rather than a cast. A NULL column is
 * `undefined` — nothing configured, take the code default. An EMPTY array is `[]` — a saved "ask
 * everyone", which must survive the round trip intact, because collapsing it to `undefined` here is
 * exactly how a saved widening of the area question would read back as untouched and go on asking
 * Medical Reps only. Anything that is not an array of non-blank strings is treated as nothing
 * configured: an unreadable audience must fall back to the code default rather than to "everyone".
 */
function readAudience(raw: unknown): StoredAudience {
  if (raw === null || raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const family = entry.trim();
    if (!family || out.includes(family)) continue;
    out.push(family);
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
    let { data, error } = await supabase
      .from(PROMPTS_TABLE)
      .select(`${WORDING_COLUMNS},applies_to_role_families`);
    // See UNDEFINED_COLUMN: pre-migration, ask for the wording alone rather than losing all of it.
    if (error && (error as { code?: string }).code === UNDEFINED_COLUMN) {
      logWarning("WhatsApp question audiences are not migrated yet — serving wording only", {
        labels: { event: "whatsapp_question_audience_column_missing" },
      });
      ({ data, error } = await supabase.from(PROMPTS_TABLE).select(WORDING_COLUMNS));
    }
    if (error) throw error;
    for (const row of (data ?? []) as {
      question_key: string;
      body_text: string | null;
      option_labels: unknown;
      hidden_options: unknown;
      option_order: unknown;
      /** Optional: absent on the pre-migration fallback select above, which is read as "nothing
       *  configured" by readAudience and so leaves every question on its code default. */
      applies_to_role_families?: unknown;
    }[]) {
      if (!isBuiltInPromptKey(row.question_key)) continue;
      const body = typeof row.body_text === "string" ? row.body_text.trim() : "";
      const optionLabels = readOptionLabels(row.option_labels);
      const hiddenOptions = readValueList(row.hidden_options);
      const optionOrder = readValueList(row.option_order);
      const appliesToRoleFamilies = readAudience(row.applies_to_role_families);
      // A row overriding nothing at all is skipped, so `overrides.has(key)` stays a truthful answer
      // to "has this question been customised?" on the admin screen. THE AUDIENCE COUNTS AS AN
      // OVERRIDE: narrowing a question whose wording is untouched writes a row with nothing else in
      // it, and leaving it out of this test would drop that row on the way back out — the setting
      // would save, the database would hold it, and the screen would show it as never set.
      if (
        !body &&
        Object.keys(optionLabels).length === 0 &&
        hiddenOptions.length === 0 &&
        optionOrder.length === 0 &&
        appliesToRoleFamilies === undefined
      ) {
        continue;
      }
      byKey.set(row.question_key, { appliesToRoleFamilies, body: body || null, hiddenOptions, optionLabels, optionOrder });
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
  /**
   * Who is asked this question. PRESENT means write this audience; ABSENT means leave whatever is
   * stored alone.
   *
   * Boxed rather than a plain optional field because the value ITSELF has `undefined` as a
   * meaningful state — "nothing configured, use the code default" — so an unboxed optional could not
   * tell "clear this back to the default" from "I am not editing the audience right now". That
   * distinction is what keeps the Reset-wording button on the screen from silently widening a
   * narrowed question: reset sends no audience, so the audience survives it.
   */
  audience?: { value: StoredAudience };
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

  // The audience the row will end up with. A caller that did not mention it keeps whatever is
  // stored, which is read back here rather than left out of the payload: PostgREST decides an
  // upsert's SET list from the keys it is given, so omitting the column would behave one way on an
  // update and another on an insert. Reading it and always writing it is one behaviour.
  const appliesToRoleFamilies = input.audience
    ? (input.audience.value === undefined ? undefined : readAudience(input.audience.value))
    : await loadStoredAudience(input.key);

  // Nothing overridden at all is the reset gesture, not a violation — drop the row and the defaults
  // return. The table's own not-empty CHECK refuses such a row anyway; this is the readable path to
  // the same outcome. THE AUDIENCE IS PART OF "NOTHING": a question narrowed to one job title but
  // otherwise left alone is a real override, and dropping its row here would answer the owner's save
  // with a silent revert to the code default.
  if (
    !body &&
    Object.keys(optionLabels).length === 0 &&
    hiddenOptions.length === 0 &&
    optionOrder.length === 0 &&
    appliesToRoleFamilies === undefined
  ) {
    await resetQuestionPrompt({ key: input.key });
    return;
  }

  const problems = [
    ...audienceViolations({ appliesToRoleFamilies, key: input.key }),
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
      applies_to_role_families: appliesToRoleFamilies ?? null,
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

/**
 * The audience currently stored for one question, straight from the table rather than from the TTL
 * cache — a save must merge against what is actually there, not against a snapshot up to 30 seconds
 * old that another admin may already have moved.
 *
 * A failed read returns `undefined`, which is "nothing configured". That is the same
 * narrow-not-widen direction the rest of this feature takes: if we cannot see the stored audience,
 * the row we write claims none, and the question falls back to its code default rather than
 * inheriting a guess.
 */
async function loadStoredAudience(key: string): Promise<StoredAudience> {
  try {
    const supabase = recruitmentDb();
    const { data, error } = await supabase
      .from(PROMPTS_TABLE)
      .select("applies_to_role_families")
      .eq("question_key", key)
      .maybeSingle();
    if (error) throw error;
    return readAudience((data as { applies_to_role_families?: unknown } | null)?.applies_to_role_families);
  } catch (error) {
    logError("WhatsApp question audience failed to load before save", {
      error,
      labels: { event: "whatsapp_question_audience_load_failed" },
    });
    return undefined;
  }
}

/** Removes an override so the question goes back to its wording and answers in the code. */
export async function resetQuestionPrompt(input: { key: BuiltInPromptKey }): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from(PROMPTS_TABLE).delete().eq("question_key", input.key);
  if (error) throw error;
  invalidateQuestionPromptCache();
}
