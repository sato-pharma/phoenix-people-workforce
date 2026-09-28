import assert from "node:assert/strict";

import {
  SAFE_BUDGET,
  TELEGRAM_BUDGET,
  buildNeedsYouTelegram,
  orderSections,
  type TelegramSection,
} from "../src/lib/needs-you/render/telegram.ts";
import { telegramKeepsParagraphs, emailKeepsLineBreaks } from "../src/lib/notifications/attendance-digest-channels.ts";
import { telegramNotificationText } from "../src/lib/notifications/telegram.ts";

/**
 * The daily board has to survive Telegram's real budget without lying about what it left out.
 *
 * WHY THIS EXISTS. Telegram here is **900 characters of plain text, truncated from the end,
 * mid-word, with no marker**: `cleanTelegramText` and `cleanTelegramParagraphs`
 * (src/lib/notifications/telegram.ts) end in a bare `.slice(0, 900)` and `sendMessage` passes no
 * `parse_mode`. Anything past 900 stops existing silently.
 *
 * Against a module whose governing rule is that **under-reporting is worse than not reporting**,
 * that platform behaviour is the whole threat. Two consequences are asserted below, and both are
 * ordering-and-construction properties rather than opinions:
 *
 *   - "could not be read" must be emitted FIRST, because it is the section whose loss is silent and
 *     the cut comes from the end. The CLI prints it last, which is correct for a terminal that never
 *     truncates and would be fatal here.
 *   - the budget must be met BY CONSTRUCTION. A message that fits because it was sliced has thrown
 *     away items with no trace; one that fits because it stopped adding them can say how many it
 *     left out and where to read them.
 *
 * Nothing here asserts the wording of an item. This file never phrases, it only fits.
 */
export function runNeedsYouTelegramBudgetTests() {
  const BOARD_URL = "https://phoenix-hr.satopharma.com/admin/needs-you";

  const section = (kind: TelegramSection["kind"], heading: string, count: number, width = 40): TelegramSection => ({
    kind,
    heading,
    lines: Array.from({ length: count }, (_, i) => `${heading} item ${i + 1} `.padEnd(width, "x")),
  });

  // ── 1. The channel gate, without which nothing else here matters ────────────
  // If the module is not in the allowlist, cleanTelegramText collapses every break and the whole
  // board arrives as one run-on sentence — and a run-on sentence is also the shape most likely to be
  // cut mid-word. This assertion fails on a branch that renders perfectly and ships unreadably.
  assert.equal(
    telegramKeepsParagraphs("needs_you"),
    true,
    "needs_you is missing from telegramKeepsParagraphs, so every section and item is flattened into one line",
  );
  assert.equal(telegramKeepsParagraphs("  Needs_You "), true, "the gate trims and lower-cases, as its siblings do");
  assert.equal(emailKeepsLineBreaks("needs_you"), true, "an HTML email body collapses bare breaks too");
  // The modules the existing pins assert must stay false.
  for (const other of ["attendance", "early_birds", "payroll", "phoenix_crm", null, undefined]) {
    assert.equal(telegramKeepsParagraphs(other), false, `${String(other)} must keep its one-block Telegram text`);
  }

  // ── 2. "Could not be read" leads, whatever order it arrives in ──────────────
  const shuffled: TelegramSection[] = [
    section("worth-knowing", "Worth knowing", 1),
    section("elsewhere", "With someone else", 1),
    section("yours", "Needs you", 1),
    section("not-proven", "Could not be read", 1),
  ];
  assert.deepEqual(
    orderSections(shuffled).map((s) => s.kind),
    ["not-proven", "yours", "elsewhere", "worth-knowing"],
    "the section whose loss is SILENT must be emitted first — every channel downstream truncates from the end",
  );

  const led = buildNeedsYouTelegram({ title: "What needs you", sections: shuffled, boardUrl: BOARD_URL, allClearProvable: false });
  assert.ok(
    led.indexOf("Could not be read") < led.indexOf("Needs you item"),
    "the could-not-be-read heading must appear before the first waiting item in the rendered text",
  );

  // ── 3. A board far past the budget fits BY CONSTRUCTION ─────────────────────
  const huge: TelegramSection[] = [
    section("not-proven", "Could not be read", 2),
    section("yours", "Needs you", 20),
    section("elsewhere", "With someone else", 20),
  ];
  const title = "What needs you — 28 Sept, 06:36 Cairo";
  const body = buildNeedsYouTelegram({ title, sections: huge, boardUrl: BOARD_URL, allClearProvable: false });

  assert.ok(
    title.length + 2 + body.length <= TELEGRAM_BUDGET,
    `title + body is ${title.length + 2 + body.length} characters, past Telegram's ${TELEGRAM_BUDGET}. ` +
      "The platform would slice the tail off mid-word with no marker.",
  );
  assert.ok(title.length + 2 + body.length <= SAFE_BUDGET + title.length + 2);

  assert.match(
    body,
    /and \d+ more on the board\./,
    "42 items cannot fit in 900 characters, so the message MUST say how many it left out. A partial " +
      "board that does not admit it is partial is the under-report this module exists to prevent.",
  );
  assert.ok(body.includes(BOARD_URL), "the link to the whole board travels with the omission count");

  // Nothing was destroyed: the last paragraph is the closing line, not a severed sentence.
  const paragraphs = body.split("\n\n");
  assert.match(paragraphs[paragraphs.length - 1], /^and \d+ more on the board\./, "the message ends on a whole sentence");
  for (const paragraph of paragraphs) {
    assert.doesNotMatch(paragraph, /…|\.\.\.$/, "no ellipsis — AGENTS.md §4. Text wraps or is counted, never trimmed.");
  }

  // The count must be truthful. 42 items in, however many rendered, the difference is what it claims.
  const claimed = Number(/and (\d+) more on the board/.exec(body)?.[1] ?? "0");
  const rendered = paragraphs.filter((p) => /item \d+/.test(p)).length;
  assert.equal(claimed + rendered, 42, `claimed ${claimed} omitted + ${rendered} rendered must equal the 42 supplied`);

  // ── 4. The worst case is the one that must not be cut ───────────────────────
  // A board whose ONLY content is "could not be read" still renders that content.
  const blind = buildNeedsYouTelegram({
    title: "What needs you",
    sections: [section("not-proven", "Could not be read", 6)],
    boardUrl: BOARD_URL,
    allClearProvable: false,
  });
  assert.match(blind, /Could not be read/, "a board that is nothing BUT failures must still say so");
  assert.ok(blind.length <= SAFE_BUDGET);

  // ── 5. An empty board says which KIND of empty it is ────────────────────────
  const provable = buildNeedsYouTelegram({ title: "t", sections: [], boardUrl: BOARD_URL, allClearProvable: true });
  assert.match(provable, /every source answered/, "a provable all-clear may say so");

  const unprovable = buildNeedsYouTelegram({ title: "t", sections: [], boardUrl: BOARD_URL, allClearProvable: false });
  assert.doesNotMatch(
    unprovable,
    /every source answered/,
    "an empty list with a failed source is NOT an all-clear. This is the single sentence that, sent " +
      "wrongly, tells him to stop looking on the morning something was waiting.",
  );
  assert.match(unprovable, /could not be read/i, "it says instead that the picture is incomplete");

  // And the verdict cannot be lost in a mapping: allClearProvable false with no not-proven section
  // supplied must still produce the caveat.
  const caveat = buildNeedsYouTelegram({
    title: "t",
    sections: [section("yours", "Needs you", 1)],
    boardUrl: BOARD_URL,
    allClearProvable: false,
  });
  assert.match(
    caveat,
    /could not be read/i,
    "the board said it could not prove an all-clear and no not-proven section was passed — the digest " +
      "must state it anyway rather than trust the caller to have mapped it",
  );

  // ── 6. Behavioural, through the real sender-side formatter ──────────────────
  const shipped = telegramNotificationText({ title, message: body, keepParagraphs: true });
  assert.ok(shipped.length <= TELEGRAM_BUDGET, `the real formatter produced ${shipped.length} characters`);
  assert.ok(shipped.includes("\n\n"), "paragraph breaks survive the real formatter when keepParagraphs is set");
  assert.match(shipped, /and \d+ more on the board/, "the omission count survives to the wire");

  // Without the flag every break inside the BODY collapses — this is what the channel gate in
  // assertion 1 prevents. The title is always separated from the body by a blank line either way
  // (see the expected string in tests/attendance-digest-notice-channels.test.ts), so the comparison
  // has to be made on the body alone; asserting on the whole string tests the separator instead.
  const flattened = telegramNotificationText({ title, message: body });
  const flattenedBody = flattened.slice(flattened.indexOf("\n\n") + 2);
  assert.ok(
    !flattenedBody.includes("\n\n"),
    "without keepParagraphs the board's own sections collapse into one run-on block — which is exactly " +
      "what happens if needs_you is ever dropped from telegramKeepsParagraphs",
  );
  const keptBody = shipped.slice(shipped.indexOf("\n\n") + 2);
  assert.ok(keptBody.includes("\n\n"), "with the flag the board's sections stay apart");
}
