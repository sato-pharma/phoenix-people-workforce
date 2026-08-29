import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  formatDecimal,
  groupDigits,
  parseDecimal,
  sanitizePastedNumber,
} from "../src/lib/calculator/decimal.ts";
import {
  calculatorActionForKey,
  calculatorDisplayText,
  calculatorReducer,
  createCalculatorState,
  type CalculatorAction,
  type CalculatorState,
} from "../src/lib/calculator/engine.ts";

// The topbar desk calculator has exactly two promises, and this file pins both.
//
//   1. IT IS ACCURATE. The owner copies its answers into salary and sales figures, so a binary
//      float is the wrong type: the assertions below include the exact sums an IEEE-754
//      calculator gets WRONG, checked against `number` in the same test so the difference is
//      visible rather than asserted.
//   2. IT DOES NOT BLOCK. It must stay open while he works on the page behind it. That is a
//      property of HOW the panel is mounted, not of anything a unit test can call, so the last
//      section reads the component source and refuses the three shapes that would break it.

const SOURCE_ROOT = new URL("../src/", import.meta.url);

const WIDGET_SOURCE = readFileSync(
  fileURLToPath(new URL("components/layout/calculator-widget.tsx", SOURCE_ROOT)),
  "utf8",
);

const TOPBAR_SOURCE = readFileSync(
  fileURLToPath(new URL("components/layout/topbar.tsx", SOURCE_ROOT)),
  "utf8",
);

/** Runs a key sequence and hands back the final state — a test reads as the buttons pressed. */
function press(...actions: CalculatorAction[]): CalculatorState {
  return actions.reduce(calculatorReducer, createCalculatorState());
}

function digits(text: string): CalculatorAction[] {
  return [...text].map((character) =>
    character === "." ? { type: "decimal-point" } : { digit: character, type: "digit" },
  );
}

/** `12.5 + 3 =` written the way somebody would press it. */
function evaluate(left: string, operator: "+" | "-" | "×" | "÷", right: string): string {
  return press(
    ...digits(left),
    { operator, type: "operator" },
    ...digits(right),
    { type: "equals" },
  ).entry;
}

export function runCalculatorEngineTests() {
  // ── 1. Exact arithmetic ─────────────────────────────────────────────────────────────────────
  // Each of these is a sum a `number`-based calculator answers wrongly. The float result is
  // computed here too, so the test documents the defect it exists to prevent.
  assert.equal(evaluate("0.1", "+", "0.2"), "0.3");
  assert.notEqual(String(0.1 + 0.2), "0.3", "sanity: the float really is wrong, so the test means something");

  assert.equal(evaluate("4.35", "×", "100"), "435");
  assert.notEqual(String(4.35 * 100), "435", "sanity: 4.35 * 100 is 434.99999999999994 in binary floating point");

  assert.equal(evaluate("1.1", "×", "3"), "3.3");
  assert.equal(evaluate("0.3", "-", "0.1"), "0.2");
  assert.equal(evaluate("100", "×", "1.15"), "115");
  assert.equal(evaluate("1", "-", "0.9"), "0.1");
  assert.equal(evaluate("2.675", "×", "100"), "267.5");

  // Money-shaped sums at a scale payroll actually reaches.
  assert.equal(evaluate("18500.75", "+", "2349.25"), "20850");
  assert.equal(evaluate("12345678.9", "×", "1.14"), "14074073.946");

  // Past 2^53 a float cannot even HOLD the operand, let alone add to it. `bigint` has no
  // significand limit, so nothing silently rounds at the top end.
  assert.equal(evaluate("9007199254740993", "+", "2"), "9007199254740995");
  assert.equal(9007199254740993 + 2, 9007199254740994, "sanity: the float loses the operand's last bit before it even adds");

  // Beyond what the panel can honestly show, it says so rather than inventing an exponent —
  // "1.2e+21" pasted into a salary field is a wrong number, not a rounded one.
  const tooLarge = press(
    ...digits("999999999999"),
    { operator: "×", type: "operator" },
    ...digits("999999999999"),
    { type: "equals" },
  );
  assert.equal(tooLarge.error, "Number too large");
  assert.ok(!tooLarge.entry.includes("e"), "an overflow must never render as an exponent");

  // ── 2. Division, the one operation that has to round ────────────────────────────────────────
  assert.equal(evaluate("1", "÷", "3"), "0.333333333333333333");
  assert.equal(evaluate("2", "÷", "3"), "0.666666666666666667", "rounds half-up at the last kept place");
  assert.equal(evaluate("10", "÷", "4"), "2.5");
  assert.equal(evaluate("-1", "÷", "8"), "-0.125");

  const dividedByZero = press(...digits("5"), { operator: "÷", type: "operator" }, ...digits("0"), { type: "equals" });
  assert.equal(dividedByZero.error, "Cannot divide by zero");
  assert.equal(dividedByZero.entry, "0");

  // The error LATCHES: a stray digit afterwards must not quietly resume on a meaningless operand.
  const afterError = calculatorReducer(dividedByZero, { digit: "7", type: "digit" });
  assert.equal(afterError.error, "Cannot divide by zero", "an error must survive a stray key press");
  assert.equal(calculatorDisplayText(afterError), "Cannot divide by zero");
  const recovered = calculatorReducer(afterError, { type: "clear-all" });
  assert.equal(recovered.error, null);
  assert.equal(recovered.entry, "0");

  // ── 3. Chaining, repeat-equals and operator correction ──────────────────────────────────────
  // 2 + 3 + shows the running total, the way a desk calculator does.
  const chained = press(...digits("2"), { operator: "+", type: "operator" }, ...digits("3"), { operator: "+", type: "operator" });
  assert.equal(chained.entry, "5");
  assert.equal(calculatorReducer(chained, { type: "equals" }).entry, "10", "the pending 5 + 5");

  // Pressing = again repeats the last operation.
  const firstEquals = press(...digits("10"), { operator: "+", type: "operator" }, ...digits("5"), { type: "equals" });
  assert.equal(firstEquals.entry, "15");
  const secondEquals = calculatorReducer(firstEquals, { type: "equals" });
  assert.equal(secondEquals.entry, "20");
  assert.equal(calculatorReducer(secondEquals, { type: "equals" }).entry, "25");

  // Two operators in a row is a correction, not a calculation.
  const corrected = press(
    ...digits("8"),
    { operator: "+", type: "operator" },
    { operator: "×", type: "operator" },
    ...digits("3"),
    { type: "equals" },
  );
  assert.equal(corrected.entry, "24", "the second operator must replace the first, not evaluate against it");

  // ── 4. Percent, as a desk calculator means it ───────────────────────────────────────────────
  // `200 + 10 %` is ten percent OF 200, but `200 × 10 %` is times 0.1. They are different sums
  // and a person pressing those keys means both.
  assert.equal(
    press(...digits("200"), { operator: "+", type: "operator" }, ...digits("10"), { type: "percent" }, { type: "equals" }).entry,
    "220",
  );
  assert.equal(
    press(...digits("200"), { operator: "-", type: "operator" }, ...digits("10"), { type: "percent" }, { type: "equals" }).entry,
    "180",
  );
  assert.equal(
    press(...digits("200"), { operator: "×", type: "operator" }, ...digits("10"), { type: "percent" }, { type: "equals" }).entry,
    "20",
  );
  // With nothing pending, % is just "divide by a hundred".
  assert.equal(press(...digits("45"), { type: "percent" }).entry, "0.45");

  // ── 5. Entry editing ────────────────────────────────────────────────────────────────────────
  assert.equal(press(...digits("120"), { type: "backspace" }).entry, "12");
  assert.equal(press(...digits("7"), { type: "backspace" }).entry, "0");
  assert.equal(press(...digits("5"), { type: "negate" }).entry, "-5");
  assert.equal(press({ type: "negate" }).entry, "0", "negating zero stays zero, never -0");
  assert.equal(press(...digits("1.5"), { type: "decimal-point" }).entry, "1.5", "a second point is ignored");
  assert.equal(press({ type: "decimal-point" }).entry, "0.", "a leading point opens 0.");
  assert.equal(press(...digits("00"), { digit: "7", type: "digit" }).entry, "7", "no leading-zero padding");

  // A typed entry is capped, so the display can never hold more digits than it can show.
  const overTyped = press(...digits("12345678901234567890"));
  assert.equal(overTyped.entry.replace(/\D/g, "").length, 16, "typing is capped at 16 digits");

  // ── 6. Memory keys ──────────────────────────────────────────────────────────────────────────
  const withMemory = press(...digits("40"), { op: "add", type: "memory" });
  assert.equal(withMemory.memory, "40");
  const memoryAfterSubtract = calculatorReducer(
    press(...digits("40"), { op: "add", type: "memory" }, ...digits("15")),
    { op: "subtract", type: "memory" },
  );
  assert.equal(memoryAfterSubtract.memory, "25");
  assert.equal(calculatorReducer(memoryAfterSubtract, { op: "recall", type: "memory" }).entry, "25");
  assert.equal(calculatorReducer(memoryAfterSubtract, { op: "clear", type: "memory" }).memory, null);
  // Clearing the calculation must NOT clear memory — that is the whole point of a memory key.
  assert.equal(calculatorReducer(withMemory, { type: "clear-all" }).memory, "40");

  // ── 7. The tape ─────────────────────────────────────────────────────────────────────────────
  const taped = press(...digits("1200"), { operator: "×", type: "operator" }, ...digits("3"), { type: "equals" });
  assert.equal(taped.history.length, 1);
  assert.equal(taped.history[0]?.result, "3600", "the tape stores the PLAIN result, which is what copies");
  assert.equal(taped.history[0]?.expression, "1,200 × 3 =", "the tape's expression is display text, grouped");
  assert.equal(calculatorReducer(taped, { type: "recall-history", value: "3600" }).entry, "3600");

  // ── 8. Reading what gets pasted in, and refusing what is ambiguous ──────────────────────────
  assert.equal(sanitizePastedNumber("EGP 1,234.56"), "1234.56", "a figure copied off a Phoenix screen");
  assert.equal(sanitizePastedNumber("  18,500.75  "), "18500.75");
  assert.equal(sanitizePastedNumber("(1,234.56)"), "-1234.56", "accounting parentheses mean negative");
  assert.equal(sanitizePastedNumber("-2 500"), "-2500");
  assert.equal(sanitizePastedNumber("45%"), "45");
  assert.equal(sanitizePastedNumber("١٢٣٤٫٥٦"), "1234.56", "Arabic-Indic digits and separator");
  assert.equal(sanitizePastedNumber("0012"), "12");
  assert.equal(sanitizePastedNumber(".5"), "0.5");
  // Genuinely ambiguous or non-numeric input is REFUSED rather than guessed at.
  assert.equal(sanitizePastedNumber("1.234.567"), null, "European grouping is ambiguous — refuse, never guess");
  assert.equal(sanitizePastedNumber("total"), null);
  assert.equal(sanitizePastedNumber(""), null);
  assert.equal(sanitizePastedNumber("   "), null);

  // A refused paste leaves the display exactly as it was.
  const beforePaste = press(...digits("77"));
  assert.equal(calculatorReducer(beforePaste, { text: "not a number", type: "paste" }).entry, "77");
  assert.equal(calculatorReducer(beforePaste, { text: "EGP 1,234.56", type: "paste" }).entry, "1234.56");
  // A paste also clears a latched error — it is a fresh operand.
  assert.equal(calculatorReducer(dividedByZero, { text: "12", type: "paste" }).error, null);

  // ── 9. Display formatting: grouped for reading, plain for copying ───────────────────────────
  assert.equal(groupDigits("1234567.891"), "1,234,567.891");
  assert.equal(groupDigits("-1234567"), "-1,234,567");
  assert.equal(groupDigits("0.5"), "0.5");
  assert.equal(calculatorDisplayText(press(...digits("1234567"))), "1,234,567");
  assert.equal(press(...digits("1234567")).entry, "1234567", "what is COPIED must never carry separators");

  // Round-tripping: whatever the display shows, plain, must parse back to the same value.
  for (const sample of ["0", "0.5", "-12.25", "1000000", "0.000000000000000001"]) {
    const parsed = parseDecimal(sample);
    assert.ok(parsed, `expected ${sample} to parse`);
    assert.equal(formatDecimal(parsed), sample);
  }
  assert.equal(formatDecimal({ scale: 4, units: BigInt(25000) }), "2.5", "trailing zeros are normalised away");

  // ── 10. Keyboard mapping ────────────────────────────────────────────────────────────────────
  assert.deepEqual(calculatorActionForKey("7"), { digit: "7", type: "digit" });
  assert.deepEqual(calculatorActionForKey("*"), { operator: "×", type: "operator" });
  assert.deepEqual(calculatorActionForKey("/"), { operator: "÷", type: "operator" });
  assert.deepEqual(calculatorActionForKey("Enter"), { type: "equals" });
  assert.deepEqual(calculatorActionForKey(","), { type: "decimal-point" }, "a numeric-keypad comma is a decimal point here");
  assert.deepEqual(calculatorActionForKey("Backspace"), { type: "backspace" });
  // Keys the calculator does NOT claim must come back null so the panel can swallow them
  // deliberately rather than acting on something it half-recognised.
  assert.equal(calculatorActionForKey("a"), null);
  assert.equal(calculatorActionForKey("Escape"), null, "Escape closes the panel — the reducer must not claim it");
  assert.equal(calculatorActionForKey("Tab"), null, "Tab must stay a focus key");

  // ── 11. THE NON-BLOCKING GUARANTEE ──────────────────────────────────────────────────────────
  // The owner asked for a calculator he can leave open while he types on the page behind it.
  // Nothing above can test that — it is a property of how the panel mounts — so it is pinned
  // here as three shapes the component must never take on.

  assert.ok(
    WIDGET_SOURCE.includes("createPortal(") && WIDGET_SOURCE.includes("document.body"),
    "the panel must mount through a portal to document.body: the topbar's backdrop-blur creates a "
      + "containing block that would trap a fixed-position panel inside the chrome",
  );

  assert.ok(
    !WIDGET_SOURCE.includes("useDismissOnOutsideInteraction"),
    "the calculator must NOT dismiss on an outside click — staying open while the owner works "
      + "outside it is the entire request",
  );

  assert.ok(
    !/document\.addEventListener/.test(WIDGET_SOURCE),
    "nothing may listen on the document: a global key listener would intercept typing meant for "
      + "the page behind the panel, which is exactly what the owner asked not to happen",
  );

  // A full-screen backdrop would swallow every click outside the panel even without a listener.
  assert.ok(
    !/className=\{?["'`][^"'`]*inset-0/.test(WIDGET_SOURCE),
    "the calculator must not render a full-screen backdrop — every pixel outside it belongs to the page",
  );

  // Keys are handled on the panel's own input, not anywhere wider.
  assert.ok(
    WIDGET_SOURCE.includes("onKeyDown={handleDisplayKeyDown}"),
    "key handling must be bound to the panel's own display input",
  );

  // The copy path must copy the RAW entry. Copying the grouped display would hand the owner
  // "1,234.56", which is not a number to any field he pastes it into.
  assert.ok(
    WIDGET_SOURCE.includes("copyPlainText(state.entry)"),
    "the copy button must copy state.entry — the plain value — never the grouped display text",
  );

  // ── 12. It is actually mounted, in the admin chrome ─────────────────────────────────────────
  // A component nothing renders is the most expensive kind of green test.
  assert.ok(
    TOPBAR_SOURCE.includes('from "@/components/layout/calculator-widget"'),
    "the topbar must import the calculator",
  );
  assert.ok(
    /isAdminMode \? <CalculatorWidget/.test(TOPBAR_SOURCE),
    "the calculator must render in the admin/HR chrome cluster of the topbar",
  );
  const calculatorIndex = TOPBAR_SOURCE.indexOf("<CalculatorWidget");
  const bellIndex = TOPBAR_SOURCE.indexOf("<InAppNotificationsBell");
  assert.ok(calculatorIndex > 0 && bellIndex > 0 && calculatorIndex < bellIndex,
    "the calculator sits in the upper bar's right-hand cluster, ahead of the notifications bell");
}
