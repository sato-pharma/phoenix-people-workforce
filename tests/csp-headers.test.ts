import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

import {
  CSP_NONCE_HEADER,
  createCspNonce,
  pageContentSecurityPolicy,
  shouldSendPageCsp,
} from "@/lib/security/content-security-policy";
import type { PagePolicyEnvironment } from "@/lib/security/content-security-policy";
import { CSP_NONCE_CAPTURE_BOOT_SCRIPT, documentScriptNonce, isCspNonce, withScriptNonce } from "@/lib/security/csp-nonce";

const { NextRequest } = await import("next/server");
const { proxy } = await import("../proxy.ts");

/**
 * Regression cover for the site-wide Content-Security-Policy.
 *
 * The CSP had no test at all, which is how this shipped: `script-src` was
 * missing `'wasm-unsafe-eval'`, so the Maps JavaScript API's vector renderer
 * threw "CompileError: call to WebAssembly.instantiate() blocked by CSP" on
 * every page that draws a map. That was 1,992 of 2,236 logged client errors
 * (89%) in the 14 days to 2026-08-09, across /employee-portals/submit-expense
 * and /admin/outstation/expense-command.
 *
 * It was invisible outside production because the non-production branch appends
 * 'unsafe-eval', which already implies WebAssembly compilation — so dev and
 * preview rendered maps fine while production did not.
 *
 * WHY THIS READS SOURCE RATHER THAN CALLING headers(): next.config.ts uses
 * `__dirname` (outputFileTracingRoot), which does not exist under a plain ESM
 * import, so the module cannot be loaded by the test runner. Next.js loads it
 * through its own pipeline. Rather than restructure a build config to suit a
 * test, this parses the script-src directive out of the file and asserts on its
 * tokens — so it still checks the policy's contents, not just that some string
 * appears somewhere in the file.
 */

const nextConfigSource = readFileSync(
  new URL("../next.config.ts", import.meta.url),
  "utf8",
);

/** The full `script-src ...` template literal as written in next.config.ts. */
function scriptSrcDirective(): string {
  const match = /`(script-src [^`]*)`/.exec(nextConfigSource);
  assert.ok(match, "next.config.ts must declare a script-src directive in the CSP array.");
  return match[1];
}

export async function runCspHeaderTests() {
  const scriptSrc = scriptSrcDirective();

  // ── The regression this file exists for ────────────────────────────────────
  assert.ok(
    scriptSrc.includes("'wasm-unsafe-eval'"),
    "script-src must allow 'wasm-unsafe-eval' or the Google Maps vector renderer throws CompileError and every map-bearing page floods the error log.",
  );

  // 'wasm-unsafe-eval' must be unconditional, not inside the non-production
  // branch — production is the only environment where it was ever missing.
  const productionBranch = /\$\{isProduction \? "" : " 'unsafe-eval'"\}/.test(scriptSrc);
  assert.ok(
    productionBranch,
    "script-src must keep 'unsafe-eval' confined to non-production builds.",
  );
  const beforeInterpolation = scriptSrc.split("${")[0];
  assert.ok(
    beforeInterpolation.includes("'wasm-unsafe-eval'"),
    "'wasm-unsafe-eval' must sit in the unconditional part of script-src — putting it inside the non-production branch would leave production broken, which is the exact bug this guards.",
  );

  // Granting wasm compilation must not smuggle full JS eval into production.
  assert.ok(
    !/(^|\s)'unsafe-eval'/.test(beforeInterpolation),
    "script-src must not enable full 'unsafe-eval' unconditionally — 'wasm-unsafe-eval' covers WebAssembly without re-enabling eval().",
  );

  // The Maps JS API is loaded from these hosts (src/lib/google-maps/browser.ts).
  for (const host of ["https://maps.googleapis.com", "https://maps.gstatic.com"]) {
    assert.ok(
      scriptSrc.includes(host),
      `script-src must allow ${host} for the Maps JavaScript API.`,
    );
  }

  // OneSignal's JSONP-style sync script is a <script> tag, not a fetch — it must
  // be in script-src, not only connect-src. Push was dead for this reason once.
  for (const host of ["https://cdn.onesignal.com", "https://api.onesignal.com"]) {
    assert.ok(
      scriptSrc.includes(host),
      `script-src must allow ${host} or OneSignal.init() hangs and push never works.`,
    );
  }

  // ── Directives that must never quietly disappear ───────────────────────────
  for (const [directive, expected] of [
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
  ] as Array<[string, string]>) {
    assert.ok(
      new RegExp(`"${directive} ${expected.replace(/'/g, "'")}"`).test(nextConfigSource),
      `CSP must keep ${directive} ${expected}.`,
    );
  }

  assert.ok(
    nextConfigSource.includes("frame-ancestors"),
    "The CSP must declare frame-ancestors so the app cannot be framed.",
  );

  // The Maps JS API injects its own Google Sans stylesheet and font files.
  assert.ok(
    /"style-src [^"]*https:\/\/fonts\.googleapis\.com/.test(nextConfigSource),
    "style-src must allow Google's font stylesheet host for the Maps JS API controls.",
  );
  assert.ok(
    /"font-src [^"]*https:\/\/fonts\.gstatic\.com/.test(nextConfigSource),
    "font-src must allow Google's font file host for the Maps JS API controls.",
  );

  runPermissionsPolicyTests();
  await runPageCspNonceTests();
}

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

/**
 * THE PAGE POLICY CARRIES A NONCE, NEVER 'unsafe-inline' (26 Oct 2026 deep audit, point 29).
 *
 * A page is served the policy from src/lib/security/content-security-policy.ts, which proxy.ts sets
 * on the request (where Next.js reads the nonce) and on the response (where it replaces the
 * next.config.ts header for that page). API routes and files keep the next.config.ts policy.
 *
 * The page policy must be next.config.ts's policy with ONE change — script-src's 'unsafe-inline'
 * becomes this request's nonce plus 'strict-dynamic' — so nothing else drifts: both are EVALUATED
 * here under the same environment (production or not, builder preview on or off, a Sentry DSN or
 * none) and compared whole, for the default page and every page override next.config.ts declares.
 */
async function runPageCspNonceTests() {
  testThePagePolicyIsTheConfigPolicyWithANonce();
  testNoPagePolicyAllowsUnsafeInlineScript();
  testTheNonceIsFreshAndWellFormed();
  testOnlyPagesGetTheNoncePolicy();
  testTheProxySetsThePolicyOnTheRequestAndTheResponse();
  testTheLayoutAndTheClientScriptsCarryTheNonce();
  testOnlyOurOwnRenderedFramesAreStamped();
  testTheBootScriptKeepsTheServedNonce();
}

const POLICY_ENVIRONMENTS: PagePolicyEnvironment[] = [false, true].flatMap((isProduction) =>
  ["", "https://phoenix-hr.satopharma.com,https://builder.io"].flatMap((allowedOrigins) =>
    ["", "https://0123456789abcdef@o1.ingest.de.sentry.io/42"].map((sentryDsn) => ({ allowedOrigins, isProduction, sentryDsn })),
  ),
);

/**
 * next.config.ts's policies, evaluated under `env`. The config cannot be imported (it uses
 * `__dirname`), so its policy block — from `const isProduction` to `siteContentSecurityPolicy` — is
 * lifted out of the source, its types are erased, and it runs against a stand-in `process.env`.
 */
function configPolicies(env: PagePolicyEnvironment): Record<string, string> {
  const start = nextConfigSource.indexOf("const isProduction =");
  const siteAt = nextConfigSource.indexOf("const siteContentSecurityPolicy =", start);
  const statementEnd = /;\r?\n/g;
  statementEnd.lastIndex = siteAt;
  const end = siteAt >= 0 ? (statementEnd.exec(nextConfigSource)?.index ?? -1) : -1;
  assert.ok(start >= 0 && siteAt > start && end > siteAt, "next.config.ts must still build its policies from `const isProduction` to `siteContentSecurityPolicy`.");
  const block = stripTypeScriptTypes(nextConfigSource.slice(start, end + 1), { mode: "strip" });
  const evaluate = new Function(
    "process",
    `${block}\nreturn { siteContentSecurityPolicy, whatsappConnectCsp, managedPlayCsp, milestonePreviewCsp };`,
  ) as (process: { env: Record<string, string> }) => Record<string, string>;
  return evaluate({
    env: {
      NEXT_PUBLIC_SENTRY_DSN: env.sentryDsn,
      NODE_ENV: env.isProduction ? "production" : "development",
      PHOENIX_ALLOWED_ORIGINS: env.allowedOrigins,
    },
  });
}

/** The page CSP overrides next.config.ts declares: source path -> the const it serves. */
function configPageOverrides(): Array<[string, string]> {
  const headersSection = nextConfigSource.slice(nextConfigSource.indexOf("async headers()"));
  const overrides = [
    ...headersSection.matchAll(/key: "Content-Security-Policy", value: ([^}]+?) \}[\s\S]*?source: "([^"]+)"/g),
  ]
    .map((match) => [match[2], match[1]] as [string, string])
    .filter(([source]) => !source.startsWith("/api/"));
  assert.ok(overrides.length > 0, "next.config.ts must still declare its page CSP overrides in headers().");
  return overrides;
}

/** next.config.ts's policy as a page receives it: script-src's 'unsafe-inline' swapped for the nonce. */
function withNonceInScriptSrc(policy: string, nonce: string): string {
  return policy
    .split("; ")
    .map((directive) => {
      if (!directive.startsWith("script-src ")) return directive;
      const tokens = directive.split(" ");
      const at = tokens.indexOf("'unsafe-inline'");
      assert.ok(at > 0, `the next.config.ts script-src was expected to carry 'unsafe-inline' for API routes and files: ${directive}`);
      tokens.splice(at, 1, `'nonce-${nonce}'`, "'strict-dynamic'");
      return tokens.join(" ");
    })
    .join("; ");
}

function scriptSrcOf(policy: string): string {
  const directive = policy.split("; ").find((part) => part.startsWith("script-src "));
  assert.ok(directive, `the policy must declare script-src: ${policy}`);
  return directive;
}

function testThePagePolicyIsTheConfigPolicyWithANonce() {
  const nonce = createCspNonce();
  const overrides = configPageOverrides();
  // A page override added to next.config.ts has to be added to pageContentSecurityPolicy too, or the
  // proxy's page header would silently replace it with the default — this list is the reminder.
  assert.deepEqual(
    overrides.map(([source]) => source).sort(),
    ["/devices/managed-play", "/hr/devices/managed-play", "/hr/milestones", "/milestones", "/whatsapp-connect"],
    "🔴 a page CSP override in next.config.ts must be mirrored in pageContentSecurityPolicy (src/lib/security/content-security-policy.ts)",
  );

  for (const env of POLICY_ENVIRONMENTS) {
    const config = configPolicies(env);
    const label = JSON.stringify(env);
    for (const path of ["/", "/employee-portals/submit-expense", "/admin/outstation/expense-command", "/hr/employees", "/whatsapp-connect/other"]) {
      assert.equal(
        pageContentSecurityPolicy(path, nonce, env),
        withNonceInScriptSrc(config.siteContentSecurityPolicy, nonce),
        `🔴 ${path} must get the site policy with only script-src changed (${label})`,
      );
    }
    for (const [source, constName] of overrides) {
      assert.ok(config[constName], `next.config.ts serves ${source} from ${constName}, which this test must evaluate`);
      assert.equal(
        pageContentSecurityPolicy(source, nonce, env),
        withNonceInScriptSrc(config[constName], nonce),
        `🔴 ${source} must get next.config.ts's ${constName} with only script-src changed (${label})`,
      );
    }
  }
}

function testNoPagePolicyAllowsUnsafeInlineScript() {
  const nonce = createCspNonce();
  const sources = ["/", "/hr/employees", ...configPageOverrides().map(([source]) => source)];
  for (const env of POLICY_ENVIRONMENTS) {
    for (const path of sources) {
      const scriptSrc = scriptSrcOf(pageContentSecurityPolicy(path, nonce, env)).split(" ");
      assert.ok(!scriptSrc.includes("'unsafe-inline'"), `🔴 no page may allow 'unsafe-inline' script — ${path}`);
      assert.ok(scriptSrc.includes(`'nonce-${nonce}'`), `${path}: script-src must carry this request's nonce`);
      assert.ok(scriptSrc.includes("'strict-dynamic'"), `${path}: script-src must carry 'strict-dynamic' so trusted scripts can load theirs`);
      assert.equal(scriptSrc.includes("'unsafe-eval'"), !env.isProduction, `${path}: 'unsafe-eval' stays confined to non-production`);
      assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"), `${path}: the Maps vector renderer still needs 'wasm-unsafe-eval'`);
    }
  }
  const moduleSource = read("src/lib/security/content-security-policy.ts");
  const scriptSrcLiterals = [...moduleSource.matchAll(/`script-src [^`]*`|"script-src [^"]*"/g)].map((match) => match[0]);
  assert.ok(scriptSrcLiterals.length > 0, "the page policy module must declare its script-src");
  for (const literal of scriptSrcLiterals) {
    assert.ok(!literal.includes("'unsafe-inline'"), `🔴 never 'unsafe-inline' in the page script-src: ${literal}`);
  }
}

function testTheNonceIsFreshAndWellFormed() {
  const nonces = new Set(Array.from({ length: 50 }, () => createCspNonce()));
  assert.equal(nonces.size, 50, "🔴 every request gets a fresh nonce — a repeated nonce is a known one");
  for (const nonce of nonces) {
    assert.ok(isCspNonce(nonce), `a minted nonce must be a valid nonce: ${nonce}`);
    assert.equal(Buffer.from(nonce, "base64").length, 16, "the nonce carries 128 random bits");
  }
}

function testOnlyPagesGetTheNoncePolicy() {
  for (const path of ["/", "/login", "/hr/milestones", "/employee-portals/submit-expense", "/whatsapp-connect", "/privacy"]) {
    assert.equal(shouldSendPageCsp(path), true, `${path} is a page and gets the nonce policy`);
  }
  for (const path of [
    "/api",
    "/api/readyz",
    "/api/hiring-pack/B-1/print",
    "/api/business-cards",
    "/_next/data/build/page.json",
    "/marketing-guide.html",
    "/OneSignalSDKWorker.js",
    "/manifest.json",
    "/fonts/great-vibes.woff2",
  ]) {
    assert.equal(shouldSendPageCsp(path), false, `${path} keeps the next.config.ts policy`);
  }
}

const PROXY_ORIGIN = "https://phoenix-hr.satopharma.com";
const FORGED_NONCE = "Zm9yZ2VkLW5vbmNlLXZhbHVlLTEyMzQ=";

function proxiedRequest(path: string) {
  return proxy(
    new NextRequest(`${PROXY_ORIGIN}${path}`, {
      headers: {
        // Signs in without a cookie, so the page is forwarded rather than sent to /login.
        authorization: "Bearer csp-header-test",
        [CSP_NONCE_HEADER]: FORGED_NONCE,
        "content-security-policy": `script-src 'nonce-${FORGED_NONCE}'`,
        "content-security-policy-report-only": "script-src *",
      },
    }),
  );
}

function testTheProxySetsThePolicyOnTheRequestAndTheResponse() {
  const seen = new Set<string>();
  for (const path of ["/hr/milestones", "/employee-portals/submit-expense", "/whatsapp-connect", "/login"]) {
    const response = proxiedRequest(path);
    const policy = response.headers.get("content-security-policy");
    const nonce = response.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`);
    assert.ok(isCspNonce(nonce), `🔴 ${path}: the proxy must hand the layout a nonce of its own`);
    assert.notEqual(nonce, FORGED_NONCE, `🔴 ${path}: a nonce the client sent must never be forwarded`);
    assert.equal(policy, pageContentSecurityPolicy(path, nonce), `🔴 ${path}: the response must carry the page policy for this nonce`);
    assert.equal(
      response.headers.get("x-middleware-request-content-security-policy"),
      policy,
      `🔴 ${path}: Next.js reads the nonce from the REQUEST policy, so the same policy must be forwarded`,
    );
    assert.equal(
      response.headers.get("x-middleware-request-content-security-policy-report-only"),
      null,
      `${path}: a client's report-only policy must not reach the page`,
    );
    seen.add(nonce);
  }
  assert.equal(seen.size, 4, "🔴 each request gets its own nonce");

  for (const path of ["/api/readyz", "/marketing-guide.html"]) {
    const response = proxiedRequest(path);
    assert.equal(response.headers.get("content-security-policy"), null, `${path} keeps the next.config.ts policy`);
    assert.equal(response.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`), null, `🔴 ${path}: a forged nonce is dropped`);
    assert.equal(response.headers.get("x-middleware-request-content-security-policy"), null, `🔴 ${path}: a forged policy is dropped`);
  }
}

function testTheLayoutAndTheClientScriptsCarryTheNonce() {
  const layout = read("app/layout.tsx");
  assert.match(layout, /export default async function RootLayout/u, "the root layout reads the request, so it is async");
  assert.match(layout, /\(await headers\(\)\)\.get\(CSP_NONCE_HEADER\)/u, "🔴 the root layout must read the proxy's nonce");
  const scriptTags = layout.match(/<script\s[^>]*/gu) ?? [];
  assert.equal(scriptTags.length, 3, "the root layout has three boot scripts");
  for (const tag of scriptTags) {
    assert.match(tag, /^<script nonce=\{nonce\} /u, `🔴 every boot script must carry the nonce or the page policy blocks it: ${tag}`);
  }
  assert.match(layout, /<CspNonceProvider nonce=\{nonce\}>/u, "the client components get the nonce through CspNonceProvider");
  assert.match(layout, /__html: CSP_NONCE_CAPTURE_BOOT_SCRIPT/u, "the served nonce is captured at boot for the frames");

  const oneSignal = read("src/components/notifications/onesignal-provider.tsx");
  const scripts = oneSignal.match(/<Script\b[^>]*/gu) ?? [];
  assert.ok(scripts.length > 0, "the OneSignal provider loads its SDK through next/script");
  for (const tag of scripts) {
    assert.match(tag, /\snonce=\{nonce\}/u, `🔴 the OneSignal SDK tag must carry the nonce or push never starts: ${tag}`);
  }
}

function testOnlyOurOwnRenderedFramesAreStamped() {
  for (const file of [
    "src/components/hiring-pack/manual-paper-workspace.tsx",
    "src/components/recruitment/job-post-builder.tsx",
    "src/components/spotlight/cheque-workspace.tsx",
    "src/components/milestones/milestones-workspace.tsx",
  ]) {
    assert.match(read(file), /withScriptNonce\(/u, `🔴 ${file} frames our own rendered HTML with inline scripts — it must stamp the page nonce`);
  }
  // These frames show somebody else's markup (a received email, a template body): they stay
  // sandbox="" and must never be handed the page nonce.
  for (const file of [
    "src/components/admin/email-reply-composer.tsx",
    "src/components/admin/email-template-manager.tsx",
    "src/components/admin/mailbox-monitor-dashboard.tsx",
    "src/components/layout/personal-mailbox-panel.tsx",
    "src/components/offers/offer-composer.tsx",
    "src/components/offers/offer-template-designer.tsx",
  ]) {
    assert.doesNotMatch(read(file), /withScriptNonce|documentScriptNonce|useCspNonce/u, `🔴 ${file} must never hand its frame the page nonce`);
  }

  const nonce = createCspNonce();
  assert.equal(
    withScriptNonce('<p>x</p><script>fit()</script><SCRIPT src="/a.js"></SCRIPT><scripts></scripts>', nonce),
    `<p>x</p><script nonce="${nonce}">fit()</script><script nonce="${nonce}" src="/a.js"></SCRIPT><scripts></scripts>`,
    "every script start tag gets the nonce, and nothing that only starts with 'script'",
  );
  assert.equal(
    withScriptNonce(`<script nonce="${nonce}">a()</script>`, nonce),
    `<script nonce="${nonce}">a()</script>`,
    "a tag that already carries a nonce is left alone",
  );
  assert.equal(withScriptNonce("<script>a()</script>", undefined), "<script>a()</script>", "no nonce, no change");
  assert.equal(
    withScriptNonce("<script>a()</script>", '"><img src=x onerror=alert(1)>'),
    "<script>a()</script>",
    "🔴 a value that is not a nonce is never written into the markup",
  );
}

function testTheBootScriptKeepsTheServedNonce() {
  const served = createCspNonce();
  const fakeWindow: Record<string, unknown> = {};
  const run = (nonce: string) =>
    new Function("window", "document", CSP_NONCE_CAPTURE_BOOT_SCRIPT)(fakeWindow, { currentScript: { nonce } });
  run(served);
  run(createCspNonce()); // a refresh re-renders the boot script with a new request's nonce
  assert.equal(fakeWindow.__phxCspNonce, served, "🔴 the nonce the document was served with is kept, never replaced");

  const globals = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in globals;
  const previous = globals.window;
  globals.window = fakeWindow;
  try {
    assert.equal(documentScriptNonce(), served, "the frames read the served nonce");
  } finally {
    if (hadWindow) globals.window = previous;
    else delete globals.window;
  }
  assert.equal(documentScriptNonce(), undefined, "no window, no nonce");
}

/**
 * The Permissions-Policy header shipped `camera=()` from 2026-05-12, which Chromium enforces by
 * rejecting getUserMedia with NotAllowedError before any prompt — measured on production
 * 2026-09-13 (`document.featurePolicy.allowsFeature('camera') === false`). Every live-photo
 * capture was dead on Android Chrome while Safari, which ignores the header, kept uploading.
 */
function runPermissionsPolicyTests() {
  const declarations = [...nextConfigSource.matchAll(/key: "Permissions-Policy",\s*value: "([^"]*)"/g)];
  assert.equal(
    declarations.length,
    1,
    "Permissions-Policy must be declared exactly once, site-wide. A per-route override cannot work: the policy is fixed when the document loads, and App Router navigation never loads a new document.",
  );

  const directives = new Map(
    declarations[0][1].split(",").map((part) => {
      const [feature, allowlist] = part.trim().split("=");
      return [feature, allowlist] as const;
    }),
  );

  assert.equal(
    directives.get("camera"),
    "(self)",
    "camera must be (self): camera=() makes Chromium refuse getUserMedia, which kills the outstation arrival/departure photos and the storefront and venue photos.",
  );
  assert.equal(
    directives.get("microphone"),
    "(self)",
    "microphone must be (self): the CRM visit form records a voice note and runs ar-EG dictation (src/components/phoenix-crm/speak.tsx), and microphone=() makes every browser refuse getUserMedia before any prompt — the owner saw 'microphone blocked for Phoenix' in Chrome with the site permission granted.",
  );
  assert.equal(directives.get("geolocation"), "(self)", "geolocation must stay (self) — every evidence capture stamps GPS.");
  assert.equal(directives.get("payment"), "()", "payment must stay ().");
}
