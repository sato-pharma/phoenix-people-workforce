import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { cairoBusinessDay, VISIT_DAY_CUTOFF_HOURS } from "../src/lib/phoenix-crm/calendar.ts";
import { captureClientOf } from "../src/lib/phoenix-crm/server/capture-client.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a visit is never dated onto a visit day EARLIER than the one it arrived on.
 *
 * Two locked rules meet here, and the hole was in the gap between them:
 *
 *   🔒 THE VISIT DAY ENDS AT 02:00 CAIRO (owner, 2026-09-29) — "never a past or a future day".
 *   🔒 GOLDEN RULE #1 — the rep is never warned, refused or told a check exists. So the answer to an
 *      unusable time claim is to DROP it and date the visit at arrival, never to argue with him.
 *
 * ## What the 2026-10-02 audit found
 *
 * 1. **THE OFFLINE CLAIM — the real hole.** `offline-clock.ts` bounds a claimed elapsed time only
 *    from ABOVE (it cannot exceed the window the server brackets with its own two readings) and
 *    deliberately not from below, because a capture taken moments after anchoring is honest. Only
 *    the APP has an offline queue; nothing on the web ever sent an `offline` body or asked for an
 *    anchor. So in a browser that one-sidedness was the whole exploit: mint an anchor on Monday
 *    afternoon (`POST /api/phoenix-crm/time-anchor`, 60 an hour, good for 20 hours), post a visit on
 *    Tuesday with `offline: { anchorId, elapsedMs: 0 }`, and the visit is filed, counted and read as
 *    MONDAY's — a day whose plan is closed and whose figures have been read.
 *
 * 2. **PHOTO-SLOT DATING.** A visit that names `photoPath` is dated by its slot's ISSUE time, and a
 *    slot lives two hours; a `reusePlacePhoto` visit is dated by the place's own capture, which adds
 *    its thirty-minute window on top. Either can carry a save arriving at 02:30 back across 02:00
 *    onto the previous visit day.
 *
 * ## The two fixes, and the one thing that is deliberately NOT fixed
 *
 *   - A browser may not make the claim and may not take an anchor (`capture-client.ts`). Structural,
 *     not a tighter bound: the capability no web screen ever used is simply not there.
 *   - When the SLOT's time falls on an earlier visit day than the arrival's, the visit is dated at
 *     arrival instead — silently, `capture_source` 'server'.
 *   - **The offline anchor still dates a visit before its arrival, and must.** A capture at 19:00
 *     synced at 02:30 belongs to the 19:00 day; that is the entire feature. It earns the exemption
 *     twice: the server brackets the claim at both ends, and only the app can make it at all.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function sqlOf(path: string): string {
  return stripSqlComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/** The migration that defines a function LAST — the body the database actually runs. */
function lastDefinerOf(name: string): string {
  const files = readdirSync(new URL("supabase/migrations/", ROOT))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => sqlOf(`supabase/migrations/${file}`).includes(`create or replace function public.${name}(`));
  assert.ok(files.length > 0, `${name} is defined by some migration`);
  return files[files.length - 1];
}

/** One function's own text out of a migration — from its header to the first `$$;` that closes its body. */
function functionBodyOf(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is defined in this migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name}'s body closes with $$;`);
  return sql.slice(start, end);
}

/**
 * 🔴 The live `phoenix_crm_save_visit`, found by SORT ORDER rather than by a path written here.
 *
 * A pin naming a migration file is how a check quietly starts reading DEAD SQL: the text is still in
 * the file and the database stopped running it the day a later migration replaced it. Asking the
 * directory means the next session that replaces this function cannot leave this test green and
 * wrong — it either still holds or it fails by name.
 */
const SAVE_VISIT_DEFINER = `supabase/migrations/${lastDefinerOf("phoenix_crm_save_visit")}`;

/** The clamp, byte for byte as the function runs it. The model below is tied to this text. */
const CLAMP =
  "  if v_source = 'slot'\n" +
  "     and ((v_captured_at - interval '2 hours') at time zone 'Africa/Cairo')::date\n" +
  "       < ((now() - interval '2 hours') at time zone 'Africa/Cairo')::date then\n" +
  "    v_captured_at := now();\n" +
  "    v_source := 'server';\n" +
  "  end if;\n";

/**
 * The clamp, transcribed into the repo's own twin of that arithmetic (`cairoBusinessDay`, pinned
 * equal to the SQL's `(captured_at - interval '2 hours') at Cairo` by phoenix-crm-one-tap-visit).
 *
 * It is a MODEL, and it is only worth something because the block above is asserted byte-exact
 * against the live function and `VISIT_DAY_CUTOFF_HOURS` against the SQL's own interval. Without
 * both of those this would be a restatement of my own opinion.
 */
function slotDatedVisit(slotIssuedAt: string, arrivedAt: string): { capturedAt: string; visitDay: string; source: string } {
  const slot = new Date(slotIssuedAt);
  const arrival = new Date(arrivedAt);
  if (cairoBusinessDay(slot) < cairoBusinessDay(arrival)) {
    return { capturedAt: arrival.toISOString(), visitDay: cairoBusinessDay(arrival), source: "server" };
  }
  return { capturedAt: slot.toISOString(), visitDay: cairoBusinessDay(slot), source: "slot" };
}

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

const COOKIE = "phoenix_session=eyJhbGciOiJ.signed.token";
const BEARER = "Bearer eyJhbGciOiJ.signed.token";

export function runPhoenixCrmVisitDatingTests(): void {
  // ── 1. Which client sent it ─────────────────────────────────────────────────────────────────────
  //
  // The web app carries its session in the cookie; the app carries the same signed token in an
  // Authorization header. `resolveAccessContext` tries the COOKIE FIRST and returns on it, so a
  // request presenting one was identified by it and is the web app whatever else it also sends.
  {
    assert.equal(captureClientOf(headers({ cookie: COOKIE })), "browser", "a session cookie is the web app");
    assert.equal(captureClientOf(headers({ authorization: BEARER })), "app", "a bearer and no cookie is the app");

    // 🔴 BOTH is a BROWSER, because the cookie is what identified it. Reading this the other way
    // would hand the capability straight back to the page that already holds the cookie.
    assert.equal(
      captureClientOf(headers({ authorization: BEARER, cookie: COOKIE })),
      "browser",
      "🔴 a request carrying both was identified by its cookie — resolveAccessContext returns on the cookie before it ever looks at the header",
    );

    // 🔴 It fails towards `browser`, which is the direction that grants nothing: a dev-auth role
    // sweep, a system caller, an unauthenticated probe. Losing an offline claim costs a visit
    // nothing — the save still happens, dated at arrival.
    assert.equal(captureClientOf(headers({})), "browser", "🔴 neither is a browser, so the capability is never granted by accident");
    assert.equal(captureClientOf(headers({ "x-phoenix-role": "Medical Rep" })), "browser", "a dev-auth sweep is a browser here");
    for (const malformed of ["Bearer", "Bearer   ", "Basic abc", "eyJhbGciOiJ"]) {
      assert.equal(captureClientOf(headers({ authorization: malformed })), "browser", `a malformed Authorization is no token: ${malformed}`);
    }
    // A cookie header carrying somebody else's crumbs but no session is not a session.
    assert.equal(captureClientOf(headers({ cookie: "theme=dark; phoenix_dev_preview=x" })), "browser");
    assert.equal(captureClientOf(headers({ authorization: BEARER, cookie: "theme=dark" })), "app", "an unrelated cookie does not make it the web app");

    // It decides ONE thing, and it is not authentication: nothing here reads a role, a permission or
    // a territory, and nothing verifies a signature.
    const client = source("src/lib/phoenix-crm/server/capture-client.ts");
    for (const forbidden of [/assertPermission/, /canAccess/, /verifySessionToken/, /getSupabaseAdmin/, /territoryFor/]) {
      assert.equal(forbidden.test(client), false, `capture-client.ts must not ${forbidden} — it grants nothing and narrows nothing`);
    }
  }

  // ── 2. 🔴 A BROWSER'S OFFLINE CLAIM IS NEVER READ ───────────────────────────────────────────────
  {
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.ok(
      visits.includes('const offlineClaim = client === "app" ? parseOfflineCaptureClaim(body) : null;'),
      "🔴 the claim is read only for the app — a browser's is not parsed, not partially honoured and not refused",
    );
    // The gate is on the CLIENT, never on anything the body could say about itself.
    assert.equal(
      /const offlineClaim = [^\n]*body\.(?:client|isApp|native|offlineAllowed)/.test(visits),
      false,
      "🔴 a request must never be able to declare itself the app — that is the forgeable version of this whole fix",
    );
    // And the third argument is REQUIRED, so a new caller cannot forget it and quietly re-open this.
    assert.ok(
      visits.includes("export async function saveVisit(viewer: PhoenixCrmViewer, raw: unknown, client: CaptureClient): Promise<SavedVisit>"),
      "saveVisit takes the client as a required argument — the typechecker is the guard against a caller that forgets",
    );

    const route = source("app/api/phoenix-crm/visits/route.ts");
    assert.ok(
      route.includes("await saveVisit(viewer, body, captureClientOf(request.headers))"),
      "the visits route reads the client from the request's own headers",
    );
    // 🔴 Never from the body, which is the thing being judged.
    assert.equal(/captureClientOf\(\s*body/.test(route), false, "🔴 the client is read from the headers, never from the body");

    // The claim's own bound is still one-sided, and that is correct — it is the CLIENT gate that
    // closes the hole, not a new floor. If a floor ever appears here, an honest early capture
    // (anchored, then photographed a minute later) starts being thrown away.
    const clock = source("src/lib/phoenix-crm/offline-clock.ts");
    assert.ok(clock.includes("if (elapsedSeconds > anchorAgeSeconds + ELAPSED_TOLERANCE_SECONDS) {"), "the upper bound is the window the server proves");
    assert.equal(
      /elapsedSeconds\s*<\s*[A-Za-z_]*MIN/.test(clock),
      false,
      "and there is no lower bound — a capture taken moments after anchoring is honest, and refusing it would cost a rep a real visit",
    );
  }

  // ── 3. 🔴 A BROWSER CANNOT TAKE AN ANCHOR ───────────────────────────────────────────────────────
  //
  // The mint is the first half of a hand-made claim. Refusing it removes no capability, because no
  // web screen has ever asked for one — the boundary test's scan of the screens' calls is what keeps
  // that true. It is a flat 404, so the refusal says nothing about what was refused, and no rep ever
  // meets it (Golden Rule #1: a message teaches the one person it caught).
  {
    const service = source("src/lib/phoenix-crm/server/time-anchor.ts");
    assert.ok(
      service.includes("export async function issueTimeAnchor(viewer: PhoenixCrmViewer, raw: unknown, client: CaptureClient): Promise<TimeAnchorView>"),
      "issueTimeAnchor takes the client as a required argument",
    );
    assert.ok(service.includes('if (client !== "app") throw notFoundError("Not found.");'), "🔴 and refuses anything that is not the app, before it writes a row");
    const body = service.slice(service.indexOf("export async function issueTimeAnchor"), service.indexOf("export async function readTimeAnchor"));
    assert.ok(body.indexOf('if (client !== "app")') < body.indexOf(".insert({"), "the refusal comes before the insert — a refused mint writes nothing and burns no rate limit");

    const route = source("app/api/phoenix-crm/time-anchor/route.ts");
    assert.ok(route.includes("await issueTimeAnchor(viewer, body, captureClientOf(request.headers))"), "the route reads the client from the request's own headers");

    // No web screen asks for an anchor, and none may start to: the queue it feeds does not exist there.
    // Recursive since the Visit report's own folder joined the web screens (2026-10-15): a folder is not a file.
    for (const file of readdirSync(new URL("src/components/phoenix-crm/", ROOT), { recursive: true }).map(String).filter((name) => /\.tsx?$/.test(name))) {
      const text = readFileSync(new URL(`src/components/phoenix-crm/${file}`, ROOT), "utf8");
      assert.equal(text.includes("time-anchor"), false, `${file} asks for a time anchor — the web app has no offline queue to date from one`);
      assert.equal(/\boffline:\s*\{/.test(text), false, `${file} sends an offline claim — the web app has no queue to make one from`);
    }
  }

  // ── 4. 🔴 NO SLOT DATES A VISIT ONTO AN EARLIER VISIT DAY THAN ITS ARRIVAL ──────────────────────
  {
    // The clamp, byte for byte, in the function the database actually runs.
    // save_visit ALONE: its definer may define other functions too (20261027185332 also replaces the admin entry).
    const live = functionBodyOf(sqlOf(SAVE_VISIT_DEFINER), "phoenix_crm_save_visit");
    assert.ok(live.includes(CLAMP), `🔴 the clamp is missing from the live phoenix_crm_save_visit (${SAVE_VISIT_DEFINER})`);

    // And in the right place: AFTER the three branches that date the visit, BEFORE the offline block
    // that is allowed to reach back, and BEFORE the day is taken from it.
    const at = live.indexOf(CLAMP);
    const slotAt = live.indexOf("v_captured_at := public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'visit', v_is_test);");
    const reuseAt = live.indexOf("select pl.captured_at into v_captured_at");
    const offlineAt = live.indexOf("if v_offline_at is not null");
    const dayAt = live.indexOf("v_date := ((v_captured_at - interval '2 hours') at time zone 'Africa/Cairo')::date;");
    assert.ok(slotAt > 0 && reuseAt > 0 && offlineAt > 0 && dayAt > 0, "the function still dates a visit the three ways this reads");
    assert.ok(at > slotAt && at > reuseAt, "the clamp runs after the slot has dated the visit, so there is something to clamp");
    assert.ok(at < offlineAt, "🔴 and BEFORE the offline block — which overwrites it, because an offline capture is allowed to be yesterday's");
    assert.ok(at < dayAt, "and before the day is taken from the capture time");

    // The TS twin and the SQL agree on the cutoff, which is what lets the model below stand in for
    // the plpgsql this suite cannot execute.
    assert.equal(VISIT_DAY_CUTOFF_HOURS, 2, "the owner's cutoff is 02:00");
    assert.equal((CLAMP.match(/interval '2 hours'/g) ?? []).length, 2, "both sides of the clamp subtract the same two hours");

    // Early October 2026 is Egypt's summer time, UTC+3. Asserted first: a runtime whose time-zone
    // data predates Law 24 of 2023 would fail here by name rather than below.
    const cairoHour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Africa/Cairo" });
    assert.equal(cairoHour.format(new Date("2026-10-05T12:00:00Z")), "15", "this runtime must know Egypt's summer time (UTC+3)");

    // (a) THE HOLE. A visit slot issued at 01:00 Cairo on Tuesday, saved at 02:30 — 01:00 is the
    // MONDAY visit day, and 02:30 is already Tuesday's.
    const hole = slotDatedVisit("2026-10-05T22:00:00Z", "2026-10-05T23:30:00Z");
    assert.equal(cairoBusinessDay(new Date("2026-10-05T22:00:00Z")), "2026-10-05", "01:00 Tuesday is Monday's visit day");
    assert.equal(cairoBusinessDay(new Date("2026-10-05T23:30:00Z")), "2026-10-06", "02:30 Tuesday is Tuesday's");
    assert.equal(hole.visitDay, "2026-10-06", "🔴 so the visit is dated at ARRIVAL, not at the slot's issue time");
    assert.equal(hole.capturedAt, "2026-10-05T23:30:00.000Z", "and captured_at is the arrival itself");
    assert.equal(hole.source, "server", "capture_source says the slot's time was not used — which is how the board can see it happened");

    // (b) THE REUSED PLACE PHOTO, which reaches two and a half hours back: a place photographed at
    // 23:45 Monday, a visit saved at 02:10 Tuesday.
    const reused = slotDatedVisit("2026-10-05T20:45:00Z", "2026-10-05T23:10:00Z");
    assert.equal(reused.visitDay, "2026-10-06", "a place photo from last night cannot date this morning's visit to last night");

    // (c) 🔴 THE HONEST LATE SAVE IS UNTOUCHED, and this is the case that matters most: a door
    // photographed at 23:00 and saved at 00:30 is still THAT DAY's work, and the slot's own time is
    // what dates it. A clamp written against the calendar date instead of the visit day would move
    // this visit a day forward and silently empty a rep's evening.
    const lateEvening = slotDatedVisit("2026-10-05T20:00:00Z", "2026-10-05T21:30:00Z");
    assert.equal(lateEvening.source, "slot", "🔴 the slot still dates it — both sides of midnight are the same visit day");
    assert.equal(lateEvening.visitDay, "2026-10-05");
    assert.equal(lateEvening.capturedAt, "2026-10-05T20:00:00.000Z", "and at 23:00, the moment the photo was taken");

    // (d) THE PROPERTY, over every arrival in a day and every slot age a slot can legally have (two
    // hours for a visit photo, two and a half for a reused place photo): the visit day is NEVER
    // earlier than the arrival's.
    let clamped = 0;
    for (let minuteOfDay = 0; minuteOfDay < 24 * 60; minuteOfDay += 5) {
      const arrival = new Date(Date.UTC(2026, 9, 5, 0, 0, 0) + minuteOfDay * 60_000);
      for (let age = 0; age <= 150; age += 5) {
        const slot = new Date(arrival.getTime() - age * 60_000);
        const dated = slotDatedVisit(slot.toISOString(), arrival.toISOString());
        assert.ok(
          dated.visitDay >= cairoBusinessDay(arrival),
          `🔴 a slot ${age} minutes old dated a visit onto ${dated.visitDay}, earlier than the arrival's ${cairoBusinessDay(arrival)}`,
        );
        if (dated.source === "server") clamped += 1;
      }
    }
    assert.ok(clamped > 0, "the sweep must actually reach the clamp — a sweep that never fires it proves nothing");

    // (e) 🔴 THE OFFLINE ANCHOR IS DELIBERATELY EXEMPT. A capture at 19:00 synced at 02:30 belongs to
    // the 19:00 day — that is the whole feature, and it is safe for two reasons that the slot never
    // had: the server brackets the claim at BOTH ends with its own readings, and since this change
    // only the app can make the claim at all. Never "fix" this into the clamp above.
    assert.equal(cairoBusinessDay(new Date("2026-10-05T16:00:00Z")), "2026-10-05", "19:00 Monday is Monday's visit day");
    assert.ok(
      live.includes("    v_captured_at := v_offline_at;\n    v_source := 'offline_anchor';"),
      "the offline block still takes the derived capture time, after the clamp, and overwrites it",
    );
    assert.ok(live.includes("v_offline_at <= now()"), "bounded at the near end by the server's own receipt");
    assert.ok(live.includes("v_offline_at > now() - interval '1 day'"), "and at the far end by a day");

    // Dwell is a measurement of the slot path only, so a clamped visit reports none rather than a
    // made-up zero — `now() - captured_at` is zero the instant the clamp fires.
    assert.ok(live.includes("when v_source <> 'slot' then null"), "dwell_seconds is null for anything the slot did not date");

    // The Super Admin's own entry is a DIFFERENT function and is untouched: entering a visit a rep
    // missed logging, on a day he chooses, is exactly what it is for.
    assert.equal(live.includes("phoenix_crm_admin_enter_visit"), false, "the clamp is in save_visit alone");
    const adminEntry = `supabase/migrations/${lastDefinerOf("phoenix_crm_admin_enter_visit")}`;
    assert.equal(
      functionBodyOf(sqlOf(adminEntry), "phoenix_crm_admin_enter_visit").includes(CLAMP),
      false,
      "and the admin entry, read from its own last definer, never carries the clamp",
    );
  }

  console.log("phoenix-crm visit dating: OK");
}
