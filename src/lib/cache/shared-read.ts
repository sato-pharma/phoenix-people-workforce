/**
 * An in-process, namespaced cache for a heavy READ that a dashboard may serve up to a minute old.
 *
 * WHY (2026-10-16 slowness audit). The SFE Command Center reads a whole company's 30 days of CRM
 * visits and check-ins on every render — a probe plus thirty one-day requests each, about 62 round
 * trips — and every other viewer, and the same viewer a minute later, pays them all again. The owner
 * chose the freshness himself that day: a dashboard may reuse a copy up to one minute old, and a write
 * the app makes (a Phoenix CRM visit captured) refreshes it at once.
 *
 * The same shape as the weekly sales row cache (src/lib/sales/weekly/row-cache.ts), generalised:
 *   • a key per read — the caller passes EVERYTHING that changes the rows (filter, columns, window);
 *   • a per-namespace generation, bumped by the app's write paths, so a write is visible at once;
 *   • a 60 s lifetime as the backstop for writes this process never sees (the vendor sync, which
 *     runs on the worker service; direct SQL);
 *   • concurrent misses on one key share a single load;
 *   • every read hands back fresh shallow COPIES, because the door's callers mark and collapse rows
 *     in place;
 *   • bounded by an entry count and a row budget per namespace; a load larger than the budget is
 *     served but not stored, and a load that a write overtook is served but never kept.
 *
 * One web process per service, so an in-process cache is coherent there. Opt-in by design: a read that
 * decides money, a deduction, an approval or a notification never comes through here.
 *
 * A longer lifetime (`ttlMs`) is the owner's to give, read by read. He has given one: the portal's double-visit
 * panel may count weeks more than 7 days old from a copy up to an hour old (2026-11-03,
 * readListedDaysSharingSettledWeeks in src/lib/double-visit-analytics/service.ts).
 */

export const SHARED_READ_TTL_MS = 60_000;

export type SharedReadLimits = {
  maxEntries: number;
  maxRowsTotal: number;
  /** How long a copy lives; SHARED_READ_TTL_MS when unset. */
  ttlMs?: number;
};

type Entry = { rows: object[]; storedAt: number };

type Namespace = {
  entries: Map<string, Entry>;
  inFlight: Map<string, Promise<object[] | null>>;
  generation: number;
};

const namespaces = new Map<string, Namespace>();

function namespaceFor(name: string): Namespace {
  let namespace = namespaces.get(name);
  if (!namespace) {
    namespace = { entries: new Map(), inFlight: new Map(), generation: 0 };
    namespaces.set(name, namespace);
  }
  return namespace;
}

/** Called by an app path that writes what a namespace caches: every entry is dropped at once. */
export function bumpSharedReadGeneration(name: string, _reason: string): void {
  const namespace = namespaceFor(name);
  namespace.generation += 1;
  namespace.entries.clear();
}

/** A deterministic key for a plain options object: keys sorted at every depth, undefined dropped. */
export function sharedReadKey(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

export type SharedReadResult<Row> = { rows: Row[] | null; cache: "hit" | "miss" };

/**
 * Serve `key` from memory when fresh, else run `load` once — concurrent callers with the same key share
 * it. `null` from `load` (the source is missing) is passed through and never stored.
 */
export async function getOrLoadShared<Row extends object>(
  name: string,
  key: string,
  load: () => Promise<Row[] | null>,
  limits: SharedReadLimits,
  now: () => number = Date.now,
): Promise<SharedReadResult<Row>> {
  const namespace = namespaceFor(name);
  const fullKey = `${namespace.generation}::${key}`;
  const cached = namespace.entries.get(fullKey);
  if (cached && now() - cached.storedAt < (limits.ttlMs ?? SHARED_READ_TTL_MS)) {
    // Re-insert so the Map's order stays least-recently-used first.
    namespace.entries.delete(fullKey);
    namespace.entries.set(fullKey, cached);
    return { rows: copyRows(cached.rows as Row[]), cache: "hit" };
  }
  if (cached) namespace.entries.delete(fullKey);

  let pending = namespace.inFlight.get(fullKey) as Promise<Row[] | null> | undefined;
  if (!pending) {
    const startedGeneration = namespace.generation;
    pending = load().then((rows) => {
      // A write that landed while this load ran may not be in these rows — serve them, never keep them.
      if (rows && startedGeneration === namespace.generation && rows.length <= limits.maxRowsTotal) {
        namespace.entries.set(fullKey, { rows: copyRows(rows), storedAt: now() });
        while (namespace.entries.size > limits.maxEntries || cachedRowCount(namespace) > limits.maxRowsTotal) {
          const oldest = namespace.entries.keys().next().value;
          if (oldest === undefined) break;
          namespace.entries.delete(oldest);
        }
      }
      return rows;
    });
    namespace.inFlight.set(fullKey, pending as Promise<object[] | null>);
    pending.then(
      () => namespace.inFlight.delete(fullKey),
      () => namespace.inFlight.delete(fullKey),
    );
  }
  const rows = await pending;
  return { rows: rows ? copyRows(rows) : null, cache: "miss" };
}

function cachedRowCount(namespace: Namespace): number {
  let total = 0;
  for (const entry of namespace.entries.values()) total += entry.rows.length;
  return total;
}

function copyRows<Row extends object>(rows: readonly Row[]): Row[] {
  return rows.map((row) => ({ ...row }));
}

/** Test-only: empty every namespace. */
export function _resetSharedReadCache(): void {
  namespaces.clear();
}
