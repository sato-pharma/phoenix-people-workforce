// The routes that take a file over 10 MB must stay OUT of the proxy matcher, and must keep their own guards.
//
// WHY THIS EXISTS. When the proxy matches a request, Next copies the request body so the proxy could
// read it, and stops copying at `proxyClientMaxBodySize` — 10 MB by default (next 16.3.8,
// `next/dist/server/config-shared.js`). The route then receives a body cut off at 10 MB with only a
// console warning, `request.formData()` throws, and `/api/devices/headwind/upload` answers "Choose a
// file to send." — for any APK over 10 MB, which is every APK. Measured on staging 2026-10-04: an
// 11 MB POST logged `Request body exceeded 10MB for /api/devices/headwind/upload. Only the first
// 10MB will be available`. Production `audit_logs` held zero `application-upload` / `file-upload`
// rows: no device upload had ever succeeded.
//
// The fix excludes ONLY the routes whose own limit is above 10 MB: the two device APK uploads, and
// (audit, 2026-10-04) hiring documents, custom hiring-pack templates, personal-mailbox send, the
// WhatsApp inbox and an employee's CV and CV staging draft. Routes capped at 10 MB or less stay behind
// the proxy, and so does the PUBLIC `/api/public/apply`. This file pins that, and pins the other half
// that makes an exclusion safe: each route still runs the same-origin test and an auth step that turns
// an anonymous caller away BEFORE it reads the body — the proxy's CSRF rule was the second layer,
// never the only one, and without the proxy's cap a body nobody authorised would be buffered whole. It also pins that the limit is NOT raised globally: that would make the
// proxy buffer up to that much of ANY request body, on any path, before authentication.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { config } from "../proxy.ts";
import { RECORDING_MAX_BYTES, RECORDING_UPLOAD_MAX_REQUEST_BYTES } from "../src/lib/devices/headwind/recordings.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Every route left out of the proxy: the matcher's own lookahead text, a real path it must not match,
 * the route file, and the auth step that must sit between the same-origin check and the body read.
 * `auth` is a source fragment, searched after comments are stripped.
 */
const EXCLUDED = [
  { pattern: "api/devices/headwind/upload$", sample: "/api/devices/headwind/upload", file: "app/api/devices/headwind/upload/route.ts", auth: 'assertPermission(access, "company_devices", "approve")' },
  { pattern: "api/hiring-documents/files$", sample: "/api/hiring-documents/files", file: "app/api/hiring-documents/files/route.ts", auth: 'assertPermission(access, "employee_documents", "update")' },
  { pattern: "api/hiring-pack/custom-templates$", sample: "/api/hiring-pack/custom-templates", file: "app/api/hiring-pack/custom-templates/route.ts", auth: 'assertPermission(access, "employee_documents", "update")' },
  { pattern: "api/messages/mailbox/send$", sample: "/api/messages/mailbox/send", file: "app/api/messages/mailbox/send/route.ts", auth: "resolveMailboxOwner(access)" },
  { pattern: "api/whatsapp-inbox/conversations/[^/]+/messages$", sample: "/api/whatsapp-inbox/conversations/abc123/messages", file: "app/api/whatsapp-inbox/conversations/[id]/messages/route.ts", auth: 'requireRecruitmentAccess(request, "recruitment", "update")' },
  { pattern: "api/employees/[^/]+/cv$", sample: "/api/employees/B-10/cv", file: "app/api/employees/[hrId]/cv/route.ts", auth: "assertCanManage(request, hrId)" },
  { pattern: "api/employees/cv-staging$", sample: "/api/employees/cv-staging", file: "app/api/employees/cv-staging/route.ts", auth: 'assertPermission(access, "employees", "update")' },
] as const;

/**
 * Doors left out of the proxy that no browser ever uses and no cookie authorises (audit, 2026-10-26,
 * point 24). A rep tablet files a screen recording of up to 256 MB with a single-use token it was
 * pushed — no session, no Origin header, so there is no same-origin test to run. What makes the
 * exclusion safe instead is pinned in section 3b: the route refuses on Content-Length and counts the
 * address BEFORE it reads a byte of the body, and it reads no session at all.
 */
const TOKEN_EXCLUDED = [
  { pattern: "api/devices/recordings/upload$", sample: "/api/devices/recordings/upload", file: "app/api/devices/recordings/upload/route.ts" },
] as const;

/**
 * Compiles each matcher with Next's own path parser, so the test asks Next's regex and not ours.
 * Only the parser is loaded: `get-page-static-info`, which wraps it with the `_next/data` prefix and the
 * `.rsc` suffix, drags in server code that throws at load outside a running server. The prefix and
 * suffix only widen what matches around the pathname, never the lookahead under test.
 */
function compileMatchers(): RegExp[] {
  const requireFromRepo = createRequire(import.meta.url);
  const { tryToParsePath } = requireFromRepo("next/dist/lib/try-to-parse-path") as {
    tryToParsePath: (path: string) => { regexStr?: string; error?: unknown };
  };
  return config.matcher.map((source) => {
    const parsed = tryToParsePath(source);
    assert.ok(parsed.regexStr, "Next could not parse proxy.ts's matcher — the harness or the matcher is broken");
    return new RegExp(parsed.regexStr);
  });
}

function proxyRuns(matchers: RegExp[], pathname: string): boolean {
  return matchers.some((matcher) => matcher.test(pathname));
}

export function runProxyUploadBodyLimitTests() {
  const matchers = compileMatchers();

  // ── 1. every excluded route is invisible to the proxy, so its body is never cut at 10 MB ───────
  for (const route of [...EXCLUDED, ...TOKEN_EXCLUDED]) {
    assert.equal(
      proxyRuns(matchers, route.sample),
      false,
      `${route.sample} is matched by the proxy — its body would be truncated at the 10 MB clone limit and a file over 10 MB would fail`,
    );
  }

  // ── 2. nothing else was excluded: siblings, look-alikes, children and every other API stay covered ──
  const stillCovered = [
    "/",
    "/admin",
    "/hr/devices",
    "/api/employees",
    "/api/employees/B-10",
    "/api/employees/B-10/cv/extra",
    "/api/devices",
    "/api/devices/headwind",
    "/api/devices/headwind/actions",
    "/api/devices/import/confirm",
    // an exclusion anchored with `$` must not swallow a longer path that merely starts the same way
    "/api/devices/headwind/uploads",
    "/api/devices/headwind/upload/extra",
    "/api/devices/recordings",
    "/api/devices/recordings/uploads",
    "/api/devices/recordings/upload/extra",
    "/api/hiring-documents",
    "/api/hiring-documents/files/extra",
    "/api/messages/mailbox",
    "/api/whatsapp-inbox/conversations/abc123",
    "/api/whatsapp-inbox/conversations/abc123/messages/extra",
    // PUBLIC and 10 MB-or-less upload routes keep the proxy's ceiling
    "/api/public/apply",
    "/api/recruitment/candidates/abc/files",
    "/api/vacations/requests",
    "/api/payroll/upload",
    "/api/sales/imports/upload",
  ];
  for (const path of stillCovered) {
    assert.equal(proxyRuns(matchers, path), true, `${path} must still pass through the proxy`);
  }
  for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/icon.png", "/apple-icon.png"]) {
    assert.equal(proxyRuns(matchers, path), false, `${path} was already excluded and must stay so`);
  }

  // The exclusion list under /api is exactly EXCLUDED — a new entry is a decision to make on purpose
  // (it drops the proxy's header stripping, CSRF layer and 10 MB ceiling for that path), not drift.
  const source = config.matcher.join("|");
  const excludedApiPatterns = [...source.matchAll(/\|(api\/[^|)]+\$)/g)].map((hit) => hit[1]).sort();
  assert.deepEqual(
    excludedApiPatterns,
    [...EXCLUDED, ...TOKEN_EXCLUDED].map((route) => route.pattern).sort(),
    "the only /api paths left out of the proxy matcher must be the routes listed in EXCLUDED and TOKEN_EXCLUDED",
  );

  // ── 3. an exclusion is safe because each route guards ITSELF, in order, before it reads the body ──
  for (const route of EXCLUDED) {
    // The POST handler alone: a file can hold a GET or PUT whose guards come in another order.
    const whole = stripComments(readFileSync(route.file, "utf8"));
    const start = whole.indexOf("export async function POST");
    assert.ok(start >= 0, `${route.file} has no POST handler — this test's premise needs re-reading`);
    const next = whole.indexOf("export async function", start + 1);
    const code = whole.slice(start, next === -1 ? undefined : next);
    const csrf = code.indexOf("assertSameOriginMutation(request)");
    const auth = code.indexOf(route.auth);
    const body = code.search(/\.formData\(\)|readCvPayload\(request\)/);
    assert.ok(csrf >= 0, `${route.file} must call assertSameOriginMutation(request) — the proxy no longer does it for this path`);
    assert.ok(auth >= 0, `${route.file} must keep ${route.auth} — the proxy never authorised and is no longer in front of it`);
    assert.ok(body >= 0, `${route.file} no longer reads the multipart body the way this test expects — its premise needs re-reading`);
    assert.ok(csrf < auth, `${route.file} must check same-origin BEFORE auth, as the proxy's CSRF rule did`);
    assert.ok(auth < body, `${route.file} must turn an anonymous caller away BEFORE it reads the uploaded body — without the proxy's ceiling an unauthorised body is buffered whole`);
  }

  // ── 3b. a token door guards itself without a session: length cap and rate limit before the body ──
  for (const route of TOKEN_EXCLUDED) {
    const whole = stripComments(readFileSync(route.file, "utf8"));
    const start = whole.indexOf("export async function POST");
    assert.ok(start >= 0, `${route.file} has no POST handler — this test's premise needs re-reading`);
    const next = whole.indexOf("export async function", start + 1);
    const code = whole.slice(start, next === -1 ? undefined : next);
    const lengthCheck = code.indexOf('recordingUploadLengthDecision(request.headers.get("content-length"))');
    const rateLimit = code.indexOf("assertApiRateLimit(");
    const slotCheck = code.indexOf("checkRecordingSlotOpen(");
    const body = code.indexOf(".formData()");
    assert.ok(body >= 0, `${route.file} no longer reads the multipart body the way this test expects — its premise needs re-reading`);
    assert.ok(lengthCheck >= 0 && lengthCheck < body, `${route.file} must refuse on Content-Length BEFORE it reads the body — without the proxy's ceiling an oversize body is buffered whole`);
    assert.ok(rateLimit >= 0 && rateLimit < body, `${route.file} must count the address BEFORE it reads the body, so nobody can stream 256 MB bodies at it without end`);
    assert.ok(slotCheck >= 0 && slotCheck < body, `${route.file} must find the slot its address names BEFORE it reads the body — a caller with no token could otherwise make it buffer 256 MB`);
    assert.ok(!/onStoreError/.test(code), `${route.file} must fail closed when the rate limit cannot be checked`);
    assert.ok(
      !/resolveAccessContext|getSessionFromRequest|cookies\(\)/.test(whole),
      `${route.file} must read no session — a token door has no cookie authority, which is the only reason it may skip the same-origin test`,
    );
  }

  // The two limits this file is about, read from the code that sets them, never typed in here. The
  // recording door's own cap must sit ABOVE the proxy's copy limit — which is the whole reason it is
  // excluded — and must hold a full-size file.
  const proxyLimit = (
    createRequire(import.meta.url)("next/dist/server/config-shared") as {
      defaultConfig: { experimental?: { proxyClientMaxBodySize?: number } };
    }
  ).defaultConfig.experimental?.proxyClientMaxBodySize;
  assert.equal(typeof proxyLimit, "number", "Next's default proxyClientMaxBodySize moved — re-read node_modules/next/dist/server/config-shared.js");
  assert.ok(
    RECORDING_UPLOAD_MAX_REQUEST_BYTES > (proxyLimit as number),
    `the recording door's request cap (${RECORDING_UPLOAD_MAX_REQUEST_BYTES} bytes) must sit above the proxy's ${proxyLimit}-byte copy limit — a full recording is far larger, and that is why the door is out of the matcher`,
  );
  assert.ok(RECORDING_UPLOAD_MAX_REQUEST_BYTES >= RECORDING_MAX_BYTES, "the recording door's request cap must hold a full-size recording");

  // ── 4. the global limit is NOT raised — that would be the unauthenticated-buffering hole ──────
  const nextConfig = stripComments(readFileSync("next.config.ts", "utf8"));
  assert.ok(
    !/proxyClientMaxBodySize|middlewareClientMaxBodySize/.test(nextConfig),
    "next.config.ts must not raise the proxy body limit: it would let any unauthenticated request make the proxy hold that much body on any path. Exclude the path from the matcher instead.",
  );
}
