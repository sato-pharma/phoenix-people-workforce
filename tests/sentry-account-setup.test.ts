import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import {
  ORG_PRIVACY,
  TEST_ISSUE_TEXT,
  apiBaseFromDsn,
  describeToken,
  emailsOnNewIssues,
  orgPrivacyPatch,
  pickOrg,
  pickProject,
  testIssues,
  workflowCoveringNewIssues,
} from "../scripts/lib/sentry-account-plan.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * `scripts/sentry-setup.mjs` configures the Sentry account over Sentry's REST API: the organisation's IP and data
 * scrubbing, the deliberate test issue, and a CHECK that an alert already emails on every new issue.
 *
 * It is the one script here that holds a credential and writes to a third party, so the tests hold three
 * things: the decisions (pure functions, fed the exact alert shapes the owner's account returned on 2026-10-16),
 * the safety properties (dry run is the default, the token is never printed, an unknown flag does nothing, nothing
 * is ever deleted or created), and the whole script run against a local stand-in for Sentry — the only way to see
 * which requests a dry run and an --apply actually make.
 */

const TOKEN = "sntryu_TESTTOKEN_0123456789abcdef";

// The three alerts the owner's account returned (trimmed to the fields the script reads).
const HIGH_PRIORITY = {
  name: "Send a notification for high priority issues",
  enabled: true,
  environment: null,
  lastTriggered: "2026-10-16T05:16:12.514134Z",
  triggers: { conditions: [{ type: "new_high_priority_issue" }, { type: "existing_high_priority_issue" }] },
  actionFilters: [{ actions: [{ type: "email", status: "active" }] }],
};
const PR_READY = {
  name: "Send a notification when pull requests are ready",
  enabled: true,
  environment: null,
  triggers: { conditions: [{ type: "seer_activity_trigger" }] },
  actionFilters: [{ actions: [{ type: "email", status: "active" }] }],
};
const SUGGESTED_ASSIGNEES_OFF = {
  name: "Notify Suggested Assignees",
  enabled: false,
  environment: "production",
  triggers: { conditions: [{ type: "first_seen_event" }] },
  actionFilters: [{ actions: [{ type: "email", status: "active" }] }],
};

function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

function pureTests() {
  assert.equal(apiBaseFromDsn("https://abc@o45.ingest.de.sentry.io/9"), "https://de.sentry.io", "an EU DSN is operated on the EU API host");
  assert.equal(apiBaseFromDsn("https://abc@o45.ingest.us.sentry.io/9"), "https://us.sentry.io");
  assert.equal(apiBaseFromDsn("https://abc@o45.ingest.sentry.io/9"), "https://sentry.io");
  assert.equal(apiBaseFromDsn("not a url"), null);

  assert.equal(emailsOnNewIssues(HIGH_PRIORITY), true, "the default high-priority alert emails on a new issue");
  assert.equal(emailsOnNewIssues(PR_READY), false, "an alert about pull requests is not new-issue coverage");
  assert.equal(emailsOnNewIssues(SUGGESTED_ASSIGNEES_OFF), false, "a DISABLED alert covers nothing");
  assert.equal(emailsOnNewIssues({ ...HIGH_PRIORITY, actionFilters: [{ actions: [{ type: "slack" }] }] }), false, "an alert that does not email is not email coverage");
  assert.equal(emailsOnNewIssues({ ...HIGH_PRIORITY, actionFilters: [{ actions: [{ type: "email", status: "disabled" }] }] }), false);
  assert.equal(emailsOnNewIssues(undefined), false);

  assert.equal(workflowCoveringNewIssues([PR_READY, SUGGESTED_ASSIGNEES_OFF, HIGH_PRIORITY])?.name, HIGH_PRIORITY.name);
  assert.equal(workflowCoveringNewIssues([PR_READY, SUGGESTED_ASSIGNEES_OFF]), null, "no enabled new-issue email means NOT covered");
  assert.equal(workflowCoveringNewIssues(undefined), null, "an unreadable answer is never read as 'covered'");
  const productionOnly = { ...HIGH_PRIORITY, name: "prod only", environment: "production" };
  assert.equal(workflowCoveringNewIssues([HIGH_PRIORITY, productionOnly])?.name, "prod only", "a production-scoped alert is named in preference");

  assert.deepEqual(orgPrivacyPatch({ ...ORG_PRIVACY }), {}, "scrubbing that is already on writes nothing");
  assert.deepEqual(orgPrivacyPatch({ dataScrubber: true, dataScrubberDefaults: true, scrubIPAddresses: false }), { scrubIPAddresses: true });
  assert.deepEqual(Object.keys(orgPrivacyPatch(null)).sort(), Object.keys(ORG_PRIVACY).sort());

  assert.equal(pickOrg([{ slug: "a" }])?.slug, "a");
  assert.equal(pickOrg([{ slug: "a" }, { slug: "b" }]), null, "two organisations cannot be decided silently");
  assert.equal(pickOrg([{ slug: "a" }, { slug: "b" }], "b")?.slug, "b");
  assert.equal(pickOrg([], undefined), null);
  assert.equal(pickProject([{ slug: "x" }, { slug: "phoenix-workforce" }])?.slug, "phoenix-workforce");
  assert.equal(pickProject([{ slug: "x" }])?.slug, "x");
  assert.equal(pickProject([{ slug: "x" }, { slug: "y" }]), null);

  const issues = [
    { id: "1", title: `Error: ${TEST_ISSUE_TEXT} 2026-10-16`, status: "unresolved" },
    { id: "2", title: `Error: ${TEST_ISSUE_TEXT} 2026-10-16`, status: "resolved" },
    { id: "3", title: "TypeError: a real one", status: "unresolved" },
  ];
  assert.deepEqual(testIssues(issues).map((i: { id: string }) => i.id), ["1"], "only the open deliberate test error is resolved, never a real one");

  assert.equal(describeToken(TOKEN), `a token of ${TOKEN.length} characters`);
  assert.ok(!describeToken(TOKEN).includes(TOKEN.slice(0, 6)), "no part of the token appears in its description");
  assert.equal(describeToken(undefined), "no token");
}

function sourceTests() {
  const script = code("scripts/sentry-setup.mjs");
  assert.match(script, /const apply = argv\.includes\("--apply"\);/, "writes happen only on an explicit --apply");
  assert.match(script, /refuseUnknownFlags\(\{[\s\S]*?known: \["--apply", "--url", "--probe"\]/, "a mistyped --aply must not fall through to a run");
  assert.match(script, /process\.env\.SENTRY_AUTH_TOKEN/, "the token comes from the environment");
  const interpolations = (script.match(/\$\{token\}/g) ?? []).length;
  const headerUses = (script.match(/Authorization: `Bearer \$\{token\}`/g) ?? []).length;
  assert.ok(headerUses >= 1 && interpolations === headerUses, "the token is interpolated only into an Authorization header, nowhere else");
  const logLines = script
    .replace(/describeToken\(token\)/g, "")
    .split("\n")
    .filter((line) => /console\.(log|error|warn|info)\(/.test(line));
  assert.ok(logLines.length > 5, "the script prints its progress");
  assert.ok(logLines.every((line) => !/\$\{[^}]*\btoken\b[^}]*\}/.test(line)), "no log line interpolates the token");
  assert.ok(!/readFileSync|writeFileSync|appendFileSync|\.env\.local|sentry-build-plugin/.test(script), "the token is never read from or written to a file");
  assert.ok(!/\bDELETE\b|"DELETE"/.test(script), "this script never deletes a rule, an issue or a project");
  assert.ok(!/api\("POST"/.test(script), "this script creates nothing: the alert is checked, not made");
  assert.equal((script.match(/process\.exit\(/g) ?? []).length, 1, "only the no-token exit (before any request) may call process.exit: after a request it crashes libuv on Windows");
}

type Seen = { method: string; path: string; auth: string | undefined; body: unknown };

async function withFakeSentry<T>(
  options: { status?: number; workflows?: unknown[]; workflowsStatus?: number } | undefined,
  run: (base: string, seen: Seen[]) => Promise<T>,
): Promise<T> {
  const seen: Seen[] = [];
  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          resolve(text);
        }
      });
    });
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const method = req.method ?? "GET";
    const path = req.url ?? "";
    seen.push({ method, path, auth: req.headers.authorization, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (options?.status) return send(options.status, { detail: "rejected" });
    if (method === "GET" && path === "/api/0/organizations/") return send(200, [{ id: "11", slug: "sato" }]);
    if (method === "GET" && path === "/api/0/organizations/sato/projects/") return send(200, [{ id: "77", slug: "phoenix-workforce" }]);
    if (method === "GET" && path === "/api/0/organizations/sato/") return send(200, { dataScrubber: true, dataScrubberDefaults: false, scrubIPAddresses: false });
    if (method === "PUT" && path === "/api/0/organizations/sato/") return send(200, {});
    if (method === "GET" && path === "/api/0/organizations/sato/workflows/") {
      if (options?.workflowsStatus) return send(options.workflowsStatus, null);
      return send(200, options?.workflows ?? [PR_READY, HIGH_PRIORITY, SUGGESTED_ASSIGNEES_OFF]);
    }
    if (method === "GET" && path.startsWith("/api/0/organizations/sato/issues/?project=77")) {
      return send(200, [
        { id: "501", title: `Error: ${TEST_ISSUE_TEXT} 2026-10-16`, status: "unresolved" },
        { id: "502", title: "TypeError: a real failure", status: "unresolved" },
      ]);
    }
    if (method === "PUT" && path.startsWith("/api/0/organizations/sato/issues/?project=77")) return send(200, {});
    return send(404, { detail: `unexpected ${method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function runScript(args: string[], env: Record<string, string | undefined>) {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL("../scripts/sentry-setup.mjs", import.meta.url)), ...args],
      { env: merged, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        const exit = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
        resolve({ code: exit, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

async function behaviourTests() {
  // No token: it says how to make one, and touches nothing.
  await withFakeSentry(undefined, async (base, seen) => {
    const result = await runScript(["--url", base], { SENTRY_AUTH_TOKEN: undefined });
    assert.equal(result.code, 1);
    assert.match(result.out, /SENTRY_AUTH_TOKEN is not set/);
    assert.match(result.out, /alerts:write/, "the message names the scopes the token needs");
    assert.equal(seen.length, 0, "without a token not one request is made");
  });

  // An unknown flag is refused before anything runs.
  await withFakeSentry(undefined, async (base, seen) => {
    const result = await runScript(["--aply", "--url", base], { SENTRY_AUTH_TOKEN: TOKEN });
    assert.equal(result.code, 2);
    assert.match(result.out, /--aply/);
    assert.equal(seen.length, 0, "a mistyped --apply must not run the dry run, let alone the real one");
  });

  // DRY RUN (the default): reads everything, writes nothing.
  await withFakeSentry(undefined, async (base, seen) => {
    const result = await runScript(["--url", base], { SENTRY_AUTH_TOKEN: TOKEN });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /DRY RUN/);
    assert.match(result.out, /WOULD SET dataScrubberDefaults, scrubIPAddresses/);
    assert.match(result.out, /alert\s+OK — "Send a notification for high priority issues" emails on new issues/);
    assert.match(result.out, /WOULD RESOLVE 1/);
    assert.deepEqual([...new Set(seen.map((r) => r.method))], ["GET"], "a dry run makes only GET requests");
    assert.ok(seen.every((r) => r.auth === `Bearer ${TOKEN}`), "every request carries the token in the header");
    assert.ok(!result.out.includes(TOKEN), "the token is not in the output");
    assert.ok(!result.out.includes(TOKEN.slice(0, 12)), "no part of the token is in the output");
  });

  // --apply: sets the missing scrubbing keys only, resolves ONLY the test issue, creates nothing.
  await withFakeSentry(undefined, async (base, seen) => {
    const result = await runScript(["--apply", "--url", base], { SENTRY_AUTH_TOKEN: TOKEN });
    assert.equal(result.code, 0, result.out);
    assert.ok(!result.out.includes(TOKEN));

    const orgPut = seen.find((r) => r.method === "PUT" && r.path === "/api/0/organizations/sato/");
    assert.deepEqual(orgPut?.body, { dataScrubberDefaults: true, scrubIPAddresses: true }, "only the keys that differ are written");

    const resolved = seen.find((r) => r.method === "PUT" && r.path.includes("/issues/"));
    assert.ok(resolved?.path.includes("id=501") && !resolved.path.includes("502"), "a real failure is never resolved");
    assert.deepEqual(resolved?.body, { status: "resolved" });

    assert.deepEqual([...new Set(seen.map((r) => r.method))].sort(), ["GET", "PUT"], "no POST and no DELETE, ever: nothing is created or removed");
  });

  // No alert emails on a new issue: it is reported NOT COVERED, the rest still runs, and the run ends non-zero.
  await withFakeSentry({ workflows: [PR_READY, SUGGESTED_ASSIGNEES_OFF] }, async (base) => {
    const result = await runScript(["--apply", "--url", base], { SENTRY_AUTH_TOKEN: TOKEN });
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /alert\s+NOT COVERED/);
    assert.match(result.out, /scrubbing\s+SET/, "the scrubbing is still applied");
    assert.match(result.out, /test issue\s+RESOLVED 1/, "the cleanup is still done");
  });

  // An endpoint Sentry has retired (404) is NOT DONE, never a crash that skips the other steps.
  await withFakeSentry({ workflowsStatus: 404 }, async (base) => {
    const result = await runScript(["--apply", "--url", base], { SENTRY_AUTH_TOKEN: TOKEN });
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /alert\s+NOT DONE/);
    assert.match(result.out, /test issue\s+RESOLVED 1/, "the cleanup still runs after a retired endpoint");
  });

  // --probe reads only, and prints the account's existing alerts.
  await withFakeSentry(undefined, async (base, seen) => {
    const result = await runScript(["--probe", "--url", base], { SENTRY_AUTH_TOKEN: TOKEN });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /GET \/api\/0\/organizations\/sato\/workflows\/\s+->\s+HTTP 200/);
    assert.match(result.out, /existing workflows/);
    assert.deepEqual([...new Set(seen.map((r) => r.method))], ["GET"], "a probe makes only GET requests");
    assert.ok(!result.out.includes(TOKEN));
  });

  // A rejected token explains itself and exits non-zero.
  await withFakeSentry({ status: 403 }, async (base) => {
    const result = await runScript(["--url", base], { SENTRY_AUTH_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.match(result.out, /rejected or is missing a scope/);
    assert.ok(!result.out.includes(TOKEN));
  });
}

export async function runSentryAccountSetupTests() {
  pureTests();
  sourceTests();
  await behaviourTests();
}
