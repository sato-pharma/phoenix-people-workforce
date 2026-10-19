// The shape of a reader's saved candidate-pool column layouts — which WhatsApp-question columns each
// view shows, in what order (pool-whatsapp-columns.ts) — and the one check every reader and writer of
// it runs. Pure, so the browser's cache, the API route and the database store cannot disagree.
//
// Owner, 2026-10-19 ("Columns follow you"): the layout lived in one browser's storage, so the columns
// he set up at his desk were not there on his phone. It is now saved to his account, one document per
// person, holding every view: `{ "all": [...], "medical_rep": [...] }`.

export type PoolColumnLayouts = Readonly<Record<string, readonly string[]>>;

/** "all" plus one per role family is well under this; the cap only stops a runaway document. */
export const POOL_LAYOUT_MAX_VIEWS = 40;
/** Five built-in columns plus every admin question a view can carry, with room to spare. */
export const POOL_LAYOUT_MAX_KEYS_PER_VIEW = 80;

const VIEW_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const COLUMN_KEY = /^(?:appliedFor|background|place|experience|salary|extra:[A-Za-z0-9_-]{1,80})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strict: true only for a document a save may store as it is. The route answers anything else with a
 * 400 rather than storing a cleaned copy the reader never sent.
 */
export function isPoolColumnLayouts(value: unknown): value is PoolColumnLayouts {
  if (!isPlainObject(value)) return false;
  const views = Object.entries(value);
  if (views.length > POOL_LAYOUT_MAX_VIEWS) return false;
  return views.every(
    ([view, keys]) =>
      VIEW_KEY.test(view) &&
      Array.isArray(keys) &&
      keys.length <= POOL_LAYOUT_MAX_KEYS_PER_VIEW &&
      keys.every((key) => typeof key === "string" && COLUMN_KEY.test(key)) &&
      new Set(keys).size === keys.length,
  );
}

/**
 * Lenient: whatever can be kept from a stored document, never a throw. A row written by an older
 * version, or the old browser-only copy, keeps its good views and loses only what no longer reads.
 */
export function parsePoolColumnLayouts(value: unknown): PoolColumnLayouts {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [view, keys] of Object.entries(value)) {
    if (Object.keys(out).length >= POOL_LAYOUT_MAX_VIEWS) break;
    if (!VIEW_KEY.test(view) || !Array.isArray(keys)) continue;
    const kept = [...new Set(keys.filter((key): key is string => typeof key === "string" && COLUMN_KEY.test(key)))];
    out[view] = kept.slice(0, POOL_LAYOUT_MAX_KEYS_PER_VIEW);
  }
  return out;
}

/**
 * What one read of a reader's saved layouts found. "unavailable" is a read that FAILED and is never
 * "nothing saved" (code review, 19 Oct 2026): a Supabase blip used to come back as "nothing saved",
 * and the pool then carried this browser's older copy up over the account's newer layout. Only
 * "none" may start that one-time carry.
 */
export type PoolColumnLayoutRead =
  | { kind: "saved"; layouts: PoolColumnLayouts }
  | { kind: "none" }
  | { kind: "unavailable" };

/**
 * The browser's reading of the account's answer. "none" only for an answer that says so in as many
 * words, `200 { success: true, data: null }`; a refused request, a body that did not parse or any
 * other shape is "unavailable", because the pool cannot tell it from a read that failed.
 */
export function readPoolColumnLayoutAnswer(ok: boolean, body: unknown): PoolColumnLayoutRead {
  if (!ok || !isPlainObject(body) || body.success !== true || !("data" in body)) return { kind: "unavailable" };
  return body.data === null ? { kind: "none" } : { kind: "saved", layouts: parsePoolColumnLayouts(body.data) };
}
