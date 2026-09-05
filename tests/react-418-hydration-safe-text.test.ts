import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cairoDateTime, cairoDateTimeSortable } from "../src/lib/format/cairo-datetime.ts";

// React error #418 is a hydration mismatch: the server renders a text node one way, the browser
// renders it another, so React throws away the server HTML and re-renders the whole tree. React
// 19.2's own message distinguishes the two cases — "the server rendered TEXT didn't match" against
// "...HTML..." — and every event this file exists to stop arrived with `args[]=text`, so what
// differed was always the CONTENT of a text node, never the element structure around it.
//
// There are two ways for one instant to render as two different strings, and they need different
// fixes. This file pins both.
//
//   1. THE FORMAT differs. `Intl` output depends on the engine's bundled Unicode locale data, and
//      that data changes between releases: CLDR 42 (ICU 72, late 2022) renamed en-GB's abbreviated
//      September from "Sep" to "Sept". The Railway server runs Node 24 (ICU 78) and renders
//      "Sept"; a reader on Samsung Internet 20 (Chrome 106, ICU 71) renders "Sep". Measured, not
//      assumed — and it accounts for all four #418 events on
//      /employee-portals/recruitment-candidates in the fortnight to 2026-09-06, every one of them
//      from that one browser, on a card that renders `cairoDateTime(candidate.createdAt)`.
//
//   2. THE INSTANT differs. `new Date()` called during render is evaluated once by Node when the
//      HTML is built and again by the browser when React hydrates. Across the Cairo midnight
//      boundary those are different days (/employee-portals/plans, 23:28 Cairo, 2026-09-05).
//
// NOT every UTC-rendered timestamp is a bug, and a blanket sweep to Cairo breaks the ones that are
// right. A DATE-ONLY value (a `date` column, a period key) parses as UTC midnight and UTC is what
// STOPS the calendar day shifting; a vendor wall-clock is already Cairo. Those sites are correct
// and this file deliberately does not touch them — see the comments at their own call sites in
// plans-workspace.tsx and vacation-report.tsx, which say so.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

/**
 * Comments stripped, because the checks below are about what the code DOES and these files explain
 * at length what they deliberately no longer do. Matching the raw text would fail on the very
 * sentence that documents the fix — which it did, the first time this test ran — and the obvious
 * way to make that green again is to delete the explanation, i.e. the test would actively punish
 * the comment a future reader most needs.
 */
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CAIRO_DATETIME_PATH = "src/lib/format/cairo-datetime.ts";
const PASSWORD_SETUP_FORM_PATH = "src/components/auth/password-setup-form.tsx";
const PASSWORD_SETUP_PAGE_PATH = "app/password-setup/[token]/page.tsx";
const PORTAL_LAYOUT_PATH = "src/components/employee-portal/employee-portal-layout.tsx";

export function runReact418HydrationSafeTextTests() {
  // ── 1. The shared Cairo formatter renders the same bytes on every engine ────────────────────
  //
  // Mid-month instants, so each assertion is about the MONTH NAME and nothing else. September is
  // the row that matters — it is the only one CLDR 42 changed — but all twelve are pinned, because
  // a table where one entry is special and eleven are borrowed from the platform is the table that
  // quietly grows a second borrowed entry later.
  const monthSamples: readonly (readonly [string, string])[] = [
    ["2026-01-15T09:00:00.000Z", "15 Jan 2026 · 11:00"],
    ["2026-02-15T09:00:00.000Z", "15 Feb 2026 · 11:00"],
    ["2026-03-15T09:00:00.000Z", "15 Mar 2026 · 11:00"],
    ["2026-04-15T09:00:00.000Z", "15 Apr 2026 · 11:00"],
    ["2026-05-15T09:00:00.000Z", "15 May 2026 · 12:00"],
    ["2026-06-15T09:00:00.000Z", "15 Jun 2026 · 12:00"],
    ["2026-07-15T09:00:00.000Z", "15 Jul 2026 · 12:00"],
    ["2026-08-15T09:00:00.000Z", "15 Aug 2026 · 12:00"],
    ["2026-09-15T09:00:00.000Z", "15 Sept 2026 · 12:00"],
    ["2026-10-15T09:00:00.000Z", "15 Oct 2026 · 12:00"],
    ["2026-11-15T09:00:00.000Z", "15 Nov 2026 · 11:00"],
    ["2026-12-15T09:00:00.000Z", "15 Dec 2026 · 11:00"],
  ];
  for (const [iso, expected] of monthSamples) {
    assert.equal(
      cairoDateTime(iso),
      expected,
      `${iso} must render exactly "${expected}" — these strings are hydrated, so a month abbreviation that varies with the engine's ICU version (en-GB September is "Sep" before CLDR 42 and "Sept" after) is React error #418 for every reader on an older browser`,
    );
  }
  // The 11:00/12:00 split above is not incidental: Cairo is UTC+2 in winter and UTC+3 in summer, so
  // a formatter that had quietly fallen back to the process zone (UTC in CI) would render 09:00 for
  // all twelve rows and fail every one of them.

  // Day-boundary behaviour, both directions and both offsets — the exact minute a naive UTC render
  // still calls the previous day.
  assert.equal(cairoDateTime("2026-07-24T20:59:00Z"), "24 Jul 2026 · 23:59", "20:59 UTC (EEST) is still the 24th in Cairo");
  assert.equal(cairoDateTime("2026-07-24T21:00:00Z"), "25 Jul 2026 · 00:00", "21:00 UTC (EEST) has already rolled to the 25th in Cairo");
  assert.equal(cairoDateTime("2026-01-15T21:59:00Z"), "15 Jan 2026 · 23:59", "21:59 UTC (EET, winter) is still the 15th in Cairo");
  assert.equal(cairoDateTime("2026-01-15T22:00:00Z"), "16 Jan 2026 · 00:00", "22:00 UTC (EET, winter) has already rolled to the 16th in Cairo");

  // Midnight is "00:00", never "24:00". With `hour: "2-digit"` some ICU builds render the h24 form,
  // which is a valid time string attached to the WRONG day — the date printed beside it has already
  // rolled over.
  assert.ok(
    !cairoDateTime("2026-01-15T22:00:00Z").includes("24:00"),
    "Cairo midnight must render as 00:00, never the h24 form 24:00 — the date beside it has already advanced, so 24:00 would name a day that disagrees with it",
  );

  // Absent or unparseable degrades to a dash on BOTH sides of hydration — never to a computed
  // "now", which would itself differ between the server render and the client hydrate.
  assert.equal(cairoDateTime(null), "—", "no value renders a dash, not a computed fallback");
  assert.equal(cairoDateTime("not-a-date"), "—", "an unparseable value renders a dash, never 'Invalid Date' text");
  assert.equal(cairoDateTimeSortable(null), "", "the spreadsheet form uses a blank cell, not a dash, for an absent value");
  assert.equal(cairoDateTimeSortable("2026-08-30T11:05:00Z"), "2026-08-30 14:05", "the sortable form stays all-numeric and Cairo-pinned");

  // ── 2. ...and it takes those names from a literal table, not from the platform ──────────────
  //
  // Every assertion above would still pass on a reverted implementation, because CI runs one engine
  // and on that engine `month: "short"` also yields "Sept". Only the source says whether the string
  // is built from data that travels with the code or from data that travels with whatever browser
  // the reader happens to be holding.
  const cairoSource = codeOnly(read(CAIRO_DATETIME_PATH));
  assert.match(
    cairoSource,
    /"Jan",\s*"Feb",\s*"Mar",\s*"Apr",\s*"May",\s*"Jun",\s*"Jul",\s*"Aug",\s*"Sept",\s*"Oct",\s*"Nov",\s*"Dec"/,
    "cairo-datetime.ts must carry its own month abbreviations, so the rendered text cannot vary with the reader's ICU version",
  );
  assert.doesNotMatch(
    cairoSource,
    /month:\s*"short"|month:\s*"long"|dateStyle:|timeStyle:/,
    "cairo-datetime.ts must not ask the engine for a month NAME, and must not use dateStyle/timeStyle — all three resolve through locale data that differs between engine versions, which is exactly what threw #418. Numeric fields plus the literal table are engine-independent.",
  );

  // ── 3. /password-setup/[token] formats on the SERVER, so the client never re-formats ────────
  //
  // The worst-hit route in the application (55 events all-time) and the first screen a new employee
  // ever sees, before they have a session. Pinning the zone was not enough here — it was ALREADY
  // pinned and the page still threw, because the mismatch was the ICU-version one. Formatting once
  // on the server removes the class rather than the instance: with no second render there is
  // nothing to disagree with, whatever engine the new joiner is holding.
  const formSource = codeOnly(read(PASSWORD_SETUP_FORM_PATH));
  assert.doesNotMatch(
    formSource,
    /Intl\.DateTimeFormat|toLocaleDateString|toLocaleTimeString|toLocaleString|new Date\(/,
    "password-setup-form.tsx is a client component and must not format a date at all — the server hands it a finished string, so no difference in ICU data or clock between the two engines can make the server HTML and the hydrated render disagree",
  );
  assert.match(
    formSource,
    /expiryLabel:\s*string\s*\|\s*null/,
    "the form must take the already-formatted label, nullable so an unparseable instant drops the line rather than printing 'Invalid Date'",
  );
  const pageSource = read(PASSWORD_SETUP_PAGE_PATH);
  assert.match(
    pageSource,
    /import\s*\{[^}]*\bcairoDateTime\b[^}]*\}\s*from\s*["']@\/lib\/format\/cairo-datetime["']/,
    "the password-setup page must format through the shared, zone-pinned helper rather than a bespoke formatter",
  );
  assert.match(
    pageSource,
    /cairoDateTime\(preview\.expiresAt\)/,
    "the expiry must be formatted on the server, from preview.expiresAt",
  );
  assert.match(
    pageSource,
    /expiryLabel=\{/,
    "the finished string must be handed to the form as expiryLabel",
  );

  // ── 4. The portal shell's today-chip reads the clock, and says so ───────────────────────────
  //
  // Shared by every employee-portal route, which is why one unguarded `new Date()` here surfaced as
  // #418 on five different portal pages. The zone is pinned and the en-US month abbreviations are
  // ICU-stable, so the FORMAT is fine — the INSTANT is what differs, across midnight.
  // suppressHydrationWarning is React's documented answer for a rendered clock, and a real fix
  // rather than a muted warning: react-dom checks the flag before calling throwOnHydrationMismatch,
  // so no recoverable error is raised and nothing reaches the error reporter.
  // Located by CONTENT rather than by position: the element is found by looking for the span that
  // actually reads the clock, so the assertion survives the file being reordered or the chip moving
  // — a fixed byte window would false-fail on an unrelated edit above it.
  const portalSource = read(PORTAL_LAYOUT_PATH);
  const clockSpans = (portalSource.match(/<span[^>]*>[\s\S]*?<\/span>/g) ?? []).filter((span) =>
    span.includes("new Date().toLocaleDateString"),
  );
  assert.equal(
    clockSpans.length,
    1,
    "exactly one span in the portal shell may render the clock during render — a second one is a second copy of this bug, and zero means the chip moved somewhere this test can no longer see it",
  );
  const todayChip = clockSpans[0];
  assert.match(
    todayChip,
    /suppressHydrationWarning/,
    "the today-chip evaluates new Date() during render, so the server and the browser produce different text across the Cairo midnight boundary; without suppressHydrationWarning React discards the server HTML for the entire portal shell and reports error #418",
  );
  assert.match(
    todayChip,
    /timeZone: "Africa\/Cairo"/,
    "the chip must stay pinned to Cairo — the owner reads Cairo local time, never the server's UTC",
  );
}
