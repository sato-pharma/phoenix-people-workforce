// Make It Happen — the one sentence Phoenix says about a plan.
//
// The numbers are decided by the engine, never here. This module only words them: a fixed,
// honest template always exists, and the language model may rephrase it — but its answer is kept
// only if every figure from the template survives verbatim, so a rewrite can never invent or
// round a number. Owner rule 2026-08-04: users never see that AI is involved, so nothing here is
// ever labelled as such, and the call stays server-side.

import { createOpenAiResponseText, hasAiApiKey, OPENAI_NANO_MODEL } from "@/lib/ai/openai-client";
import { HONESTY_SENTENCE } from "@/lib/sales/make-it-happen/engine";

/** The owner's own sentence for an out-of-reach target (2026-09-13). Declared in engine.ts. */
export { HONESTY_SENTENCE };

export type CoachFacts = {
  periodLabel: string;
  /**
   * The goal the user chose, e.g. "90%" — set only when it is not 100%, so the default wording is
   * unchanged. When set, "short" says short of THAT goal, not of the whole target.
   */
  goalLabel?: string | null;
  /** null when no target is set for the period. */
  projectedAchievementLabel: string | null;
  shortValueLabel: string | null;
  reachable: boolean | null;
  onTrack: boolean;
  earlyHistory: boolean;
  picks: Array<{ name: string; unitsLabel: string }>;
  /**
   * The Pedia halves (engine.ts rule 7), each read on its OWN target. `reachable` above is the whole
   * plan; a half carrying `shortValueLabel` falls short of the goal, and the message must say so —
   * a plan can read 100% while the Sato half pays nothing.
   */
  halves?: Array<{ label: string; achievementLabel: string; shortValueLabel: string | null }>;
};

/** One sentence per Pedia half, in the order the plan meets them. Empty for every other plan. */
export function halvesSentence(facts: CoachFacts): string {
  return (facts.halves ?? [])
    .map((half) =>
      half.shortValueLabel
        ? ` ${half.label} realistically reaches only ${half.achievementLabel} of its own target, ${half.shortValueLabel} short.`
        : ` ${half.label} reaches ${half.achievementLabel} of its own target.`,
    )
    .join("");
}

function anyHalfShort(facts: CoachFacts): boolean {
  return (facts.halves ?? []).some((half) => half.shortValueLabel != null);
}

function picksSentence(picks: CoachFacts["picks"]): string {
  if (picks.length === 0) return "";
  const parts = picks.map((pick) => `${pick.unitsLabel} units of ${pick.name}`);
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The fixed wording — also the fallback whenever the rewrite is unavailable or unfaithful. */
export function templateCoachMessage(facts: CoachFacts): string {
  const base = baseCoachMessage(facts);
  const halves = halvesSentence(facts);
  if (!halves) return base;
  // The whole plan's branch already carries the owner's sentence when IT is out of reach; a short
  // half adds it otherwise, exactly once.
  const honesty = anyHalfShort(facts) && facts.reachable !== false ? ` ${HONESTY_SENTENCE}.` : "";
  return `${base}${halves}${honesty}`;
}

function baseCoachMessage(facts: CoachFacts): string {
  const picks = picksSentence(facts.picks);
  const early = facts.earlyHistory
    ? " With only a few closed months, Phoenix reads each product from its average and the spread between those months."
    : "";

  if (facts.projectedAchievementLabel == null) {
    return picks
      ? `There is no target set for ${facts.periodLabel} yet. At your own pace, plan on ${picks}.${early}`
      : `There is no target set for ${facts.periodLabel} yet.${early}`;
  }
  if (facts.reachable === false) {
    return (
      `Realistically, your best for ${facts.periodLabel} is ${facts.projectedAchievementLabel} of target, ` +
      `${facts.shortValueLabel ?? ""} short${facts.goalLabel ? ` of your ${facts.goalLabel} goal` : ""}. ${HONESTY_SENTENCE}.` +
      (picks ? ` Focus on ${picks}.` : "") +
      early
    );
  }
  if (facts.onTrack) {
    return (
      `You are on track for ${facts.projectedAchievementLabel} of target in ${facts.periodLabel}.` +
      (picks ? ` Keep ${picks} coming and it is yours.` : "") +
      early
    );
  }
  return (
    `Phoenix will make it happen: sell ${picks || "the plan below"} and you reach ` +
    `${facts.projectedAchievementLabel} of your target for ${facts.periodLabel}.${early}`
  );
}

function figuresIn(text: string): string[] {
  return (text.match(/\d[\d,.]*%?/g) ?? []).map((figure) => figure.replace(/[.,]+$/, ""));
}

/**
 * The clause that says what the percentage MEANS. A model rewrites it into something else even
 * with every figure intact ("July to September is 24.0% of target"), so it is kept word for word.
 */
export function coachAnchorPhrase(facts: CoachFacts): string {
  if (facts.projectedAchievementLabel == null) return `There is no target set for ${facts.periodLabel}`;
  if (facts.reachable === false) return `your best for ${facts.periodLabel} is ${facts.projectedAchievementLabel} of target`;
  if (facts.onTrack) return `on track for ${facts.projectedAchievementLabel} of target`;
  return `you reach ${facts.projectedAchievementLabel} of your target`;
}

/**
 * A rewrite is shown only when it says exactly what the template says:
 *  - the anchor clause above, word for word;
 *  - the same figures, none dropped and none added;
 *  - every product name;
 *  - the owner's honesty sentence, verbatim, whenever the target is out of reach;
 *  - Phoenix in the third person — a model's "I" is how it drifts into speaking for itself;
 *  - never "you are at": the percentage is the best reachable result, not today's standing;
 *  - nothing about AI.
 * Measured 2026-09-14: unguarded rewrites dropped the honesty sentence and turned "your best is
 * 24.0%" into "you are at 24.0%".
 */
export function isFaithfulRewrite(facts: CoachFacts, template: string, rewrite: string): boolean {
  if (!rewrite || rewrite.length > template.length * 2 + 80) return false;
  if (!rewrite.toLowerCase().includes(coachAnchorPhrase(facts).toLowerCase())) return false;
  const expected = new Set(figuresIn(template));
  const got = new Set(figuresIn(rewrite));
  if (expected.size !== got.size || [...expected].some((figure) => !got.has(figure))) return false;
  if (facts.picks.some((pick) => !rewrite.includes(pick.name))) return false;
  if ((facts.halves ?? []).some((half) => !rewrite.includes(half.label))) return false;
  if ((facts.reachable === false || anyHalfShort(facts)) && !rewrite.includes(HONESTY_SENTENCE)) return false;
  if (/\b(I|I'm|I'll|I've|me|my|we|we'll|we're|us|our)\b/i.test(rewrite)) return false;
  if (/\byou(?: are|'re) (?:at|currently)\b/i.test(rewrite)) return false;
  if (/\bAI\b|artificial|language model|chatbot|automat/i.test(rewrite)) return false;
  return true;
}

export async function phoenixCoachMessage(facts: CoachFacts): Promise<string> {
  const template = templateCoachMessage(facts);
  if (!hasAiApiKey()) return template;
  try {
    const { outputText } = await createOpenAiResponseText({
      purpose: "make_it_happen_coach",
      model: OPENAI_NANO_MODEL,
      maxOutputTokens: 400,
      timeoutMs: 12_000,
      text: { format: { type: "text" } },
      instructions:
        "You are Phoenix, the sales coach inside a pharmaceutical company's HR and sales system. " +
        "Rewrite the message you are given so it sounds warm, direct and motivating to a medical sales employee. " +
        "Use at most two sentences, plain English, no emoji, no markdown. " +
        "Keep every number, percentage, currency amount and product name exactly as written. " +
        "Keep every phrase that starts with \"Sato half\" or \"Total half\" exactly as written. " +
        "Never add a number. Never promise more than the message does. " +
        `If the message contains the sentence "${HONESTY_SENTENCE}", keep that sentence word for word. ` +
        `Keep the words "${coachAnchorPhrase(facts)}" exactly as written. ` +
        "A percentage is the best result the plan can reach, never where the person stands today. " +
        "Speak about Phoenix in the third person: never use I, me, my, we, us or our. " +
        "Never mention AI, models or automation.",
      input: template,
    });
    const trimmed = outputText.trim();
    const rewrite = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return isFaithfulRewrite(facts, template, rewrite) ? rewrite : template;
  } catch {
    return template;
  }
}
