import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { closingCorrectionsHeadline } from "../src/lib/sales/closing-corrections-headline.ts";

// The Closing Corrections headline chip read a green "Nothing distorts this month" whenever the
// count was 0 — including when the page failed to load, so a month nobody could check looked clean
// to the person about to sign it off. Source of Sales fix backlog, re-measured 2026-09-18, #109.

export function runClosingCorrectionsHeadlineTests() {
  // 1. A failed load never reads green, whatever count it carries.
  const failed = closingCorrectionsHeadline({ loadError: "statement timeout", period: null, situationCount: undefined });
  assert.notEqual(failed.tone, "emerald", "a failed load reads as a clean month");
  assert.equal(failed.text, "Could not check this month");
  assert.notEqual(
    closingCorrectionsHeadline({ loadError: "boom", period: "2026-08", situationCount: 0 }).text,
    "Nothing distorts this month",
    "an error outranks a zero count",
  );

  // 2. Nothing to check is not "nothing wrong".
  const empty = closingCorrectionsHeadline({ loadError: null, period: "", situationCount: 0 });
  assert.deepEqual(empty, { tone: "neutral", text: "No month to check" });

  // 3. A load that ran: the real count, or the earned green.
  assert.deepEqual(closingCorrectionsHeadline({ loadError: null, period: "2026-07", situationCount: 12 }), {
    tone: "orange",
    text: "12 situations found",
  });
  assert.deepEqual(closingCorrectionsHeadline({ loadError: null, period: "2026-07", situationCount: 0 }), {
    tone: "emerald",
    text: "Nothing distorts this month",
  });

  // 4. The page reads the helper, never its own count-only ternary.
  const view = readFileSync("src/components/sales/closing-corrections-view.tsx", "utf8");
  assert.match(view, /closingCorrectionsHeadline\(\{\s*loadError: initialError,/, "the chip is told about the load error");
  assert.match(view, /<AdminInsightChip tone=\{headline\.tone\}>\{headline\.text\}<\/AdminInsightChip>/);
  assert.doesNotMatch(view, /"Nothing distorts this month"/, "the view prints its own green verdict again");
}
