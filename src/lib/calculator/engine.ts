/**
 * The desk calculator's state machine.
 *
 * Kept as a pure reducer with no React in it so the arithmetic can be tested directly — the panel
 * is only a keypad wired to this. Every value in the state is a plain string, so the whole thing is
 * serialisable and a test reads as the numbers a person would actually see.
 *
 * Arithmetic is exact: see `./decimal.ts` for why a `number` is the wrong type for this job.
 */

import {
  addDecimal,
  DECIMAL_ZERO,
  divideDecimal,
  formatDecimal,
  groupDigits,
  MAX_SIGNIFICANT_DIGITS,
  multiplyDecimal,
  negateDecimal,
  normalizeDecimal,
  parseDecimal,
  sanitizePastedNumber,
  subtractDecimal,
  type Decimal,
} from "@/lib/calculator/decimal";

export const CALCULATOR_OPERATORS = ["+", "-", "×", "÷"] as const;

export type CalculatorOperator = (typeof CALCULATOR_OPERATORS)[number];

export type CalculatorHistoryEntry = {
  /** Display text, already grouped — e.g. `1,200 × 3 =`. */
  expression: string;
  id: number;
  /** Plain, ungrouped, machine-readable — this is what a click on the row loads and what copies. */
  result: string;
};

export type CalculatorState = {
  /** The settled left-hand operand, plain, or null when nothing is pending. */
  accumulator: string | null;
  /** What the display shows, plain and ungrouped. */
  entry: string;
  error: string | null;
  /** The faint line above the display, already grouped for reading. */
  expression: string;
  history: CalculatorHistoryEntry[];
  /** Monotonic, so history ids stay deterministic and the reducer stays pure. */
  historySeq: number;
  memory: string | null;
  operator: CalculatorOperator | null;
  /** The operand of the last `=`, so pressing `=` again repeats it. */
  repeatOperand: string | null;
  repeatOperator: CalculatorOperator | null;
  /** True while the user is building `entry` by keystroke; false when `entry` holds a result. */
  typing: boolean;
};

export type CalculatorAction =
  | { digit: string; type: "digit" }
  | { op: "add" | "clear" | "recall" | "subtract"; type: "memory" }
  | { operator: CalculatorOperator; type: "operator" }
  | { text: string; type: "paste" }
  | { type: "backspace" }
  | { type: "clear-all" }
  | { type: "clear-entry" }
  | { type: "decimal-point" }
  | { type: "equals" }
  | { type: "negate" }
  | { type: "percent" }
  | { type: "recall-history"; value: string };

// Built with `BigInt(...)`, never the literal form — see the note at the top of ./decimal.ts.
const ONE_DECIMAL: Decimal = { scale: 0, units: BigInt(1) };
const HUNDRED_DECIMAL: Decimal = { scale: 0, units: BigInt(100) };

/** Digits a person may type into one entry. Results may be longer; typing is capped for sanity. */
const MAX_ENTRY_DIGITS = 16;

const MAX_HISTORY_ENTRIES = 25;

const DIVIDE_BY_ZERO_MESSAGE = "Cannot divide by zero";
const OVERFLOW_MESSAGE = "Number too large";

export function createCalculatorState(): CalculatorState {
  return {
    accumulator: null,
    entry: "0",
    error: null,
    expression: "",
    history: [],
    historySeq: 0,
    memory: null,
    operator: null,
    repeatOperand: null,
    repeatOperator: null,
    typing: false,
  };
}

function toDecimal(plain: string | null): Decimal {
  return (plain === null ? null : parseDecimal(plain)) ?? DECIMAL_ZERO;
}

/**
 * Holds a result to a width the panel can show honestly. An integer part that cannot fit is a hard
 * error rather than a silent `1.2e+21` — an exponent pasted into a salary field is a wrong number,
 * not a rounded one. A fraction that cannot fit is rounded, once, and said so by being shorter.
 */
function clampForDisplay(value: Decimal): { error?: string; value?: Decimal } {
  const normalized = normalizeDecimal(value);
  const plain = formatDecimal(normalized);
  const integerText = plain.replace("-", "").split(".")[0] ?? "0";
  const integerDigits = integerText === "0" ? 0 : integerText.length;
  if (integerDigits > MAX_SIGNIFICANT_DIGITS) return { error: OVERFLOW_MESSAGE };
  // A leading "0." costs no significant digit, so a value below one keeps the full division
  // scale — charging it one would silently make 1 ÷ 3 one digit shorter than it was computed to.
  const allowedFraction = Math.max(0, MAX_SIGNIFICANT_DIGITS - integerDigits);
  if (normalized.scale <= allowedFraction) return { value: normalized };
  const rounded = divideDecimal(normalized, ONE_DECIMAL, allowedFraction);
  return rounded ? { value: rounded } : { error: OVERFLOW_MESSAGE };
}

function compute(
  operator: CalculatorOperator,
  left: Decimal,
  right: Decimal,
): { error?: string; value?: Decimal } {
  if (operator === "+") return clampForDisplay(addDecimal(left, right));
  if (operator === "-") return clampForDisplay(subtractDecimal(left, right));
  if (operator === "×") return clampForDisplay(multiplyDecimal(left, right));
  const quotient = divideDecimal(left, right);
  if (!quotient) return { error: DIVIDE_BY_ZERO_MESSAGE };
  return clampForDisplay(quotient);
}

function failed(state: CalculatorState, message: string): CalculatorState {
  return {
    ...state,
    accumulator: null,
    entry: "0",
    error: message,
    expression: "",
    operator: null,
    repeatOperand: null,
    repeatOperator: null,
    typing: false,
  };
}

function countEntryDigits(entry: string): number {
  return entry.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "").length;
}

function pushHistory(state: CalculatorState, expression: string, result: string): CalculatorHistoryEntry[] {
  const entry: CalculatorHistoryEntry = { expression, id: state.historySeq + 1, result };
  return [entry, ...state.history].slice(0, MAX_HISTORY_ENTRIES);
}

function loadValue(state: CalculatorState, plain: string): CalculatorState {
  return { ...state, entry: plain, error: null, typing: false };
}

export function calculatorReducer(state: CalculatorState, action: CalculatorAction): CalculatorState {
  // An error latches. Only clearing, pasting, or recalling a value gets out of it — otherwise a
  // stray key press after a divide-by-zero silently resumes on a meaningless operand.
  if (state.error && action.type !== "clear-all" && action.type !== "clear-entry"
    && action.type !== "paste" && action.type !== "recall-history" && action.type !== "memory") {
    return state;
  }

  switch (action.type) {
    case "digit": {
      if (!state.typing) {
        return { ...state, entry: action.digit, error: null, typing: true };
      }
      if (countEntryDigits(state.entry) >= MAX_ENTRY_DIGITS) return state;
      const next = state.entry === "0" ? action.digit : `${state.entry}${action.digit}`;
      const negativeZero = state.entry === "-0" ? `-${action.digit}` : next;
      return { ...state, entry: negativeZero, typing: true };
    }

    case "decimal-point": {
      if (!state.typing) return { ...state, entry: "0.", error: null, typing: true };
      if (state.entry.includes(".")) return state;
      return { ...state, entry: `${state.entry}.`, typing: true };
    }

    case "backspace": {
      if (!state.typing) return { ...state, entry: "0", typing: false };
      const trimmed = state.entry.slice(0, -1);
      if (!trimmed || trimmed === "-") return { ...state, entry: "0", typing: true };
      return { ...state, entry: trimmed, typing: true };
    }

    case "clear-entry":
      return { ...state, entry: "0", error: null, typing: false };

    case "clear-all":
      return { ...createCalculatorState(), history: state.history, historySeq: state.historySeq, memory: state.memory };

    case "negate": {
      const value = toDecimal(state.entry);
      if (value.units === BigInt(0)) return state;
      return { ...state, entry: formatDecimal(negateDecimal(value)) };
    }

    case "operator": {
      // Two operators in a row is a correction, not a calculation — swap, don't evaluate.
      if (state.operator && !state.typing && state.accumulator !== null) {
        return {
          ...state,
          expression: `${groupDigits(state.accumulator)} ${action.operator}`,
          operator: action.operator,
        };
      }
      if (state.operator && state.accumulator !== null) {
        const outcome = compute(state.operator, toDecimal(state.accumulator), toDecimal(state.entry));
        if (outcome.error || !outcome.value) return failed(state, outcome.error ?? OVERFLOW_MESSAGE);
        const result = formatDecimal(outcome.value);
        return {
          ...state,
          accumulator: result,
          entry: result,
          expression: `${groupDigits(result)} ${action.operator}`,
          operator: action.operator,
          repeatOperand: null,
          repeatOperator: null,
          typing: false,
        };
      }
      return {
        ...state,
        accumulator: state.entry,
        expression: `${groupDigits(state.entry)} ${action.operator}`,
        operator: action.operator,
        repeatOperand: null,
        repeatOperator: null,
        typing: false,
      };
    }

    case "percent": {
      const entry = toDecimal(state.entry);
      // A desk calculator reads `200 + 10 %` as "ten percent OF 200", and `200 × 10 %` as
      // "times 0.1". Both are what a person means; they are not the same arithmetic.
      const base = state.operator === "+" || state.operator === "-"
        ? multiplyDecimal(toDecimal(state.accumulator), entry)
        : entry;
      const value = divideDecimal(base, HUNDRED_DECIMAL);
      if (!value) return failed(state, DIVIDE_BY_ZERO_MESSAGE);
      const clamped = clampForDisplay(value);
      if (clamped.error || !clamped.value) return failed(state, clamped.error ?? OVERFLOW_MESSAGE);
      return { ...state, entry: formatDecimal(clamped.value), typing: false };
    }

    case "equals": {
      const operator = state.operator ?? state.repeatOperator;
      if (!operator) return { ...state, typing: false };

      const left = state.operator ? toDecimal(state.accumulator) : toDecimal(state.entry);
      const right = state.operator
        ? toDecimal(state.entry)
        : toDecimal(state.repeatOperand);
      const rightPlain = state.operator ? state.entry : (state.repeatOperand ?? state.entry);

      const outcome = compute(operator, left, right);
      if (outcome.error || !outcome.value) return failed(state, outcome.error ?? OVERFLOW_MESSAGE);
      const result = formatDecimal(outcome.value);
      const expression = `${groupDigits(formatDecimal(left))} ${operator} ${groupDigits(rightPlain)} =`;
      return {
        ...state,
        accumulator: null,
        entry: result,
        expression,
        history: pushHistory(state, expression, result),
        historySeq: state.historySeq + 1,
        operator: null,
        repeatOperand: rightPlain,
        repeatOperator: operator,
        typing: false,
      };
    }

    case "paste": {
      const clean = sanitizePastedNumber(action.text);
      if (!clean) return state;
      return loadValue(state, clean);
    }

    case "recall-history":
      return loadValue(state, action.value);

    case "memory": {
      if (action.op === "clear") return { ...state, memory: null };
      if (action.op === "recall") return state.memory === null ? state : loadValue(state, state.memory);
      const current = toDecimal(state.memory ?? "0");
      const entry = toDecimal(state.entry);
      const next = action.op === "add" ? addDecimal(current, entry) : subtractDecimal(current, entry);
      const clamped = clampForDisplay(next);
      if (clamped.error || !clamped.value) return failed(state, clamped.error ?? OVERFLOW_MESSAGE);
      return { ...state, error: null, memory: formatDecimal(clamped.value), typing: false };
    }

    default:
      return state;
  }
}

/**
 * Maps one key press to an action, or null when the calculator does not claim that key.
 *
 * This is only ever consulted for keys that arrive INSIDE the panel. Nothing in the calculator
 * listens on the document, which is what lets it stay open while the owner types on the page
 * behind it.
 */
export function calculatorActionForKey(key: string): CalculatorAction | null {
  if (/^\d$/.test(key)) return { digit: key, type: "digit" };
  if (key === "." || key === ",") return { type: "decimal-point" };
  if (key === "+") return { operator: "+", type: "operator" };
  if (key === "-") return { operator: "-", type: "operator" };
  if (key === "*" || key === "x" || key === "X") return { operator: "×", type: "operator" };
  if (key === "/") return { operator: "÷", type: "operator" };
  if (key === "Enter" || key === "=") return { type: "equals" };
  if (key === "Backspace") return { type: "backspace" };
  if (key === "Delete") return { type: "clear-entry" };
  if (key === "%") return { type: "percent" };
  if (key === "F9") return { type: "negate" };
  if (key === "c" || key === "C") return { type: "clear-all" };
  return null;
}

/** What the display shows: grouped for reading, never for copying. */
export function calculatorDisplayText(state: CalculatorState): string {
  if (state.error) return state.error;
  return groupDigits(state.entry);
}
