import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The cron/worker authorization rule must exist in exactly ONE place.
 *
 * WHY A SWEEP AND NOT A LIST. This replaces an 18-name hand-maintained array in
 * tests/contract-renewal-hardening.test.ts. That array was not wrong when written — it was
 * wrong by the time it was read. At the moment it was retired it named 18 of the 24 routes
 * that carried the rule, so six routes (the three ireports360-visits-*, cron/reconciliation-
 * check, cron/crm-contact-lists, and cron/marketing-field-capture-nudge, added the same
 * morning this migration ran) could each have regressed on a fully green suite.
 *
 * That last one is the point worth keeping. It was written by a different session, hours
 * before this test existed, by a careful author who copied the surrounding convention —
 * because copying was the only thing available. A list cannot catch that. A sweep can, and a
 * sweep cannot fall behind the codebase it sweeps.
 *
 * ZERO TOLERANCE, not a ratchet: unlike the timezone and hr-id baselines, there is no
 * legitimate remaining copy to grandfather. Every one of them is now an import.
 */

const ROUTE_ROOT = "app/api";
const GUARD_MODULE = "@/lib/security/cron-auth";

/** Measured 2026-08-29 at 683 route files and 26 importers. Floors sit well below both, so a
 *  legitimate route deletion does not turn this red — but a rename or a moved directory that
 *  silently empties the sweep does. Without these, every assertion below passes on zero files. */
const MIN_ROUTE_FILES = 300;
const MIN_GUARD_IMPORTERS = 20;

/**
 * The ONE route under app/api allowed to import constant-time directly.
 *
 * It is a Telegram webhook, not a cron route: the secret arrives in a Telegram-specific header
 * rather than an Authorization bearer, and an unset secret refuses every update in every
 * environment (S01, F-COM-014). Folding it into
 * assertCronAuthorized would mean widening that helper to cover a case it was not designed for,
 * which is how the original duplication started. Left alone on purpose, and pinned here so the
 * exception stays a decision rather than an oversight.
 */
const CONSTANT_TIME_EXCEPTIONS = new Set(["app/api/integrations/telegram/webhook/route.ts"]);

/** The rule itself. Any route restating it has grown a private copy of the policy. */
const INLINE_BYPASS = /if \(\s*!secret\s*\)\s*return process\.env\.NODE_ENV === "development";/;

/** The pre-#2479 spelling. Reads "only in dev", means "anywhere not labelled production". */
const BROADER_BYPASS = /if \(\s*!\w+\s*\)\s*return !isProductionRuntime\(\);/;

/** A hand-rolled constant-time comparison — what the two token routes did before A2. */
const HAND_ROLLED_COMPARE = /timingSafeEqual\(/;

/**
 * A local authorization helper reading the shared cron secret.
 *
 * Deliberately NO `s` flag. tsconfig targets ES2017 and dotAll is ES2018, so it is a hard
 * TS1501 build error — and it buys nothing here, because every "any character" role in this
 * pattern is a negated class (`[^)]`, `[^{]`, `[^}]`) and those match newlines on their own.
 * The local suite cannot catch this: --experimental-strip-types drops the types and Node's
 * own regex engine accepts the flag happily. Only the PR's typecheck job sees it. Do not add one.
 */
const LOCAL_CRON_HELPER = /function is(?:Cron)?Authorized\s*\([^)]*\)[^{]*\{[^}]*CRON_SECRET/;

function listRouteFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listRouteFiles(full, found);
    else if (entry.name === "route.ts") found.push(full.split(path.sep).join("/"));
  }
  return found;
}

export function runCronAuthSingleGuardTests() {
  // ---- Detector self-checks ------------------------------------------------------------
  // Every assertion below is a NEGATIVE over ~683 files, and a negative assertion passes
  // just as happily when the pattern is broken as when the codebase is clean. Prove each
  // detector still fires before trusting any of them.
  assert.match(
    'if (!secret) return process.env.NODE_ENV === "development";',
    INLINE_BYPASS,
    "INLINE_BYPASS stopped matching the exact line it exists to find",
  );
  assert.match(
    "if (!secret) return !isProductionRuntime();",
    BROADER_BYPASS,
    "BROADER_BYPASS stopped matching the pre-#2479 spelling",
  );
  assert.match("timingSafeEqual(a, b)", HAND_ROLLED_COMPARE, "HAND_ROLLED_COMPARE stopped matching");
  assert.match(
    'function isAuthorized(request: Request) {\n  const secret = process.env.CRON_SECRET;\n',
    LOCAL_CRON_HELPER,
    "LOCAL_CRON_HELPER stopped matching a route-local cron guard",
  );
  // ...and does NOT fire on the migrated shape, or it would report every fixed route as broken.
  assert.doesNotMatch(
    'const denied = assertCronAuthorized(request, "cron/x");\n  if (denied) return denied;',
    LOCAL_CRON_HELPER,
    "LOCAL_CRON_HELPER false-positives on the migrated call shape",
  );

  // ---- The sweep -----------------------------------------------------------------------
  const routeFiles = listRouteFiles(ROUTE_ROOT);
  assert.ok(
    routeFiles.length > MIN_ROUTE_FILES,
    `expected more than ${MIN_ROUTE_FILES} route files, found ${routeFiles.length} — the sweep is looking at the wrong place and every assertion below is vacuous`,
  );

  const offenders: Record<string, string[]> = {
    inlineBypass: [],
    broaderBypass: [],
    handRolledCompare: [],
    localCronHelper: [],
    constantTimeImport: [],
  };
  let guardImporters = 0;

  for (const file of routeFiles) {
    const source = readFileSync(file, "utf8");
    if (source.includes(GUARD_MODULE)) guardImporters += 1;
    if (INLINE_BYPASS.test(source)) offenders.inlineBypass.push(file);
    if (BROADER_BYPASS.test(source)) offenders.broaderBypass.push(file);
    if (HAND_ROLLED_COMPARE.test(source)) offenders.handRolledCompare.push(file);
    if (LOCAL_CRON_HELPER.test(source)) offenders.localCronHelper.push(file);
    if (source.includes("@/lib/security/constant-time") && !CONSTANT_TIME_EXCEPTIONS.has(file)) {
      offenders.constantTimeImport.push(file);
    }
  }

  assert.ok(
    guardImporters >= MIN_GUARD_IMPORTERS,
    `expected at least ${MIN_GUARD_IMPORTERS} routes importing ${GUARD_MODULE}, found ${guardImporters} — either the migration was reverted or this test is reading the wrong tree`,
  );

  assert.deepEqual(
    offenders.inlineBypass,
    [],
    `these routes state the unset-secret rule themselves instead of importing it from ${GUARD_MODULE}. That rule lives in exactly one file; a private copy is how the same defect survived three separate hardening passes (#1529, #1949, #2479).`,
  );
  assert.deepEqual(
    offenders.broaderBypass,
    [],
    "these routes use the pre-#2479 !isProductionRuntime() bypass, which opens on ANY environment not labelled production — including staging, a 1:1 clone of production data",
  );
  assert.deepEqual(
    offenders.handRolledCompare,
    [],
    "these routes hand-roll a constant-time comparison; use requiredTokenAuthorized or bearerSecretMatches so the comparison has one implementation",
  );
  assert.deepEqual(
    offenders.localCronHelper,
    [],
    "these routes define a local authorization helper reading CRON_SECRET; call assertCronAuthorized instead",
  );
  assert.deepEqual(
    offenders.constantTimeImport,
    [],
    `these routes import constant-time directly. That is the raw comparison with no policy attached, and reaching for it is how a route ends up restating the unset-secret rule. Import ${GUARD_MODULE}, or add the file to CONSTANT_TIME_EXCEPTIONS with a written reason.`,
  );

  // ---- The observability half ------------------------------------------------------------
  // The rejection and the log are now inseparable inside assertCronAuthorized, which is the
  // whole reason the migration was worth doing: eight routes rejected unauthorized callers and
  // logged NOTHING, and `railway logs | grep cron_unauthorized` is the only detection there is
  // in production. Pin that they cannot come apart again.
  const guardSource = readFileSync("src/lib/security/cron-auth.ts", "utf8");
  assert.match(
    guardSource,
    /logCronUnauthorized\(job, request\);\s*\n\s*return NextResponse\.json\(/,
    "assertCronAuthorized must log immediately before returning its 401 — a rejection that logs nothing is invisible in production",
  );
}
