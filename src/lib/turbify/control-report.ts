/**
 * Reporting the controls on a Turbify page, so a flow can be calibrated without guessing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. Clearing a leaver's app passwords needs the wordings that LIST and REMOVE an
 * existing one (`APP_PASSWORD_REVOKE_CONTROLS`), and nobody has ever seen them. The page they live
 * on is reachable only by signing in AS a mailbox — and the joiner robot is already standing on it,
 * signed in, every time it provisions a new hire, because that is where it presses Generate.
 *
 * So the calibration is a BY-PRODUCT of the robot's own authorised run rather than a person driving
 * a browser at somebody's mailbox: with the flag on, it reads the page it is already on and reports
 * what it found. No extra sign-in, no extra mailbox touched, and nothing is clicked.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THE PAGE IS DISPLAYING A FRESHLY MINTED APP PASSWORD AT THE EXACT MOMENT THIS READS IT. That is
 * the whole hazard here: a naive dump of the page's text would write a live mailbox credential into
 * the production logs, where it would sit in Railway and in Sentry for anyone with log access. So
 * this module is built around REDACTION, not around collection:
 *
 *   1. every secret the caller is holding is removed by exact match, case-insensitively;
 *   2. any remaining long run of non-space characters is dropped WHOLESALE, because that is the
 *      shape of a secret and the shape `generateAppPassword` itself looks for — the same heuristic
 *      that reads the password is the one that refuses to print it;
 *   3. only short, human labels survive, which is all a locator ever needs.
 *
 * It is a pure function over a list of elements so all of that is provable without a browser, and
 * the tests assert the password cannot come out.
 */

/** One element as read off the page. No values — a form value can BE the secret. */
export type ObservedControl = {
  /** The element's role or tag, e.g. "button", "a", "input". */
  role: string;
  /** Its accessible name, if any. */
  name?: string | null;
  /** Its visible text, if any. */
  text?: string | null;
};

/**
 * The longest a label may be before it is treated as prose rather than a control name.
 *
 * A locator matches on short visible text ("Generate", "Manage App Passwords"), so anything longer
 * is both useless here and more likely to be a paragraph carrying something it should not.
 */
export const MAX_LABEL_LENGTH = 48;

/**
 * A run of non-space characters at least this long is treated as a secret and dropped.
 *
 * Deliberately the same shape `generateAppPassword` uses to FIND the app password (>= 12 characters,
 * no whitespace). Keeping the two in step is the point: whatever that reader would pick up, this
 * refuses to emit.
 */
export const SECRET_LIKE_MIN_LENGTH = 12;

/** True when a token looks like a credential rather than a label. */
export function looksLikeSecret(token: string): boolean {
  const value = token.trim();
  if (value.length < SECRET_LIKE_MIN_LENGTH) return false;
  if (/\s/.test(value)) return false;
  // A long hyphenated or dotted word is usually a URL, a domain or an id — still not a label, and
  // still not worth emitting, so it is dropped on the same rule rather than excused.
  return true;
}

/**
 * Strip anything secret-shaped, and anything the caller knows is secret, from one label.
 *
 * Returns null when nothing printable survives, so the caller drops the entry entirely rather than
 * emitting an empty row that implies the control had no name.
 */
export function redactLabel(raw: string | null | undefined, secrets: readonly string[]): string | null {
  let value = String(raw ?? "");
  if (!value.trim()) return null;

  // 1. Exact, case-insensitive removal of every secret we are holding.
  for (const secret of secrets) {
    const needle = String(secret ?? "").trim();
    if (needle.length < 4) continue; // too short to match safely
    let index = value.toLowerCase().indexOf(needle.toLowerCase());
    while (index !== -1) {
      value = `${value.slice(0, index)}[redacted]${value.slice(index + needle.length)}`;
      index = value.toLowerCase().indexOf(needle.toLowerCase());
    }
  }

  // 2. Drop every remaining secret-shaped token.
  const kept = value
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => (looksLikeSecret(token) ? "[redacted]" : token));

  const cleaned = kept.join(" ").trim();
  if (!cleaned || cleaned.replace(/\[redacted\]/g, "").trim().length === 0) return null;
  // 3. Short labels only.
  return cleaned.length > MAX_LABEL_LENGTH ? `${cleaned.slice(0, MAX_LABEL_LENGTH)}` : cleaned;
}

export type ControlReport = {
  page: string;
  /** One line per control that survived redaction, deduplicated and ordered as read. */
  controls: string[];
  /** How many were read before redaction, so a silent drop is visible. */
  observed: number;
  /** How many were dropped because nothing printable survived. */
  redacted: number;
};

/**
 * Build a safe, loggable report of a page's controls.
 *
 * `secrets` is every value the caller is holding that must never appear — the minted app password,
 * the mailbox password, the one-time password. Passing them is not optional in practice: the exact
 * match is what catches a secret that is too short to trip the shape rule.
 */
export function buildControlReport(
  page: string,
  observed: readonly ObservedControl[],
  secrets: readonly string[] = [],
): ControlReport {
  const lines: string[] = [];
  const seen = new Set<string>();
  let redacted = 0;

  for (const control of observed) {
    const role = redactLabel(control.role, secrets) ?? "?";
    const name = redactLabel(control.name, secrets);
    const text = redactLabel(control.text, secrets);
    if (!name && !text) {
      redacted += 1;
      continue;
    }
    // `name` and `text` often agree; print the pair only when they differ, so the report stays
    // readable enough to turn straight into a locator.
    const label = name && text && name !== text ? `${name} | ${text}` : (name ?? text ?? "");
    const line = `${role}: ${label}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }

  return { controls: lines, observed: observed.length, page, redacted };
}

/**
 * The flag that turns the report on. OFF unless it is exactly "true".
 *
 * Off by default because this is a diagnostic: it writes page structure into the production log, and
 * it should be on for the one run that calibrates a flow and then go off again.
 */
export const CONTROL_REPORT_ENV = "PHOENIX_TURBIFY_REPORT_CONTROLS" as const;

export function controlReportEnabled(value = process.env[CONTROL_REPORT_ENV]): boolean {
  return String(value ?? "").trim() === "true";
}

/**
 * The page-reading expression, kept here beside the redaction so the two are read together.
 *
 * 🔴 It collects role, accessible name and SHORT text, and deliberately never reads `value`, an
 * `input`'s contents, or `innerText` of the whole document — the places the minted password is. The
 * redaction above is the second line of defence, not the first.
 */
export const CONTROL_READ_EXPRESSION = `(() => {
  const out = [];
  const nodes = document.querySelectorAll('button, a, [role="button"], [role="link"], input, [aria-label]');
  for (const el of nodes) {
    const role = (el.getAttribute('role') || el.tagName || '').toLowerCase();
    const name = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '';
    // The element's own text, trimmed and capped. Never a form field's contents, and never a
    // whole container's rendered text — those are where a displayed credential lives.
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 64);
    out.push({ role, name, text });
  }
  return out;
})()`;
