import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isForceTestingDelivery, isProductionRuntime } from "@/config/system-settings.ts";

/**
 * P0: the testing-delivery redirect must FAIL SAFE.
 *  - Unset env => OFF in production, ON in dev/preview (so prod never silently traps
 *    real mail in the test inboxes, while dev/preview never email real people).
 *  - An explicit PHOENIX_EMAIL_FORCE_TESTING value always wins.
 *  - No personal/external address may sit in the prod fallback list.
 *  - A redirect must never be silent (Sentry breadcrumb/warning).
 */
export function runEmailP0TestingTrapTests() {
  const savedForce = process.env.PHOENIX_EMAIL_FORCE_TESTING;
  const savedVercel = process.env.VERCEL_ENV;

  // Every case sets VERCEL_ENV explicitly; isProductionRuntime reads VERCEL_ENV first
  // (`VERCEL_ENV || NODE_ENV`), so VERCEL_ENV shadows NODE_ENV and we never touch the
  // read-only NODE_ENV.
  const setEnv = (force: string | undefined, vercelEnv: string) => {
    if (force === undefined) delete process.env.PHOENIX_EMAIL_FORCE_TESTING;
    else process.env.PHOENIX_EMAIL_FORCE_TESTING = force;
    process.env.VERCEL_ENV = vercelEnv;
  };

  try {
    // 1. Unset in production => redirect OFF (real mail reaches real recipients).
    setEnv(undefined, "production");
    assert.equal(isProductionRuntime(), true, "VERCEL_ENV=production must be production runtime");
    assert.equal(isForceTestingDelivery(), false, "unset force-testing in production must be OFF");

    // 2. Unset in preview/dev => redirect ON (never email real people from preview).
    setEnv(undefined, "preview");
    assert.equal(isForceTestingDelivery(), true, "unset force-testing in preview must be ON");
    setEnv(undefined, "development");
    assert.equal(isForceTestingDelivery(), true, "unset force-testing in development must be ON");

    // 3. Explicit override always wins, regardless of environment.
    setEnv("true", "production");
    assert.equal(isForceTestingDelivery(), true, "explicit true overrides prod default");
    setEnv("false", "development");
    assert.equal(isForceTestingDelivery(), false, "explicit false overrides dev default");
    for (const truthy of ["1", "yes", "on", "TRUE"]) {
      setEnv(truthy, "production");
      assert.equal(isForceTestingDelivery(), true, `explicit ${truthy} must be ON`);
    }
    for (const falsy of ["0", "no", "off", "nope"]) {
      setEnv(falsy, "preview");
      assert.equal(isForceTestingDelivery(), false, `explicit ${falsy} must be OFF`);
    }

    // 4. Empty string is treated as unset (falls through to the env default).
    setEnv("", "production");
    assert.equal(isForceTestingDelivery(), false, "blank value falls through to prod default (OFF)");
  } finally {
    if (savedForce === undefined) delete process.env.PHOENIX_EMAIL_FORCE_TESTING;
    else process.env.PHOENIX_EMAIL_FORCE_TESTING = savedForce;
    if (savedVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = savedVercel;
  }

  // Source-pattern locks.
  const settingsSource = readFileSync("src/config/system-settings.ts", "utf8");
  assert.doesNotMatch(
    settingsSource,
    /achieverrr303@gmail\.com/,
    "personal Gmail must not be in the testing fallback list",
  );
  assert.match(settingsSource, /export function isProductionRuntime/, "isProductionRuntime must be exported");
  assert.match(
    settingsSource,
    /isProductionRuntime\(\)/,
    "isForceTestingDelivery must consult isProductionRuntime for its default",
  );

  const sendSource = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
  assert.match(sendSource, /console\.log\(/, "a redirect must log a trail (never silent)");
  assert.match(
    sendSource,
    /redirected to testing recipients in production/,
    "a redirect in production must raise a logged warning",
  );
}
