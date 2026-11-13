import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { AI_PROVIDER_HOSTS } from "../src/lib/ai/provider-hosts.ts";
import { fetchRouteStaticMap } from "../src/lib/outstation/review-map-image.ts";
import { resolveAiProvider } from "../src/lib/sales/ai/provider.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { pageContentSecurityPolicy, pagePolicyEnvironment } from "../src/lib/security/content-security-policy.ts";
import { ZOOM_CALL_DEADLINE_MS, resetZoomTokenCacheForTests, zoomAccessToken } from "../src/lib/zoom/meetings.ts";

/**
 * THE EDGES THE INTEGRATION AUDIT OF 13 NOV 2026 FOUND OPEN, each pinned where it was closed.
 *
 *   ISS-041  the sales AI's address is written out — no variable can point it at another host
 *   ISS-027  the page policy allows no websocket origin (nothing opens one)
 *   ISS-028  the notification drain is registered by its two doors, not as one session route
 *   ISS-033  no route runs on the edge runtime, which is why error tracking starts on Node only
 *   ISS-011  every outbound call the audit named carries a deadline
 *   ISS-047  the three workflows that had no concurrency group have one, and never cancel an alarm
 *   ISS-048  the browser cache key carries the runner image, read where it actually exists
 *
 * ISS-015 (an applicant's link is checked at every redirect) is pinned beside its own code, in
 * tests/recruitment-inbound-mastery.test.ts.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function filesUnder(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      filesUnder(rel, match, out);
    } else if (match.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

// ── ISS-041 ─────────────────────────────────────────────────────────────────────────────────────────
function salesAiAddressIsWrittenOut() {
  const pinned = new Set<string>(AI_PROVIDER_HOSTS);
  const elsewhere = "https://collector.example.test/v1";

  const openAi = resolveAiProvider(undefined, { AI_BASE_URL: elsewhere, OPENAI_API_KEY: "k" });
  assert.equal(openAi?.baseUrl, "https://api.openai.com/v1", "AI_BASE_URL no longer moves the OpenAI leg — the address is written out");
  const groq = resolveAiProvider(undefined, { AI_BASE_URL: elsewhere, GROQ_API_KEY: "k" });
  assert.equal(groq?.baseUrl, "https://api.groq.com/openai/v1", "AI_BASE_URL no longer moves the Groq leg either");
  for (const provider of [openAi, groq]) {
    assert.ok(provider && pinned.has(new URL(provider.baseUrl).hostname), "every leg resolves to a host on the AI library's own list");
  }

  assert.equal(
    resolveAiProvider(undefined, { AI_API_KEY: "k", AI_BASE_URL: elsewhere }),
    null,
    "the 'any other provider' leg is gone: a key plus an address is no longer a provider",
  );
  assert.equal(resolveAiProvider(undefined, { OPENROUTER_API_KEY: "k" }), null, "the OpenRouter leg is gone — no environment ever set it");

  const source = read("src/lib/sales/ai/provider.ts");
  assert.doesNotMatch(source, /env\s*\.\s*AI_BASE_URL|env\s*\[\s*["']AI_BASE_URL/, "provider.ts reads no address from the environment");
  assert.doesNotMatch(source, /openrouter\.ai/, "and spells no third address");
}

// ── ISS-027 ─────────────────────────────────────────────────────────────────────────────────────────
function pagePolicyAllowsNoWebsocket() {
  const policy = pageContentSecurityPolicy("/admin", "nonce-for-test", pagePolicyEnvironment());
  assert.match(policy, /connect-src 'self' https:\/\/\*\.supabase\.co /, "the database's https origin is still allowed");
  assert.doesNotMatch(policy, /wss?:/, "no websocket origin: nothing in the app opens a realtime channel, so the policy does not allow one");
  assert.doesNotMatch(read("next.config.ts"), /wss:\/\//, "next.config.ts carries the same policy for the routes the proxy does not serve, and must agree");
}

// ── ISS-028 ─────────────────────────────────────────────────────────────────────────────────────────
function notificationDrainIsRegisteredByItsTwoDoors() {
  const route = "/api/notifications/process";
  const scheduler = findAccessRegistryEntry(route, "GET");
  assert.equal(scheduler?.pattern, route);
  assert.equal(scheduler?.authMode, "cron-secret", "the scheduler's GET is registered as what guards it: the cron secret");
  assert.equal(scheduler?.permission, null, "a cron-secret row claims no session permission");

  const admin = findAccessRegistryEntry(route, "POST");
  assert.equal(admin?.authMode, "session", "the admin's POST is a session route");
  assert.deepEqual(admin?.permission, { action: "update", resource: "admin" });

  for (const method of ["PATCH", "PUT", "DELETE"] as const) {
    assert.equal(findAccessRegistryEntry(route, method), null, `${method} is not a door of this route and is no longer registered as one`);
  }

  // The register describes the handler; if the handler changes, this is where it shows.
  const handler = read("app/api/notifications/process/route.ts");
  const get = handler.slice(handler.indexOf("export async function GET"));
  const post = handler.slice(handler.indexOf("export async function POST"), handler.indexOf("export async function GET"));
  assert.match(get, /assertCronAuthorized\(/, "GET is still guarded by the cron secret");
  assert.match(post, /assertPermission\([^)]*"admin",\s*"update"\)/, "POST still asserts admin:update");
}

// ── ISS-033 ─────────────────────────────────────────────────────────────────────────────────────────
function noRouteRunsOnTheEdgeRuntime() {
  const declaresEdge = /export\s+const\s+runtime\s*=\s*["'](?:edge|experimental-edge)["']/;
  const files = [...filesUnder("app", /\.(?:ts|tsx)$/), "proxy.ts"];
  assert.ok(files.length > 500, `the scan saw only ${files.length} files — it has stopped seeing the app tree`);
  const onEdge = files.filter((file) => declaresEdge.test(read(file)));
  assert.deepEqual(
    onEdge,
    [],
    "error tracking starts on the Node runtime only (instrumentation.ts), which is complete ONLY while nothing runs on the edge runtime. " +
      "A route that declares it needs an edge start-up for error tracking in the same change — docs/observability.md, 'Error tracking and the edge runtime'.",
  );
  assert.match(read("instrumentation.ts"), /process\.env\.NEXT_RUNTIME === "nodejs"/, "the Node-only start-up this rule protects is still how instrumentation.ts begins");
}

// ── ISS-011 ─────────────────────────────────────────────────────────────────────────────────────────
async function everyNamedOutboundCallHasADeadline() {
  // Zoom: the deadline reaches the call, and every call in the file has one.
  const seen: Array<RequestInit | undefined> = [];
  resetZoomTokenCacheForTests();
  await zoomAccessToken(
    { accountId: "account-deadline-test", clientId: "id", clientSecret: "secret", hostUser: "me" } as Parameters<typeof zoomAccessToken>[0],
    async (_url, init) => {
      seen.push(init);
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    },
    0,
  );
  resetZoomTokenCacheForTests();
  assert.equal(seen.length, 1);
  assert.ok(seen[0]?.signal instanceof AbortSignal, "Zoom's sign-in call is handed a deadline");
  assert.ok(ZOOM_CALL_DEADLINE_MS >= 5_000 && ZOOM_CALL_DEADLINE_MS <= 30_000, "long enough for a slow answer, short enough that a booking does not hang");

  const zoom = read("src/lib/zoom/meetings.ts");
  assert.equal(count(zoom, "await fetchImpl("), 7, "seven Zoom calls — a new one must be added here and given a deadline");
  assert.equal(count(zoom, "signal: zoomDeadline()"), count(zoom, "await fetchImpl("), "every Zoom call carries the deadline");

  // The trip review's map: the deadline reaches the call, and a call that runs out prints no map.
  let mapInit: RequestInit | undefined;
  const fine = await fetchRouteStaticMap({ url: "https://maps.example.test/staticmap" } as Parameters<typeof fetchRouteStaticMap>[0], (async (_input: unknown, init?: RequestInit) => {
    mapInit = init;
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" }, status: 200 });
  }) as typeof fetch);
  assert.ok(mapInit?.signal instanceof AbortSignal, "the static map call is handed a deadline");
  assert.match(String(fine), /^data:image\/png;base64,/);

  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const ranOut = await fetchRouteStaticMap({ url: "https://maps.example.test/staticmap" } as Parameters<typeof fetchRouteStaticMap>[0], (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch);
    assert.equal(ranOut, null, "a map that runs out of time is a PDF without a map, never a failed PDF");
  } finally {
    console.warn = warn;
  }

  // The four files that call fetch directly: as many deadlines as calls.
  const direct: Array<[file: string, calls: number]> = [
    ["src/lib/outstation/places-autocomplete.ts", 1],
    ["app/api/admin/outstation/place-details/route.ts", 1],
    ["app/api/admin/outstation/[id]/pdf/route.ts", 1],
    ["src/lib/sales/master-map/sheets-client.ts", 2],
  ];
  for (const [file, calls] of direct) {
    const source = read(file);
    assert.equal(count(source, "await fetch("), calls, `${file}: ${calls} outbound call(s) — a new one must be counted here and given a deadline`);
    assert.equal(count(source, "signal: AbortSignal.timeout("), calls, `${file}: every outbound call carries a deadline`);
  }
}

// ── ISS-047 · ISS-048 ───────────────────────────────────────────────────────────────────────────────
function workflowsQueueAndKeyTheirCaches() {
  const workflow = (name: string) => read(`.github/workflows/${name}.yml`);

  for (const name of ["migration-drift-check", "sync-railway-production-secrets"]) {
    const block = /^concurrency:\n {2}group: ([^\n]+)\n {2}cancel-in-progress: ([^\n]+)$/m.exec(workflow(name));
    assert.ok(block, `${name}.yml declares a top-level concurrency group`);
    assert.equal(block?.[1], name, `${name}.yml runs one at a time, whatever started it`);
    assert.equal(block?.[2], "false", `${name}.yml never cancels a run: half a sync, or a cancelled alarm on main, is worse than a queue`);
  }

  const mcp = /^concurrency:\n {2}group: ([^\n]+)\n {2}cancel-in-progress: ([^\n]+)$/m.exec(workflow("phoenix-mcp"));
  assert.ok(mcp, "phoenix-mcp.yml declares a top-level concurrency group");
  assert.match(mcp?.[1] ?? "", /github\.event\.pull_request\.number \|\| github\.ref/, "one group per pull request");
  assert.equal(mcp?.[2], "${{ github.event_name == 'pull_request' }}", "only a pull request's own superseded run is cancelled — never a dispatch");

  assert.match(
    workflow("fallback-image"),
    /^ {2}group: fallback-image-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| inputs\.deploy \|\| 'build' \}\}$/m,
    "a pull request's image build queues behind its own pull request only; a dispatch or a call keeps the group it had",
  );
  assert.match(workflow("fallback-image"), /^ {2}cancel-in-progress: false$/m, "and a switch is still never cancelled half way");

  // The browser cache key. `env.ImageOS` is empty in an expression; the live keys read `playwright--X64-…`.
  const everyWorkflow = filesUnder(".github/workflows", /\.ya?ml$/);
  assert.ok(everyWorkflow.length >= 20, `the scan saw only ${everyWorkflow.length} workflows`);
  // Comment lines are left out: the two workflows explain the trap in words that spell it.
  const withoutComments = (source: string) => source.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  const readsItEmpty = everyWorkflow.filter((file) => /\$\{\{[^}]*\benv\.ImageOS\b/.test(withoutComments(read(file))));
  assert.deepEqual(readsItEmpty, [], "`${{ env.ImageOS }}` is always empty — the runner's own variables are not in the `env` context. Read $ImageOS in a shell step.");

  for (const name of ["ci", "synthetic-journeys"]) {
    const source = workflow(name);
    const named = source.indexOf("id: runner-image");
    const cached = source.indexOf("id: playwright-cache");
    assert.ok(named > 0 && cached > named, `${name}.yml names the runner image in a step BEFORE the browser cache step that uses it`);
    assert.match(
      source,
      /key: playwright-\$\{\{ steps\.runner-image\.outputs\.name \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ hashFiles\('pnpm-lock\.yaml'\) \}\}/,
      `${name}.yml keys the browser cache by image, architecture and lockfile`,
    );
    assert.match(source, /image="\$\{ImageOS:-\}"/, `${name}.yml reads ImageOS where it exists: the step's own shell`);
    assert.match(source, /echo "name=\$\{image:-unknown\}" >> "\$GITHUB_OUTPUT"/, `${name}.yml never writes an empty name into the key`);
  }
  const ci = workflow("ci");
  const imageStep = ci.slice(ci.indexOf("- name: Name the runner image for the browser cache key"), ci.indexOf("- name: Cache Playwright browsers"));
  assert.match(imageStep, /if: github\.event_name != 'pull_request'/, "ci.yml: the naming step runs exactly when the cache step does");
}

export async function runIntegrationAuditEdgesTests() {
  salesAiAddressIsWrittenOut();
  pagePolicyAllowsNoWebsocket();
  notificationDrainIsRegisteredByItsTwoDoors();
  noRouteRunsOnTheEdgeRuntime();
  await everyNamedOutboundCallHasADeadline();
  workflowsQueueAndKeyTheirCaches();
}
