// The CI login smoke switch needs APP_ENV to be exactly "ci" AND PHOENIX_CI_SMOKE_LOGIN=true, and
// the session short-circuit it opens covers the one CI account only (audit point 16, owner-approved
// 2026-10-26).
//
// WHY THIS EXISTS. Three places bent for the CI smoke test on `APP_ENV !== "production" &&
// PHOENIX_CI_SMOKE_LOGIN === "true"` — fail-open on APP_ENV: a deployment whose APP_ENV is unset
// (it happened, 2026-08) plus one stray flag would have:
//   - signed in the published a-12 / 12345678 password as a National Sales Manager, no database;
//   - accepted ANY validly signed session token with no app_sessions row, so a revoked or
//     signed-out session kept working;
//   - trusted a loopback origin on a production build.
// Now all three read `isCiSmokeLoginEnabled()` (src/lib/auth/ci-smoke-login.ts), which needs the
// environment to say positively that it is CI, and the session short-circuit is narrowed to the CI
// account. ci.yml's smoke step sets APP_ENV: ci beside the flag. No database is touched: the admin
// client points at a dummy URL and `fetch` is stubbed, then everything is restored.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Namespace import, so a build without the helper fails an ASSERTION below, not the import.
import * as ciSmoke from "../src/lib/auth/ci-smoke-login.ts";
import { resolveSessionState } from "../src/lib/auth/server.ts";
import { createSessionToken } from "../src/lib/auth/session-token.ts";
import { isAllowedPhoenixOrigin } from "../src/lib/security/origins.ts";
import { stripComments } from "./support/comment-strip.ts";

const ENV_NAMES = [
  "APP_ENV",
  "NODE_ENV",
  "PHOENIX_CI_SMOKE_LOGIN",
  "PHOENIX_AUTH_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
type EnvName = (typeof ENV_NAMES)[number];

async function withEnv(values: Partial<Record<EnvName, string | undefined>>, run: () => Promise<void> | void) {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const env = process.env as Record<string, string | undefined>;
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
  }
}

function enabledFn() {
  const fn = (ciSmoke as Record<string, unknown>).isCiSmokeLoginEnabled;
  assert.equal(typeof fn, "function", "ci-smoke-login.ts exports isCiSmokeLoginEnabled, the one smoke switch");
  return fn as () => boolean;
}

async function testTheSwitchNeedsBothHalves() {
  const isCiSmokeLoginEnabled = enabledFn();
  const cases: Array<[string | undefined, string | undefined, boolean, string]> = [
    ["ci", "true", true, "APP_ENV=ci and the flag switch the smoke login on"],
    [undefined, "true", false, "HEADLINE: the flag alone, with APP_ENV unset, never switches the smoke login on"],
    ["", "true", false, "an empty APP_ENV is not CI"],
    ["production", "true", false, "production never takes the smoke login"],
    ["staging", "true", false, "staging never takes the smoke login"],
    ["preview", "true", false, "a preview never takes the smoke login"],
    ["CI", "true", false, "APP_ENV must be exactly \"ci\""],
    ["ci", undefined, false, "APP_ENV=ci alone does nothing without the flag"],
    ["ci", "1", false, "the flag must be exactly \"true\""],
  ];
  for (const [appEnv, flag, expected, message] of cases) {
    await withEnv({ APP_ENV: appEnv, PHOENIX_CI_SMOKE_LOGIN: flag }, () => {
      assert.equal(isCiSmokeLoginEnabled(), expected, message);
    });
  }
  assert.equal((ciSmoke as Record<string, unknown>).CI_SMOKE_LOGIN_ID, "a-12", "the CI account is defined once, beside the switch");
}

async function testALoopbackOriginOnAProductionBuild() {
  const loopback = "http://127.0.0.1:3000";
  await withEnv({ APP_ENV: undefined, NODE_ENV: "production", PHOENIX_CI_SMOKE_LOGIN: "true" }, () => {
    assert.equal(isAllowedPhoenixOrigin(loopback), false, "a production build never trusts loopback on the flag alone");
  });
  await withEnv({ APP_ENV: "production", NODE_ENV: "production", PHOENIX_CI_SMOKE_LOGIN: "true" }, () => {
    assert.equal(isAllowedPhoenixOrigin(loopback), false, "production never trusts loopback");
  });
  await withEnv({ APP_ENV: "ci", NODE_ENV: "production", PHOENIX_CI_SMOKE_LOGIN: "true" }, () => {
    assert.equal(isAllowedPhoenixOrigin(loopback), true, "the CI smoke test's production build trusts its own loopback origin");
    assert.equal(isAllowedPhoenixOrigin("https://attacker.example"), false, "and still nothing else");
  });
  await withEnv({ APP_ENV: undefined, NODE_ENV: "development", PHOENIX_CI_SMOKE_LOGIN: undefined }, () => {
    assert.equal(isAllowedPhoenixOrigin(loopback), true, "development still trusts loopback, unchanged");
  });
}

async function testTheSessionShortCircuitCoversTheCiAccountOnly() {
  const asked: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input instanceof Request ? input.url : input));
    // A non-retryable PostgREST refusal: the resolver throws it straight back, and nothing is written.
    return new Response(
      JSON.stringify({ code: "42501", details: null, hint: null, message: "permission denied for function phx_auth_session_bundle" }),
      { headers: { "content-type": "application/json" }, status: 403 },
    );
  }) as typeof fetch;

  const token = (loginId: string, role: "National Sales Manager" | "Super Admin") =>
    createSessionToken({ hrId: loginId.toUpperCase(), loginId, maxAgeSeconds: 600, role, sessionId: `sid-${loginId}`, sessionVersion: 1 });

  try {
    await withEnv(
      {
        APP_ENV: "ci",
        NEXT_PUBLIC_SUPABASE_URL: "http://ci-smoke-test.invalid",
        PHOENIX_AUTH_SECRET: "ci-smoke-login-gate-test-only-secret",
        PHOENIX_CI_SMOKE_LOGIN: "true",
        SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-key",
      },
      async () => {
        const ciAccount = await resolveSessionState(token("a-12", "National Sales Manager"));
        assert.equal(ciAccount?.appSession.id, "sid-a-12", "the CI account's session is accepted inside the smoke test");
        assert.equal(asked.length, 0, "the CI account's session asks no database inside the smoke test");

        let realSession: Awaited<ReturnType<typeof resolveSessionState>> | "threw" = null;
        try {
          realSession = await resolveSessionState(token("b-10", "Super Admin"));
        } catch {
          realSession = "threw";
        }
        assert.ok(
          asked.some((url) => url.includes("/rpc/phx_auth_session_bundle")),
          "HEADLINE: any other session is still checked against app_sessions, even with the smoke switch on",
        );
        assert.ok(realSession === "threw" || realSession === null, "a session the database cannot confirm is never accepted");
      },
    );

    asked.length = 0;
    await withEnv(
      {
        APP_ENV: undefined,
        NEXT_PUBLIC_SUPABASE_URL: "http://ci-smoke-test.invalid",
        PHOENIX_AUTH_SECRET: "ci-smoke-login-gate-test-only-secret",
        PHOENIX_CI_SMOKE_LOGIN: "true",
        SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-key",
      },
      async () => {
        await resolveSessionState(token("a-12", "National Sales Manager")).catch(() => null);
        assert.ok(
          asked.some((url) => url.includes("/rpc/phx_auth_session_bundle")),
          "with APP_ENV unset, even the CI account's session is checked against app_sessions",
        );
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.ok(
    asked.every((url) => url.startsWith("http://ci-smoke-test.invalid/")),
    "the test never reaches a real database",
  );
}

function listSourceFiles(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

function testEveryReaderGoesThroughTheSwitch() {
  const code = (path: string) => stripComments(readFileSync(resolve(process.cwd(), path), "utf8"));

  const login = code("app/api/auth/login/route.ts");
  assert.match(login, /const ciSmokeMode = isCiSmokeLoginEnabled\(\);/, "the login route asks the one smoke switch");
  const server = code("src/lib/auth/server.ts");
  assert.match(
    server,
    /if \(isCiSmokeLoginEnabled\(\) && payload\.loginId === CI_SMOKE_LOGIN_ID\)/,
    "the session short-circuit asks the switch AND names the CI account",
  );
  const origins = code("src/lib/security/origins.ts");
  assert.match(
    origins,
    /\(process\.env\.NODE_ENV !== "production" \|\| isCiSmokeLoginEnabled\(\)\) && isLocalOrigin\(normalized\)/,
    "the origin check asks the switch, never the bare flag",
  );

  const readers = ["app", "src", "proxy.ts"]
    .flatMap((root) => (root.endsWith(".ts") ? [root] : listSourceFiles(root)))
    .filter((path) => readFileSync(path, "utf8").includes("PHOENIX_CI_SMOKE_LOGIN") && /PHOENIX_CI_SMOKE_LOGIN/.test(code(path)))
    .map((path) => path.replace(/\\/g, "/"));
  assert.deepEqual(readers, ["src/lib/auth/ci-smoke-login.ts"], "nothing reads PHOENIX_CI_SMOKE_LOGIN but the switch");

  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
  const smokeStep = workflow.slice(workflow.indexOf("- name: Run Playwright login smoke test"));
  const stepEnd = smokeStep.indexOf("\n      - name:");
  const smokeEnv = stepEnd > 0 ? smokeStep.slice(0, stepEnd) : smokeStep;
  assert.match(smokeEnv, /\n\s+APP_ENV: ci\n/, "the CI smoke step says APP_ENV: ci");
  assert.match(smokeEnv, /\n\s+PHOENIX_CI_SMOKE_LOGIN: "true"\n/, "the CI smoke step still sets the flag");
}

export async function runCiSmokeLoginGateTests() {
  await testTheSwitchNeedsBothHalves();
  await testALoopbackOriginOnAProductionBuild();
  await testTheSessionShortCircuitCoversTheCiAccountOnly();
  testEveryReaderGoesThroughTheSwitch();
}
