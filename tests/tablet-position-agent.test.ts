import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { POST as helloPost } from "../app/api/devices/positions/hello/route.ts";
import { POST as reportPost } from "../app/api/devices/positions/route.ts";
import {
  bindPositionAgent,
  hashAgentToken,
  listAgentFixes,
  parseReportedFixes,
  readAgentText,
  readInstallId,
  readIntroduction,
  readPermission,
  revokePositionAgent,
  toPositionAgent,
  PositionAgentError,
  POSITION_BATCH_MAX,
  POSITION_MAX_AGE_MS,
  POSITION_MAX_SKEW_MS,
} from "../src/lib/devices/positions/agents.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments } from "./support/comment-strip.ts";
import { withPostgrestStandIn, writesTo, type StandIn } from "./support/postgrest-stand-in.ts";

/**
 * The Phoenix Position agent — the small Android app on a rep tablet that posts where the tablet is
 * straight to Phoenix, needing neither the tablet server nor a premium plugin.
 *
 * 🔴 AN INSTALL IS NOT A TABLET, AND THAT IS THE WHOLE SECURITY MODEL. A tablet's Headwind
 * configuration is world-readable, so nothing long-lived may be provisioned into the app: it mints
 * its own install id, says hello, and Phoenix hands back a token ONCE. An install nobody has bound is
 * INERT — its positions are kept but belong to no tablet and no rep — so what a stranger's hello buys
 * is nothing. These tests hold that door shut, and hold the trail honest about what it does not know.
 */

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const INSTALL = "7b1f4c22-9d3e-4a15-8c77-2f0e5a9b6d41";
const OTHER_INSTALL = "2c9a7e14-5b6d-4f08-9a23-1e7c4d8b5f60";

function runPureTests() {
  // ── Install ids ───────────────────────────────────────────────────────────────────────────────────
  assert.equal(readInstallId(INSTALL.toUpperCase()), INSTALL, "an id is read whatever its casing, and kept lower-case");
  assert.equal(readInstallId(` ${INSTALL} `), INSTALL, "and through the whitespace a client adds");
  for (const rubbish of ["", "not-an-id", INSTALL.slice(0, -1), 42, null, undefined, {}, [INSTALL]]) {
    assert.equal(readInstallId(rubbish), null, `${JSON.stringify(rubbish)} is not an install id`);
  }
  // 🔴 AN INSTALL ID IS THE ONLY THING A HELLO MUST CARRY, and a body without one is refused by name —
  // never defaulted, because a defaulted id would make every tablet the same install.
  assert.throws(() => readIntroduction({}), PositionAgentError, "a hello with no install id is refused");
  assert.throws(() => readIntroduction({ installId: "nope" }), /Say which install this is/);
  assert.throws(() => readIntroduction(null), PositionAgentError, "and so is no body at all");

  // ── What the tablet says about itself ─────────────────────────────────────────────────────────────
  const introduction = readIntroduction({
    agentVersion: "1.0.0",
    androidId: "  a1b2c3d4e5f6  ",
    androidVersion: "14",
    installId: INSTALL,
    locationPermission: "FINE",
    manufacturer: "Lenovo",
    model: "TB328XU   TB328XU",
  });
  assert.equal(introduction.model, "TB328XU TB328XU", "runs of whitespace fold, so one model is one string");
  assert.equal(introduction.androidId, "a1b2c3d4e5f6");
  assert.equal(introduction.locationPermission, "fine");
  assert.equal(readAgentText("x".repeat(500), 24)?.length, 24, "a free-text fact is capped, never stored whole");
  assert.equal(readAgentText("   "), null, "and blank is absent, not an empty string");
  assert.equal(readAgentText(12345), null, "a number is not a fact the agent stated");

  // 🔴 NO PERMISSION IS NOT NO MOVEMENT, AND "DID NOT SAY" IS NOT "none". An agent that never mentions
  // the permission must read as unknown: defaulting it to "none" would print a tablet as un-permissioned
  // on the tablet page and send somebody to fix a permission that is already granted.
  assert.equal(readPermission("none"), "none");
  assert.equal(readPermission("background"), "background");
  assert.equal(readPermission(undefined), null, "🔴 unsaid is null — never 'none'");
  assert.equal(readPermission("granted"), null, "a word Android does not use is not read as one that is");
  assert.equal(readIntroduction({ installId: INSTALL }).locationPermission, null);

  // ── The token ────────────────────────────────────────────────────────────────────────────────────
  // 🔴 THE TOKEN IS STORED AS A HASH, NEVER AS ITSELF — the same rule as the screen-recording upload.
  const token = "a".repeat(64);
  assert.equal(hashAgentToken(token), createHash("sha256").update(token, "utf8").digest("hex"));
  assert.equal(hashAgentToken(token).length, 64, "which is what the table's own check constraint demands");
  assert.notEqual(hashAgentToken(token), token);
  const agents = stripComments(source("src/lib/devices/positions/agents.ts"));
  assert.match(agents, /timingSafeEqual/, "and the comparison is constant-time, so a token cannot be guessed a byte at a time");
  assert.doesNotMatch(agents, /token_hash:\s*token\b/, "the token itself is never written to the row");

  // ── The fixes a report carries ───────────────────────────────────────────────────────────────────
  const now = Date.UTC(2026, 10, 26, 2, 0, 0);
  const good = parseReportedFixes(
    [
      { accuracyM: 11.6, batteryLevel: 73, lat: 30.0444, lon: 31.2357, provider: "fused", ts: now - 60_000 },
      { accuracy: 9, battery: 70, latitude: 30.05, longitude: 31.24, recordedAtMs: Math.floor((now - 120_000) / 1000) },
    ],
    now,
  );
  assert.equal(good.fixes.length, 2, "both spellings of every field are read — the app and the launcher name them differently");
  assert.equal(good.fixes[0].accuracyM, 12, "accuracy is rounded to a metre");
  assert.equal(good.fixes[1].recordedAt, new Date(now - 120_000).toISOString(), "🔴 a seconds stamp is not read as 1970");
  assert.equal(good.rejected, 0);

  // 🔴 EVERY REASON A FIX IS DROPPED IS A REASON PHOENIX WOULD OTHERWISE DRAW A LINE THROUGH A PLACE
  // THE TABLET NEVER WAS — and each one is COUNTED, so a report of rubbish is never silence.
  const dropped = parseReportedFixes(
    [
      { lat: 0, lon: 0, ts: now },
      { lat: 95, lon: 31, ts: now },
      { lat: 30, lon: 999, ts: now },
      { lat: 30, lon: 31, ts: now + POSITION_MAX_SKEW_MS + 60_000 },
      { lat: 30, lon: 31, ts: now - POSITION_MAX_AGE_MS - 60_000 },
      { lat: 30, ts: now },
      { lat: "thirty", lon: 31, ts: now },
      null,
      "not a fix",
    ],
    now,
  );
  assert.deepEqual(dropped.fixes, [], "Null Island, an impossible pair, a clock out of range and a half-written row are all refused");
  assert.equal(dropped.rejected, 9, "and every one of them is counted back to the agent");
  assert.deepEqual(parseReportedFixes("not a list"), { fixes: [], rejected: 0 }, "a body in a shape Phoenix cannot read is no fixes, never a throw");

  // A clock inside the allowance is believed: a tablet's own clock is minutes out, not days.
  assert.equal(parseReportedFixes([{ lat: 30, lon: 31, ts: now + 60_000 }], now).fixes.length, 1);

  // 🔴 A MOCKED POSITION IS KEPT AND MARKED, NEVER DROPPED — the fake-location mark is evidence in
  // itself, and deleting the row hides what happened.
  const mocked = parseReportedFixes([{ lat: 30, lon: 31, mock: true, ts: now }], now);
  assert.equal(mocked.fixes.length, 1);
  assert.equal(mocked.fixes[0].mock, true);
  assert.equal(mocked.rejected, 0);

  // The batch cap, and what is over it: counted, not quietly forgotten.
  const flood = parseReportedFixes(
    Array.from({ length: POSITION_BATCH_MAX + 5 }, (_unused, index) => ({ lat: 30 + index / 10_000, lon: 31, ts: now - index * 1000 })),
    now,
  );
  assert.equal(flood.fixes.length, POSITION_BATCH_MAX);
  assert.equal(flood.rejected, 5, "the fixes past the cap are reported, so the agent knows to send them again");

  // A row as the database holds it, as a screen reads it — and the token is not part of it.
  const row = toPositionAgent({
    agent_version: "1.0.0",
    android_id: "a1",
    android_version: "14",
    bound_at: "2026-11-26T02:30:00.000Z",
    bound_by_hr_id: "B-10",
    device_number: "PHX-TAB-0007",
    first_seen_at: "2026-11-26T02:00:00.000Z",
    fixes_received: "12",
    install_id: INSTALL,
    last_fix_at: "2026-11-26T02:29:00.000Z",
    last_seen_at: "2026-11-26T02:30:00.000Z",
    location_permission: "fine",
    manufacturer: "Lenovo",
    model: "TB328XU",
    revoked_at: null,
    revoked_reason: null,
    token_hash: "f".repeat(64),
  });
  assert.equal(row.fixesReceived, 12, "a bigint arrives as a string and is still a number here");
  assert.equal(row.deviceNumber, "PHX-TAB-0007");
  assert.equal(JSON.stringify(row).includes("f".repeat(64)), false, "🔴 and nothing a screen reads carries the token hash");
}

/**
 * The two doors, and the desk jobs behind them, driven end to end against the SHARED in-memory
 * PostgREST (`tests/support/postgrest-stand-in.ts`).
 *
 * 🔴 NO TEST TOUCHES THE REAL DATABASE, AND NO SUITE BRINGS ITS OWN STAND-IN. `pnpm run test` runs
 * with `--env-file-if-exists=.env.local`, which points at PRODUCTION; `withPostgrestStandIn` points
 * the real admin client at memory, refuses every socket and every other host, and puts it all back.
 * The first version of this suite stood up its own HTTP server, which honoured only the filters it had
 * been written for — so `bindPositionAgent`'s back-stamp could be broken with the suite still green.
 */
async function runDoorTests() {
  let rateAllowed = true;
  let positionInsertError: { code: string; message: string } | null = null;

  const standIn: StandIn = {
    failWrites: {
      device_positions: () => (positionInsertError ? { body: positionInsertError, status: 400 } : null),
    },
    rpc: {
      api_rate_limit_consume: () => [{ allowed: rateAllowed, retry_after_seconds: rateAllowed ? 0 : 30 }],
    },
    tables: { device_position_agents: [], device_positions: [] },
  };
  /** The two tables, as the code has left them. */
  const installRows = () => standIn.tables.device_position_agents ?? [];
  const installRow = (id: string) => installRows().find((row) => row.install_id === id);
  const positions = () => standIn.tables.device_positions ?? [];

  const hello = (body: unknown, address = "41.33.1.1") =>
    new Request("https://phoenix.test/api/devices/positions/hello", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-forwarded-for": address },
      method: "POST",
    });
  const report = (body: unknown, token: string | null, address = "41.33.1.2") =>
    new Request("https://phoenix.test/api/devices/positions", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": address,
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      method: "POST",
    });

  await withPostgrestStandIn(standIn, async (seen) => {
    // ── 1. refused before anything is read ───────────────────────────────────────────────────────────
    assert.equal((await reportPost(report({ installId: INSTALL, fixes: [] }, null))).status, 401, "a report with no bearer is refused");
    assert.equal(
      (await reportPost(report({ installId: INSTALL, fixes: [] }, "   "))).status,
      401,
      "and a blank bearer is no bearer, never an empty match against an empty hash",
    );
    const badJson = await helloPost(
      new Request("https://phoenix.test/api/devices/positions/hello", { body: "{not json", headers: { "x-forwarded-for": "41.33.1.3" }, method: "POST" }),
    );
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, "invalid_json");
    assert.equal((await helloPost(hello({ model: "TB328XU" }))).status, 400, "a hello with no install id gets no row and no token");
    assert.equal(installRows().length, 0, "🔴 and nothing was written for any of them");

    // ── 2. the hello mints exactly once ─────────────────────────────────────────────────────────────
    const enrolled = await helloPost(hello({ agentVersion: "1.0.0", installId: INSTALL, locationPermission: "fine", model: "TB328XU" }));
    assert.equal(enrolled.status, 201, "a first hello is an enrolment");
    const minted = (await enrolled.json()) as { bound: boolean; deviceNumber: string | null; status: string; token: string | null };
    assert.equal(minted.status, "enrolled");
    assert.equal(typeof minted.token, "string");
    assert.equal(minted.token?.length, 64, "the token is 32 bytes of hex");
    assert.equal(minted.bound, false, "🔴 and a new install is UNBOUND — it belongs to no tablet and no rep");
    assert.equal(minted.deviceNumber, null);
    assert.equal(installRow(INSTALL)?.token_hash, hashAgentToken(minted.token as string), "the row holds the hash, never the token");

    // 🔴 A SECOND HELLO FOR A KNOWN INSTALL MINTS NOTHING. If it did, anyone who learned an install id
    // could ask for that install's token and start writing a real tablet's trail.
    const second = await helloPost(hello({ agentVersion: "1.0.1", installId: INSTALL }));
    assert.equal(second.status, 200, "a second hello is not an enrolment");
    const again = (await second.json()) as { status: string; token: string | null };
    assert.equal(again.status, "known");
    assert.equal(again.token, null, "🔴 and it hands back NO token");
    assert.equal(installRow(INSTALL)?.token_hash, hashAgentToken(minted.token as string), "the stored hash is untouched");
    assert.equal(installRow(INSTALL)?.agent_version, "1.0.1", "what it did take is the version the app now runs");
    assert.equal(
      installRow(INSTALL)?.location_permission,
      "fine",
      "🔴 and a hello that says nothing about the permission never erases what the last one said",
    );

    // ── 3. the report ───────────────────────────────────────────────────────────────────────────────
    const token = minted.token as string;
    const nowMs = Date.now();
    const batch = {
      fixes: [
        { accuracyM: 10, batteryLevel: 80, lat: 30.0444, lon: 31.2357, provider: "fused", ts: nowMs - 120_000 },
        { accuracyM: 14, batteryLevel: 79, lat: 30.0455, lon: 31.2366, provider: "gps", ts: nowMs - 60_000 },
        { lat: 0, lon: 0, ts: nowMs },
      ],
      installId: INSTALL,
      locationPermission: "fine",
    };
    const stored = await reportPost(report(batch, token));
    assert.equal(stored.status, 200);
    const result = (await stored.json()) as { bound: boolean; deviceNumber: string | null; rejected: number; stored: number };
    assert.equal(result.stored, 2);
    assert.equal(result.rejected, 1, "the Null Island row is reported as refused, not silently absent");
    assert.equal(result.bound, false, "🔴 the positions are KEPT while the install is unbound — they just belong to no tablet");
    assert.equal(positions().length, 2);
    // Each row is stored with NO tablet number, to be stamped at the bind. (`?? null` because the
    // stand-in holds exactly the columns the code sent, where the real table has the column with a
    // null default — an absent key and a null are the same fact here, and a stamped number is not.)
    assert.ok(
      positions().every((row) => (row.device_number ?? null) === null),
      "so each row is stored with no tablet number, to be stamped at the bind",
    );
    assert.equal(Number(installRow(INSTALL)?.fixes_received), 2, "the install's counter moves by what was really stored");
    assert.equal(installRow(INSTALL)?.last_fix_at, new Date(nowMs - 60_000).toISOString(), "and last_fix_at is the NEWEST fix's own time");

    // 🔴 A RE-SENT BATCH IS FREE. The agent cannot tell a lost reply from a refusal, so it sends again.
    const resent = await reportPost(report(batch, token));
    assert.equal(resent.status, 200);
    assert.equal(((await resent.json()) as { stored: number }).stored, 0, "the second copy stores nothing");
    assert.equal(positions().length, 2, "🔴 and the trail is not doubled");
    assert.equal(Number(installRow(INSTALL)?.fixes_received), 2, "nor is the count");

    // An empty report is a heartbeat: it still says the agent is alive and what its permission is.
    const patchesBefore = writesTo(seen, "device_position_agents").filter((entry) => entry.method === "PATCH").length;
    const heartbeat = await reportPost(report({ fixes: [], installId: INSTALL, locationPermission: "none" }, token));
    assert.equal(heartbeat.status, 200);
    assert.equal(((await heartbeat.json()) as { stored: number }).stored, 0);
    assert.equal(
      writesTo(seen, "device_position_agents").filter((entry) => entry.method === "PATCH").length,
      patchesBefore + 1,
      "it touches the install",
    );
    assert.equal(installRow(INSTALL)?.location_permission, "none", "🔴 and 'Android gave me no permission' is recorded as the agent's own word");
    assert.equal(installRow(INSTALL)?.last_fix_at, new Date(nowMs - 60_000).toISOString(), "while last_fix_at stays the last REAL fix");

    // ── 4. what the token is worth, and what it is not ──────────────────────────────────────────────
    // 🔴 AN UNKNOWN INSTALL AND A WRONG TOKEN ANSWER THE SAME 401 — any difference would tell a caller
    // which install ids exist, and an install id is the one thing an attacker could learn.
    const wrongToken = await reportPost(report({ fixes: [], installId: INSTALL }, "b".repeat(64)));
    const unknownInstall = await reportPost(report({ fixes: [], installId: OTHER_INSTALL }, token));
    assert.equal(wrongToken.status, 401);
    assert.equal(unknownInstall.status, 401);
    assert.deepEqual(await wrongToken.json(), await unknownInstall.json(), "🔴 the same answer, word for word");
    assert.equal(positions().length, 2, "and neither wrote a position");

    // A token of the wrong shape cannot match by accident — the compare is length-checked first.
    assert.equal((await reportPost(report({ fixes: [], installId: INSTALL }, "short"))).status, 401);

    // ── 5. the desk: whose tablet is this install? ─────────────────────────────────────────────────
    // 🔴 THE BIND STAMPS THE FIXES THE INSTALL ALREADY SENT. Nothing on the tablet says which tablet it
    // is (the app is silent by the golden rule), so an install reports for days before anybody claims
    // it. Without the back-stamp those days read as a tablet that never moved.
    const unbound = await listAgentFixes("PHX-TAB-0007");
    assert.deepEqual(unbound, { error: null, fixes: [] }, "before the bind the tablet's own trail is empty");
    const bound = await bindPositionAgent({ actor: "B-10", deviceNumber: "PHX-TAB-0007", installId: INSTALL });
    assert.equal(bound.deviceNumber, "PHX-TAB-0007");
    assert.equal(bound.boundByHrId, "B-10", "and the row says who said so");
    const trail = await listAgentFixes("PHX-TAB-0007");
    assert.equal(trail.error, null);
    assert.equal(trail.fixes.length, 2, "🔴 both fixes it sent BEFORE the bind are now that tablet's");
    assert.equal(trail.fixes[0]?.recordedAt, new Date(nowMs - 60_000).toISOString(), "newest first, as the tablet page draws it");
    assert.ok(
      writesTo(seen, "audit_logs").some((entry) => JSON.stringify(entry.body).includes("tablet_position_agent")),
      "and the bind is an audited act",
    );

    // 🔴 ONE LIVE INSTALL PER TABLET — two installs claiming one tablet would draw two trails as one.
    await helloPost(hello({ installId: OTHER_INSTALL, model: "TB328XU" }));
    await assert.rejects(
      () => bindPositionAgent({ actor: "B-10", deviceNumber: "PHX-TAB-0007", installId: OTHER_INSTALL }),
      /already reporting through install/,
      "a tablet that already has a live install refuses a second, naming the one it has",
    );
    await assert.rejects(
      () => bindPositionAgent({ actor: "B-10", deviceNumber: "PHX-TAB-0007", installId: "11111111-2222-4333-8444-555555555555" }),
      /No install has said hello/,
      "and an install id nobody has used is a refusal, never a row minted by the bind",
    );

    // A revoked install is refused outright: that is how a lost or replaced tablet is silenced.
    const silenced = await revokePositionAgent({ actor: "B-10", installId: INSTALL, reason: "tablet replaced" });
    assert.equal(typeof silenced.revokedAt, "string");
    const revoked = await reportPost(report({ fixes: [{ lat: 30.1, lon: 31.3, ts: nowMs }], installId: INSTALL }, token));
    assert.equal(revoked.status, 403, "a revoked install is told so, apart from a wrong token");
    assert.equal(positions().length, 2, "and nothing it sends is stored");
    const revokedHello = await helloPost(hello({ installId: INSTALL }));
    assert.equal(((await revokedHello.json()) as { status: string; token: string | null }).status, "revoked");
    assert.equal(((await helloPost(hello({ installId: INSTALL }))).status === 200), true, "a revoked install's hello still mints no new token");
    await assert.rejects(
      () => bindPositionAgent({ actor: "B-10", deviceNumber: "PHX-TAB-0009", installId: INSTALL }),
      /taken out of service/,
      "a revoked install cannot be bound to another tablet either",
    );
    // 🔴 AND THE TABLET IS FREE AGAIN — a factory-reset tablet comes back as a NEW install id, which is
    // bound where the revoked one was, with its own trail stamped.
    const replacement = await bindPositionAgent({ actor: "B-10", deviceNumber: "PHX-TAB-0007", installId: OTHER_INSTALL });
    assert.equal(replacement.deviceNumber, "PHX-TAB-0007", "once the old install is out of service the new one takes the tablet");

    // ── 6. a door that fails, fails closed and says so ─────────────────────────────────────────────
    const live = installRow(INSTALL);
    if (live) {
      live.revoked_at = null;
      live.revoked_reason = null;
    }
    positionInsertError = { code: "XX000", message: "stand-in write failure" };
    const failed = await reportPost(report({ fixes: [{ lat: 30.2, lon: 31.4, ts: nowMs }], installId: INSTALL }, token));
    assert.equal(failed.status, 503, "🔴 a store that refuses is a 503 the agent will RETRY — never a 200 that loses the fix");
    positionInsertError = null;

    rateAllowed = false;
    const THIRD_INSTALL = "9f8e7d6c-5b4a-4938-8271-615243342516";
    const limitedHello = await helloPost(hello({ installId: THIRD_INSTALL }, "41.33.9.9"));
    const limitedReport = await reportPost(report({ fixes: [], installId: INSTALL }, token, "41.33.9.9"));
    assert.equal(limitedHello.status, 429, "both doors are metered per address");
    assert.equal(limitedReport.status, 429);
    assert.equal(limitedHello.headers.get("Retry-After"), "30", "and say when to come back, so the agent does not hammer");
    assert.equal(installRow(THIRD_INSTALL), undefined, "a metered hello enrols nothing");
    rateAllowed = true;
  });
}

/** The paperwork that makes the two doors reachable at all, and the table they write. */
function runPaperworkTests() {
  // 🔴 BOTH DOORS ARE CSRF-EXEMPT BY EXACT PATH, because an Android app sends no Origin and no cookie —
  // and the exemption is only safe because neither door reads a session.
  const proxy = stripComments(source("proxy.ts"));
  for (const path of ["/api/devices/positions", "/api/devices/positions/hello"]) {
    assert.match(
      proxy,
      new RegExp(`request\\.nextUrl\\.pathname === "${path.replace(/\//g, "\\/")}"`),
      `${path} is exempt from the proxy's POST origin check by its exact path`,
    );
  }
  for (const file of ["app/api/devices/positions/route.ts", "app/api/devices/positions/hello/route.ts"]) {
    const route = stripComments(source(file));
    assert.doesNotMatch(route, /resolveAccessContext|assertPermission|cookies\(\)/, `${file} reads no session — the token is the whole credential`);
    assert.match(route, /assertApiRateLimit/, `${file} is metered before it does anything`);
    assert.match(route, /rate_limit_unavailable/, `${file} fails CLOSED when the limiter cannot be read`);
  }
  // The token is checked before the body is used, and the answer never says which install ids exist.
  // 🔴 THE CALL, NOT THE IMPORT. `indexOf("recordAgentPositions")` finds the import at the top of the
  // file, which is before everything — the assertion passed on any order it was given.
  const reportRoute = stripComments(source("app/api/devices/positions/route.ts"));
  const readsToken = reportRoute.indexOf("= presentedToken(");
  const stores = reportRoute.indexOf("await recordAgentPositions(");
  assert.ok(readsToken > 0, "the handler reads the bearer through presentedToken()");
  assert.ok(stores > 0, "and stores through recordAgentPositions()");
  assert.ok(readsToken < stores, "the bearer is read before the positions are stored");

  // Both are registered as token doors, so the access-registry sweep knows they take no session.
  for (const path of ["/api/devices/positions", "/api/devices/positions/hello"]) {
    const entry = findAccessRegistryEntry(path, "POST");
    assert.ok(entry, `${path} is in the access registry`);
    assert.equal(entry?.pattern, path, "under its own exact pattern, so no blanket judges it");
    assert.equal(entry?.authMode, "machine-token", `${path} is a token door, never a session route`);
    assert.equal(entry?.permission, null, "there is no permission to hold — the caller is a tablet");
    assert.equal(entry?.csrf.required, false, "and its CSRF exemption is written down with its reason");
  }

  // 🔴 THE TABLES ARE SERVICE-ROLE ONLY, AND THE UNIQUE KEY IS WHAT MAKES A RE-SEND FREE.
  const migration = source("supabase/migrations/20261126021500_tablet_position_agents.sql");
  assert.match(migration, /alter table public\.device_position_agents enable row level security/);
  assert.match(migration, /alter table public\.device_positions enable row level security/);
  assert.match(migration, /revoke all on table public\.device_position_agents from public, anon, authenticated/);
  assert.match(migration, /revoke all on table public\.device_positions from public, anon, authenticated/);
  assert.doesNotMatch(migration, /grant (all|insert|update|delete)[^;]*to (anon|authenticated)/, "the browser roles get nothing on either table");
  assert.match(
    migration,
    /create unique index if not exists device_positions_one_per_fix\s+on public\.device_positions \(install_id, recorded_at, latitude, longitude\)/,
    "one row per fix per install — the key a re-sent batch lands on",
  );
  assert.match(
    migration,
    /create unique index if not exists device_position_agents_one_live_per_device[\s\S]*where device_number is not null and revoked_at is null/,
    "🔴 one LIVE install per tablet, so two installs can never both claim to be one tablet",
  );
  assert.match(migration, /device_positions_not_null_island check \(latitude <> 0 or longitude <> 0\)/, "Null Island cannot be stored even by hand");
  assert.match(migration, /char_length\(token_hash\) = 64/, "and a row can only hold a SHA-256, never a token");

  // The upsert in the code names that exact key — a drifted spelling would double every re-sent batch.
  const agents = stripComments(source("src/lib/devices/positions/agents.ts"));
  assert.match(agents, /onConflict: "install_id,recorded_at,latitude,longitude"/);
  assert.match(agents, /ignoreDuplicates: true/);

  // Binding and revoking are audited acts, under their own entity type.
  assert.match(agents, /entityType: "tablet_position_agent"/);
  // The CALLS, not the import line, which is a third mention of the same name.
  assert.equal((agents.match(/await writeRequiredAuditLog\(\{/g) ?? []).length, 2, "both the bind and the revoke write a row");
  assert.match(agents, /is\("revoked_at", null\)/, "and a tablet's live agent is the one that has not been revoked");
}

export async function runTabletPositionAgentTests() {
  runPureTests();
  await runDoorTests();
  runPaperworkTests();
}
