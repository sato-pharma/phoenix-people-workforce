/**
 * Phoenix CRM — whether the browser's own location reader is still the browser's.
 *
 * Owner, 2026-10-16: "add a silent check for a replaced location reader in Phoenix CRM". A browser
 * add-on that changes where a page thinks the phone is does it one way: it puts its own function in
 * place of `navigator.geolocation.getCurrentPosition` / `watchPosition` (or of `navigator.geolocation`
 * itself) and hands the page a position it made up. Android's mock flag never reaches the web, so
 * until this file a browser capture answered that question with nothing at all.
 *
 * WHAT IS ASKED, and why each is safe to ask:
 *
 *   * `geolocation` as an OWN property of `navigator`. Every engine defines it once, as an accessor
 *     on `Navigator.prototype`; one sitting on the object itself was put there by a script.
 *   * the methods as OWN properties of the `Geolocation` object. Same reason: the engine's live on
 *     the prototype.
 *   * the methods' own source. An engine's function prints `[native code]`; a script's prints its
 *     body. A Proxy or a bound function also prints `[native code]`, so this can miss a careful
 *     replacement — it never accuses a native one.
 *   * the object types. A real position is a `GeolocationPosition` and its coordinates a
 *     `GeolocationCoordinates`; a made-up one is a plain object. Asked only where the engine defines
 *     those names (an older Safari spells them differently, and is then simply not asked).
 *
 * 🔴 `Function.prototype.toString` BEING REPLACED IS DELIBERATELY NOT A FINDING. Content blockers
 * replace it on every page to hide their own scriptlets, so it says nothing about location and would
 * name every rep with an ad blocker. It only makes the source question unanswerable, which is why
 * that question is one of four and not the whole check.
 *
 * GOLDEN RULE #1: nothing here is ever put into words for the rep, refuses anything, or changes what
 * he sees. It answers a question; `server/location-integrity.ts` files the answer for the Super Admin.
 * Pure and total: no throw escapes it, whatever the page has done to the objects it reads.
 */

/** What one capture says about its own location reader. */
export type LocationReaderAnswer = {
  /** True when anything below was found; false when it was asked and nothing was; null when not asked. */
  readerReplaced: boolean | null;
  /** Which questions answered "replaced", by code — the board puts them into words. */
  readerFindings: string[];
};

/** The codes a capture may carry. The server keeps only these, so a body cannot write prose here. */
export const LOCATION_READER_FINDINGS = [
  "navigator_own_property",
  "reader_not_engine_object",
  "method_own_property",
  "method_not_engine_code",
  "position_not_engine_object",
] as const;

export type LocationReaderFinding = (typeof LOCATION_READER_FINDINGS)[number];

/** The parts of the page the probe reads, passed in so it can be judged without a browser. */
export type LocationReaderScope = {
  navigator?: unknown;
  Geolocation?: unknown;
  GeolocationPosition?: unknown;
  GeolocationCoordinates?: unknown;
};

const METHODS = ["getCurrentPosition", "watchPosition"] as const;

function hasOwn(target: unknown, key: string): boolean {
  try {
    return target !== null && (typeof target === "object" || typeof target === "function") && Object.prototype.hasOwnProperty.call(target, key);
  } catch {
    return false;
  }
}

function read(target: unknown, key: string): unknown {
  try {
    return target !== null && (typeof target === "object" || typeof target === "function")
      ? (target as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

/** True / false when the source could be read; null when it could not be asked at all. */
function isEngineCode(fn: unknown): boolean | null {
  if (typeof fn !== "function") return false;
  try {
    return /\[native code\]/.test(Function.prototype.toString.call(fn));
  } catch {
    return null;
  }
}

/** `instanceof`, answered only where the engine defines the type; null when it cannot be asked. */
function isInstance(value: unknown, type: unknown): boolean | null {
  if (typeof type !== "function") return null;
  try {
    return value instanceof (type as new (...args: never[]) => unknown);
  } catch {
    return null;
  }
}

/**
 * Ask the page whether its location reader is the engine's own.
 *
 * `positions` are the readings this page has already been handed, when there are any — the object
 * types can only be asked of a real reading. With none, the other three questions still answer.
 */
export function probeLocationReader(scope: LocationReaderScope, positions: readonly unknown[] = []): LocationReaderAnswer {
  const findings = new Set<LocationReaderFinding>();
  try {
    const nav = scope.navigator;
    const reader = read(nav, "geolocation");
    if (reader === undefined || reader === null) return { readerReplaced: null, readerFindings: [] };

    if (hasOwn(nav, "geolocation")) findings.add("navigator_own_property");
    if (isInstance(reader, scope.Geolocation) === false) findings.add("reader_not_engine_object");

    for (const method of METHODS) {
      if (hasOwn(reader, method)) findings.add("method_own_property");
      // The function the PAGE would call — whatever sits there now, own or inherited.
      if (isEngineCode(read(reader, method)) === false) findings.add("method_not_engine_code");
      // And the engine's own prototype, which a replacement may have been written onto instead.
      const prototype = read(scope.Geolocation, "prototype");
      if (prototype !== undefined && isEngineCode(read(prototype, method)) === false) findings.add("method_not_engine_code");
    }

    for (const position of positions) {
      if (position === null || position === undefined) continue;
      if (isInstance(position, scope.GeolocationPosition) === false) findings.add("position_not_engine_object");
      const coords = read(position, "coords");
      if (coords !== undefined && isInstance(coords, scope.GeolocationCoordinates) === false) findings.add("position_not_engine_object");
    }
  } catch {
    // Total by design: a page that throws on being read answers what it had answered so far.
  }
  const readerFindings = LOCATION_READER_FINDINGS.filter((code) => findings.has(code));
  return { readerReplaced: readerFindings.length > 0, readerFindings };
}

/**
 * The answer as the server reads it from a capture's body (`parseCapturedFix`, entry-rules.ts).
 *
 * Strictly a boolean or nothing, and only known codes: a body that omits it — an older bundle, a
 * phone that could not be asked — is NOT ASKED, never "clean", and is never refused for the omission.
 */
export function readLocationReaderAnswer(raw: Record<string, unknown>): LocationReaderAnswer {
  const readerReplaced = typeof raw.readerReplaced === "boolean" ? raw.readerReplaced : null;
  const sent: unknown[] = Array.isArray(raw.readerFindings) ? raw.readerFindings : [];
  const readerFindings = LOCATION_READER_FINDINGS.filter((code) => sent.includes(code));
  return { readerReplaced, readerFindings };
}
