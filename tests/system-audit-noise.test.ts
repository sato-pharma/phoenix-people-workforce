import assert from "node:assert/strict";

import { CROSS_ORIGIN_MASKED_DISPLAY } from "../src/lib/error-monitor/cross-origin-masked.ts";
import {
  APP_ERROR_NOISE_CLASSES,
  EXCLUDED_NOISE_CLASSES,
  classifyAppErrorNoise,
  hasAppFrame,
  isTestAccountRow,
  isThirdPartyOnly,
  thirdPartyScriptHost,
} from "../src/lib/system-audit/noise.ts";
import type { AppErrorEventRow } from "../src/lib/system-audit/signature.ts";

/**
 * Which app_error_events rows leave the System Audit, and which stay. Narrow on purpose: a filter
 * that hides a real fault is worse than the noise it removes, so each KEPT case below is as much a
 * rule as each excluded one.
 */

function row(overrides: Partial<AppErrorEventRow>): AppErrorEventRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-10-20T10:00:00.000Z",
    source: "client",
    hr_id: "B-10",
    login_id: "B-10",
    route: "/employee-portals/field-crm",
    message: "TypeError: Cannot read properties of undefined (reading 'items')",
    stack: null,
    environment: "production",
    ...overrides,
  };
}

const APP_FRAME = "Error: x\n    at Ab (https://phoenix-hr.satopharma.com/_next/static/chunks/app/page-1a2b.js:1:200)";
const OFF_APP_FRAME = "Error: x\n    at Ab (https://maps.googleapis.com/maps-api-v3/api/js/58/1/main.js:120:33)";

export function runSystemAuditNoiseTests() {
  // ── An ordinary failure is kept ────────────────────────────────────────────────────────────────
  assert.equal(classifyAppErrorNoise(row({})), null, "an ordinary production failure must be kept");

  // ── Environment: development leaves, NULL stays (older production rows carry none) ─────────────
  assert.equal(classifyAppErrorNoise(row({ environment: "development" })), "development");
  assert.equal(classifyAppErrorNoise(row({ environment: null })), null, "a NULL environment is a production row and must be kept");
  assert.equal(classifyAppErrorNoise(row({ environment: "staging" })), null);

  // ── The browser's masked placeholder: excluded with no frame of ours, kept with one ────────────
  assert.equal(classifyAppErrorNoise(row({ message: "Script error.", stack: null })), "masked_script_error");
  assert.equal(
    classifyAppErrorNoise(row({ message: "Script error.", stack: APP_FRAME })),
    null,
    "a masked error with one of OUR frames on its stack must be KEPT",
  );
  assert.equal(
    classifyAppErrorNoise(row({ message: "Script error.", stack: "boom\n\n— Component stack —\n    in VisitForm" })),
    null,
    "a masked error a React boundary named our component for must be KEPT",
  );
  // The reporter STORES the display text, never "Script error." — the shape of all 217 such rows on
  // production (31 Oct 2026). Eight of them reached the morning message as a Command Center fault.
  const CLIENT_CONTEXT_ONLY =
    "— Client context —\nseq=1 readyState=complete visibility=visible unloading=false sinceNavMs=23156 navType=navigate";
  assert.equal(
    classifyAppErrorNoise(row({ message: CROSS_ORIGIN_MASKED_DISPLAY, stack: CLIENT_CONTEXT_ONLY })),
    "masked_script_error",
    "the stored browser-injected-script text with no frame of ours must leave the System Audit like 'Script error.' does",
  );
  assert.equal(
    classifyAppErrorNoise(row({ message: CROSS_ORIGIN_MASKED_DISPLAY, stack: APP_FRAME })),
    null,
    "the stored text with one of OUR frames is still KEPT",
  );
  assert.equal(hasAppFrame(APP_FRAME), true);
  assert.equal(hasAppFrame(OFF_APP_FRAME), false);
  assert.equal(hasAppFrame(null), false);

  // ── Network: the browser's own words, client only ──────────────────────────────────────────────
  assert.equal(classifyAppErrorNoise(row({ message: "TypeError: Failed to fetch" })), "browser_network");
  assert.equal(classifyAppErrorNoise(row({ message: "Load failed" })), "browser_network");
  assert.equal(
    classifyAppErrorNoise(row({ source: "server", message: "TypeError: Failed to fetch" })),
    null,
    "a SERVER fetch failure is our call to a service failing — a real fault, kept",
  );
  assert.equal(classifyAppErrorNoise(row({ message: "Failed to fetch the visit list for B-10" })), null, "only the exact browser wording leaves");

  // ── Disconnects: exact messages only. "Connection closed." is a finding ────────────────────────
  assert.equal(classifyAppErrorNoise(row({ source: "server", message: "Aborted" })), "benign_disconnect");
  assert.equal(classifyAppErrorNoise(row({ source: "server", message: "The destination stream closed early." })), "benign_disconnect");
  assert.equal(
    classifyAppErrorNoise(row({ source: "server", message: "Connection closed." })),
    null,
    '"Connection closed." must be KEPT as a finding, never swallowed as a disconnect',
  );

  // ── Recovered by the app itself ────────────────────────────────────────────────────────────────
  assert.equal(classifyAppErrorNoise(row({ message: "Loading chunk 812 failed." })), "stale_deploy_chunk");
  assert.equal(classifyAppErrorNoise(row({ message: "ChunkLoadError: Failed to load chunk /_next/x.js" })), "stale_deploy_chunk");
  assert.equal(classifyAppErrorNoise(row({ message: "Error: invariant expected layout router to be mounted" })), "router_mount_recovered");

  // ── Test accounts are KEPT, flagged — the failure was real ─────────────────────────────────────
  assert.equal(classifyAppErrorNoise(row({ login_id: "TEST-B-10", hr_id: "B-10" })), "test_account");
  assert.equal(classifyAppErrorNoise(row({ login_id: "admin-HR", hr_id: null })), "test_account", "the health-check login is a test account");
  assert.equal(isTestAccountRow({ login_id: "admin-HR", hr_id: "B-10" }), false, "admin-HR linked to a person is that person");
  assert.equal(isTestAccountRow({ login_id: "journey-bot", hr_id: null }, { extraTestLoginIds: ["Journey-Bot"] }), true);
  assert.equal(isTestAccountRow({ login_id: "B-10", hr_id: "B-10" }), false);
  // An excluded class still wins over the test flag: a test account's masked placeholder is noise.
  assert.equal(classifyAppErrorNoise(row({ login_id: "TEST-B-10", message: "Script error." })), "masked_script_error");

  // ── The excluded set is every class but test_account ───────────────────────────────────────────
  assert.equal(EXCLUDED_NOISE_CLASSES.has("test_account"), false, "test_account must never leave the ledger");
  for (const noiseClass of APP_ERROR_NOISE_CLASSES) {
    if (noiseClass !== "test_account") assert.equal(EXCLUDED_NOISE_CLASSES.has(noiseClass), true, `${noiseClass} must be excluded`);
  }

  // ── Third-party scripts are KEPT, with their host named ────────────────────────────────────────
  assert.equal(classifyAppErrorNoise(row({ stack: OFF_APP_FRAME })), null, "an error inside a third-party script is kept");
  assert.equal(thirdPartyScriptHost(row({ stack: OFF_APP_FRAME })), "maps.googleapis.com");
  assert.equal(thirdPartyScriptHost(row({ stack: `${OFF_APP_FRAME}\n    at Cd (https://phoenix-hr.satopharma.com/_next/static/chunks/x.js:1:1)` })), null);
  assert.equal(thirdPartyScriptHost(row({ source: "server", stack: OFF_APP_FRAME })), null);
  assert.equal(isThirdPartyOnly(row({ stack: OFF_APP_FRAME })), true);
}
