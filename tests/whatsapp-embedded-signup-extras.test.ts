import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WHATSAPP_EMBEDDED_SIGNUP_EXTRAS,
  WHATSAPP_EMBEDDED_SIGNUP_FEATURE_TYPE,
  WHATSAPP_EMBEDDED_SIGNUP_VERSION,
} from "../src/lib/recruitment/inbound/whatsapp-embedded-signup.ts";

// The coexistence dialog fails OPEN, which is why this test exists.
//
// /whatsapp-connect asked Meta for coexistence by name — featureType "whatsapp_business_app_onboarding"
// — and Meta served the v2 dialog anyway, because the extras carried no `version`. There was no
// error and no warning: the owner simply got a normal signup screen offering "create a new number",
// which is the MIGRATION path that signs WhatsApp out of the handset. The only tell was that the
// coexistence step never appeared.
//
// So the thing worth pinning is the payload actually handed to FB.login, not the wording of the
// source around it. Assert on the exported object, and assert the page hands over that same object
// rather than assembling its own.

export function runWhatsAppEmbeddedSignupExtrasTests() {
  // --- THE REGRESSION --------------------------------------------------------------------------
  // Read live on 2026-09-11 from the onboarding link Meta generates for this app on its own Tech
  // Provider page: {"version":"v4","sessionInfoVersion":"3","featureType":"whatsapp_business_app_onboarding"}
  assert.equal(
    WHATSAPP_EMBEDDED_SIGNUP_VERSION,
    "v4",
    "without version v4 Meta serves the v2 dialog, which has no coexistence step at all",
  );
  assert.equal(
    WHATSAPP_EMBEDDED_SIGNUP_EXTRAS.version,
    "v4",
    "the version must reach the extras payload, not merely exist as a constant",
  );

  // --- the rest of the payload -----------------------------------------------------------------
  assert.equal(
    WHATSAPP_EMBEDDED_SIGNUP_EXTRAS.featureType,
    WHATSAPP_EMBEDDED_SIGNUP_FEATURE_TYPE,
    "coexistence is requested by featureType; a stale value silently onboards a NEW Cloud API number",
  );
  assert.equal(WHATSAPP_EMBEDDED_SIGNUP_EXTRAS.featureType, "whatsapp_business_app_onboarding");
  assert.equal(
    WHATSAPP_EMBEDDED_SIGNUP_EXTRAS.sessionInfoVersion,
    "3",
    "sessionInfoVersion 3 is what returns waba_id through the dialog's postMessage",
  );

  // --- exact shape ------------------------------------------------------------------------------
  // Meta's own generated link carries these three keys and nothing else. The v2-era `setup: {}` was
  // dropped deliberately. A new key here should be a decision someone made, not a leftover.
  assert.deepEqual(
    Object.keys(WHATSAPP_EMBEDDED_SIGNUP_EXTRAS).sort(),
    ["featureType", "sessionInfoVersion", "version"],
    "the extras payload must match the link Meta generates, field for field",
  );

  // --- the page must send the shared object ------------------------------------------------------
  // A page that rebuilds its own extras inline is exactly how the missing version survived unnoticed,
  // because nothing outside the browser could see what was sent.
  const page = readFileSync("app/whatsapp-connect/page.tsx", "utf8");
  assert.ok(
    page.includes("extras: WHATSAPP_EMBEDDED_SIGNUP_EXTRAS"),
    "the connect page must hand FB.login the shared extras object, never an inline literal",
  );
  assert.ok(
    !page.includes("setup: {}"),
    "the v2-era setup key must not come back inline in the page",
  );
}
