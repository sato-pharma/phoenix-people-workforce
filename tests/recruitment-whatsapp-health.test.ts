import assert from "node:assert/strict";

import {
  aggregateProbeError,
  evaluateWebhookRouting,
  expectedWebhookUrl,
  normalizeCallbackUrl,
  cairoDateKey,
  cairoHour,
  evaluateWhatsAppIntakeHealth,
  isCairoBusinessDay,
  isCairoBusinessHours,
  isNumberSilent,
  isSilenceAlertWindow,
  resolveConfiguredPhoneNumberIds,
  type WhatsAppNumberProbe,
  type WhatsAppPublicReach,
} from "../src/lib/recruitment/inbound/whatsapp-health.ts";
import { autoReplyConfig, isWhatsAppAutoReplyEnabled } from "../src/lib/recruitment/inbound/whatsapp-reply.ts";

// 2026-07-27 is inside Egypt's summer time (UTC+3 since the DST reinstatement), so 09:00 UTC is
// 12:00 Cairo. Using a real instant rather than a hand-built offset keeps this honest if the
// rules change.
const CAIRO_NOON = new Date("2026-07-27T09:00:00.000Z"); // Monday
const CAIRO_MIDNIGHT_ISH = new Date("2026-07-27T01:00:00.000Z"); // 04:00 Cairo

// Same 12:00 Cairo instant on each surrounding day, so only the weekday differs between them.
const CAIRO_THURSDAY_NOON = new Date("2026-07-30T09:00:00.000Z");
const CAIRO_FRIDAY_NOON = new Date("2026-07-31T09:00:00.000Z");
const CAIRO_SATURDAY_NOON = new Date("2026-08-01T09:00:00.000Z");
const CAIRO_SUNDAY_NOON = new Date("2026-08-02T09:00:00.000Z");

export function runRecruitmentWhatsAppHealthTests() {
  // --- Cairo business-hours gate -----------------------------------------------------------
  assert.equal(cairoHour(CAIRO_NOON), 12);
  assert.equal(cairoHour(CAIRO_MIDNIGHT_ISH), 4);
  assert.equal(isCairoBusinessHours(CAIRO_NOON), true);
  assert.equal(isCairoBusinessHours(CAIRO_MIDNIGHT_ISH), false, "quiet nights must never page anyone");

  // --- Cairo business-DAY gate (Egyptian weekend is Friday + Saturday) -------------------------
  assert.equal(isCairoBusinessDay(CAIRO_SUNDAY_NOON), true, "Sunday is the first Egyptian working day");
  assert.equal(isCairoBusinessDay(CAIRO_NOON), true, "Monday is a working day");
  assert.equal(isCairoBusinessDay(CAIRO_THURSDAY_NOON), true, "Thursday is a working day");
  assert.equal(isCairoBusinessDay(CAIRO_FRIDAY_NOON), false, "Friday is the weekend");
  assert.equal(isCairoBusinessDay(CAIRO_SATURDAY_NOON), false, "Saturday is the weekend");

  // The day is read in Cairo, not UTC: this instant is still Thursday in UTC but already Friday in
  // Cairo, so it must count as weekend.
  assert.equal(
    isCairoBusinessDay(new Date("2026-07-30T21:30:00.000Z")),
    false,
    "00:30 Cairo Friday is the weekend even though UTC still says Thursday",
  );

  // --- The combined alert window ----------------------------------------------------------------
  assert.equal(isSilenceAlertWindow(CAIRO_NOON), true, "working day + working hours = alertable");
  assert.equal(isSilenceAlertWindow(CAIRO_FRIDAY_NOON), false, "working hours on the weekend are still not alertable");
  assert.equal(isSilenceAlertWindow(CAIRO_MIDNIGHT_ISH), false, "a working day outside working hours is not alertable");

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
  // This used to pin the words "webhook subscription" - the detail told the reader to go and check
  // the subscription and callback URL by hand. Since 2026-08-23 the health check verifies both
  // itself (`fetchWebhookRouting`), so repeating that instruction would send someone to redo work
  // already done. The INTENT of the original assertion survives unchanged: the alert must still say
  // something the reader can act on, and must never imply a verification that did not happen.
  assert.match(silent.detail, /30h/, "the alert must name the gap it is reporting");
  assert.match(
    silent.detail,
    /could not be verified/,
    "with no routing answer the alert must say delivery config was NOT verified - never imply it was",
  );

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

  // --- Weekend silence is not an incident -------------------------------------------------------
  // The real 2026-07-31 false positive: the last CV arrived Wednesday 06:36 UTC and nothing came in
  // over the Egyptian weekend. With only the hours gate this logged the "not healthy" error on all
  // six cron ticks an hour for the whole ten-hour window — 120 errors across Thu+Fri — while every
  // Meta-side check passed. Nobody had sent a CV; the alert was measuring the weekend.
  const LAST_REAL_CV = new Date("2026-07-29T06:36:06.905Z"); // Wednesday
  const firstTickOf = (day: Date) => new Date(day.getTime() - 2 * 3_600_000 + 4 * 60_000); // 10:04 Cairo

  const quietSaturday = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: LAST_REAL_CV,
    now: firstTickOf(CAIRO_SATURDAY_NOON),
    silenceThresholdHours: 24,
  });
  assert.equal(quietSaturday.status, "ok", "72h of weekend quiet is normal, not an outage");
  assert.ok((quietSaturday.hoursSinceLastInbound ?? 0) > 24, "the gap is still measured, it just does not alert");

  const quietFriday = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: LAST_REAL_CV,
    now: firstTickOf(CAIRO_FRIDAY_NOON),
    silenceThresholdHours: 24,
  });
  assert.equal(quietFriday.status, "ok", "Friday is the other weekend day");

  // ...but the check must not simply be muted. The same gap on the first WORKING day still fires,
  // so a webhook that genuinely died on Thursday night is reported Sunday morning.
  const quietSunday = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: LAST_REAL_CV,
    now: firstTickOf(CAIRO_SUNDAY_NOON),
    silenceThresholdHours: 24,
  });
  assert.equal(quietSunday.status, "silent", "silence carried into a working day is a real signal");

  // Same instant against the threshold actually deployed in production (96h): 96.5h has elapsed,
  // so Sunday morning is exactly when it reports.
  const sundayAtDeployedThreshold = evaluateWhatsAppIntakeHealth({
    apiError: null,
    configured: true,
    lastInboundAt: LAST_REAL_CV,
    now: firstTickOf(CAIRO_SUNDAY_NOON),
    silenceThresholdHours: 96,
  });
  assert.equal(sundayAtDeployedThreshold.status, "silent");

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

  // --- isNumberSilent (per-line silence) --------------------------------------------------------
  // Catches a single line that goes quiet while others stay busy — a channel-wide check would miss it.
  assert.equal(
    isNumberSilent({ lastInboundAt: new Date(CAIRO_NOON.getTime() - 30 * 3_600_000), now: CAIRO_NOON, ok: true, thresholdHours: 24 }),
    true,
    "a healthy line silent 30h during business hours is flagged",
  );
  assert.equal(
    isNumberSilent({ lastInboundAt: null, now: CAIRO_NOON, ok: true, thresholdHours: 24 }),
    false,
    "no history on this line -> never a regression (a freshly-added line stays inert)",
  );
  assert.equal(
    isNumberSilent({ lastInboundAt: new Date(CAIRO_NOON.getTime() - 30 * 3_600_000), now: CAIRO_NOON, ok: false, thresholdHours: 24 }),
    false,
    "a DOWN line is api_unreachable, not silence — one incident reported once",
  );
  assert.equal(
    isNumberSilent({ lastInboundAt: new Date(CAIRO_MIDNIGHT_ISH.getTime() - 30 * 3_600_000), now: CAIRO_MIDNIGHT_ISH, ok: true, thresholdHours: 24 }),
    false,
    "silence outside Cairo business hours is normal",
  );
  assert.equal(
    isNumberSilent({ lastInboundAt: new Date(CAIRO_NOON.getTime() - 23 * 3_600_000), now: CAIRO_NOON, ok: true, thresholdHours: 24 }),
    false,
    "just under the threshold is still fine",
  );
  // Per-line silence carries the same weekend gate as the channel-wide one, or a quiet weekend
  // would page per number instead of once.
  assert.equal(
    isNumberSilent({
      lastInboundAt: new Date(CAIRO_SATURDAY_NOON.getTime() - 30 * 3_600_000),
      now: CAIRO_SATURDAY_NOON,
      ok: true,
      thresholdHours: 24,
    }),
    false,
    "a line quiet over the Egyptian weekend is normal",
  );
  assert.equal(
    isNumberSilent({
      lastInboundAt: new Date(CAIRO_SUNDAY_NOON.getTime() - 30 * 3_600_000),
      now: CAIRO_SUNDAY_NOON,
      ok: true,
      thresholdHours: 24,
    }),
    true,
    "the same 30h gap on a working day is still flagged",
  );

  // --- WhatsApp auto-reply gate (OFF by default) ------------------------------------------------
  // Outbound messaging drives quality rating, so acknowledgement ships dormant: it must be inert
  // unless the flag AND an approved template AND a token are all present.
  const savedEnabled = process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED;
  const savedTemplate = process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE;
  const savedLang = process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_LANG;
  const savedToken = process.env.WHATSAPP_ACCESS_TOKEN;
  try {
    delete process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED;
    delete process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE;
    delete process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_LANG;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    assert.equal(autoReplyConfig().enabled, false, "default is OFF");
    assert.equal(autoReplyConfig().languageCode, "en", "language defaults to en");
    assert.equal(isWhatsAppAutoReplyEnabled(), false, "nothing configured -> inert");

    process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED = "true";
    assert.equal(isWhatsAppAutoReplyEnabled(), false, "flag on but no template/token -> still inert");

    process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE = "cv_received";
    assert.equal(isWhatsAppAutoReplyEnabled(), false, "template but no token -> still inert");

    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    process.env.RECRUITMENT_WHATSAPP_AUTOREPLY_LANG = "ar";
    assert.equal(isWhatsAppAutoReplyEnabled(), true, "flag + template + token -> enabled");
    assert.equal(autoReplyConfig().languageCode, "ar");
    assert.equal(autoReplyConfig().templateName, "cv_received");
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED", savedEnabled);
    restore("RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE", savedTemplate);
    restore("RECRUITMENT_WHATSAPP_AUTOREPLY_LANG", savedLang);
    restore("WHATSAPP_ACCESS_TOKEN", savedToken);
  }
}

// ===================================================================================================
// Webhook ROUTING — the deterministic check that replaced silence as the thing that pages.
//
// Why this exists: on 2026-08-23 the "no inbound for 96h" alert was firing on production while every
// layer was verifiably healthy - number CONNECTED, callback URL correct, `messages` subscribed, our
// endpoint answering 403/401 correctly, the intake queue holding zero failures. Measured on the same
// data, this channel's normal inbound gap has reached 333 hours. A 96-hour threshold therefore fires
// during ordinary quiet weeks (it did, for ~10 consecutive days in early August) and so cannot
// signal an outage at all. These tests pin the replacement: facts about how Meta is configured now.
// ===================================================================================================

/** Exactly what Meta returned for this app on 2026-08-23, so a drift in the expected URL fails here. */
const LIVE_PRODUCTION_SUBSCRIPTION = {
  active: true,
  callback_url: "https://phoenix-hr.satopharma.com/api/webhooks/whatsapp",
  fields: [
    { name: "account_alerts" },
    { name: "account_review_update" },
    { name: "account_update" },
    { name: "calls" },
    { name: "message_template_quality_update" },
    { name: "message_template_status_update" },
    { name: "messages" },
    { name: "phone_number_name_update" },
    { name: "phone_number_quality_update" },
    { name: "security" },
  ],
};

export function runWhatsAppWebhookRoutingTests() {
  const expectedCallbackUrl = expectedWebhookUrl();

  // --- the URL we expect Meta to hold ------------------------------------------------------------
  assert.equal(
    expectedCallbackUrl,
    "https://phoenix-hr.satopharma.com/api/webhooks/whatsapp",
    "the expected callback must be the ONE configured production URL plus the webhook route's own path",
  );

  // --- normalization: a cosmetic difference must never be reported as an outage -------------------
  assert.equal(normalizeCallbackUrl("https://EXAMPLE.com/hook/"), "https://example.com/hook");
  assert.equal(normalizeCallbackUrl("https://example.com/hook"), "https://example.com/hook");
  assert.equal(normalizeCallbackUrl(null), null);
  assert.equal(normalizeCallbackUrl("   "), null);
  assert.equal(
    normalizeCallbackUrl("https://example.com/hook///"),
    "https://example.com/hook",
    "repeated trailing slashes are still the same endpoint",
  );

  // --- the configuration production ACTUALLY has today must read as healthy -----------------------
  {
    const routing = evaluateWebhookRouting({
      answerable: true,
      expectedCallbackUrl,
      numberOverrideUrl: "https://phoenix-hr.satopharma.com/api/webhooks/whatsapp",
      subscription: LIVE_PRODUCTION_SUBSCRIPTION,
    });
    assert.equal(routing.ok, true, "the live production webhook configuration must evaluate as healthy");
    assert.deepEqual(routing.problems, []);
    assert.equal(routing.messagesSubscribed, true);
    assert.equal(routing.active, true);
  }

  // --- unanswerable is NOT unhealthy --------------------------------------------------------------
  {
    const routing = evaluateWebhookRouting({
      answerable: false,
      expectedCallbackUrl,
      numberOverrideUrl: null,
      subscription: null,
    });
    assert.equal(routing.ok, null, "no app secret / Graph unreachable must be null, never false");
    assert.deepEqual(routing.problems, [], "an unanswerable check must not invent a problem to report");
  }

  // --- each real failure mode is caught, and NAMED ------------------------------------------------
  const failing: Array<{ label: string; input: Parameters<typeof evaluateWebhookRouting>[0]; match: RegExp }> = [
    {
      input: { answerable: true, expectedCallbackUrl, numberOverrideUrl: null, subscription: null },
      label: "no subscription at all",
      match: /no whatsapp_business_account webhook subscription/i,
    },
    {
      input: {
        answerable: true,
        expectedCallbackUrl,
        numberOverrideUrl: null,
        subscription: { ...LIVE_PRODUCTION_SUBSCRIPTION, active: false },
      },
      label: "Meta disabled the subscription",
      match: /DISABLED/,
    },
    {
      input: {
        answerable: true,
        expectedCallbackUrl,
        numberOverrideUrl: null,
        subscription: {
          ...LIVE_PRODUCTION_SUBSCRIPTION,
          fields: LIVE_PRODUCTION_SUBSCRIPTION.fields.filter((field) => field.name !== "messages"),
        },
      },
      label: "the messages field is gone",
      match: /"messages" webhook field is not subscribed/,
    },
    {
      input: {
        answerable: true,
        expectedCallbackUrl,
        numberOverrideUrl: null,
        subscription: { ...LIVE_PRODUCTION_SUBSCRIPTION, callback_url: "https://someone-elses-app.example.com/hook" },
      },
      label: "callback URL points elsewhere",
      match: /callback URL is https:\/\/someone-elses-app\.example\.com\/hook/,
    },
    {
      input: {
        answerable: true,
        expectedCallbackUrl,
        numberOverrideUrl: "https://stale-preview.up.railway.app/api/webhooks/whatsapp",
        subscription: LIVE_PRODUCTION_SUBSCRIPTION,
      },
      label: "a per-number override silently reroutes every message",
      match: /own webhook override points at https:\/\/stale-preview\.up\.railway\.app/,
    },
  ];
  for (const scenario of failing) {
    const routing = evaluateWebhookRouting(scenario.input);
    assert.equal(routing.ok, false, `${scenario.label}: must be reported as broken`);
    assert.ok(
      routing.problems.some((problem) => scenario.match.test(problem)),
      `${scenario.label}: the problem must be NAMED, not merely counted - got ${JSON.stringify(routing.problems)}`,
    );
  }

  // A matching override is not a problem - this must not fire merely because an override exists.
  assert.equal(
    evaluateWebhookRouting({
      answerable: true,
      expectedCallbackUrl,
      numberOverrideUrl: "https://phoenix-hr.satopharma.com/api/webhooks/whatsapp/",
      subscription: LIVE_PRODUCTION_SUBSCRIPTION,
    }).ok,
    true,
    "an override that matches (bar a trailing slash) is correct configuration, not a fault",
  );

  // --- precedence inside the health verdict -------------------------------------------------------
  const silentFor = (hours: number) => new Date(CAIRO_NOON.getTime() - hours * 60 * 60 * 1000);
  const broken = evaluateWebhookRouting({
    answerable: true,
    expectedCallbackUrl,
    numberOverrideUrl: null,
    subscription: { ...LIVE_PRODUCTION_SUBSCRIPTION, active: false },
  });
  const healthy = evaluateWebhookRouting({
    answerable: true,
    expectedCallbackUrl,
    numberOverrideUrl: null,
    subscription: LIVE_PRODUCTION_SUBSCRIPTION,
  });

  // Misrouting EXPLAINS the silence, so it is what gets reported - the actionable fact wins.
  assert.equal(
    evaluateWhatsAppIntakeHealth({
      apiError: null,
      configured: true,
      lastInboundAt: silentFor(200),
      now: CAIRO_NOON,
      routing: broken,
      silenceThresholdHours: 96,
    }).status,
    "webhook_misrouted",
    "a broken route outranks the silence it causes",
  );

  // Dead credentials outrank everything: one incident, one alert.
  assert.equal(
    evaluateWhatsAppIntakeHealth({
      apiError: "API access blocked",
      configured: true,
      lastInboundAt: silentFor(200),
      now: CAIRO_NOON,
      routing: broken,
      silenceThresholdHours: 96,
    }).status,
    "api_unreachable",
    "a credential block still outranks a routing fault",
  );

  // THE REGRESSION THIS SHIPS FOR: healthy routing plus a long quiet spell is quiet, not broken.
  {
    const verdict = evaluateWhatsAppIntakeHealth({
      apiError: null,
      configured: true,
      lastInboundAt: silentFor(333),
      now: CAIRO_NOON,
      routing: healthy,
      silenceThresholdHours: 96,
    });
    assert.equal(verdict.status, "silent", "a verified-healthy route that is merely quiet is 'silent'");
    assert.notEqual(
      verdict.status,
      "webhook_misrouted",
      "333h of measured-normal quiet must never be reported as a misconfiguration",
    );
    assert.equal(verdict.routing?.ok, true, "and the verdict must carry the proof that the route WAS checked");
  }

  // An unanswerable routing check must not change the outcome either way.
  assert.equal(
    evaluateWhatsAppIntakeHealth({
      apiError: null,
      configured: true,
      lastInboundAt: silentFor(10),
      now: CAIRO_NOON,
      routing: null,
      silenceThresholdHours: 96,
    }).status,
    "ok",
    "no routing answer plus recent inbound is still plainly ok",
  );
}

// ===================================================================================================
// PUBLIC REACH — the check that measures whether applicants actually GOT THROUGH.
//
// Why this exists: on 2026-08-23 every configuration check in this module passed — number CONNECTED,
// subscription active, `messages` subscribed, callback URL correct, per-number override correct —
// while the public channel had been shut for 25 days. The advertised number was a normal WhatsApp
// Business handset that is not on the Cloud API at all, so applicants' CVs sat on a phone and
// entered the ATS only when a human forwarded a batch. Config was flawless and irrelevant: it can
// prove Meta is WILLING to call us, never that anybody arrived.
//
// The contrast with email is what makes this measurable. Email is an independent transport with no
// Meta dependency, so "nobody reached WhatsApp" and "149 different people emailed a CV" together
// mean something neither says alone.
// ===================================================================================================

export function runWhatsAppPublicReachTests() {
  const reach = (over: Partial<WhatsAppPublicReach> = {}): WhatsAppPublicReach => ({
    directDeliveryExpected: true,
    emailSenders: 40,
    outsideSenders: 0,
    windowHours: 96,
    ...over,
  });
  const hoursAgo = (hours: number) => new Date(CAIRO_NOON.getTime() - hours * 60 * 60 * 1000);
  const verdict = (
    r: WhatsAppPublicReach | null,
    extra: { apiError?: string | null; routing?: ReturnType<typeof evaluateWebhookRouting> | null; lastInboundHoursAgo?: number } = {},
  ) =>
    evaluateWhatsAppIntakeHealth({
      apiError: extra.apiError ?? null,
      configured: true,
      lastInboundAt: hoursAgo(extra.lastInboundHoursAgo ?? 200),
      now: CAIRO_NOON,
      reach: r,
      routing: extra.routing ?? null,
      silenceThresholdHours: 96,
    });

  // --- THE REGRESSION THIS SHIPS FOR ---------------------------------------------------------
  {
    const dead = verdict(reach());
    assert.equal(
      dead.status,
      "public_channel_dead",
      "applicants applying by email while NONE reached WhatsApp is an outage, however green the config",
    );
    assert.match(
      dead.detail,
      /40 different people sent a CV by email/,
      "the alert must carry the contrast that proves applicants exist - that is the whole evidence",
    );
    assert.equal(dead.reach?.outsideSenders, 0, "the verdict must carry the measurement it was based on");
  }

  // --- under MANUAL FORWARDING the very same numbers are correct, not an outage ----------------
  {
    const forwarding = verdict(reach({ directDeliveryExpected: false }));
    assert.notEqual(
      forwarding.status,
      "public_channel_dead",
      "while CVs arrive only by manual forwarding, zero outside senders is the DESIGN - paging on it would fire forever",
    );
    assert.equal(forwarding.status, "silent");
    assert.match(
      forwarding.detail,
      /nobody has forwarded a CV batch from the HR handset/,
      "silence on a forwarding channel must name the actual cause, not restate the gap",
    );
  }

  // --- nobody applying ANYWHERE is a quiet week, not a broken channel --------------------------
  assert.notEqual(
    verdict(reach({ emailSenders: 0 })).status,
    "public_channel_dead",
    "with both transports quiet this is a holiday or a hiring pause - the contrast is what makes it an outage",
  );
  assert.notEqual(
    verdict(reach({ emailSenders: 4 })).status,
    "public_channel_dead",
    "a trickle below the contrast floor is not proof that applicants are trying",
  );
  assert.equal(
    verdict(reach({ emailSenders: 5 })).status,
    "public_channel_dead",
    "at the floor the contrast is proven and it must fire",
  );

  // --- applicants getting through is plainly ok -------------------------------------------------
  assert.equal(
    verdict(reach({ outsideSenders: 12 }), { lastInboundHoursAgo: 1 }).status,
    "ok",
    "a channel real applicants are reaching is healthy",
  );

  // --- precedence: one incident, one alert -------------------------------------------------------
  assert.equal(
    verdict(reach(), { apiError: "API access blocked" }).status,
    "api_unreachable",
    "dead credentials outrank an unreachable public channel - they already explain it",
  );
  assert.equal(
    verdict(reach(), {
      routing: evaluateWebhookRouting({
        answerable: true,
        expectedCallbackUrl: expectedWebhookUrl(),
        numberOverrideUrl: null,
        subscription: null,
      }),
    }).status,
    "webhook_misrouted",
    "a NAMED misconfiguration outranks the measurement, because it explains why nobody got through",
  );

  // --- an unmeasured reach must never invent an outage -------------------------------------------
  assert.equal(
    verdict(null).status,
    "silent",
    "when reach could not be measured the verdict must fall back, never fabricate public_channel_dead",
  );
}
