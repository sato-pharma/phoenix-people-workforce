/**
 * Phoenix CRM — what the Team tab says FIRST, and which weeks are worth a button.
 *
 * Owner, 2026-10-02: *"the page is many long, is very long also … make the DM page more smarter"*.
 * Measured the same evening on the live preview, signed in as the district manager at 375px wide:
 * the page ran **3,335px — 4.1 phone screens — for 2,320 characters of text**, and the text it did
 * carry was mostly itself. "Nothing waiting" appeared **ten** times, her own name five, "the rep has
 * not started this week's plan" five more beside five NOT STARTED pills. The six tiles across the
 * top repeated, word for word, the notes on the switcher one block below them.
 *
 * So the tiles became one sentence that NAMES what waits — or says plainly that nothing does, and
 * carries the context the tiles used to hold — and the nine-week strip shows the weeks that have
 * something in them.
 *
 * Pure on purpose. The counting and the wording are rules, so a test pins them instead of a
 * screenshot, and the component only lays the answer out.
 */

export type TeamWaitingCounts = {
  /** Weekly plans sent for this viewer's approval. Null while the week's review is still loading. */
  plans: number | null;
  /** Monthly plans at this viewer's step. Null when no month has been sent at all. */
  months: number | null;
  planEdits: number;
  unplanned: number;
  requests: number;
  /** Visit asks at this viewer's answer. Null when he cannot answer asks at all. */
  visitAsks: number | null;
};

export type TeamWaitingContext = {
  territories: number;
  vacant: number;
  ready: number;
  notReady: number;
  /** Items waiting at SOMEONE ELSE'S step — context, never a call to act. */
  elsewhere: number;
  /** Test mode carries no readiness, so the lists half is left out of the context. */
  test: boolean;
};

export type TeamWaitingLine = {
  tone: "warn" | "good";
  /** The sentence: what waits on him, or that nothing does. */
  title: string;
  /** The standing facts the tiles used to hold — never a call to act. */
  detail: string;
};

/** The order they are named in, which is the order he works them. */
const KINDS: ReadonlyArray<{ key: keyof TeamWaitingCounts; one: string; many: string }> = [
  { key: "plans", one: "weekly plan", many: "weekly plans" },
  { key: "months", one: "monthly plan", many: "monthly plans" },
  { key: "planEdits", one: "plan edit", many: "plan edits" },
  { key: "unplanned", one: "off-plan visit", many: "off-plan visits" },
  { key: "requests", one: "list request", many: "list requests" },
  { key: "visitAsks", one: "visit ask", many: "visit asks" },
];

function counted(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/** "3 weekly plans and 1 off-plan visit" — it is read as a sentence, so it joins as one. */
function joinWords(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The one line at the top of a manager's Team tab.
 *
 * A count that is still loading (null) is NOT a zero: it is left out of the sentence rather than
 * told to him as "nothing", so a slow week never reads as an empty one.
 */
export function teamWaitingLine(counts: TeamWaitingCounts, context: TeamWaitingContext): TeamWaitingLine {
  const named = KINDS.map((kind) => ({ kind, value: counts[kind.key] ?? 0 })).filter((part) => part.value > 0);
  const total = named.reduce((sum, part) => sum + part.value, 0);

  const detail = [
    counted(context.territories, "territory", "territories") + (context.vacant > 0 ? `, ${context.vacant} without a rep` : ""),
    context.test ? null : `${context.ready} of ${context.ready + context.notReady} lists ready`,
    context.elsewhere > 0 ? `${context.elsewhere} waiting at another step` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  if (total === 0) return { tone: "good", title: "Nothing is waiting for you", detail };
  const words = joinWords(named.map((part) => counted(part.value, part.kind.one, part.kind.many)));
  return { tone: "warn", title: `${words} ${total === 1 ? "is" : "are"} waiting for you`, detail };
}

export type TeamWeek = { weekStart: string; waiting: number | null };

/**
 * The weeks worth a button.
 *
 * The strip offered every plannable week — nine of them — and nine of them said "Nothing waiting".
 * Kept: a week with something waiting, this week, and whichever week he is looking at. The rest are
 * one press away behind "Every week", because planning a month ahead still has to be reachable.
 *
 * A week whose count has not loaded yet (null) is not treated as busy: the strip settles down to the
 * short form once, rather than flashing long and then short on every read.
 */
export function teamWeeksToShow(
  weeks: ReadonlyArray<TeamWeek>,
  input: { selectedWeek: string; thisWeek: string; showAll: boolean },
): ReadonlyArray<TeamWeek> {
  if (input.showAll) return weeks;
  const kept = weeks.filter(
    (week) => (week.waiting ?? 0) > 0 || week.weekStart === input.thisWeek || week.weekStart === input.selectedWeek,
  );
  // A strip that answers nothing is worse than a long one: never hand back an empty week list.
  return kept.length > 0 ? kept : weeks;
}
