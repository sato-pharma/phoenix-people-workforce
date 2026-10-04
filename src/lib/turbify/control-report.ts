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
  /**
   * Where the element SITS, as a short CSS path — tags, ids, classes and positions, never text.
   *
   * 🔴 THIS IS WHY THE CAPTURE EXISTS AT ALL NOW. Two of the four controls a clear needs —
   * `existingList` (the rows of app passwords already issued) and `emptyState` (how the page reads
   * once none are left) — are plain TEXT, and the reader above is forbidden from reading a
   * container's text because on this page that text IS a credential. They were therefore
   * uncalibratable by label for as long as the label was the only thing reported: the 10:30 Cairo
   * run on 2026-10-04 read 22 controls and could fill exactly one of the four.
   *
   * A path names those two without reading a character more: the entry rows are whatever contains
   * the Remove buttons, and the empty state is that same container with none of them under it. It
   * is also what `APP_PASSWORD_REVOKE_CONTROLS` actually stores — `{ label, selector }` — so a
   * path, not a wording, is the thing those fields were always waiting for.
   */
  selector?: string | null;
  /**
   * How many siblings share this element's tag, counting itself.
   *
   * The one number that separates "no app passwords are listed" from "the rows are there and the
   * reader cannot see their text". Without it, an empty `existingList` and a redacted one look
   * identical in the report — which is exactly the ambiguity the first run left behind.
   */
  siblings?: number | null;
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
      // 🔴 THE SECOND COPY OF THE SAME LOOP, fixed the same day (2026-10-03): resume AFTER the
      // marker. Searching from 0 again never terminates for a secret that is a substring of
      // "[redacted]" — and this one runs inside a diagnostic that must never fail a run.
      index = value.toLowerCase().indexOf(needle.toLowerCase(), index + "[redacted]".length);
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

/**
 * The longest a path may be before it is truncated.
 *
 * Three segments of tag + id + two classes + a position is comfortably inside this; anything longer
 * is a generated class soup that is useless as a locator and worth less than the bytes.
 */
export const MAX_SELECTOR_LENGTH = 160;

/**
 * True when one word inside a CSS identifier reads like English rather than like a credential.
 *
 * 🔴 ONLY EVER USED ON A PATH, NEVER ON A LABEL. A label is prose and `looksLikeSecret` is right
 * about it; an identifier is not. `notifications` is 13 characters with no space, so the plain
 * shape rule drops it and the path loses the one class that made it worth keeping — while
 * `xqhdlpzwmrkfabcd` must still go. The two are told apart by how they are SPELLED: a word is all
 * lower case, carries no digits, and has vowels in roughly the proportion English has them. A
 * minted password is vowel-starved, or mixes case and digits, or both.
 *
 * It is deliberately conservative: anything it is unsure about is NOT a word, and so is dropped.
 */
export function looksLikePathWord(word: string): boolean {
  if (!/^[a-z]+$/.test(word)) return false;
  const vowels = (word.match(/[aeiou]/g) ?? []).length;
  return vowels / word.length >= 0.25;
}

/**
 * Strip anything secret-shaped out of a CSS path, segment by segment.
 *
 * 🔴 A PATH IS BUILT FROM ATTRIBUTES, AND AN ATTRIBUTE CAN CARRY A SECRET — `id="pw-xqhdlpzwmrkf"`
 * is a perfectly ordinary thing for a credential row to have. So a path goes through the same two
 * rules as a label: every secret in hand by exact match, then anything secret-SHAPED by shape. It
 * cannot reuse `redactLabel`, which splits on whitespace: a path has none, so the whole path would
 * be judged as one token and a long one dropped wholesale.
 *
 * Returns null when nothing usable survives, so the caller omits the path rather than printing a
 * row of `[redacted]` that reads like a located control.
 */
export function redactSelector(raw: string | null | undefined, secrets: readonly string[] = []): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  // Split on the CSS punctuation so each id, class and tag is judged on its own, and so the
  // punctuation itself is never mistaken for part of a long token. A `#` or `.` is kept WITH the
  // token it introduces, so dropping the token drops its punctuation too.
  const parts = value.split(/(?=[\s>#.:,])|(?<=[\s>:,([\]])/);
  const kept = parts.map((part) => {
    const head = (/^[#.]/.exec(part) ?? [""])[0];
    const token = part.slice(head.length);
    if (!token || /^[\s>:,()[\]"'=]+$/.test(token)) return part;

    for (const secret of secrets) {
      const needle = String(secret ?? "").trim();
      if (needle.length >= 4 && token.toLowerCase().includes(needle.toLowerCase())) {
        return "";
      }
    }
    // 🔴 `looksLikeSecret` IS WRONG FOR A PATH AND MUST NOT BE USED ON ONE WHOLE. Its rule is "12+
    // characters with no whitespace", which is the shape of every ordinary CSS identifier —
    // `app-password-row` is 16. Applied directly it would redact exactly the class names that make
    // a path worth having. So the token is split on its own separators first and each WORD judged:
    // a credential is one long undivided run, an identifier is short words joined by - or _.
    if (token.split(/[-_]/).some((word) => looksLikeSecret(word) && !looksLikePathWord(word))) {
      return "";
    }
    return part;
  });

  // 🔴 AND A DROPPED PART IS REMOVED, NOT REPLACED WITH A MARKER. `div#[redacted] > button.rm` is
  // not a selector any more — it names a class that does not exist, so a later reader pins a
  // locator that can never match. `div > button.rm` is shorter, honest, and still resolves.
  const cleaned = kept.join("").replace(/\s+/g, " ").replace(/\s*>\s*/g, " > ").trim();
  // Nothing left means the path locates nothing — omit it rather than return an empty string that
  // a caller would print as a located control.
  //
  // 🔴 THERE IS DELIBERATELY NO SECOND GUARD HERE for "something was dropped and no letters
  // survive". It was written, and breaking it changed no test: a path always carries tag names, so
  // letters survive every drop, and the only case with none left is the empty string this line
  // already catches. A dead branch in a redactor is worse than no branch — it reads like a
  // protection while doing nothing, so the next reader trusts a guard that has never run.
  if (!cleaned) return null;
  return cleaned.length > MAX_SELECTOR_LENGTH ? cleaned.slice(0, MAX_SELECTOR_LENGTH) : cleaned;
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
    const selector = redactSelector(control.selector, secrets);
    const siblings = typeof control.siblings === "number" && control.siblings > 1 ? control.siblings : null;
    // 🔴 THE PATH IS PART OF THE DEDUPLICATION KEY, AND THAT IS THE POINT, not a side effect. Two
    // `Remove` buttons used to collapse into one line, which is precisely the reading that hid how
    // many app passwords a mailbox actually has — one entry and five entries printed identically.
    // Pathed separately, they stay separate, and the count becomes readable off the report.
    const line =
      `${role}: ${label}`
      + (selector ? ` @ ${selector}` : "")
      + (siblings ? ` ×${siblings}` : "");
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
 * 🔴 It collects role, accessible name, SHORT text and a STRUCTURAL path, and deliberately never
 * reads `value`, an `input`'s contents, or `innerText` of the whole document — the places the
 * minted password is. The redaction above is the second line of defence, not the first.
 *
 * The path was added on 2026-10-04 and reads no text whatsoever: tag, id, class and position only.
 * That is the whole reason it was a safe way to finish the calibration — the two controls still
 * unknown after the first live run are text that this reader is forbidden to touch, and a path
 * names them without touching it.
 */
export const CONTROL_READ_EXPRESSION = `(() => {
  const out = [];
  // A path is built from ATTRIBUTES ONLY — tag, id, class, position. It never reads text, so it
  // adds no new way for the displayed password to escape, and the redaction still runs over it.
  const SAFE = /^[A-Za-z][\\w-]{0,31}$/;
  const segment = (el) => {
    const tag = (el.tagName || '').toLowerCase();
    const id = el.getAttribute('id') || '';
    if (SAFE.test(id)) return tag + '#' + id;
    const classes = (el.getAttribute('class') || '').trim().split(/\\s+/).filter((c) => SAFE.test(c)).slice(0, 2);
    let seg = tag + classes.map((c) => '.' + c).join('');
    const parent = el.parentElement;
    if (parent) {
      let n = 1;
      for (const sib of parent.children) {
        if (sib === el) break;
        if (sib.tagName === el.tagName) n += 1;
      }
      seg += ':nth-of-type(' + n + ')';
    }
    return seg;
  };
  // Three levels is enough to name the row AND the container it sits in, which is what tells an
  // entry apart from the list holding it. Deeper is a generated-class soup that locates nothing.
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 3; depth += 1) {
      parts.unshift(segment(node));
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const nodes = document.querySelectorAll('button, a, [role="button"], [role="link"], input, [aria-label]');
  for (const el of nodes) {
    const role = (el.getAttribute('role') || el.tagName || '').toLowerCase();
    const name = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '';
    // The element's own text, trimmed and capped. Never a form field's contents, and never a
    // whole container's rendered text — those are where a displayed credential lives.
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 64);
    const parent = el.parentElement;
    let siblings = 1;
    if (parent) {
      siblings = 0;
      for (const sib of parent.children) {
        if (sib.tagName === el.tagName) siblings += 1;
      }
    }
    out.push({ name, role, selector: pathOf(el), siblings, text });
  }
  return out;
})()`;
