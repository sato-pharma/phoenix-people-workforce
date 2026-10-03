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
 * The one-row rule as a PURE decision, for a driver that reads the rows itself.
 *
 * 🔴 IT IS AN IDENTITY RULE, NOT A COUNT. This replaced a count-based guard on 2026-10-03, because
 * the console's search is a SUBSTRING match and a count cannot see "exactly one row, and it is
 * somebody else's mailbox". `adel.sayed@satopharma.com` matches a search for
 * `el.sayed@satopharma.com`, is Active, and carries its own `Reset password` button — so the count
 * guard returned "safe to act" and the next click would have reset a working employee out of their
 * mail. The old comment here even named "an address that is a prefix of another" as the danger; the
 * count simply could not detect it.
 *
 * `resolveOne` is the version for a reader this module can query. The revocation and provisioning
 * drivers work directly against puppeteer, so they need the same rule without a reader — keeping the
 * decision here means there is ONE statement of it for the whole Turbify console, provable without a
 * browser.
 *
 * Returns null when it is safe to act, or the refusal to throw. Rows that could not be read are a
 * refusal too: an unreadable list is not an empty one, and treating it as empty is how a robot
 * proceeds against a page it never saw.
 */
export function rowIdentityRefusal(
  rows: readonly ConsoleMailboxRow[] | null | undefined,
  address: string,
  action = "Reset",
): string | null {
  const reading = readExistenceFromRows(rows, address);
  if ("refusal" in reading) return `${action} ${address}: ${reading.refusal}`;
  if (!reading.exists) {
    const seen = Array.isArray(rows) ? rows.length : 0;
    return (
      `${action} ${address}: after filtering to this address, no row CARRIES that address — `
      + `${seen} row(s) matched the search, which is a substring match. Nothing was clicked.`
    );
  }
  if (reading.status === "pending") {
    return (
      `${action} ${address}: the row exists but is PENDING, so it has no password to act on. `
      + "Nothing was clicked."
    );
  }
  return null;
}

/**
 * Does this dialog's text NAME this mailbox? Compared as whole tokens, never with `includes`.
 *
 * 🔴 WHY `includes` IS NOT SAFE HERE, measured 2026-10-03. `adel.sayed@satopharma.com` CONTAINS
 * `el.sayed@satopharma.com`, so a reset that opened the dialog for the wrong employee satisfied an
 * `includes` check and would have been recorded as the right one. The substring relation defeats the
 * row filter and the confirmation together, which is why both now compare identity.
 */
export function dialogNamesAddress(text: string | null | undefined, address: string): boolean {
  const wanted = String(address ?? "").trim().toLowerCase();
  if (wanted.length === 0) return false;
  const local = wanted.split("@")[0];
  const tokens = new Set(
    // 🔴 THE GLUE BOUNDARY, measured on the live dialog 2026-10-03. `textContent` runs the address
    // straight into the NEXT LABEL with no separator at all:
    //
    //     Email account:hr.mailbox@satopharma.comOne-time password: ...
    //
    // so the only token was `hr.mailbox@satopharma.comone-time`, and neither the address nor its
    // local part survived. The check then refused a dialog that DOES name the mailbox, and the
    // invite-inbox adoption stopped on it. This is the same `textContent` concatenation that made a
    // table row's address parse as `Abd-Elnaimahmed.mohamed@satopharma.com` — met a second time, in
    // the dialog, after being fixed for rows.
    //
    // A lowercase→uppercase transition is where that glue always falls, because what follows is the
    // next label's capitalised first word. Inserting a boundary there can only ever SPLIT a token,
    // so it cannot turn a near miss into a match: `adel.sayed@satopharma.comOne-time` still yields
    // `adel.sayed@satopharma.com`, which still does not equal `el.sayed@satopharma.com`.
    String(text ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9._%+@-]+/)
      .filter((token) => token.length > 0),
  );
  return tokens.has(wanted) || (local.length > 0 && tokens.has(local));
}

/** Whether the locator resolves at all, without throwing. For verifying a page is the expected one. */
export async function isPresent(page: CandidateReader, locator: Locator): Promise<boolean> {
  return (await findMatches(page, locator)).length > 0;
}

/** One row of the console's mailbox table, as the ROW itself reports it. */
export type ConsoleMailboxRow = {
  /** The address read from the row's OWN cell, not from the row's concatenated text. */
  address: string;
  /** What the Status column says. A `pending` mailbox exists but has no password yet. */
  status: MailboxRowStatus;
};

export type MailboxRowStatus = "active" | "pending" | "unknown";

export type ExistenceReading =
  | { exists: false }
  | { exists: true; status: MailboxRowStatus }
  | { refusal: string };

/**
 * Read "does this address exist?" from the ROWS' OWN ADDRESSES — never from a row COUNT, and never
 * from the page's text.
 *
 * 🔴 WHY A COUNT IS NOT ENOUGH, measured on production 2026-10-03. The console's search is a
 * SUBSTRING match, so searching the full address `el.sayed@satopharma.com` returns the row for
 * `adel.sayed@satopharma.com` — a different employee, whose address literally contains the one
 * asked about ("ad" + "el.sayed@satopharma.com"). That is ONE row, so a count-based reader called it
 * EXISTS and the robot refused to create El Sayed Rady's mailbox for ever, blaming Phoenix's record
 * while Phoenix was right. The same shape in reverse is worse: a real new hire whose address is a
 * substring of somebody else's would be silently skipped.
 *
 * So the question is answered by comparing each row's own address cell, exactly. A count can only
 * ever say "something matched", which is not the question.
 *
 * 🔴 AND THE STATUS IS PART OF THE ANSWER. A mailbox Turbify has created but that has not completed
 * its invitation sits at `Pending`: it EXISTS, it carries no password, and it is absent from the
 * console's "Active mailboxes" figure and carries no `Reset password` button. A reader that looked
 * at either of those called a created mailbox absent — which is how two real ones (`ahmed.mohamed`,
 * `asmaa.zaghloul`) were created and then reported as never created at all.
 *
 * The earlier count-based reader took `(rows: number)`. It is deliberately gone rather than kept
 * beside this one: a caller reaching for it would be reintroducing the measured defect above.
 */
export function readExistenceFromRows(
  rows: readonly ConsoleMailboxRow[] | null | undefined,
  address: string,
): ExistenceReading {
  if (!Array.isArray(rows)) {
    return {
      refusal:
        `Could not read the Turbify console's rows for ${address}, so the robot cannot tell whether `
        + "the mailbox already exists. It stopped rather than risk creating a second one.",
    };
  }
  const wanted = address.trim().toLowerCase();
  if (wanted.length === 0) {
    return { refusal: "No address was given to look for in the Turbify console, so nothing was read." };
  }
  const exact = rows.filter(
    (row) => typeof row?.address === "string" && row.address.trim().toLowerCase() === wanted,
  );
  if (exact.length > 1) {
    return {
      refusal:
        `${exact.length} rows in the Turbify console carry the address ${address} itself, which should `
        + "be impossible. The robot stopped rather than act on one of them.",
    };
  }
  if (exact.length === 1) return { exists: true, status: readRowStatus(exact[0].status) };
  return { exists: false };
}

/** Narrow whatever the row reported to the three states the robot distinguishes. */
export function readRowStatus(value: unknown): MailboxRowStatus {
  if (typeof value !== "string") return "unknown";
  const text = value.trim().toLowerCase();
  if (text === "pending") return "pending";
  if (text === "active") return "active";
  return "unknown";
}

/**
 * The selector that reaches the console's mailbox rows. The table is a real `<table>`, but the
 * console also marks rows with ARIA roles, so both are asked for.
 */
export const MAILBOX_ROW_QUERY = "tr, [role=row]" as const;

/**
 * Read one row per mailbox out of the DOM, taking each address from ITS OWN CELL.
 *
 * 🔴 NOT FROM THE ROW'S TEXT. The row renders the display name immediately before the address with
 * no separator, so `(row.textContent)` reads "Ahmed Mohamed Abd-Elnaimahmed.mohamed@satopharma.com"
 * and an email pattern over that string matches `Abd-Elnaimahmed.mohamed@satopharma.com` — an
 * address that belongs to nobody. Every row then fails to match the address asked about, and a
 * mailbox that plainly exists reads as absent. Measured on production 2026-10-03.
 *
 * A real function, never a string: a string handed to `page.evaluate` passes through the template
 * and escaping layers that have already turned one of this robot's regexes into a different regex.
 */
export function readMailboxRowCells(elements: Element[]): ConsoleMailboxRow[] {
  const rows: ConsoleMailboxRow[] = [];
  for (const element of elements) {
    const cells = Array.from(element.querySelectorAll("td, th, [role=cell], [role=gridcell]"))
      .map((cell) => (cell.textContent ?? "").trim());
    const address = cells.find((value) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value));
    if (!address) continue;
    const text = (element.textContent ?? "").toLowerCase();
    const status = text.includes("pending") ? "pending" : (text.includes("active") ? "active" : "unknown");
    rows.push({ address: address.toLowerCase(), status });
  }
  return rows;
}
