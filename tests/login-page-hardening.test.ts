import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runLoginPageHardeningTests() {
  const loginPage = readFileSync("src/components/auth/premium-login-page.tsx", "utf8");
  const loginRoute = readFileSync("app/api/auth/login/route.ts", "utf8");
  const browserSentry = readFileSync("instrumentation-client.ts", "utf8");
  const serverSentry = readFileSync("sentry.server.config.ts", "utf8");
  const edgeSentry = readFileSync("sentry.edge.config.ts", "utf8");
  const sentryHelper = readFileSync("src/lib/observability/sentry.ts", "utf8");
  const nextConfig = readFileSync("next.config.ts", "utf8");
  const gitignore = readFileSync(".gitignore", "utf8");

  assert.match(loginPage, /const maxLoginIdLength = 120/);
  assert.match(loginPage, /const maxPasswordLength = 1024/);
  assert.match(loginPage, /required\s+type="text"/);
  assert.match(loginPage, /required\s+type=\{showPassword \? "text" : "password"\}/);
  assert.match(loginPage, /maxLength=\{maxLoginIdLength\}/);
  assert.match(loginPage, /maxLength=\{maxPasswordLength\}/);
  assert.match(loginPage, /safeLocalStorageGet/);
  assert.match(loginPage, /safeLocalStorageSet/);
  assert.match(loginPage, /safeLocalStorageRemove/);
  assert.match(loginPage, /type LoginErrorField = "form" \| "loginId" \| "password"/);
  assert.match(loginPage, /aria-invalid=\{loginInvalid\}/);
  assert.match(loginPage, /aria-invalid=\{passwordInvalid\}/);
  assert.doesNotMatch(loginPage, /passwordLinkHelpMessage/);
  assert.doesNotMatch(loginPage, /href="#"/);
  assert.doesNotMatch(loginPage, /onClick=\{\(event\) => event\.preventDefault\(\)\}/);

  assert.match(loginRoute, /parseJsonLoginPayload/);
  assert.match(loginRoute, /Login request body must be a JSON object/);
  assert.match(loginRoute, /Login request body has invalid fields/);
  assert.match(loginRoute, /remember !== undefined && typeof remember !== "boolean"/);
  assert.match(loginRoute, /error: "invalid_request"/);

  for (const source of [browserSentry, serverSentry, edgeSentry]) {
    assert.match(source, /sendDefaultPii:\s*false/);
    assert.match(source, /beforeSend:\s*scrubSentryErrorEvent/);
    assert.match(source, /beforeBreadcrumb:\s*scrubSentryBreadcrumb/);
    assert.match(source, /tracesSampleRate:\s*parseSentrySampleRate/);
    assert.doesNotMatch(source, /enableLogs:\s*true/);
    assert.doesNotMatch(source, /replayIntegration/);
  }

  assert.match(sentryHelper, /sensitiveKeyPattern/);
  assert.match(sentryHelper, /delete mutable\.user/);
  assert.match(sentryHelper, /delete sanitized\.cookies/);
  assert.match(sentryHelper, /delete sanitized\.data/);
  assert.match(sentryHelper, /breadcrumb\.category === "console"/);
  assert.match(nextConfig, /telemetry:\s*false/);
  assert.match(nextConfig, /deleteSourcemapsAfterUpload:\s*true/);
  assert.match(nextConfig, /removeDebugLogging:\s*true/);
  assert.doesNotMatch(nextConfig, /disableLogger:\s*true/);
  assert.match(gitignore, /app\/api\/sentry-example-api\//);
  assert.match(gitignore, /app\/sentry-example-page\//);
}
