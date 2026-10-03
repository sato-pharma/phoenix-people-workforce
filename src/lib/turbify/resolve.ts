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

/** What a one-time password read either found, or why it refused to hand one back. */
export type OneTimePasswordReading = { password: string } | { refusal: string };

/**
 * The labels the one-time-password dialog prints around the credential. Matched whole and lowercased,
 * so a label can never be mistaken for the password itself.
 */
const DIALOG_LABELS: ReadonlySet<string> = new Set([
  "cancel", "close", "close modal", "copy", "done", "email account", "hide", "hide password", "ok",
  "one time password", "one-time password", "password", "print", "send invite", "show",
  "show password", "temp password", "temporary password",
]);

/**
 * Read the one-time password out of the dialog's text.
 *
 * 🔴 THIS REPLACED "THE LONGEST NON-WHITESPACE LINE IN `document.body`", WHICH RETURNED THE MAILBOX
 * ADDRESS EVERY SINGLE TIME — and that, not any of the three sign-in faults fixed before it, is why
 * the owner's adoption clicks failed. The old reader scored candidates by LENGTH, and the dialog is
 * REQUIRED to name the mailbox (`dialogNamesAddress` above refuses one that does not), so
 * `hr.mailbox@satopharma.com` — 25 characters, no whitespace, plenty of non-letters — outscored a
 * ~10-character generated credential. The robot then typed the ADDRESS into the password box, Turbify
 * refused it, and the step reported "the expected page never appeared" while sitting on a login form
 * that was telling the truth. Reading `document.body` rather than the dialog made it worse: the
 * account list behind the modal supplies a whole column of longer addresses.
 *
 * So length is no longer a signal at all. The address is excluded by construction — nothing holding
 * `@`, and nothing equal to the address, its local part or its domain, can be returned — and the
 * surrounding labels are excluded by name. What is left is required to be UNIQUE: two plausible
 * candidates refuse and report how many and how long, never what they said, because the one thing
 * worse than stopping here is handing back a credential that is actually somebody's address.
 */
export function pickOneTimePassword(
  text: string | null | undefined,
  address: string,
): OneTimePasswordReading {
  return pickCredential(text, address, {
    labels: DIALOG_LABELS,
    minLength: 8,
    // A reset password from this console carries digits or capitals; plain lowercase prose does not
    // qualify. An APP password does — see `pickAppPassword`, which must not inherit this.
    requireNonLowercase: true,
    what: "one-time password",
    where: "the dialog",
  });
}

/**
 * The labels around the minted app password, inside the mailbox's own account pages.
 *
 * These are not measured — nothing in Phoenix has ever stood on that page (`APP_PASSWORD_WORDINGS`
 * in `locators.ts` says the same of the three clicks that get there). They are listed so that the
 * obvious furniture cannot be mistaken for the credential, and the read fails CLOSED when something
 * unlisted survives, rather than returning the first long thing it sees.
 */
const APP_PASSWORD_LABELS: ReadonlySet<string> = new Set([
  "account info", "account information", "account security", "account settings", "app password",
  "app passwords", "apppasswords", "cancel", "close", "continue", "copy", "done", "generate",
  "manage app passwords", "notifications", "preferences", "privacy", "security", "sign out",
  "subscriptions",
]);

/**
 * Read the app password Turbify has just minted inside the mailbox.
 *
 * 🔴 THE SAME LENGTH-SCORED READ WAS HERE TOO, and it would have been the NEXT thing to fail: this
 * page is signed in AS the mailbox, so it prints the address, and "the longest space-free line of 12
 * characters or more" is `hr.mailbox@satopharma.com` at 25 against an app password at about 16. The
 * step would have reported "no app password could be read" at best and recorded the ADDRESS as
 * Phoenix's stored credential at worst. Found by grepping for the pattern after fixing the one-time
 * password read, which is the rule this module keeps having to relearn: when you fix something here,
 * search for the shape before you commit.
 *
 * 🔴 UNLIKE A ONE-TIME PASSWORD, AN APP PASSWORD MAY BE ALL LOWERCASE — Yahoo-platform app passwords
 * are commonly 16 plain lowercase letters, so the "must contain a non-lowercase character" test that
 * protects the dialog read would reject every real one here.
 */
export function pickAppPassword(
  text: string | null | undefined,
  address: string,
): OneTimePasswordReading {
  return pickCredential(text, address, {
    labels: APP_PASSWORD_LABELS,
    minLength: 12,
    requireNonLowercase: false,
    what: "app password",
    where: "the page",
  });
}

type CredentialShape = {
  labels: ReadonlySet<string>;
  minLength: number;
  requireNonLowercase: boolean;
  what: string;
  where: string;
};

/**
 * The shared rule behind both reads. **Length is never a signal**; the address can never be returned.
 *
 * `innerText` is what the callers pass, so a line break still separates a label from its value. The
 * value after the last colon is considered as well as the whole line, because the console prints
 * `One-time password: Xk9mPq2w` on one line in some renderings and on two in others.
 */
function pickCredential(
  text: string | null | undefined,
  address: string,
  shape: CredentialShape,
): OneTimePasswordReading {
  const wanted = String(address ?? "").trim().toLowerCase();
  const local = wanted.split("@")[0] ?? "";
  const domain = wanted.includes("@") ? (wanted.split("@")[1] ?? "") : "";
  const forbidden = new Set([wanted, local, domain].filter((value) => value.length > 0));

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const afterColon = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1).trim() : "";
    for (const value of [afterColon, trimmed]) {
      if (value.length < shape.minLength || value.length > 64) continue;
      if (/\s/.test(value)) continue;
      // 🔴 The address is the thing these reads kept returning. It cannot survive either of these.
      if (value.includes("@")) continue;
      if (forbidden.has(value.toLowerCase())) continue;
      if (shape.labels.has(value.toLowerCase())) continue;
      if (value.endsWith(":")) continue;
      // 🔴 THE DIALOG CONTAINS THE LOGIN URL — Turbify documents it: "you will see the user's email
      // address, the one-time password, AND THE LOGIN URL" (help article SLN29262). A URL survives
      // every test above — no spaces, no `@`, the right length — and `https://mail.turbify.com`
      // even yields a second candidate through the after-the-colon split (`//mail.turbify.com`). It
      // only lost to the password by luck, because the password happens to carry a digit and the URL
      // does not. Excluded explicitly instead.
      if (/^https?:/i.test(value) || value.includes("://") || value.startsWith("//")) continue;
      if (/\.(com|net|org|co|io)$/i.test(value)) continue;
      if (shape.requireNonLowercase && !/[^a-z]/.test(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      candidates.push(value);
    }
  }

  if (candidates.length === 1) return { password: candidates[0]! };
  if (candidates.length === 0) {
    return {
      refusal:
        `nothing in ${shape.where} looked like ${article(shape.what)} ${shape.what}. Every line was `
        + "either the mailbox address, one of the page's own labels, or too short to be a credential.",
    };
  }

  // More than one survived. A generated credential mixes letters and digits; prefer that class.
  const mixed = candidates.filter((value) => /[a-z]/i.test(value) && /[0-9]/.test(value));
  if (mixed.length === 1) return { password: mixed[0]! };

  const lengths = (mixed.length > 0 ? mixed : candidates).map((value) => value.length).join(", ");
  return {
    refusal:
      `${candidates.length} different values in ${shape.where} could each have been the ${shape.what} `
      + `(lengths ${lengths}), so the robot refused to guess which one is the credential.`,
  };
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
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
