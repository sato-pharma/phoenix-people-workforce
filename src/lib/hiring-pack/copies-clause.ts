// How many copies a paper is printed in — the number the desk gives before anything prints — and the
// sentence that states it on a paper that says how it was drawn up.
//
// THE OWNER, 2026-09-20: "before you print any copy from any HR form you should ask me how many
// copies this should be printed … and based on what I tell you, you write here", after asking that
// the Arabic HR letter carry «تحرر من نسختين نسخة تسلم …». So the count is asked once, at the moment
// of printing, and the sentence follows it. It was a fixed "two copies" before, which is a claim on a
// signed paper that stopped being true the first time somebody printed three.
//
// One module rather than a line in the renderer, because the dialog that asks, the route that
// clamps and the paper that states the number must agree on the ceiling and on what a bad answer
// means — the same reasoning `resolveCopyCount` in the manager gives for sharing its clamp.

/** The most copies one print run produces. The print route clamps to the same figure. */
export const PRINT_COPIES_MAX = 20;

/** The quick choices the prompt offers. Any whole number from 1 to `PRINT_COPIES_MAX` is accepted. */
export const PRINT_COPIES_CHOICES = [1, 2, 3, 4] as const;

/**
 * A typed answer, made safe: a whole number from 1 to `PRINT_COPIES_MAX`, or `fallback` when it is
 * blank, zero, negative or not a number. A blank box is never read as zero copies — a print run of
 * nothing is not something anybody asks for, and one that quietly prints a page is the lesser harm.
 */
export function parsePrintCopies(raw: string | number | null | undefined, fallback: number): number {
  const requested = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(requested) || requested < 1) return fallback;
  return Math.min(requested, PRINT_COPIES_MAX);
}

// The feminine forms Arabic counts three to ten with (ثلاث نسخ), since «نسخة» is feminine.
const COUNT_WORDS_AR: Record<number, string> = {
  3: "ثلاث",
  4: "أربع",
  5: "خمس",
  6: "ست",
  7: "سبع",
  8: "ثماني",
  9: "تسع",
  10: "عشر",
};

/**
 * The sentence stating how a letter was drawn up, from the number of copies being printed.
 *
 * ONE COPY, TWO COPIES AND MANY read differently in Arabic — «نسخة واحدة», the dual «نسختين», and a
 * counted plural «ثلاث نسخ» — so this is a table of three shapes, not a number dropped into one
 * template. From eleven the counted noun changes again («أحد عشر نسخة» is not how anyone writes it),
 * so the figure is given in digits with the singular.
 *
 * Who keeps which copy is the company's own practice for a letter to a third party: one is handed
 * to the person it concerns, the rest stay in his service file.
 */
export function copiesClauseAr(copies: number): string {
  const count = parsePrintCopies(copies, 1);
  if (count === 1) return "تُحرَّر هذه الشهادة من نسخة واحدة تُسلَّم لصاحب الشأن.";
  if (count === 2) {
    return "تُحرَّر هذه الشهادة من نسختين، نسخة تُسلَّم لصاحب الشأن ونسخة تُحفظ بملف الخدمة.";
  }
  const counted = COUNT_WORDS_AR[count];
  const head = counted ? `${counted} نسخ` : `${count} نسخة`;
  return `تُحرَّر هذه الشهادة من ${head}، نسخة تُسلَّم لصاحب الشأن وباقي النسخ تُحفظ بملف الخدمة.`;
}
