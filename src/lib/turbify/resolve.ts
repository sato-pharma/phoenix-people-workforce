/**
 * Turning a semantic locator into exactly one control on the page.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THE DANGER THIS MODULE EXISTS FOR. The account list holds 288 mailboxes and EVERY row carries
 * its own `aria-label="Reset password"` and `aria-label="More actions"` button. So "click the Reset
 * password button" is not an instruction — it is 288 instructions, and the robot taking the first
 * one it finds would reset whichever mailbox happens to sit at the top of the list. On a leaver run
 * that resets a working employee out of their mail; after the grace period it is a DELETE.
 *
 * The protection is not a cleverer selector. It is this: the robot types the exact address into the
 * search box first, which filters the table to that one row, and then every row action demands
 * EXACTLY ONE match. If two match, the filter did not do what was assumed and the run stops. If none
 * match, the page is not the one expected and the run stops. Both are refusals, never a guess, and
 * never a silent skip — a skip is indistinguishable from a run with no work to do.
 *
 * `resolveOne` is therefore the only resolver exported for acting on a control. There is deliberately
 * no "first match" variant: a caller that wants one would be the bug.
 */

import { missingControl, type Locator } from "./locators";

/** One candidate read off the page, with whatever identifies it and a way to act on it. */
export type ElementCandidate = {
  tag: string;
  /** `aria-label`, or "" when absent. */
  aria?: string;
  /** The `name` attribute, or "" when absent. */
  name?: string;
  /** The `placeholder` attribute, or "" when absent. */
  placeholder?: string;
  /** Visible text, already collapsed and trimmed by the reader. */
  text?: string;
};

/** The page capability this module needs: read candidates for a CSS query. */
export type CandidateReader = {
  candidates: (cssQuery: string) => Promise<readonly ElementCandidate[]>;
};

export class TurbifyAmbiguousControlError extends Error {
  readonly locator: Locator;
  readonly matches: number;
  constructor(locator: Locator, matches: number) {
    super(
      `The Turbify panel has ${matches} controls matching ${locator.kind}="${locator.value}" `
      + `(${locator.purpose}), so the robot cannot tell which mailbox it would act on. It stopped. `
      + "A row action is only safe once the search box has filtered the list to one row.",
    );
    this.name = "TurbifyAmbiguousControlError";
    this.locator = locator;
    this.matches = matches;
  }
}

/** Escape a value for use inside a CSS attribute selector's quotes. */
function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The CSS query that narrows the page to plausible candidates.
 *
 * For `text` there is no attribute to query, so every allowed tag is read and the text is compared
 * in `matchesLocator`. For the attribute kinds the query does most of the work, and the match is
 * still re-checked so a selector engine quirk cannot widen it.
 */
export function cssQueryFor(locator: Locator): string {
  const attribute = (name: string) => locator.tags.map((tag) => `${tag}[${name}="${cssAttrValue(locator.value)}"]`).join(",");
  switch (locator.kind) {
    case "aria": return attribute("aria-label");
    case "name": return attribute("name");
    case "placeholder": return attribute("placeholder");
    case "text": return locator.tags.join(",");
  }
}

/** Whether a candidate really satisfies the locator. Exact, trimmed comparison — never a substring. */
export function matchesLocator(candidate: ElementCandidate, locator: Locator): boolean {
  if (!locator.tags.includes(candidate.tag.toLowerCase())) return false;
  const value = locator.value;
  switch (locator.kind) {
    case "aria": return (candidate.aria ?? "").trim() === value;
    case "name": return (candidate.name ?? "").trim() === value;
    case "placeholder": return (candidate.placeholder ?? "").trim() === value;
    // Collapse whitespace on both sides: a button's rendered text carries newlines and padding from
    // the markup, and an exact compare against the raw string would never match.
    case "text": return (candidate.text ?? "").replace(/\s+/g, " ").trim() === value;
  }
}

/** Every candidate on the page that satisfies the locator. */
export async function findMatches(
  page: CandidateReader,
  locator: Locator,
): Promise<readonly ElementCandidate[]> {
  const candidates = await page.candidates(cssQueryFor(locator));
  return candidates.filter((candidate) => matchesLocator(candidate, locator));
}

/**
 * The single control the locator names, or a refusal.
 *
 * Throws `missingControl` on none and `TurbifyAmbiguousControlError` on more than one. Returns the
 * INDEX of the match as well as the candidate, so a caller driving a real browser can act on the
 * same element it was shown rather than re-querying and racing the page.
 */
export async function resolveOne(
  page: CandidateReader,
  locator: Locator,
): Promise<{ candidate: ElementCandidate; index: number }> {
  const all = await page.candidates(cssQueryFor(locator));
  const indexed = all
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => matchesLocator(candidate, locator));
  if (indexed.length === 0) throw missingControl(locator);
  if (indexed.length > 1) throw new TurbifyAmbiguousControlError(locator, indexed.length);
  return indexed[0];
}

/**
 * The exactly-one-row rule as a PURE decision, for a driver that counts matches itself.
 *
 * `resolveOne` is the version for a reader this module can query. The revocation driver works
 * directly against puppeteer and counts with `$$eval`, so it needs the same rule without a reader.
 * Keeping the decision here means there is ONE statement of "exactly one, or stop" for the whole
 * Turbify console, and that it can be proven without a browser.
 *
 * Returns null when it is safe to act, or the refusal to throw. A NEGATIVE or non-finite count means
 * the page could not be read, which is also a refusal — an unreadable list is not an empty one, and
 * treating it as empty is how a robot proceeds against a page it never saw.
 */
export function rowCountRefusal(count: number, address: string, action = "Reset"): string | null {
  if (count === 1) return null;
  const seen = !Number.isFinite(count) || count < 0 ? "an unreadable number of" : String(count);
  return (
    `${action} ${address}: after filtering to this address the list showed ${seen} matching rows, `
    + `so the robot cannot tell which mailbox it would act on. Nothing was clicked.`
  );
}

/** Whether the locator resolves at all, without throwing. For verifying a page is the expected one. */
export async function isPresent(page: CandidateReader, locator: Locator): Promise<boolean> {
  return (await findMatches(page, locator)).length > 0;
}

export type ExistenceReading =
  | { exists: boolean }
  | { refusal: string };

/**
 * Read "does this address exist?" from the number of matching ROWS, never from the page's text.
 *
 * 🔴 WHY THIS EXISTS, measured on production 2026-10-03. `createMailbox` asked the question with
 * `document.body.innerText.includes(address)` — and the console leaves the searched address on the
 * page after an attempt, so the check was reading the residue of the robot's OWN previous run. The
 * measurement that pinned it: of four addresses, the two the robot had attempted carried their local
 * part in the page text while showing ZERO rows, and the two it had never reached carried neither.
 * Ahmed Mohamed was absent from a console holding 288 mailboxes and refused as "already exists"
 * anyway — permanently, because every failed attempt re-poisons the page for the next run.
 *
 * It matters more than a stuck queue: this is the only check standing between a second mailbox and
 * an address that already has one, and a text scan is wrong in BOTH directions.
 *
 * 🔴 AND IT FAILS CLOSED. An unreadable count refuses rather than answering "absent", because
 * "absent" is the answer that goes on to create a mailbox. More than one row refuses too: the search
 * is for one address, so two rows mean the filter is not doing what the caller believes.
 */
export function readExistence(rows: number, address: string): ExistenceReading {
  if (!Number.isFinite(rows) || rows < 0) {
    return {
      refusal:
        `Could not count the rows for ${address} in the Turbify console, so the robot cannot tell `
        + "whether the mailbox already exists. It stopped rather than risk creating a second one.",
    };
  }
  if (rows > 1) {
    return {
      refusal:
        `Searching the Turbify console for ${address} showed ${rows} rows, so the list is not filtered `
        + "to the one address the robot asked about. It stopped rather than read an answer about "
        + "somebody else's mailbox.",
    };
  }
  return { exists: rows === 1 };
}
