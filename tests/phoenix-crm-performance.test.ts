import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FLUSH_AT_EVENTS, FLUSH_EVERY_MS } from "../src/lib/phoenix-crm/touch-trail.ts";
import { DEVICE_CLOCK_GRACE_MS, deviceClockNote } from "../src/lib/phoenix-crm/touch-trail-reader.ts";
import { phoenixCrmModuleOfNotice } from "../src/lib/phoenix-crm/notice-badge-rules.ts";
import { phoenixCrmModulePath } from "../src/lib/phoenix-crm/modules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM performance audit, 2026-10-16 — the fixes that change HOW the module works without changing
 * anything a person reads.
 *
 *   1. A notice is delivered after the reply has gone, its deliveries side by side, the SFE Managers read
 *      once per notice — and the live-team gate a sender asks is still read fresh every time.
 *   2. The badges take the live teams from a minute-long copy that a Start or Stop clears at once.
 *   3. The settings are held 30 s and dropped by every save; the viewer is built once per page render.
 *   4. The bell does not poll a hidden tab; the template wording is held 30 s and dropped by its save.
 *   5. The touch trail flushes every 30 s, and the phone-clock line stays at the one minute it has meant.
 *   6. Small client repeats: the voice probe asks once per page, the photo's place-name lookup runs
 *      while the shutter reading is taken, and a written-up visit re-reads its own day.
 *
 * Most of these are pinned by SOURCE, because each one lives behind the database client or the browser.
 * Every source assertion reads comment-stripped text: the comments here quote the old shapes on purpose,
 * and an assertion a comment can satisfy is one that cannot fail.
 */

const code = (path: string) => stripComments(readFileSync(path, "utf8"));

/** The body of one top-level function, from its declaration to the next top-level declaration. */
function bodyOf(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  assert.ok(at !== -1, `could not find ${declaration}`);
  const rest = source.slice(at + declaration.length);
  const next = rest.search(/\n(?:export )?(?:async )?function |\nexport const |\nconst [A-Za-z_]+ = /);
  return next === -1 ? rest : rest.slice(0, next);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export function runPhoenixCrmPerformanceTests(): void {
  // ── 1. The notice leaves the request, and the sender's gate stays fresh ───────────────────────────────
  {
    const notifier = code("src/lib/phoenix-crm/server/notifications.ts");
    const notify = bodyOf(notifier, "export async function notifyPhoenixCrm(");
    assert.match(
      notify,
      /await afterResponse\(`phoenix_crm_notify:\$\{notice\.kind\}`, \(\) => sendPhoenixCrmNotice\(notice, isTest\)\);/,
      "a notice is handed to afterResponse, so the person who pressed Save never waits for its deliveries",
    );
    const send = bodyOf(notifier, "async function sendPhoenixCrmNotice(");
    assert.match(
      send,
      /await Promise\.all\(deliveries\.map\(\(delivery\) => deliver\(notice, delivery, isTest\)\)\);/,
      "the deliveries of one notice run side by side — each has its own recipients and idempotency key",
    );
    assert.doesNotMatch(send, /for \(const delivery of deliveries\)/, "and never one after another again");
    assert.match(send, /withSfeManagersReadOnce\(/, "the SFE Managers are read once per notice");
    assert.match(
      send,
      /const live = await loadLiveTeamSeatIds\(\);/,
      "a SENDER asks the live-team gate fresh — a team just stopped must not be told one more thing",
    );
    assert.doesNotMatch(notifier, /loadLiveTeamSeatIdsForDisplay/, "and never the badges' minute-long copy");

    const sfe = bodyOf(notifier, "export async function sfeManagerHrIds(");
    assert.match(sfe, /scope\.read \?\?= readSfeManagerHrIds\(\)/, "inside a notice, one read of the role is shared");
    assert.match(sfe, /return readSfeManagerHrIds\(\);/, "outside one, every caller reads the role itself");

    const deliver = bodyOf(notifier, "async function deliver(");
    assert.match(
      deliver,
      /delivery\.path \?\? phoenixCrmModulePath\(PHOENIX_CRM_PORTAL_PATH, delivery\.tab\)/,
      "a notice links straight to its module's page, not through the `?tab=` redirect",
    );
    for (const tab of ["team", "list", "plan", "visits", "forecast", "reports"] as const) {
      assert.equal(
        phoenixCrmModuleOfNotice(phoenixCrmModulePath("/employee-portals/field-crm", tab)),
        tab,
        `the badges still recognise a ${tab} notice by its new link`,
      );
    }
  }

  // ── 2. The badges' copy of the live teams, and the one writer that clears it ──────────────────────────
  {
    const badges = code("src/lib/phoenix-crm/server/unread-notices.ts");
    assert.match(badges, /loadLiveTeamSeatIdsForDisplay\(\)/, "the badges read the live teams from the display copy");
    assert.doesNotMatch(badges, /loadLiveTeamSeatIds\(\)/, "and not the sender's fresh read, every minute on every screen");

    const liveTeams = code("src/lib/phoenix-crm/server/live-teams.ts");
    const fresh = bodyOf(liveTeams, "export async function loadLiveTeamSeatIds(");
    assert.doesNotMatch(fresh, /getOrLoadShared/, "the sender's gate is never served from memory");
    const display = bodyOf(liveTeams, "export async function loadLiveTeamSeatIdsForDisplay(");
    assert.match(display, /getOrLoadShared\(LIVE_TEAMS_FOR_DISPLAY,/, "the display copy is the shared minute-long cache");
    assert.match(display, /return null;/, "an unreadable copy still fails open, as the fresh gate does");

    const starts = code("src/lib/crm/phoenix-team-starts-server.ts");
    const set = bodyOf(starts, "export async function setPhoenixTeamStart(");
    const savedAt = set.indexOf("throw new Error(`The team start could not be saved:");
    const forgetAt = set.indexOf("forgetLiveTeamsForDisplay();");
    assert.ok(forgetAt !== -1, "a Start or a Stop clears the badges' copy");
    assert.ok(forgetAt > savedAt, "only after the write has landed — a refused start changes nothing");
  }

  // ── 3. The settings are held and dropped; the viewer is built once per render ─────────────────────────
  {
    const settings = code("src/lib/phoenix-crm/server/settings.ts");
    const load = bodyOf(settings, "export async function loadPhoenixCrmConfig(");
    assert.match(load, /now - entry\.readAt >= CONFIG_TTL_MS/, "the config is held for CONFIG_TTL_MS");
    assert.match(load, /if \(held === fresh\) held = null;/, "a failed read is never held");
    assert.match(load, /return structuredClone\(await entry\.config\);/, "and every caller gets its own copy");
    assert.match(settings, /const CONFIG_TTL_MS = 30_000;/);
    for (const save of ["export async function saveSettings(", "export async function saveLineRollout(", "export async function saveRamadanOverride("]) {
      assert.match(bodyOf(settings, save), /forgetPhoenixCrmConfig\(\);/, `${save} drops the held config, so the next save reads the new value`);
    }
    assert.equal(
      count(bodyOf(settings, "export async function saveRamadanOverride("), "forgetPhoenixCrmConfig();"),
      2,
      "both branches of the Ramadan save — clearing an override and setting one — drop the held config",
    );

    const access = code("src/lib/phoenix-crm/server/access.ts");
    assert.match(access, /export const resolvePhoenixCrmViewer = cache\(buildPhoenixCrmViewer\);/, "the viewer is built once per page render");
  }

  // ── 4. The bell and the template wording ──────────────────────────────────────────────────────────────
  {
    const bell = code("src/components/layout/in-app-notifications-bell.tsx");
    assert.match(
      bell,
      /window\.setInterval\(\(\) => \{\s*if \(document\.visibilityState !== "hidden"\) load\(\);\s*\}, 60_000\)/,
      "a hidden tab skips its minute poll",
    );
    assert.match(bell, /document\.addEventListener\("visibilitychange", onVisible\);/, "and reads the moment it is shown again");
    assert.match(bell, /document\.removeEventListener\("visibilitychange", onVisible\);/, "and lets go of the listener on unmount");
    assert.match(bell, /Date\.now\(\) - lastLoadAt >= BELL_RETURN_GAP_MS/, "unless it read moments ago");

    const templates = code("src/lib/notifications/templates.ts");
    const load = bodyOf(templates, "async function loadTemplate(");
    assert.match(load, /now - entry\.readAt >= TEMPLATE_TTL_MS/, "the template rows are held for TEMPLATE_TTL_MS");
    assert.match(load, /if \(heldTemplates\.get\(key\) === fresh\) heldTemplates\.delete\(key\);/, "a failed read is never held");
    const telegram = code("src/lib/notifications/telegram-templates.ts");
    assert.match(telegram, /forgetNotificationTemplates\(\);/, "saving a template drops the held wording");

    const unread = code("src/lib/notifications/unread.ts");
    assert.match(unread, /\.in\("notification_event_id", chunk\)/, "the read-state lookup is asked in chunks");
    assert.doesNotMatch(unread, /\.in\("notification_event_id", ids\)/, "never one URL holding all 300 ids");
  }

  // ── 5. The touch trail's timer, and the phone-clock line it must not move ─────────────────────────────
  {
    assert.equal(FLUSH_EVERY_MS, 30_000, "a quiet screen files what it saw every 30 seconds");
    assert.equal(FLUSH_AT_EVENTS, 40, "a busy one still files at 40 events, as before");
    assert.equal(DEVICE_CLOCK_GRACE_MS, 60_000, "a phone is still called out past one minute, as it always was");
    assert.equal(deviceClockNote(FLUSH_EVERY_MS + 29_000), null, "thirty seconds of wait plus network is the flush, not the clock");
    assert.match(String(deviceClockNote(61_000)), /behind the server/, "past the minute, the phone's clock is named");

    const collector = code("src/components/phoenix-crm/touch-trail-collector.tsx");
    assert.match(collector, /if \(document\.visibilityState !== "visible"\) flush\("leaving"\);/, "hiding the page still files at once");
    assert.match(collector, /const onPageHide = \(\) => \{\s*record\(\{ kind: "hide" \}\);\s*flush\("leaving"\);/, "and so does leaving it");
  }

  // ── 6. Small client repeats ───────────────────────────────────────────────────────────────────────────
  {
    const speak = code("src/components/phoenix-crm/speak.tsx");
    assert.match(speak, /browser\.audio && transcriptionAnswer === null \? TRANSCRIBE_URL : null/, "the voice probe asks only while the answer is unknown");
    assert.match(speak, /if \(typeof probed === "boolean"\) transcriptionAnswer = probed;/, "and only a real answer is kept");

    const camera = code("src/components/phoenix-crm/live-photo-capture.tsx");
    const lookupAt = camera.indexOf("const stampLookup = fetchEvidenceLocation(LOCATION_ENDPOINT, usedFix.lat, usedFix.lon, null);");
    const shutterAt = camera.indexOf("const shutterFix = await readShutterFix();");
    assert.ok(lookupAt !== -1 && shutterAt !== -1, "the camera still looks up the place and takes the shutter reading");
    assert.ok(lookupAt < shutterAt, "the place-name lookup starts BEFORE the shutter reading is awaited, so the two waits overlap");
    // A second lookup only in the one case the early one was started for a reading the shutter then
    // overruled as a cold network guess (2026-10-22, photo-reading-rules.ts); every other photo waits
    // for the lookup already running.
    assert.match(camera, /const payload = stampFix === usedFix \? await stampLookup : /, "and the stamp waits for that same lookup");

    const panel = code("src/components/phoenix-crm/visit-detail-panel.tsx");
    assert.doesNotMatch(panel, /router\.refresh\(\)/, "the write-up never re-renders a page the Visits tab does not read");
    assert.match(panel, /onWrittenUp\(\);/, "it re-reads the day the visit sits in");
    const tab = code("src/components/phoenix-crm/visits-tab.tsx");
    assert.equal(count(tab, "onWrittenUp={detail.reload}"), 2, "both write-up doors — the card and the table row — hand it the day's reload");
  }

  // ── 7. The portal's manager name, one read ────────────────────────────────────────────────────────────
  {
    const service = code("src/lib/employee-portal/service.ts");
    assert.match(
      service,
      /\.select\("manager_hr_id, manager:manager_hr_id\(full_name,nickname\)"\)/,
      "the manager's name rides on the same read as the manager's id",
    );
  }
}
