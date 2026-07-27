import assert from "node:assert/strict";

import {
  aggregateProbeError,
  cairoDateKey,
  cairoHour,
  evaluateWhatsAppIntakeHealth,
  isCairoBusinessHours,
  resolveConfiguredPhoneNumberIds,
  type WhatsAppNumberProbe,
} from "../src/lib/recruitment/inbound/whatsapp-health.ts";

// 2026-07-27 is inside Egypt's summer time (UTC+3 since the DST reinstatement), so 09:00 UTC is
// 12:00 Cairo. Using a real instant rather than a hand-built offset keeps this honest if the
// rules change.
const CAIRO_NOON = new Date("2026-07-27T09:00:00.000Z");
const CAIRO_MIDNIGHT_ISH = new Date("2026-07-27T01:00:00.000Z"); // 04:00 Cairo

export function runRecruitmentWhatsAppHealthTests() {
  // --- Cairo business-hours gate -----------------------------------------------------------
  assert.equal(cairoHour(CAIRO_NOON), 12);
  assert.equal(cairoHour(CAIRO_MIDNIGHT_ISH), 4);
  assert.equal(isCairoBusinessHours(CAIRO_NOON), true);
  assert.equal(isCairoBusinessHours(CAIRO_MIDNIGHT_ISH), false, "quiet nights must never page anyone");

  // --- cairoDateKey (once-per-day push throttle bucket) ----------------------------------------
  assert.equal(cairoDateKey(CAIRO_NOON), "2026-07-27");
  // The bucket rolls at Cairo midnight, not UTC midnight, so a persistent outage re-alerts once
  // per Cairo day rather than at the wrong boundary.
  assert.equal(cairoDateKey(new Date("2026-07-27T20:30:00.000Z")), "2026-07-27", "23:30 Cairo is still the same day");
  assert.equal(cairoDateKey(new Date("2026-07-27T21:30:00.000Z")), "2026-07-28", "00:30 Cairo has rolled to the next day");

  // --- Not configured --------------------------------------------------------------------------
  const unconfigured = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: false,
    lastInboundAt: null,
    now: CAIRO_NOON,
    silenceThresholdHours: 24,
  });
  assert.equal(unconfigured.status, "not_configured", "an unconfigured channel is inert, never an alert");

  // --- API probe failure (the 2026-07-26 incident) ---------------------------------------------
  // Meta blocked API access app-wide and simply stopped delivering webhooks. Nothing failed,
  // nothing logged, and it took ~19 hours for a human to notice. This is the check that catches it.
  const blocked = evaluateWhatsAppIntakeHealth({
    apiError: "API access blocked. (code 200)",
    configured: true,
    lastInboundAt: new Date(CAIRO_NOON.getTime() - 2 * 60 * 60 * 1000),
    now: CAIRO_NOON,
    silenceThresholdHours: 24,
  });
  assert.equal(blocked.status, "api_unreachable");
  assert.match(blocked.detail, /API access blocked/, "Meta's own wording is what makes the alert actionable");

  // A dead API outranks silence — one incident must not be reported as two problems.
  const blockedAndSilent = evaluateWhatsAppIntakeHealth({
    apiError: "API access blocked. (code 200)",
    configured: true,
    lastInboundAt: new Date(CAIRO_NOON.getTime() - 96 * 60 * 60 * 1000),
    now: CAIRO_NOON,
    silenceThresholdHours: 24,
  });
  assert.equal(blockedAndSilent.status, "api_unreachable");

  // --- Silence (credentials fine, messages not arriving) ---------------------------------------
  const silent = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: new Date(CAIRO_NOON.getTime() - 30 * 60 * 60 * 1000),
    now: CAIRO_NOON,
    silenceThresholdHours: 24,
  });
  assert.equal(silent.status, "silent");
  assert.equal(Math.floor(silent.hoursSinceLastInbound ?? 0), 30);
  assert.match(silent.detail, /webhook subscription/, "the alert says what to actually go and check");

  // Same 30h gap, but at 04:00 Cairo — normal, and must stay quiet.
  const silentOvernight = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: new Date(CAIRO_MIDNIGHT_ISH.getTime() - 30 * 60 * 60 * 1000),
    now: CAIRO_MIDNIGHT_ISH,
    silenceThresholdHours: 24,
  });
  assert.equal(silentOvernight.status, "ok", "silence outside Cairo working hours is not an incident");

  // Just under the threshold during business hours -> still fine.
  const withinThreshold = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: new Date(CAIRO_NOON.getTime() - 23 * 60 * 60 * 1000),
    now: CAIRO_NOON,
    silenceThresholdHours: 24,
  });
  assert.equal(withinThreshold.status, "ok");

  // --- Never-received ----------------------------------------------------------------------
  // A freshly connected number has no baseline, so "no messages ever" cannot be called a
  // regression — this is what keeps the check inert before the first real applicant.
  const neverReceived = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: null,
    now: CAIRO_NOON,
    silenceThresholdHours: 24,
  });
  assert.equal(neverReceived.status, "ok");
  assert.equal(neverReceived.hoursSinceLastInbound, null);
  assert.equal(neverReceived.lastInboundAt, null);

  // --- Healthy ---------------------------------------------------------------------------------
  const healthy = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: new Date(CAIRO_NOON.getTime() - 90 * 60 * 1000),
    now: CAIRO_NOON,
    silenceThresholdHours: 24,
  });
  assert.equal(healthy.status, "ok");
  assert.equal(healthy.apiError, null);
  assert.equal(healthy.lastInboundAt, new Date(CAIRO_NOON.getTime() - 90 * 60 * 1000).toISOString());

  // --- resolveConfiguredPhoneNumberIds (multi-number config) -----------------------------------
  // A second HR line (01159888247 in coexistence) feeds the same webhook; the health check must
  // watch every configured number, not just the first one.
  const savedMulti = process.env.WHATSAPP_PHONE_NUMBER_IDS;
  const savedSingle = process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    delete process.env.WHATSAPP_PHONE_NUMBER_IDS;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    assert.deepEqual(resolveConfiguredPhoneNumberIds(), [], "nothing configured -> empty, channel is inert");

    process.env.WHATSAPP_PHONE_NUMBER_ID = "1319071451278873";
    assert.deepEqual(resolveConfiguredPhoneNumberIds(), ["1319071451278873"], "falls back to the single var so nothing changes until a 2nd number is added");

    process.env.WHATSAPP_PHONE_NUMBER_IDS = " 1319071451278873 , 2000000000000 ,1319071451278873";
    assert.deepEqual(
      resolveConfiguredPhoneNumberIds(),
      ["1319071451278873", "2000000000000"],
      "the plural var wins, is trimmed, and deduped",
    );
  } finally {
    if (savedMulti === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_IDS;
    else process.env.WHATSAPP_PHONE_NUMBER_IDS = savedMulti;
    if (savedSingle === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = savedSingle;
  }

  // --- aggregateProbeError (per-number probe -> one status) ------------------------------------
  const bothOk: WhatsAppNumberProbe[] = [
    { displayNumber: "+20 10 98500699", error: null, ok: true, phoneNumberId: "a" },
    { displayNumber: "+20 11 59888247", error: null, ok: true, phoneNumberId: "b" },
  ];
  assert.equal(aggregateProbeError(bothOk), null, "all numbers healthy -> no API error");
  assert.equal(aggregateProbeError([]), null, "no numbers probed -> no API error (handled as not_configured upstream)");

  const oneDown: WhatsAppNumberProbe[] = [
    { displayNumber: "+20 10 98500699", error: null, ok: true, phoneNumberId: "a" },
    { displayNumber: "+20 11 59888247", error: "number status is FLAGGED", ok: false, phoneNumberId: "b" },
  ];
  assert.equal(
    aggregateProbeError(oneDown),
    "+20 11 59888247: number status is FLAGGED",
    "only the failing line is named, by its readable display number",
  );

  const bothDown: WhatsAppNumberProbe[] = [
    { displayNumber: null, error: "API access blocked. (code 200)", ok: false, phoneNumberId: "a" },
    { displayNumber: "+20 11 59888247", error: "number status is RESTRICTED", ok: false, phoneNumberId: "b" },
  ];
  assert.equal(
    aggregateProbeError(bothDown),
    "a: API access blocked. (code 200); +20 11 59888247: number status is RESTRICTED",
    "every failing line is reported; the id is used when Meta returned no display number",
  );
}
