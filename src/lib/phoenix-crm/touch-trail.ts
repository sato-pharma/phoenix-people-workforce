/**
 * Phoenix CRM — THE TOUCH TRAIL's rules.
 *
 * Owner, 2026-10-03: "every click or every touch on the touch screen for this module to be saved in a
 * separate audit trail … every single thing is saved, even if the rep didn't save it … anything you
 * can record, anything you can capture … like a file manager grabber."
 *
 * This file is the half with NO DOM and NO server client in it, so both ends run the same rules and a
 * test can reach them: what an element is called, what may be stored, how big a batch may be, and how
 * the server reads one back. The listeners live in
 * `src/components/phoenix-crm/touch-trail-collector.tsx`; the writer in `server/touch-trail.ts`.
 *
 * FOUR RULES GOVERN EVERY LINE HERE.
 *
 *   1. 🔴 GOLDEN RULE #1 IS UNTOUCHED. The rep's app is easy and BLIND. Nothing here adds a step, draws
 *      anything, changes a message or a figure, or can be noticed by him. Collection is passive and
 *      every listener is `passive`/capture-phase, so it cannot swallow or delay his own tap.
 *
 *   2. IT MUST NEVER COST A REP HIS WORK. Every function is total: bad input produces a dropped row,
 *      never a throw. A trail that fails is a trail that is missing, never a rep who is stuck.
 *
 *   3. 🔴 A PASSWORD-TYPE FIELD'S VALUE NEVER LEAVES THE BROWSER. `valueForTrail` drops it at the point
 *      of capture rather than on the way in, so there is no stored secret for a later redaction to
 *      forget. Everything else the rep types IS kept, deliberately and at his instruction — the comment
 *      he wrote and deleted is the single most useful thing in this table.
 *
 *   4. 🔴 THE VOLUME IS REAL, SO SCROLL IS SAMPLED AND NOTHING ELSE IS. One rep's field day is hundreds
 *      of taps; a raw scroll stream alone is thousands. Scroll is coalesced to one row per
 *      `SCROLL_SAMPLE_MS` per screen — kept, not dropped, because "he scrolled the list for a minute and
 *      pressed nothing" is a real finding. Every other kind is recorded one row per event.
 */

/** The kinds the collector sends. Free text in the column: an unknown kind must land, not be refused. */
export const TOUCH_TRAIL_KINDS = [
  "tap",
  "press",
  "type",
  "change",
  "focus",
  "submit",
  "screen",
  "scroll",
  "hide",
  "show",
  "offline",
  "online",
] as const;

export type TouchTrailKind = (typeof TOUCH_TRAIL_KINDS)[number];

/** One interaction, as the browser hands it over. Short keys: this travels hundreds of times a day. */
export type TouchTrailEvent = {
  kind: string;
  msSinceLoad: number | null;
  deviceAt: string | null;
  route: string | null;
  screen: string | null;
  element: string | null;
  elementLabel: string | null;
  value: string | null;
  valueLength: number | null;
  pointerX: number | null;
  pointerY: number | null;
  viewportW: number | null;
  viewportH: number | null;
};

/** One POST: a page load's identity plus the events collected since the last flush. */
export type TouchTrailBatch = {
  sessionId: string;
  seatId: string | null;
  test: boolean;
  events: TouchTrailEvent[];
};

/**
 * Flush on a timer as well as on a full buffer, so a quiet screen still files what it saw.
 *
 * 30 s, not the 5 s it shipped with (Phoenix CRM performance audit, 2026-10-16): the trail was the
 * module's busiest request — every few seconds from every rep's phone — for rows nobody reads live.
 * Nothing is lost by waiting: a busy screen still sends at `FLUSH_AT_EVENTS`, and hiding or leaving
 * the page sends at once (the collector's `visibilitychange` and `pagehide`).
 */
export const FLUSH_EVERY_MS = 30_000;
/** And flush early once the buffer reaches this, so a busy screen does not hold a minute of evidence. */
export const FLUSH_AT_EVENTS = 40;
/** The most one request may carry. A bigger buffer is split across requests, never trimmed. */
export const MAX_EVENTS_PER_BATCH = 200;
/** One scroll row per screen per this long. The only kind that is sampled (rule 4). */
export const SCROLL_SAMPLE_MS = 1_000;
/** A typed body longer than this is stored cut to it; `valueLength` always records the true length. */
export const MAX_VALUE_CHARS = 4_000;
/** A label is the words on the control, not a paragraph. */
export const MAX_LABEL_CHARS = 160;
/**
 * And a CONTAINER the finger merely landed on gets this much — one heading's worth.
 *
 * Owner, 2026-10-03: "trim the touch trail label to the control, not the whole card." A press that
 * finds no interactive owner is recorded against the element under the finger, and that element's
 * `innerText` is every descendant's text joined — so the first hour of real data recorded a 159-char
 * label for one tap on a banner ("Get Phoenix CRM messages on Telegram Plans, requests and reminders
 * reach your phone the moment they happen. Connect Telegram Later New here? The one-page guide").
 * At a rep's thousand events a day that buries the signal it exists to carry.
 */
export const MAX_CONTAINER_LABEL_CHARS = 48;
/** Held in the browser while it is offline. Past this the OLDEST are dropped: recent is worth more. */
export const MAX_QUEUED_EVENTS = 1_000;

/**
 * The input types whose value is never recorded, at the point of capture.
 *
 * `password` is the one that matters; the other two are here because a browser may give either to a
 * password manager, and a one-time code is a secret for as long as it is useful.
 */
const SECRET_INPUT_TYPES = new Set(["password", "otp", "one-time-code"]);

/** True when this field's contents must not leave the browser at all. */
export function isSecretField(field: { type?: string | null; autocomplete?: string | null; name?: string | null }): boolean {
  const type = (field.type ?? "").trim().toLowerCase();
  if (SECRET_INPUT_TYPES.has(type)) return true;
  const autocomplete = (field.autocomplete ?? "").trim().toLowerCase();
  if (autocomplete.includes("password") || autocomplete.includes("one-time-code")) return true;
  const name = (field.name ?? "").trim().toLowerCase();
  return name.includes("password") || name.includes("passcode");
}

/**
 * What to store for a field's contents: the text, or nothing at all for a secret.
 *
 * The length is reported for a secret too — that a password of 11 characters was typed is a fact about
 * the session and not a disclosure, and it is what tells a failed sign-in from an abandoned one.
 */
export function valueForTrail(
  field: { type?: string | null; autocomplete?: string | null; name?: string | null },
  raw: unknown,
): { value: string | null; valueLength: number | null } {
  const text = typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : String(raw);
  if (!text) return { value: null, valueLength: 0 };
  if (isSecretField(field)) return { value: null, valueLength: text.length };
  return { value: text.length > MAX_VALUE_CHARS ? text.slice(0, MAX_VALUE_CHARS) : text, valueLength: text.length };
}

/**
 * A stable name for the thing that was touched.
 *
 * The order is deliberate: a hand-placed `data-trail` first (it is the only one a refactor cannot
 * rename out from under this table), then the form identity a developer already maintains, then the
 * tag alone. A class list is never used — Tailwind classes change with every restyle and would make
 * last month's rows unmatchable.
 */
export function describeElement(element: {
  tag?: string | null;
  trailId?: string | null;
  name?: string | null;
  id?: string | null;
  type?: string | null;
  role?: string | null;
}): string {
  const tag = (element.tag ?? "").trim().toLowerCase() || "unknown";
  const parts: string[] = [tag];
  const type = (element.type ?? "").trim().toLowerCase();
  if (type) parts.push(`[type=${type}]`);
  const role = (element.role ?? "").trim().toLowerCase();
  if (role) parts.push(`[role=${role}]`);
  const trailId = (element.trailId ?? "").trim();
  if (trailId) parts.push(`@${trailId}`);
  else {
    const name = (element.name ?? "").trim();
    if (name) parts.push(`#name=${name}`);
    else {
      const id = (element.id ?? "").trim();
      if (id) parts.push(`#${id}`);
    }
  }
  return parts.join("");
}

/**
 * The words a human would have read on the control.
 *
 * 🔴 CUT, NEVER ELLIPSED. The no-ellipsis rule is about what a person reads, and nothing here is ever
 * rendered — but an added "…" would also be indistinguishable from one the rep typed himself, which is
 * the real reason not to add one. A label longer than the cap is rare and its tail carries nothing.
 */
export function labelOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > MAX_LABEL_CHARS ? flat.slice(0, MAX_LABEL_CHARS) : flat;
}

/**
 * The words on a CONTAINER the finger landed on — its FIRST LINE, never its whole subtree.
 *
 * 🔴 WHY A LINE AND NOT A SHORTER CAP. Cutting the joined text at 48 characters would keep the start
 * of the first line and then whatever of the second happened to fit, which reads as one sentence that
 * nobody ever saw. `innerText` already breaks a line per rendered block, so the first line IS the
 * heading a person would name the thing by — "Menoufia 1 · CNS" for a territory card, "Get Phoenix
 * CRM messages on Telegram" for the banner. That keeps WHICH card was pressed, which is the whole
 * value of a container label, and drops the paragraph behind it.
 *
 * Blank-line tolerant: a card whose markup opens with an empty block would otherwise label as null.
 * Cut, never ellipsed, for the reason `labelOf` gives.
 */
export function containerLabelOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  for (const line of text.split(/\r?\n/)) {
    const flat = line.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    return flat.length > MAX_CONTAINER_LABEL_CHARS ? flat.slice(0, MAX_CONTAINER_LABEL_CHARS) : flat;
  }
  return null;
}

function textOrNull(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function intOrNull(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/**
 * Read one posted batch.
 *
 * TOTAL BY DESIGN: anything unreadable becomes null or is dropped from the list, and the batch itself
 * only fails to exist when there is no `sessionId` and no event in it. A browser that posts rubbish
 * records less, never an error the rep could see.
 */
export function parseTouchTrailBatch(raw: unknown): TouchTrailBatch | null {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sessionId = textOrNull(body.sessionId, 64);
  if (!sessionId) return null;
  const list = Array.isArray(body.events) ? body.events : [];
  const events: TouchTrailEvent[] = [];
  for (const item of list.slice(0, MAX_EVENTS_PER_BATCH)) {
    const event = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const kind = textOrNull(event.kind, 32);
    if (!kind) continue;
    const value = typeof event.value === "string" ? event.value : null;
    events.push({
      deviceAt: isoOrNull(event.deviceAt),
      element: textOrNull(event.element, 300),
      elementLabel: textOrNull(event.elementLabel, MAX_LABEL_CHARS),
      kind,
      msSinceLoad: intOrNull(event.msSinceLoad),
      pointerX: intOrNull(event.pointerX),
      pointerY: intOrNull(event.pointerY),
      route: textOrNull(event.route, 300),
      screen: textOrNull(event.screen, 120),
      value: value === null ? null : value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value,
      valueLength: intOrNull(event.valueLength),
      viewportH: intOrNull(event.viewportH),
      viewportW: intOrNull(event.viewportW),
    });
  }
  if (events.length === 0) return null;
  return { events, seatId: textOrNull(body.seatId, 120), sessionId, test: body.test === true };
}
