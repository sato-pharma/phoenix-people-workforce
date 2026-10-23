import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * WHO CALLS EACH API ROUTE — the measurement behind the API reverse guard.
 *
 * `app/api/**\/route.ts` is 1,000+ handlers. Every one of them is declared in
 * src/lib/security/access-registry.ts, which CI already forces to stay complete — so the registry
 * answers *is this route accounted for?* and can never answer *does anything call it?*. A handler
 * whose caller was deleted keeps its registry row, keeps its permission, keeps passing every check,
 * and serves 404-free to nobody for ever. This module is the other question.
 *
 * It is deliberately a string measurement, not a type-graph one. A route is reached by a URL built
 * at runtime, and there is no symbol linking `fetch("/api/contracts")` to
 * `app/api/contracts/route.ts` — the compiler sees a string on one side and a file on the other.
 * So the only honest reading is: does any source file in this repository contain a path literal
 * that resolves to this route?
 *
 * ## The five things that make a naive version of this lie
 *
 * Each was measured, and each one on its own turned a working route into a false accusation. They
 * are written down because the next person to extend this will otherwise rediscover them one wrong
 * red build at a time.
 *
 * 1. **The access registry names every route by contract.** Counting it as a caller makes the whole
 *    census vacuous — the first run answered "0 orphans" for exactly this reason. Four files declare
 *    routes rather than call them and are excluded by name (DECLARATION_ONLY).
 * 2. **An interpolation can sit GLUED to literal text.** `fetch(`/api/production-planning${path}`)`
 *    is not a free wildcard: the literal head still constrains which routes it can reach. Treating
 *    the segment as a wildcard made that single line vouch for 148 unrelated routes.
 * 3. **A TRAILING interpolation carries its own slashes.** That same call passes `path = "/fx"`, so
 *    a reference ending in an interpolation reaches DEEPER routes too. Treating it as
 *    segment-bounded falsely orphaned all 8 production-planning routes.
 * 4. **A base lives in a constant.** `const BASE = "/api/x"` then `` `${BASE}/send` `` is a literal
 *    call site, and a reader that does not resolve file-local constants cannot see it.
 * 5. **Callers live outside `app/` and `src/`.** Measured 2026-10-08: 25 files under `scripts/`,
 *    27 under `mobile/`, and 2 each under `local-attendance-agent/` and `google-apps-script/` hold
 *    `/api/` path literals. Scoping the sweep to the web app's own two directories accused every
 *    route whose only caller is an ops script or a non-web client. The scope is therefore the whole
 *    repository minus SKIP_DIRECTORIES.
 *
 * `tests/` is skipped on purpose and it is the one judgement call here: a route whose only caller is
 * its own test is dead product surface wearing a green check. Counting the test as a caller would
 * hide exactly the thing being looked for.
 */

/** A route's declared caller, as src/lib/security/access-registry.ts states it. */
export type ApiAuthMode =
  | "session"
  | "public-token"
  | "webhook-secret"
  | "cron-secret"
  | "machine-token"
  | "dev-only"
  | "unknown";

/**
 * How strongly the repository reaches a route.
 *
 * `called` and `built-url` are kept apart rather than merged into one "reached" verdict, because
 * "this exact line calls this route" and "something probably calls this route" are different facts
 * and only the first is evidence.
 */
export type ApiCallerVerdict = "called" | "built-url" | "no-caller";

export type ApiRouteCallerRow = {
  /** The URL the handler serves, with dynamic segments left as `[param]`. */
  readonly route: string;
  /** Repo-relative path of the `route.ts`. */
  readonly file: string;
  readonly authMode: ApiAuthMode;
  readonly verdict: ApiCallerVerdict;
  /** Up to two path literals that reached it, for the failure message. */
  readonly via: readonly string[];
  /** Up to two files those literals live in. */
  readonly from: readonly string[];
};

export type ApiCallerCensus = {
  readonly rows: readonly ApiRouteCallerRow[];
  /** Every path literal the sweep resolved, across the whole repository. */
  readonly referenceCount: number;
  /** Source files read. A collapse here is what the guard's floors catch. */
  readonly sourceFileCount: number;
  /** Routes declared in the access registry — the authMode lookup's own size. */
  readonly registryPatternCount: number;
};

/**
 * Files that NAME routes rather than call them. Without this the census is vacuous: the access
 * registry alone vouches for all 1,061 routes, and the first measurement duly reported zero.
 */
export const DECLARATION_ONLY: readonly string[] = [
  "src/lib/security/access-registry.ts",
  "src/lib/cron-control/job-registry.ts",
  "src/lib/error-monitor/redact-route.ts",
  "src/lib/navigation/shell-headers.ts",
];

/**
 * `tests` is a judgement call, documented in the header. The other three hold no authored source.
 */
export const SKIP_DIRECTORIES: readonly string[] = ["node_modules", ".next", ".git", "tests"];

const SOURCE_EXTENSIONS = /\.(tsx|ts|jsx|js|mjs|cjs)$/;

/**
 * Stands in for an interpolation. Plain text, not a regex metacharacter and not a character class,
 * so no path literal in the repository can impersonate or escape it.
 */
const WILDCARD = "<<W>>";

function walkSource(directory: string, collected: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.includes(entry.name)) continue;
      walkSource(full, collected);
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      collected.push(full);
    }
  }
  return collected;
}

const toPosix = (value: string) => value.split(path.sep).join("/");

type PathReference = {
  readonly pattern: string;
  readonly file: string;
  readonly segments: readonly string[];
};

/** Every `/api/...` path literal in one file, with its file-local constants resolved. */
function readReferences(absoluteFile: string, repoRelative: string): PathReference[] {
  const source = readFileSync(absoluteFile, "utf8");
  const found: PathReference[] = [];

  // `const BASE = "/api/x"` and `{ base: "/api/x" }` — lesson 4 in the header.
  const constants = new Map<string, string>();
  for (const match of source.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["'`](\/api\/[^"'`${}]*)["'`]/g,
  )) {
    constants.set(match[1]!, match[2]!.replace(/\/+$/, ""));
  }
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*["'`](\/api\/[^"'`${}]*)["'`]/g)) {
    if (!constants.has(match[1]!)) constants.set(match[1]!, match[2]!.replace(/\/+$/, ""));
  }

  // Any string or template literal that is, or starts with, an api path — including one whose base
  // is interpolated (`${BASE}/send`), which is why the alternation allows a leading `${`.
  for (const match of source.matchAll(/["'`]((?:\/api\/|\$\{)[^"'`]*)["'`]/g)) {
    let raw = match[1]!.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_whole, identifier: string) =>
      constants.has(identifier) ? constants.get(identifier)! : WILDCARD,
    );
    raw = raw.replace(/\$\{[^}]*\}/g, WILDCARD);
    // A NESTED template literal leaves an unbalanced `${` behind, because the outer regex stopped at
    // the inner backtick: `` `/api/admin/monitoring/events-csv${q ? `?${q}` : ""}` `` captures only
    // as far as that inner tick, so neither replacement pass above can close it. Everything past an
    // interpolation nobody can parse is unknown, so truncate there and let it span segments. Without
    // this the CSV export link read as an orphan while the button worked perfectly (that link was the
    // retired Monitoring page's, gone since 23 Oct 2026; the shape it taught is still common).
    const unparseable = raw.indexOf("${");
    if (unparseable >= 0) raw = `${raw.slice(0, unparseable)}${WILDCARD}`;
    // An ABSOLUTE url whose origin is interpolated — `` `${baseUrl}/api/notifications/test` `` in
    // scripts/phase21-security-readiness-smoke.ts — does not start with `/api/`, so the check below
    // dropped it and the route read as uncalled. The interpolated origin is a host; the path after it
    // is still a literal naming one route. Only trust this when the discarded prefix is itself an
    // interpolation, so a genuine path like `/foo/api/bar` is never rewritten into `/api/bar`.
    if (!raw.startsWith("/api/")) {
      const pathStart = raw.indexOf("/api/");
      if (pathStart > 0 && raw.slice(0, pathStart).includes(WILDCARD)) raw = raw.slice(pathStart);
    }
    if (!raw.startsWith("/api/") && raw !== "/api") continue;
    const clean = raw.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "");
    found.push({
      pattern: clean,
      file: repoRelative,
      segments: clean.split("/").filter(Boolean),
    });
  }
  return found;
}

const isDynamicSegment = (segment: string) => /^\[.*\]$/.test(segment);
const isCatchAllSegment = (segment: string) => /^\[\[?\.\.\./.test(segment);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lesson 2: a reference segment is a glob WITHIN its segment, never a free wildcard, because the
 * literal text glued to the interpolation still constrains what it can reach.
 */
function segmentMatches(routeSegment: string, referenceSegment: string): boolean {
  if (isDynamicSegment(routeSegment)) return true;
  if (!referenceSegment.includes(WILDCARD)) return routeSegment === referenceSegment;
  const pattern = referenceSegment.split(WILDCARD).map(escapeRegExp).join(".*");
  return new RegExp(`^${pattern}$`).test(routeSegment);
}

/** Lesson 3: a reference whose last segment ends in an interpolation can span deeper segments. */
const spansSegments = (reference: PathReference) =>
  reference.segments.length > 0 && reference.segments[reference.segments.length - 1]!.endsWith(WILDCARD);

/** STRICT — segment for segment, same length. The strong signal: a line that names this route. */
function resolvesTo(reference: PathReference, routeSegments: readonly string[]): boolean {
  if (spansSegments(reference)) return false;
  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index]!;
    if (isCatchAllSegment(routeSegment)) {
      return routeSegment.startsWith("[[") || reference.segments.length > index;
    }
    if (index >= reference.segments.length) return false;
    if (!segmentMatches(routeSegment, reference.segments[index]!)) return false;
  }
  return reference.segments.length === routeSegments.length;
}

/** WEAKER — the tail is built at runtime, so it reaches a FAMILY and cannot name one member. */
function reachedByBuiltUrl(reference: PathReference, routeSegments: readonly string[]): boolean {
  if (!spansSegments(reference)) return false;
  const head = reference.segments.slice(0, -1);
  if (head.length + 1 > routeSegments.length) return false;
  for (let index = 0; index < head.length; index += 1) {
    if (!segmentMatches(routeSegments[index]!, head[index]!)) return false;
  }
  const lastHead = reference.segments[reference.segments.length - 1]!.slice(0, -WILDCARD.length);
  const against = routeSegments[head.length]!;
  return lastHead === "" || isDynamicSegment(against) || against.startsWith(lastHead);
}

/**
 * A prefix vouches for a route only as a plausible BASE: at least three segments, so `/api` and
 * `/api/x` never vouch for anything.
 */
function isBaseOf(reference: PathReference, routeSegments: readonly string[]): boolean {
  if (reference.segments.length < 3) return false;
  if (reference.segments.length >= routeSegments.length) return false;
  for (let index = 0; index < reference.segments.length; index += 1) {
    if (!segmentMatches(routeSegments[index]!, reference.segments[index]!)) return false;
  }
  return true;
}

/**
 * The access registry's declared auth mode, read from source rather than imported.
 *
 * Reading the source keeps the census independent of the registry's runtime shape, and the helper
 * names (`cronApi(`, `webhookApi(`, …) are what actually distinguish the modes on most rows.
 */
function readAuthModes(repoRoot: string): Map<string, ApiAuthMode> {
  const source = readFileSync(
    path.join(repoRoot, "src", "lib", "security", "access-registry.ts"),
    "utf8",
  );
  const modes = new Map<string, ApiAuthMode>();
  for (const match of source.matchAll(/pattern:\s*"([^"]+)"/g)) {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    let lineEnd = source.indexOf("\n", match.index);
    if (lineEnd === -1) lineEnd = source.length;
    const line = source.slice(lineStart, lineEnd);
    const declared = line.match(/authMode:\s*"([^"]+)"/);
    let mode: ApiAuthMode = "session";
    if (declared) mode = declared[1] as ApiAuthMode;
    else if (/cronApi\(/.test(line)) mode = "cron-secret";
    else if (/webhookApi\(/.test(line)) mode = "webhook-secret";
    else if (/publicApi\(/.test(line)) mode = "public-token";
    else if (/machineApi\(/.test(line)) mode = "machine-token";
    else if (/devOnlyApi\(/.test(line)) mode = "dev-only";
    const pattern = match[1]!;
    // sessionApi() is the default, so a later non-session row for the same pattern wins.
    if (!modes.has(pattern) || modes.get(pattern) === "session") modes.set(pattern, mode);
  }
  return modes;
}

/**
 * Resolve a route to its declared mode SEGMENT-WISE.
 *
 * The registry writes a dynamic segment as `:token`; a route path carries `[token]`. A plain
 * `startsWith` therefore misses every pattern whose wildcard is in the MIDDLE, which left the five
 * share/unsubscribe-token routes reading `unknown` and so unclassifiable. Most literals wins.
 */
export function declaredAuthMode(route: string, modes: Map<string, ApiAuthMode>): ApiAuthMode {
  const exact = modes.get(route);
  if (exact) return exact;
  const routeSegments = route.split("/").filter(Boolean);
  let best: { mode: ApiAuthMode; literals: number } | null = null;
  for (const [pattern, mode] of modes) {
    const patternSegments = pattern.split("/").filter(Boolean);
    const trailingWildcard = patternSegments[patternSegments.length - 1] === "**";
    let matched = true;
    let literals = 0;
    for (let index = 0; index < patternSegments.length; index += 1) {
      const segment = patternSegments[index]!;
      if (segment === "**") {
        matched = index <= routeSegments.length;
        break;
      }
      if (index >= routeSegments.length) {
        matched = false;
        break;
      }
      if (segment === "*" || segment.startsWith(":")) continue;
      if (segment === routeSegments[index] || isDynamicSegment(routeSegments[index]!)) {
        literals += 1;
        continue;
      }
      matched = false;
      break;
    }
    if (!matched) continue;
    if (!trailingWildcard && patternSegments.length !== routeSegments.length) continue;
    if (!best || literals > best.literals) best = { mode, literals };
  }
  return best ? best.mode : "unknown";
}

/** Read every `app/api/**\/route.ts` and say what reaches it. */
export function measureApiCallers(repoRoot: string = process.cwd()): ApiCallerCensus {
  const apiDirectory = path.join(repoRoot, "app", "api");
  const routeFiles = walkSource(apiDirectory).filter((file) =>
    /(?:^|[\\/])route\.ts$/.test(file),
  );
  const routes = routeFiles.map((file) => ({
    route: `/api/${toPosix(path.relative(apiDirectory, file)).split("/").slice(0, -1).join("/")}`.replace(
      /\/$/,
      "",
    ),
    file: toPosix(path.relative(repoRoot, file)),
  }));

  const sourceFiles: string[] = [];
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.includes(entry.name)) continue;
      sourceFiles.push(...walkSource(path.join(repoRoot, entry.name)));
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      sourceFiles.push(path.join(repoRoot, entry.name));
    }
  }

  const references: PathReference[] = [];
  for (const absoluteFile of sourceFiles) {
    const repoRelative = toPosix(path.relative(repoRoot, absoluteFile));
    if (DECLARATION_ONLY.includes(repoRelative)) continue;
    references.push(...readReferences(absoluteFile, repoRelative));
  }

  const modes = readAuthModes(repoRoot);
  const rows: ApiRouteCallerRow[] = [];
  for (const route of routes) {
    const segments = route.route.split("/").filter(Boolean);
    const authMode = declaredAuthMode(route.route, modes);
    // A handler's own file naming its own path is not a caller.
    const outside = references.filter((reference) => reference.file !== route.file);

    const exact = outside.filter((reference) => resolvesTo(reference, segments));
    if (exact.length > 0) {
      rows.push({ ...route, authMode, verdict: "called", via: pick(exact, "pattern"), from: pick(exact, "file") });
      continue;
    }
    const loose = outside.filter(
      (reference) => isBaseOf(reference, segments) || reachedByBuiltUrl(reference, segments),
    );
    if (loose.length > 0) {
      rows.push({
        ...route,
        authMode,
        verdict: "built-url",
        via: pick(loose, "pattern"),
        from: pick(loose, "file"),
      });
      continue;
    }
    rows.push({ ...route, authMode, verdict: "no-caller", via: [], from: [] });
  }

  return {
    rows,
    referenceCount: references.length,
    sourceFileCount: sourceFiles.length,
    registryPatternCount: modes.size,
  };
}

function pick(references: readonly PathReference[], key: "pattern" | "file"): string[] {
  return [...new Set(references.map((reference) => reference[key]))].slice(0, 2);
}
