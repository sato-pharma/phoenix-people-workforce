// A password-setup link sets an employee's password for 48 hours; a share link is stored
// unhashed, so the URL IS the credential. Both were being written into `app_error_events.route`
// in plaintext the moment the page threw — which is while the token still works, not after it
// has been used. Production held 55 such rows before this landed.
//
// The guard that matters here is the FIRST one: the set of credential-bearing routes is read
// back off disk rather than restated. A `[token]` segment is how Next.js spells "this part of
// the path is a secret", so a route family added next month either appears in
// CREDENTIAL_ROUTE_PREFIXES or turns this test red. A hand-maintained list would simply fall
// behind, silently, and the first sign would be another token in the table.
//
// The second guard is the wiring. A pure function that redacts perfectly proves nothing if the
// insert stops calling it, so the source of logAppError is pinned on both sides: the redacted
// form must be present AND the raw form must be absent.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  CREDENTIAL_ROUTE_PREFIXES,
  redactSecretsFromRoute,
  TOKEN_PLACEHOLDER,
} from "../src/lib/error-monitor/redact-route.ts";

const APP_DIR = "app";
const SERVICE_FILE = path.join("src", "lib", "error-monitor", "service.ts");

/** Every directory under `app/` literally named `[token]`, as repo-relative paths. */
function findTokenSegmentDirs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
    if (entry === "[token]") out.push(full);
    findTokenSegmentDirs(full, out);
  }
  return out;
}

/**
 * `app/api/share/territory/[token]` → `/api/share/territory`.
 *
 * Route groups (`(admin)`) and parallel slots (`@modal`) are folder-only conventions that never
 * appear in a URL, so they are dropped — otherwise a route moved into a group would read as a
 * different family and the set comparison below would fail for a reason that is not a defect.
 */
function routePrefixForTokenDir(tokenDir: string): string {
  const segments = tokenDir
    .split(path.sep)
    .join("/")
    .split("/")
    .slice(0, -1) // drop the `[token]` segment itself — we want its PARENT
    .filter((segment, index) => !(index === 0 && segment === APP_DIR))
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));
  return `/${segments.join("/")}`;
}

export function runErrorMonitorRedactRouteTests() {
  // ── 1. The list is the filesystem's, not a guess ────────────────────────────
  const onDisk = [...new Set(findTokenSegmentDirs(APP_DIR).map(routePrefixForTokenDir))].sort();
  const declared = [...CREDENTIAL_ROUTE_PREFIXES].sort();

  assert.ok(onDisk.length > 0, "found no [token] route segments under app/ — the walk is broken, not the app");

  const unguarded = onDisk.filter((prefix) => !declared.includes(prefix));
  assert.deepEqual(
    unguarded,
    [],
    `these routes carry a [token] segment but are not redacted — add them to CREDENTIAL_ROUTE_PREFIXES in src/lib/error-monitor/redact-route.ts:\n  ${unguarded.join("\n  ")}`,
  );

  const stale = declared.filter((prefix) => !onDisk.includes(prefix));
  assert.deepEqual(
    stale,
    [],
    `these prefixes no longer exist under app/ — drop them from CREDENTIAL_ROUTE_PREFIXES:\n  ${stale.join("\n  ")}`,
  );

  // ── 2. Every declared family actually redacts ───────────────────────────────
  for (const prefix of CREDENTIAL_ROUTE_PREFIXES) {
    // DELIBERATELY low-entropy. A realistic-looking token here failed the required secret-scan
    // check (gitleaks generic-api-key, 2026-09-05) — the very check this file exists to help. The
    // redactor replaces whatever sits in the segment, so entropy buys no coverage. Do not "improve"
    // these fixtures into something that looks real. The mixed case, digits, `-` and `_` are the
    // part that matters: they exercise the character class that decides where the segment ends.
    const secret = "example-token_ABC123-not-a-credential";
    assert.equal(
      redactSecretsFromRoute(`${prefix}/${secret}`),
      `${prefix}/${TOKEN_PLACEHOLDER}`,
      `${prefix} leaked its token`,
    );
    // A trailing segment or query string must not let the token through.
    assert.equal(
      redactSecretsFromRoute(`${prefix}/${secret}/preview?line=Pedia`),
      `${prefix}/${TOKEN_PLACEHOLDER}/preview?line=Pedia`,
      `${prefix} leaked its token when a segment followed it`,
    );
    assert.ok(
      !redactSecretsFromRoute(`${prefix}/${secret}`)?.includes(secret),
      `${prefix} still contains the raw token`,
    );
  }

  // ── 3. Real shapes, including the ones production actually logged ───────────
  assert.equal(
    redactSecretsFromRoute("/password-setup/example-token_0001-not-a-credential"),
    "/password-setup/[token]",
  );
  assert.equal(
    redactSecretsFromRoute("/share/territory/example-token_0002-not-a-credential"),
    "/share/territory/[token]",
  );
  // The interview calendar's copy link: in the page path, and as `?link=` on the CV addresses.
  assert.equal(
    redactSecretsFromRoute("/share/interview-calendar/example-token_0003-not-a-credential?week=2026-09-20"),
    "/share/interview-calendar/[token]?week=2026-09-20",
  );
  assert.equal(
    redactSecretsFromRoute("/api/recruitment/interview-calendar/bookings/b1/cv?link=example-token_0004"),
    "/api/recruitment/interview-calendar/bookings/b1/cv?link=[token]",
  );
  // Case-insensitive: the browser may send a differently-cased path.
  assert.equal(redactSecretsFromRoute("/Password-Setup/ABC123"), "/Password-Setup/[token]");

  // ── 4. Secrets in the QUERY STRING, anchored so ordinary params survive ─────
  assert.equal(redactSecretsFromRoute("/api/x?token=abc123"), "/api/x?token=[token]");
  assert.equal(redactSecretsFromRoute("/api/x?a=1&secret=zz&b=2"), "/api/x?a=1&secret=[token]&b=2");
  // `sortKey` ENDS in "key" but is not a credential — the `[?&]` anchor is what saves it.
  assert.equal(redactSecretsFromRoute("/api/x?sortKey=name"), "/api/x?sortKey=name");
  assert.equal(redactSecretsFromRoute("/api/x?area_code=GZ3"), "/api/x?area_code=GZ3");

  // ── 5. No over-redaction: the error monitor has to stay readable ────────────
  for (const ordinary of [
    "/admin/sales/monthly-closing",
    "/portal/expenses",
    "/api/employees/B-59",
    "/employee-360/A-12",
    "/api/share",
    "/share",
    "/api/shareholder/report/9f2c1ab8", // a longer sibling, NOT /api/share/...
  ]) {
    assert.equal(redactSecretsFromRoute(ordinary), ordinary, `over-redacted ${ordinary}`);
  }

  // ── 6. Null / empty pass through, and redaction is idempotent ──────────────
  assert.equal(redactSecretsFromRoute(null), null);
  assert.equal(redactSecretsFromRoute(undefined), null);
  assert.equal(redactSecretsFromRoute(""), "");
  const once = redactSecretsFromRoute("/password-setup/abc123") ?? "";
  assert.equal(redactSecretsFromRoute(once), once, "re-logging a redacted route must be a no-op");

  // ── 7. The WIRING — a perfect redactor the insert stops calling is worthless ─
  const service = readFileSync(SERVICE_FILE, "utf8");
  assert.ok(
    /route:\s*redactSecretsFromRoute\(input\.route\)/.test(service),
    `${SERVICE_FILE}: the app_error_events insert must write redactSecretsFromRoute(input.route), not the raw route`,
  );
  assert.ok(
    !/route:\s*input\.route\s*\?\?\s*null/.test(service),
    `${SERVICE_FILE}: found the raw \`route: input.route ?? null\` insert — a token written here is stored while it still works`,
  );
  assert.ok(
    /\[app-error:not-persisted\][^\n]*redactSecretsFromRoute\(input\.route\)/.test(service),
    `${SERVICE_FILE}: the not-persisted console line must redact too — an application log is a sink like any other`,
  );
  // Section 8 (the AI triage redactor, redactForAi) left with the System Issues page's AI triage
  // on 23 Oct 2026 (src/lib/error-monitor/ai-redact.ts was deleted with it).
}
