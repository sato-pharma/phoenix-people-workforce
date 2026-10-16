import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { DIRECTIONS_BASE_URL, directionsPlace, directionsUrl } from "../src/lib/phoenix-crm/directions.ts";
import { showsTelegramCard, TELEGRAM_CARD_LATER_KEY, telegramCardLaterToday, telegramCardOffered } from "../src/lib/phoenix-crm/telegram-card.ts";
import { weekProgressOf, weekProgressParts, type WeekVisit } from "../src/lib/phoenix-crm/week-progress.ts";

/**
 * Phoenix CRM — the rep's field day, and reaching people (owner, 2026-10-02).
 *
 *   1. DIRECTIONS. The visit flow's customer card, the visit form's header and his planned day on the
 *      landing page carry one "Directions" link that opens Google Maps at the customer's SAVED place —
 *      the destination only, no key, no paid service, nothing about where the rep himself is — and no
 *      link at all when no place with a usable point is saved.
 *   2. HIS OWN WEEK. Under his planned day, one line for the field week: what his sent plan holds and
 *      what he has visited so far, AM · PM · Pharmacies apart, from the countable visits every figure
 *      reads, in the same parallel read as the rest of his day.
 *   3. TELEGRAM. 0 of 74 active reps had Telegram connected, so every Telegram leg of every Phoenix CRM
 *      notice reached nobody. One compact card at the top of Phoenix CRM asks the reps and managers to
 *      connect — through the EXISTING connect flow — until the server says they have; "Later" hides it
 *      for the Cairo day.
 */

const source = (path: string) => stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));

/** The words Golden rule #1 keeps off the rep's own screens. */
const JUDGING_WORDS = [/distance/i, /accuracy/i, /\bfar\b/i, /spread/i, /integrity/i, /\bflagg?ed\b/i, /suspic/i];

/** `first` appears, `second` appears, and `first` comes before `second`. */
function assertBefore(text: string, first: string, second: string, message: string): void {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  assert.ok(a >= 0, `${message} — missing: ${first}`);
  assert.ok(b >= 0, `${message} — missing: ${second}`);
  assert.ok(a < b, message);
}

function visit(visitDate: string, listType: "AM" | "PM", pharmacyName: string | null = null): WeekVisit {
  return { visitDate, listType, pharmacyName };
}

export function runPhoenixCrmFieldReachTests() {
  // ── 1. Directions: the saved place as the destination, and nothing else ────────────────────────
  {
    assert.equal(DIRECTIONS_BASE_URL, "https://www.google.com/maps/dir/?api=1&destination=", "Google Maps' public directions address — no key, no paid service");
    assert.equal(
      directionsUrl({ lat: 30.0444196, lon: 31.2357116 }),
      "https://www.google.com/maps/dir/?api=1&destination=30.04442,31.235712",
      "the saved point, to six decimals",
    );
    assert.equal(directionsUrl({ lat: "30.1", lon: "31.2" }), `${DIRECTIONS_BASE_URL}30.1,31.2`, "a point read back as text still makes the link");
    assert.equal(directionsUrl(null), null, "no place, no link");
    assert.equal(directionsUrl(undefined), null);
    assert.equal(directionsUrl({ lat: 0, lon: 0 }), null, "a (0, 0) reading is not a clinic");
    assert.equal(directionsUrl({ lat: 48.8566, lon: 2.3522 }), null, "and a point outside Egypt's field range is not one either");
    assert.equal(directionsUrl({ lat: "north", lon: null }), null, "nor is a value that is not a coordinate");
    assert.ok(!String(directionsUrl({ lat: 30.1, lon: 31.2 })).includes("origin"), "the destination only — the rep's own position is never written into the link");

    // Which place: the one he receives at today, else his first with a usable point.
    const evening = { label: "Evening clinic", lat: 30.1, lon: 31.2, receives: false };
    const morning = { label: "Hospital", lat: 30.2, lon: 31.3, receives: true };
    const broken = { label: "Not a place", lat: 0, lon: 0, receives: true };
    assert.equal(directionsPlace([evening, morning], (place) => place.receives)?.label, "Hospital", "the place that receives today");
    assert.equal(directionsPlace([evening, morning])?.label, "Evening clinic", "else the first");
    assert.equal(directionsPlace([broken, evening], (place) => place.receives)?.label, "Evening clinic", "a place with no usable point is never chosen");
    assert.equal(directionsPlace([broken]), null, "and with none usable there is no place to go to");
    assert.equal(directionsPlace([]), null);

    // The link itself: a new tab, nothing reaching back, and nothing drawn without an address.
    const link = source("src/components/phoenix-crm/directions-link.tsx");
    assert.ok(link.includes("if (!href) return null;"), "no saved place, no link — never a link to nowhere");
    assert.ok(link.includes('target="_blank"'), "a new tab, so a visit half-entered behind it is still there");
    assert.ok(link.includes('rel="noopener noreferrer"'), "and the maps page can neither reach back nor learn where it came from");
    assert.ok(link.includes("Directions"), "it says Directions");
    assert.doesNotMatch(link, /rounded(?!-none)/, "square corners");
    assert.doesNotMatch(link, /truncate|text-ellipsis|…/, "nothing cut short");

    // Neither half ever reads where the rep is: the link is built from the SAVED place alone.
    for (const path of ["src/lib/phoenix-crm/directions.ts", "src/components/phoenix-crm/directions-link.tsx"]) {
      const code = source(path);
      for (const banned of [/geolocation/i, /getCurrentPosition/, /useSilentFix/, /origin=/]) {
        assert.doesNotMatch(code, banned, `${path} must build the way from the saved place alone — never from the rep's own position`);
      }
      for (const word of JUDGING_WORDS) assert.doesNotMatch(code, word, `${path} must not carry ${word} to the rep (golden rule #1)`);
    }

    // The visit flow's customer card: the link hangs UNDER the card, never inside its button.
    const picker = source("src/components/phoenix-crm/visit-customer-picker.tsx");
    assert.ok(
      picker.includes("const place = directionsPlace(customer.places, (place) => place.todayWindows !== NOT_RECEIVING);"),
      "the card's place is the one he receives at today, else his first",
    );
    // 2026-10-09: a pharmacy has no place row at all, so its own pin answers after his places —
    // never before them, and a doctor never has one, so a doctor's link is exactly what it was.
    assert.ok(picker.includes("return directionsUrl(place) ?? directionsUrl(customer.pharmacyPin);"), "and a pharmacy's own pin answers when no place of his does");
    assert.ok(picker.includes("const directions = customerDirectionsUrl(customer);"), "each card asks for its own customer's way");
    const card = picker.slice(picker.indexOf("const directions = customerDirectionsUrl(customer);"), picker.indexOf("</ul>", picker.indexOf("const directions = customerDirectionsUrl(customer);")));
    assertBefore(card, "</button>", "<DirectionsLink customerName={customer.name} href={directions} />", "the link sits after the card's button closes — a link inside a button fires the card on a phone");
    // A doctor with no saved place still gets NO strip: `where` and `pharmacyDetails` are both
    // pharmacy-only, so the condition is false for him exactly as `{directions ? (` was.
    assert.ok(card.includes("{directions || where || pharmacyDetails ? ("), "and no strip at all for a customer with no saved place and nothing of his own to save");
    assert.ok(card.includes("const pharmacy = isPharmacyListType(customer.listType);"), "the pharmacy half of the strip is keyed off the list type, never off the pin being absent");

    // The visit form's header.
    const form = source("src/components/phoenix-crm/visit-log-form.tsx");
    assert.ok(
      form.includes('<DirectionsLink className="mt-2" customerName={customer.name} href={customerDirectionsUrl(customer)} />'),
      "the visit form's customer header carries the same link",
    );
    assertBefore(form, '<CrmBlock title="1 · Customer">', "<DirectionsLink", "in the customer block, under his name and hours");

    // His planned day on the landing page.
    const today = source("src/lib/phoenix-crm/server/today.ts");
    assert.ok(today.includes("directionsUrl: directionsUrl(place ?? null),"), "every planned stop carries the way to the place its row names");
    const landing = source("src/lib/phoenix-crm/server/rep-landing.ts");
    assert.ok(landing.includes("directionsUrl: stop.directionsUrl ?? null,"), "and the landing panel's row is handed it");
    const panel = source("src/components/employee-portal/rep-today-plan-panel.tsx");
    assert.ok(
      panel.includes('<DirectionsLink className="mt-1" customerName={stop.name} href={stop.directionsUrl} variant="text" />'),
      "one quiet line under the row's place and hours",
    );
    assertBefore(panel, "parts={stop.where}", "href={stop.directionsUrl}", "after the place it leads to");
  }

  // ── 2. His own week: planned against done, AM · PM · Pharmacies apart ──────────────────────────
  {
    const visits = [
      visit("2026-10-03", "AM"),
      visit("2026-10-03", "PM", "El Ezaby"),
      visit("2026-10-03", "PM", "el ezaby "),
      visit("2026-10-04", "PM", "El Ezaby"),
      visit("2026-10-04", "PM", "Seif"),
    ];
    const week = weekProgressOf({
      weekStart: "2026-10-03",
      anyDaySent: true,
      plannedListTypes: ["AM", "AM", "PM", "PM", "PM", "PM", "PM", "PM"],
      visits,
    });
    assert.deepEqual(week.planned, { am: 2, pm: 6 }, "every stop on his sent plan, AM and PM apart");
    assert.deepEqual(week.visited, { am: 1, pm: 4, pharmacies: 3 }, "the week so far — one pharmacy however it is spelled on a day, counted again on another day");
    assert.deepEqual(
      weekProgressParts(week),
      ["AM 2 planned · 1 visited", "PM 6 planned · 4 visited", "Pharmacies 3"],
      "his own words: N planned · M visited, once for AM and once for PM, and the pharmacies beside them",
    );

    // 🔴 THREE FIGURES APART — never a total, never a slash, never averaged.
    for (const part of weekProgressParts(week)) {
      assert.doesNotMatch(part, /\//, `"${part}" — the pair is never printed with a slash (owner, 2026-09-04)`);
      assert.ok(!(/\bAM\b/.test(part) && /\bPM\b/.test(part)), `"${part}" — AM and PM are never in one figure`);
    }
    assert.ok(!weekProgressParts(week).some((part) => part.includes(String(week.visited.am + week.visited.pm))), "no part prints the AM and PM visits added together");
    assert.ok(!weekProgressParts(week).some((part) => part.includes(String(week.visited.pm + week.visited.pharmacies))), "and a pharmacy is never counted inside PM");

    // A sent DAY plans the week (2026-10-02 — the week's own status is no longer asked); with no
    // sent day at all — a draft, a week returned whole, no plan — it plans nothing yet.
    const unsent = weekProgressOf({ weekStart: "2026-10-03", anyDaySent: false, plannedListTypes: ["AM", "PM"], visits });
    assert.equal(unsent.planned, null, "no day of it is sent, so the week is still his to change and plans nothing yet");
    assert.deepEqual(weekProgressParts(unsent), ["AM 1 visited", "PM 4 visited", "Pharmacies 3"], "and the line says only what he visited");

    // Nothing to say is no line: a list he has nothing on, and no pharmacy yet.
    assert.deepEqual(
      weekProgressParts(weekProgressOf({ weekStart: "2026-10-03", anyDaySent: true, plannedListTypes: ["PM", "PM"], visits: [] })),
      ["PM 2 planned · 0 visited"],
      "a rep with no AM customers is not told AM 0 every day, and Pharmacies 0 is never printed",
    );
    assert.deepEqual(weekProgressParts(weekProgressOf({ weekStart: "2026-10-03", anyDaySent: false, plannedListTypes: [], visits: [] })), [], "nothing at all, no line at all");

    // The reads: the countable visits, in the day's one parallel wave.
    const reads = source("src/lib/phoenix-crm/server/week-progress.ts");
    assert.ok(reads.includes('.from("phoenix_crm_countable_visits")'), "the visits every figure reads — an off-plan visit nobody approved is not counted");
    assert.doesNotMatch(reads, /\.from\("phoenix_crm_visits"\)/, "never the raw visit table");
    assert.ok(reads.includes('.eq("seat_id", seatId)') && reads.includes('.eq("is_test", isTest)'), "his own territory, in his own world");
    assert.ok(reads.includes('.gte("visit_date", weekStart)') && reads.includes('.lte("visit_date", visitDay)'), "Saturday through today");
    // 🔴 DAY BY DAY (2026-10-02), never the WEEK's own status: a week returned for ONE day reads
    // `returned`, and asking `isPlanSentForReview` of it took the planned figures off the whole line.
    assert.ok(reads.includes("isPlanDaySent({ ...facts, date })"), "each day of the week is asked on its own");
    assert.ok(reads.includes("loadPlanDayFacts([planRow], isTest)"), "through the one reader every other day-level question goes through");
    assert.equal(/isPlanSentForReview/.test(reads), false, "and never the week's own status again");
    assert.ok(reads.includes("sentDays.has(String(row.plan_date ?? \"\"))"), "only the stops on a day he sent are counted as planned");
    assertBefore(reads, "visitsRead.catch(() => undefined);", "await supabase", "the visits' read starts beside the plan's, handled the moment it starts");

    const today = source("src/lib/phoenix-crm/server/today.ts");
    const wave = today.slice(today.indexOf("await Promise.all(["), today.indexOf("]);", today.indexOf("await Promise.all([")));
    assert.ok(
      wave.includes("loadWeekProgress(seat.seatId, isTest, date, { planRow: planRowRead }),"),
      "the week joins the day's one parallel wave — never a read after it — on the plan row Today reads once",
    );
    assert.match(today, /const plannedStopsRead = Promise\.all\(\[customersRead, plannedRead\]\)\.then\(/, "and the wave keeps the shape the speed pins hold");
    assert.ok(today.includes("week,\n"), "and the day hands it on");

    const landing = source("src/lib/phoenix-crm/server/rep-landing.ts");
    assert.ok(landing.includes("weekParts: weekProgressParts(view.week),"), "the landing panel is handed the line's parts, never a figure to add up");
    const panel = source("src/components/employee-portal/rep-today-plan-panel.tsx");
    assert.ok(panel.includes("if (parts.length === 0) return null;"), "no parts, no line — never an empty square");
    assert.ok(panel.includes('<FootLine label="This week" parts={plan.weekParts} />'), "the line opens This week");
    assert.ok(panel.includes("{parts.map((part) => ("), "each figure its own part");
    assert.equal(/weekParts\.join\(/.test(panel), false, "never joined into one string a reader could take for one figure");

    // His own work, and nothing that judges him.
    for (const path of ["src/lib/phoenix-crm/week-progress.ts", "src/lib/phoenix-crm/server/week-progress.ts"]) {
      for (const word of JUDGING_WORDS) assert.doesNotMatch(source(path), word, `${path} must not carry ${word} onto his own week`);
    }
  }

  // ── 3. The Telegram card ───────────────────────────────────────────────────────────────────────
  {
    const viewer = { isSuperAdmin: false, isTestPersona: false, isRep: false, isManager: false, isSfeManager: false };
    assert.equal(telegramCardOffered({ ...viewer, isRep: true }), true, "a rep is asked");
    assert.equal(telegramCardOffered({ ...viewer, isManager: true }), true, "a district, regional or national manager is asked");
    assert.equal(telegramCardOffered({ ...viewer, isSfeManager: true }), true, "the SFE Manager, whom the plan-edit and nudge notices reach, is asked");
    assert.equal(telegramCardOffered(viewer), false, "someone the module's notices never reach — the CEO, a directory role — is not");
    assert.equal(telegramCardOffered({ ...viewer, isRep: true, isSuperAdmin: true }), false, "never the Super Admin");
    assert.equal(telegramCardOffered({ ...viewer, isRep: true, isTestPersona: true }), false, "never a test account, whose messages go nowhere real");

    assert.equal(showsTelegramCard({ connected: false }), true, "offered and not connected: the card");
    assert.equal(showsTelegramCard({ connected: true }), false, "connected: gone");
    assert.equal(showsTelegramCard(null), false, "not offered, or the status could not be read: no card");
    assert.equal(showsTelegramCard(undefined), false, "an overview from before the field existed: no card");

    assert.equal(telegramCardLaterToday("2026-10-02", "2026-10-02"), true, "Later hides it for the rest of that Cairo day");
    assert.equal(telegramCardLaterToday("2026-10-01", "2026-10-02"), false, "and it is back the next day");
    assert.equal(telegramCardLaterToday(null, "2026-10-02"), false);
    assert.equal(telegramCardLaterToday("", "2026-10-02"), false);
    assert.equal(TELEGRAM_CARD_LATER_KEY, "phoenix-crm:telegram-card:later");

    // The server says whether he is connected — the very row the Notification Settings panel reads.
    const settings = source("src/lib/notifications/settings.ts");
    const connected = settings.slice(settings.indexOf("export async function isTelegramConnected("), settings.indexOf("export async function saveNotificationPreferences("));
    assert.ok(connected.includes('.from("telegram_connections")'), "it reads the connection row");
    assert.ok(connected.includes('.eq("user_id", userId)') && connected.includes('.order("updated_at", { ascending: false })'), "keyed and ordered exactly as getNotificationSettings reads it");
    assert.ok(connected.includes('.status === "connected"'), "connected means connected — a pending link is not");

    const overview = source("src/lib/phoenix-crm/server/overview.ts");
    const wave = overview.slice(overview.indexOf("await Promise.all(["), overview.indexOf("]);", overview.indexOf("await Promise.all([")));
    assert.ok(wave.includes("telegramOffered ? telegramConnectedOrNull(viewer) : null,"), "read in the overview's own wave, and only for someone the card is for");
    assert.ok(overview.includes("telegram: telegramConnected === null ? null : { connected: telegramConnected },"), "the page is told connected or not, or nothing");
    const orNull = overview.slice(overview.indexOf("async function telegramConnectedOrNull("), overview.indexOf("export async function loadPhoenixCrmOverview("));
    assert.ok(orNull.includes("return null;"), "an unreadable status draws no card and never fails the page");

    // ONE connect flow: the card and the settings panel go through the same helper to the same route.
    const helper = source("src/components/notifications/telegram-connect.ts");
    assert.ok(helper.includes('fetch("/api/integrations/telegram/connect", { method: "POST" })'), "the existing connect route");
    assert.ok(helper.includes('fetch("/api/notifications/settings", { cache: "no-store" })'), "and the existing settings read to learn he is connected");
    const panel = source("src/components/notifications/notification-settings-panel.tsx");
    assert.ok(panel.includes('from "@/components/notifications/telegram-connect";'), "the Notification Settings panel connects through the same helper");
    assert.ok(panel.includes("await requestTelegramConnectLink();"), "and its Connect Telegram button calls it");
    assert.equal(panel.includes('fetch("/api/integrations/telegram/connect"'), false, "with no second copy of the request left in the panel");
    const card = source("src/components/phoenix-crm/telegram-connect-card.tsx");
    assert.ok(card.includes("await requestTelegramConnectLink();"), "the card's button goes into that same flow");
    assert.equal(/\bfetch\(/.test(card), false, "and builds no request of its own");
    assert.equal(existsSync("app/api/phoenix-crm/telegram"), false, "there is no second Telegram route");

    // The card's own rules: hidden until the page is live, Later remembered for the day and every
    // storage touch wrapped, square, and nothing cut short.
    assert.ok(card.includes("if (!hydrated || dismissed) return null;"), "nothing until the page is live, and nothing once he pressed Later");
    assert.ok(card.includes('if (state === "ask" && telegramCardLaterToday(laterDay, cairoToday)) return null;'), "Later keeps it away for the Cairo day");
    assert.match(card, /try \{\s*return window\.localStorage\.getItem\(TELEGRAM_CARD_LATER_KEY\);\s*\} catch \{/, "every read of storage is wrapped");
    assert.match(card, /try \{\s*window\.localStorage\.setItem\(TELEGRAM_CARD_LATER_KEY, cairoToday\);/, "and every write");
    assert.ok(card.includes("Get Phoenix CRM messages on Telegram"), "his words");
    assert.ok(card.includes('rel="noopener noreferrer"') && card.includes('target="_blank"'), "the bot opens in a new tab");
    assert.doesNotMatch(card, /rounded(?!-none)/, "square corners");
    assert.doesNotMatch(card, /truncate|text-ellipsis|…/, "nothing cut short");

    // At the top of Phoenix CRM: the chooser and every module page.
    const drawn = "{showsTelegramCard(overview.telegram) ? <TelegramConnectCard cairoToday={overview.cairoToday} /> : null}";
    const app = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    assert.ok(app.includes(drawn), "every module page draws it");
    assertBefore(app, drawn, "{standingNote()}", "at the very top");
    const chooser = source("src/components/phoenix-crm/module-chooser.tsx");
    assert.ok(chooser.includes(drawn), "and the chooser, Phoenix CRM's own first page");
    assert.equal(chooser.includes('"use client"'), false, "which stays a server component");
  }

  console.log("phoenix-crm field reach: OK");
}
