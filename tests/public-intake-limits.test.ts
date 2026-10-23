import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CLIENT_ERROR_FIELD_CAPS,
  CLIENT_ERROR_MAX_BODY_BYTES,
  clientErrorBodyTooLarge,
  sanitizeClientErrorReport,
} from "../src/lib/error-monitor/client-error-intake.ts";
import { PUBLIC_APPLY_AI_READS_PER_DAY, createPublicApplyAiBudget } from "../src/lib/recruitment/inbound/public-apply-ai-budget.ts";
import { ApiRateLimitError } from "../src/lib/security/api-rate-limit.ts";
import { isRecaptchaUnavailable, verifyRecaptcha } from "../src/lib/security/recaptcha.ts";

/**
 * THE PUBLIC, UNAUTHENTICATED DOORS ARE BOUNDED (23 Oct 2026 audit, P5-02, P5-03 and the readyz item).
 *
 *  - reCAPTCHA on the careers form failed OPEN (secret unset, or Google unreachable) — now refused.
 *  - the paid AI read of a public CV had no ceiling — now PUBLIC_APPLY_AI_READS_PER_DAY a day; past it
 *    the CV is still read, the free way.
 *  - /api/errors/client had no rate limit and no field caps — now 30 a minute per address, 64 KB, caps.
 *  - /api/readyz answered raw error text and variable names — now booleans only.
 *
 * No network: Google is a stubbed `fetch`, the rate limiter an injected function.
 */
export async function runPublicIntakeLimitsTests() {
  // ── reCAPTCHA fails closed ──────────────────────────────────────────────────────────────────────
  const savedSecret = process.env.RECRUITMENT_APPLY_RECAPTCHA_SECRET;
  const savedFetch = globalThis.fetch;
  try {
    delete process.env.RECRUITMENT_APPLY_RECAPTCHA_SECRET;
    const unset = await verifyRecaptcha("token", "1.2.3.4");
    assert.deepEqual(unset, { ok: false, reason: "not_configured" }, "no secret is a refusal, never a pass");
    assert.equal(isRecaptchaUnavailable(unset), true);

    process.env.RECRUITMENT_APPLY_RECAPTCHA_SECRET = "test-secret";
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const down = await verifyRecaptcha("token", null);
    assert.deepEqual(down, { ok: false, reason: "verify_unavailable" }, "Google unreachable is a refusal, never a pass");
    assert.equal(isRecaptchaUnavailable(down), true, "and it reads as OUR side failing (503, try again), not the applicant's");

    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch;
    assert.equal((await verifyRecaptcha("token", null)).reason, "verify_unavailable", "a non-200 from Google is refused too");

    globalThis.fetch = (async () => ({ json: async () => ({ success: false }), ok: true, status: 200 }) as unknown as Response) as typeof fetch;
    const failed = await verifyRecaptcha("token", null);
    assert.equal(failed.reason, "challenge_failed");
    assert.equal(isRecaptchaUnavailable(failed), false, "a failed challenge is the applicant's (400), not an outage");

    globalThis.fetch = (async () => ({ json: async () => ({ score: 0.9, success: true }), ok: true, status: 200 }) as unknown as Response) as typeof fetch;
    assert.deepEqual(await verifyRecaptcha("token", null), { ok: true }, "a real pass still passes");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedSecret === undefined) delete process.env.RECRUITMENT_APPLY_RECAPTCHA_SECRET;
    else process.env.RECRUITMENT_APPLY_RECAPTCHA_SECRET = savedSecret;
  }
  const apply = readFileSync("app/api/public/apply/route.ts", "utf8");
  assert.ok(
    apply.indexOf("isRecaptchaUnavailable(captcha)") > -1 && apply.indexOf("isRecaptchaUnavailable(captcha)") < apply.indexOf('form.get("cv")'),
    "the public form refuses before it reads the CV",
  );

  // ── the AI spend ceiling on public applications ─────────────────────────────────────────────────
  assert.ok(PUBLIC_APPLY_AI_READS_PER_DAY > 0 && PUBLIC_APPLY_AI_READS_PER_DAY <= 1_000, "a named, finite daily ceiling");
  assert.equal(await createPublicApplyAiBudget(async () => undefined)(), true, "inside the ceiling the model may read");
  assert.equal(
    await createPublicApplyAiBudget(async () => {
      throw new ApiRateLimitError(60);
    })(),
    false,
    "past the ceiling: no model call",
  );
  assert.equal(
    await createPublicApplyAiBudget(async () => {
      throw new Error("database down");
    })(),
    false,
    "a ceiling that cannot be checked is not a ceiling: no model call",
  );
  const extraction = readFileSync("src/lib/recruitment/cv-extraction.ts", "utf8");
  const gate = extraction.indexOf("if (input.aiBudget && !(await input.aiBudget())) {");
  assert.ok(gate > -1, "the reader asks the budget");
  assert.ok(gate > extraction.indexOf("if (!hasAiApiKey()) {"), "only once a model call would really be made");
  assert.match(extraction.slice(gate, gate + 300), /if \(rule && rule\.isCv\) return ruleOnly\(\);\s*const scanned = await ruleFromOcr\(\);/, "and a spent budget takes the free path");
  const websiteApply = readFileSync("src/lib/recruitment/inbound/website-apply.ts", "utf8");
  assert.match(websiteApply, /aiBudget: consumePublicApplyAiRead/, "the public careers form passes the budget");
  for (const other of ["src/lib/recruitment/inbound/intake-worker.ts", "src/lib/recruitment/inbound/email-poller.ts"]) {
    assert.doesNotMatch(readFileSync(other, "utf8"), /consumePublicApplyAiRead/, `${other} is not gated — only the public form is`);
  }

  // ── /api/errors/client: caps and a rate limit ──────────────────────────────────────────────────
  const huge = "x".repeat(100_000);
  const report = sanitizeClientErrorReport({
    clientContext: huge,
    componentStack: huge,
    digest: huge,
    message: huge,
    route: huge,
    routeType: huge,
    source: "server",
    stack: huge,
  });
  for (const [field, cap] of Object.entries(CLIENT_ERROR_FIELD_CAPS)) {
    assert.equal((report as Record<string, string | null>)[field]?.length, cap, `${field} is capped at ${cap}`);
  }
  assert.equal(sanitizeClientErrorReport({ message: 42, route: ["x"] }).message, null, "a non-string field is dropped, never coerced");
  assert.equal(sanitizeClientErrorReport("not an object").source, "client");
  assert.equal(clientErrorBodyTooLarge(String(CLIENT_ERROR_MAX_BODY_BYTES + 1)), true);
  assert.equal(clientErrorBodyTooLarge(String(CLIENT_ERROR_MAX_BODY_BYTES)), false);
  assert.equal(clientErrorBodyTooLarge(null), false, "no header: the read is capped instead");
  const errorsRoute = readFileSync("app/api/errors/client/route.ts", "utf8");
  assert.ok(
    errorsRoute.indexOf("assertApiRateLimit(") > -1 && errorsRoute.indexOf("assertApiRateLimit(") < errorsRoute.indexOf("logAppError("),
    "the rate limit runs before anything is stored",
  );
  assert.match(errorsRoute, /status: 429/, "a flood past the limit is answered 429");
  assert.match(errorsRoute, /raw\.length > CLIENT_ERROR_MAX_BODY_BYTES/, "a body with a false Content-Length is capped on the read");
  assert.match(errorsRoute, /sanitizeClientErrorReport\(parsed\)/);

  // ── /api/readyz answers booleans only ──────────────────────────────────────────────────────────
  const readyz = readFileSync("app/api/readyz/route.ts", "utf8");
  const answer = readyz.slice(readyz.lastIndexOf("return NextResponse.json("));
  for (const leaked of ["missingEnv,", "databaseError", "registryCheckError", "skippedWorkflowModules", "warnings,", "sha:"]) {
    assert.ok(!answer.includes(leaked), `the public answer no longer carries ${leaked}`);
  }
  assert.match(answer, /env: missingEnv\.length === 0,/);
  assert.match(answer, /database: databaseOk,/);
  assert.match(readyz, /readyz_not_clean/, "the detail goes to the server log instead");
}
