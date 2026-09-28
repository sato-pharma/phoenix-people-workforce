/**
 * The "what needs you" board, rendered for Telegram inside its real budget.
 *
 * 🔴 TELEGRAM IS 900 CHARACTERS OF PLAIN TEXT, AND IT TRUNCATES FROM THE END, MID-WORD.
 * `cleanTelegramText` / `cleanTelegramParagraphs` (src/lib/notifications/telegram.ts) end in a bare
 * `.slice(0, 900)`, and `sendMessage` passes no `parse_mode` at all — so there is no markdown, no
 * 4096-character budget, and no ellipsis marking the cut. Whatever runs past 900 simply stops
 * existing, silently.
 *
 * That single fact decides the design, because this module's governing rule is that **a board which
 * under-reports is worse than no board**. If the digest says "nothing needs you" while something is
 * waiting — or while a source could not be read — it costs the owner the decision more surely than
 * no digest would, because he has delegated the looking.
 *
 * So two things follow, and neither is a style choice:
 *
 *   1. **"Could not be read" is emitted FIRST, always.** The CLI (`scripts/needs-you.mjs`) prints it
 *      last, which is right for a terminal that never truncates and fatal at 900 characters: the one
 *      section that must survive the cut would be the first thing cut. Ordering is what makes the
 *      under-report rule hold on a channel with a hard budget.
 *   2. **The budget is met BY CONSTRUCTION, never by truncation.** Nothing here calls `.slice`. Items
 *      are added while they fit, and the moment one does not, the message says how many were left
 *      out and where to read them. A reader who sees "and 6 more on the board" knows the list is
 *      partial; a reader handed a sentence that stops mid-word does not.
 *
 * WHY IT DECLARES ITS OWN INPUT TYPE. `TelegramSection` is deliberately minimal and owned here
 * rather than imported from the board's own section model. The two are being built in parallel, and
 * a renderer that reaches into a type someone else is still shaping either blocks on it or
 * duplicates it — the "two copies of one fact" failure this repository records over and over. The
 * seam is one mapping function on the caller's side; everything below is pure, and a test can drive
 * it with nothing but literals.
 *
 * PARAGRAPHS, NOT LINES. `cleanTelegramParagraphs` keeps a blank line between paragraphs and
 * collapses every single `\n` into a space. So one item per PARAGRAPH is the only way each item
 * lands on its own; one item per line renders as one run-on sentence. That path is also gated:
 * `telegramKeepsParagraphs(module)` must return true for this module, or the whole message is
 * flattened whatever this file does.
 */

/** The hard platform budget. Not a target — the point past which text is destroyed. */
export const TELEGRAM_BUDGET = 900;

/**
 * Kept below the platform's own 900 so the message survives the cleaner untouched. `cleanTelegram*`
 * collapses runs of whitespace and strips `<`/`>`, both of which only ever SHRINK the text, so
 * budgeting on the raw length here is conservative in the safe direction.
 */
export const SAFE_BUDGET = 860;

/** The module key this digest is filed under. Must also appear in `telegramKeepsParagraphs`. */
export const NEEDS_YOU_MODULE = "needs_you";

export type TelegramSectionKind = "not-proven" | "yours" | "elsewhere" | "worth-knowing";

/** One rendered section. `lines` are finished sentences — this file never phrases, only fits. */
export type TelegramSection = {
  kind: TelegramSectionKind;
  heading: string;
  lines: readonly string[];
};

/**
 * Emission order. `not-proven` leads because it is the section whose loss is silent, and every
 * channel downstream truncates from the end. `worth-knowing` trails because it is context, and
 * context is the right thing to lose first when something has to go.
 */
const SECTION_ORDER: readonly TelegramSectionKind[] = ["not-proven", "yours", "elsewhere", "worth-knowing"];

export function orderSections(sections: readonly TelegramSection[]): TelegramSection[] {
  return [...sections].sort((a, b) => SECTION_ORDER.indexOf(a.kind) - SECTION_ORDER.indexOf(b.kind));
}

export type NeedsYouTelegramInput = {
  /** Prepended by `telegramNotificationText`, so it spends the same budget. Counted here. */
  title: string;
  sections: readonly TelegramSection[];
  /** Where the full board lives. Always present in the message when anything was left out. */
  boardUrl: string;
  /**
   * The board's own verdict. When false, the digest says so in fixed text — it is never inferred
   * from an empty list, because "no items" and "nothing could be read" are the two readings this
   * whole module exists to keep apart.
   */
  allClearProvable: boolean;
};

/**
 * Build the message body. Never exceeds {@link SAFE_BUDGET}, never truncates a sentence, and never
 * silently drops an item — anything omitted is counted in the closing line.
 */
export function buildNeedsYouTelegram(input: NeedsYouTelegramInput): string {
  const ordered = orderSections(input.sections).filter((section) => section.lines.length > 0);
  const totalItems = ordered.reduce((sum, section) => sum + section.lines.length, 0);

  // Nothing waiting AND every source answered: the one case where silence is honest and short.
  if (totalItems === 0) {
    return input.allClearProvable
      ? "Nothing is waiting on a decision only you can make, and every source answered."
      : `Nothing is listed, but at least one source could not be read — so this is not an all-clear. ${input.boardUrl}`;
  }

  const paragraphs: string[] = [];
  let used = input.title.length + 2; // the title and the blank line after it
  let omitted = 0;
  let stopped = false;

  // Reserve room for the closing line up front. Computing it afterwards and discovering it does not
  // fit is how a budget builder ends up truncating after all.
  const closingReserve = `and ${totalItems} more on the board. ${input.boardUrl}`.length + 2;

  for (const section of ordered) {
    if (stopped) {
      omitted += section.lines.length;
      continue;
    }
    const headingCost = section.heading.length + 2;
    if (used + headingCost + closingReserve > SAFE_BUDGET) {
      stopped = true;
      omitted += section.lines.length;
      continue;
    }
    paragraphs.push(section.heading);
    used += headingCost;

    for (const line of section.lines) {
      const cost = line.length + 2;
      if (used + cost + closingReserve > SAFE_BUDGET) {
        stopped = true;
        omitted += 1;
        continue;
      }
      paragraphs.push(line);
      used += cost;
    }
  }

  if (!input.allClearProvable && !ordered.some((section) => section.kind === "not-proven")) {
    // The board could not prove an all-clear and no not-proven section was supplied. Say it anyway:
    // a verdict that depends on a section being passed in is a verdict that can be lost in a mapping.
    const sentence = "At least one source could not be read, so this is not a complete picture.";
    if (used + sentence.length + 2 + closingReserve <= SAFE_BUDGET) {
      paragraphs.unshift(sentence);
      used += sentence.length + 2;
    }
  }

  if (omitted > 0) {
    paragraphs.push(`and ${omitted} more on the board. ${input.boardUrl}`);
  }

  return paragraphs.join("\n\n");
}
