import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CAIRO_MONTHS, cairoDate, cairoDateTime, cairoDateTime12h, cairoDateTimeSortable, cairoMonthDayTime12h, stableEnGbFormatter, utcDate } from "../src/lib/format/cairo-datetime.ts";
import { offerWhen } from "../src/components/offers/offer-ui.ts";
import { cairoStamp } from "../src/components/recruitment/workspace/workspace-format.ts";
import { compareMyMapNames } from "../src/lib/phoenix-crm/my-map-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// React error #418 is a hydration mismatch: the server renders a text node one way, the browser
// renders it another, so React throws away the server HTML and re-renders the whole tree. React
// 19.2's own message distinguishes the two cases — "the server rendered TEXT didn't match" against
// "...HTML..." — and every event this file exists to stop arrived with `args[]=text`, so what
// differed was always the CONTENT of a text node, never the element structure around it.
//
// There are two ways for one instant to render as two different strings, and they need different
// fixes. This file pins the FIRST; the second is fixed and pinned by #3336, next door.
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
//      boundary those are different days (/employee-portals/plans, 23:28 Cairo, 2026-09-05). That
//      one is the employee-portal header chip, fixed on main by #3336 and pinned by its own test.
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
  stripComments(source);

const CAIRO_DATETIME_PATH = "src/lib/format/cairo-datetime.ts";
const PASSWORD_SETUP_FORM_PATH = "src/components/auth/password-setup-form.tsx";
const PASSWORD_SETUP_PAGE_PATH = "app/password-setup/[token]/page.tsx";

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

  // `cairoDate` (#3340) is the date-only sibling and shares formatCairoDatePart, so it inherits
  // the same month table — and the same exposure if anyone re-borrows the name from the platform.
  // It reaches the Report It export subtitle, which is server-rendered, so a split there would be
  // a wrong DATE on a downloaded document rather than only a flicker.
  assert.equal(cairoDate("2026-09-15T09:00:00.000Z"), "15 Sept 2026", "the date-only sibling must use the same engine-independent month table");
  assert.equal(cairoDate(null), "—", "an absent value renders a dash, never today");

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

  // ── 3b. The plan decision timeline, which BOTH earlier fixes missed ─────────────────────────
  //
  // /employee-portals/plans kept throwing #418 after #3336 and #3337 both shipped on 2026-09-06.
  // Confirmed rather than assumed: every event's `release` column was resolved back to a commit and
  // `git merge-base --is-ancestor` says all six erroring builds already contained both fixes. The
  // last arrived 2026-09-07 13:06 Cairo.
  //
  // What they missed is this call site — the decision timeline rendered
  // `new Date(d.createdAt).toLocaleDateString("en-GB", { month: "short", … })` straight into a text
  // node, inside a `"use client"` component. `createdAt` is an INSTANT and the month is the en-GB
  // abbreviation, the one field CLDR 42 changed, so it is cause (1) at a second site rather than a
  // new cause.
  //
  // Pinned by SOURCE, like the password-setup pair above: the value assertions in section 1 pass on
  // a reverted implementation too, because CI runs one engine.
  const plansSource = codeOnly(read("src/components/employee-portal/plans-workspace.tsx"));
  assert.match(
    plansSource,
    /\{cairoDate\(d\.createdAt\)\}/,
    "the plan decision timeline must render the instant through the shared cairoDate helper",
  );
  assert.doesNotMatch(
    plansSource,
    /toLocaleDateString\("en-GB"/,
    'no en-GB toLocaleDateString may survive in plans-workspace — that pairing is what CLDR 42 split, and this file renders during SSR',
  );
  // The date-only helpers in the same file are NOT this bug and must survive the fix. They format a
  // plan row's `activity_date` in locale "en" — where the September abbreviation never changed —
  // and their UTC zone is what stops the calendar day shifting. A sweep that "finishes the job" by
  // dragging them to Cairo breaks the grid's day alignment, which is why they are asserted present.
  assert.match(plansSource, /function formatDate\(/, "the date-only helpers must stay");
  assert.match(
    plansSource,
    /timeZone: "UTC"/,
    "the date-only helpers keep UTC deliberately — see their own comment; Cairo there shifts the calendar day",
  );

  // ── 3c. No component may re-implement the shared formatter ──────────────────────────────────
  //
  // validated-customer-register.tsx had its own `cairoDateTime` built on
  // `Intl.DateTimeFormat("en-GB", { month: "short" })` — a second, unsafe copy of the exact thing
  // the shared helper exists to be. It is a `"use client"` component, so it was a live #418 waiting
  // for two readers on different ICU versions. It now delegates.
  const registerSource = codeOnly(read("src/components/marketing-requests/validated-customer-register.tsx"));
  assert.doesNotMatch(
    registerSource,
    /Intl\.DateTimeFormat\("en-GB"/,
    "validated-customer-register must not rebuild the Cairo formatter — delegate to @/lib/format/cairo-datetime",
  );
  assert.match(registerSource, /sharedCairoDateTime/, "validated-customer-register must delegate to the shared helper");
  assert.match(
    registerSource,
    /"Not recorded"/,
    'the register keeps its own "Not recorded" copy for an absent instant — the shared dash reads wrong in that column',
  );

  // ── 3d. The UTC date-only sibling, and the three sites that still used the platform ────────
  //
  // `utcDate` exists because the previous three fixes all treated "is the zone deliberate?" as the
  // question. At these sites it WAS deliberate and correct — a `date` column, or a vendor
  // wall-clock already in Cairo but tagged UTC — so each one carried a comment defending its UTC
  // and each was still throwing #418, because the engine-dependent part is the LOCALE, not the
  // zone. `en-GB` + `month: "short"` is the pairing CLDR 42 split; the UTC pin never touched it.
  //
  // Measured on production before the fix: /employee-portals/visits last threw 2026-09-06 23:57
  // Cairo and /employee-portals/double-visit-report 2026-09-07 00:06, both on builds that already
  // contained #3336, #3337 and #3340 — confirmed by resolving each event's `release` column back
  // to a commit and asking `git merge-base --is-ancestor`.
  const utcMonthSamples: readonly (readonly [string, string])[] = [
    ["2026-01-15T00:00:00.000Z", "15 Jan 2026"],
    ["2026-02-15T00:00:00.000Z", "15 Feb 2026"],
    ["2026-03-15T00:00:00.000Z", "15 Mar 2026"],
    ["2026-04-15T00:00:00.000Z", "15 Apr 2026"],
    ["2026-05-15T00:00:00.000Z", "15 May 2026"],
    ["2026-06-15T00:00:00.000Z", "15 Jun 2026"],
    ["2026-07-15T00:00:00.000Z", "15 Jul 2026"],
    ["2026-08-15T00:00:00.000Z", "15 Aug 2026"],
    ["2026-09-15T00:00:00.000Z", "15 Sept 2026"],
    ["2026-10-15T00:00:00.000Z", "15 Oct 2026"],
    ["2026-11-15T00:00:00.000Z", "15 Nov 2026"],
    ["2026-12-15T00:00:00.000Z", "15 Dec 2026"],
  ];
  for (const [iso, expected] of utcMonthSamples) {
    assert.equal(
      utcDate(iso),
      expected,
      `${iso} must render exactly "${expected}" — same engine-independent month table as cairoDate, so an older ICU cannot render "Sep" where the server rendered "Sept"`,
    );
  }

  // The whole point of the UTC pin: a date-only value must NOT shift a calendar day. Cairo is
  // UTC+2/+3, so if this ever fell back to Cairo these two would read 01 Sept and 01 Jan.
  assert.equal(utcDate("2026-08-31T22:00:00Z"), "31 Aug 2026", "22:00 UTC must stay the 31st — a Cairo pin here would advance the calendar day");
  assert.equal(utcDate("2025-12-31T23:30:00Z"), "31 Dec 2025", "a date-only value must not roll into the next year");
  assert.equal(utcDate(null), "—", "an absent value renders a dash, never today");
  assert.equal(utcDate("not-a-date"), "—", "an unparseable value renders a dash, never 'Invalid Date' text");

  // Source pins for the three call sites, same reasoning as every other pin in this file: the value
  // assertions above pass on a reverted implementation too, because CI runs a single engine.
  for (const [file, what] of [
    ["src/components/employee-portal/my-visits-workspace.tsx", "the visits list (visit_date and the vendor check-in stamp)"],
    ["src/components/double-visit-report/double-visit-report-workspace.tsx", "the double-visit report's date column"],
    ["src/components/weekly-planning/plan-conversation-thread.tsx", "the plan conversation thread"],
  ] as const) {
    const source = codeOnly(read(file));
    assert.doesNotMatch(
      source,
      /["']en-GB["']/,
      `${what} (${file}) must not name the en-GB locale — its month abbreviation is what CLDR 42 changed, and this file renders during SSR`,
    );
  }

  const utcSource = codeOnly(read(CAIRO_DATETIME_PATH));
  assert.match(
    utcSource,
    /export function utcDate\(/,
    "the UTC date-only sibling must live beside cairoDate and share CAIRO_MONTHS — a second month table is how validated-customer-register grew its own unsafe copy",
  );
  assert.doesNotMatch(
    utcSource,
    /const [A-Z_]*MONTHS[A-Z_]* = \[[\s\S]*?\][\s\S]*?const [A-Z_]*MONTHS[A-Z_]* = \[/,
    "there must be exactly one month table in this module",
  );

  // ── 3e. The generic en-GB formatter, and the repo-wide guard that ends this class ──────────
  //
  // The three named helpers above cover the formats this app renders most. They did not scale to
  // the long tail: a sweep on 2026-09-08 found 69 further client-side sites across 21 option
  // shapes — seconds, weekdays, month-only, `hour12`, in four different zones. So the remaining
  // sites keep their OWN options and zone and route through stableEnGbFormatter, which replaces
  // only the month token.
  //
  // Asserting literal strings rather than equality with `Intl`: comparing the helper against the
  // platform passes trivially on CI's single engine, which is the mistake this whole file exists
  // to avoid. These are the bytes an old engine must also produce.
  const septUtc = new Date("2026-09-15T09:00:00.000Z");
  assert.equal(
    stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(septUtc),
    "15 Sept 2026",
    "the generic formatter must spell September from the shipped table, not the reader's ICU build",
  );
  assert.equal(
    stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(new Date("2026-08-15T09:00:00.000Z")),
    "15 Aug 2026",
    "a month CLDR never changed must still render exactly as before",
  );

  // The zone is the caller's and is never touched — this migration moved the LOCALE axis only.
  // 22:00 UTC on the 31st is already the 1st in Cairo, so these two must disagree.
  const boundary = new Date("2026-08-31T22:00:00.000Z");
  assert.equal(
    stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(boundary),
    "31 Aug 2026",
    "a UTC-pinned caller must still get UTC — dragging these to Cairo is what shifts a date-only calendar day",
  );
  assert.equal(
    stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" }).format(boundary),
    "01 Sept 2026",
    "a Cairo-pinned caller must still get Cairo",
  );

  // The invisible half. On Node 24 / ICU 78, en-GB with `hour12` puts a PLAIN space before "pm"
  // through format() and U+202F (narrow no-break space) through formatToParts(). The helper joins
  // parts, so without normalising it would silently swap in a character nobody can see — and an
  // invisible character is still a text node, so it is still #418.
  const pmLabel = stableEnGbFormatter({
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  }).format(septUtc);
  assert.ok(
    !pmLabel.includes("\u202f"),
    `the hour12 form must not carry U+202F — formatToParts emits it where format() emits a plain space, and the difference is invisible in review (got ${JSON.stringify(pmLabel)})`,
  );

  // ── 3f. Repo-wide: no client component may ask the platform for an en-GB month name ─────────
  //
  // This is the part that ends the cycle. #3336, #3337, #3340, #3463 and #3477 each fixed the
  // sites that were known to be erroring, and each was followed by another report, because a site
  // only throws while it is rendering a SEPTEMBER date — the other eleven months it looks perfect.
  // A list of fixed files can never be complete; the absence of the pattern can.
  //
  // Scoped to the two call shapes that reach ICU's month data directly. `formatDateOnly(value,
  // "en-GB", …)` in src/lib/date-only.ts is deliberately NOT matched: it already normalises with
  // .replace(/\bSept\b/g, "Sep"), solving the same problem by canonicalising to the OLD spelling
  // instead of the new one, so it is stable on every engine and its callers are safe.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(rel);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = codeOnly(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
      if (!/^\s*["']use client["']/m.test(source.slice(0, 2000))) continue;
      const patterns = [
        /new Intl\.DateTimeFormat\(\s*["']en-GB["']\s*,/g,
        /\.toLocale(?:Date|Time)?String\(\s*["']en-GB["']\s*,/g,
      ];
      for (const pattern of patterns) {
        for (let m; (m = pattern.exec(source)); ) {
          // Read the OPTIONS OBJECT by balancing braces, never a fixed window. A window runs past
          // the end of this call into whatever is declared next, so a call that asks for NO month
          // at all — which renders numerically, and is safe — gets reported because the function
          // below it happens to use month: "short". That false positive cost a run here, and it is
          // the same window bug the sweep script that found these sites had. The balance is the check.
          const open = source.indexOf("{", m.index);
          if (open === -1) continue;
          let depth = 0;
          let end = -1;
          for (let i = open; i < source.length; i += 1) {
            if (source[i] === "{") depth += 1;
            else if (source[i] === "}") {
              depth -= 1;
              if (depth === 0) {
                end = i;
                break;
              }
            }
          }
          if (end === -1) continue;
          const options = source.slice(open, end + 1);
          if (/month:\s*["']short["']/.test(options) || /dateStyle:\s*["']medium["']/.test(options)) {
            offenders.push(`${rel}:${source.slice(0, m.index).split("\n").length}`);
          }
        }
      }
    }
  };
  walk("src");
  walk("app");
  assert.deepEqual(
    offenders,
    [],
    `these client components ask the reader's ICU build for an en-GB month abbreviation, which CLDR 42 changed from "Sep" to "Sept" — every one is React hydration error #418 for anyone on an older browser, and it will only show up in September:\n  ${offenders.join("\n  ")}\nRoute them through stableEnGbFormatter (keeping their own options and timeZone verbatim — the zone is not the bug).`,
  );

  // ── 3g. THE MACHINE-TRANSLATION OPT-OUT IS GONE, AND NOTHING IS PINNED HERE ────────────────
  //
  // This section used to assert translate="no" on <html> and a google=notranslate meta in
  // app/layout.tsx. Both were added on 2026-09-08 to test one hypothesis about this same error: a
  // browser translation rewrites text nodes, so if it lands before or during hydration React
  // discards the server HTML. That commit named its own falsification test — if the routes still
  // erroring went quiet the diagnosis was right, and if they kept erroring the attribute should
  // come back out.
  //
  // It kept erroring. Measured on production 2026-09-11: exactly one route platform-wide still
  // threw #418, /employee-portals/recruitment-candidates, 12 events, all from ONE District Sales
  // Manager on Samsung Internet 20 (Chrome 106) — an engine that need not honour Chrome's signal
  // in the first place. Everything else had gone quiet. Removed at the owner's instruction that
  // day, because the attribute was costing every Arabic-speaking reader the browser's translate
  // offer and buying nothing measurable.
  //
  // NOTHING IS ASSERTED IN EITHER DIRECTION. An anti-pin would block a future session from
  // re-running the experiment properly, and that is not what the evidence supports — the remaining
  // #418 on that one page is still unexplained. The account is here so a re-add is a decision
  // somebody makes on purpose rather than a guess somebody repeats. See app/layout.tsx.

  // ── 4. The portal shell clock is NOT pinned here — #3336 owns it ─────────────────────
  //
  // The employee-portal header chip was the second cause on these routes: it called `new Date()`
  // during render, so Node and the browser disagreed across Cairo midnight
  // (/employee-portals/plans, 23:28 Cairo, 2026-09-05). That is fixed on main by #3336, which
  // moved the read into a mount effect so the server renders nothing at all, and it carries its
  // own regression test — tests/employee-portal-header-clock-hydration.test.ts. Deliberately not
  // re-pinned here: two tests guarding one line disagree the moment either is edited, and the one
  // that lives beside the fix is the one that will be kept honest.

  // ── 4. The Vacation Report's 12-hour time (System Audit APP-C3275308) ───────────────────────
  //
  // "Oct 20, 2026, 02:04 PM" came from `Intl.DateTimeFormat("en", { hour12: true, timeZone:
  // "Africa/Cairo" })` inside a "use client" component. The server (Node 24) puts a plain space
  // before PM; every iPhone browser runs Safari's engine, which puts U+202F there — and an older
  // iPhone also gets Cairo's hour wrong for half the year. 7 hydration mismatches, 4 people,
  // 4 Sep – 20 Oct 2026. cairoDateTime12h builds the text from digits instead.
  //
  // (a) Nothing on screen changes: the output is exactly what the server printed before, across both
  // daylight-saving seasons, midnight and noon.
  const serverBefore = new Intl.DateTimeFormat("en", {
    day: "2-digit", hour: "2-digit", hour12: true, minute: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric",
  });
  for (const iso of [
    "2026-01-15T08:05:00Z", "2026-04-24T21:59:00Z", "2026-07-01T09:30:00Z", "2026-09-30T22:00:00Z",
    "2026-10-20T11:04:21Z", "2026-10-29T21:00:00Z", "2026-12-31T22:00:00Z", "2026-06-15T10:00:00Z",
  ]) {
    assert.equal(cairoDateTime12h(iso), serverBefore.format(new Date(iso)).replace(/[\u202f\u00a0]/g, " "), `${iso}: the 12-hour Cairo text must read exactly as the server printed it before`);
  }
  assert.equal(cairoDateTime12h(null), "-", "an empty instant keeps the report's own dash");
  assert.equal(cairoDateTime12h("not a date"), "-", "an unreadable instant is a dash, never 'Invalid Date'");

  // (b) It asks the engine for nothing. Stand in for an iPhone: an Intl that answers with U+202F and
  // with the hour one off. The text must not move.
  const iphoneProbe = "2026-10-20T11:04:21Z";
  const truth = cairoDateTime12h(iphoneProbe);
  const RealDateTimeFormat = Intl.DateTimeFormat;
  try {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = function SafariLike(locale?: string, options?: Intl.DateTimeFormatOptions) {
      const inner = new RealDateTimeFormat(locale, { ...options, timeZone: "UTC" });
      const swap = (text: string) => text.replace(/ (AM|PM|am|pm)/g, "\u202f$1");
      return {
        format: (d: Date) => swap(inner.format(d)),
        formatToParts: (d: Date) => inner.formatToParts(d).map((part) => ({ ...part, value: swap(part.value) })),
        resolvedOptions: () => inner.resolvedOptions(),
      };
    } as unknown as typeof Intl.DateTimeFormat;
    assert.equal(cairoDateTime12h(iphoneProbe), truth, "an engine that spaces PM with U+202F and has stale Cairo rules must still get the server's exact text");
  } finally {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
  }
  assert.ok(!truth.includes("\u202f") && /^[\x20-\x7e]+$/.test(truth), `the 12-hour text is plain ASCII (got ${JSON.stringify(truth)})`);

  // (c) The report uses it, and no longer asks the browser for a 12-hour Cairo time itself.
  const vacationReport = codeOnly(read("src/components/vacation/vacation-report.tsx"));
  assert.match(vacationReport, /function formatDateTime\([^)]*\)\s*\{\s*return cairoDateTime12h\(value\);/, "the Vacation Report formats its instants through cairoDateTime12h");
  assert.doesNotMatch(vacationReport, /hour12\s*:\s*true/, "the Vacation Report must not ask the browser for a 12-hour time — that is the AM/PM space an iPhone draws differently");

  // (d) The same bug, a second time: the evidence list on a vacation approval (System Audit, 28 and
  // 31 Oct 2026 — a Super Admin's Mac and a Regional Manager's iPhone, both on sick notes). It is
  // drawn on the server and again in the browser, and it asked the browser for "Oct 26, 2026, 05:29
  // PM" with `Intl.DateTimeFormat("en", { hour12: true })`. The sweep in 3f only looks for an en-GB
  // month, so it never saw this file; (e) below is the sweep that would have.
  const attachmentHistory = codeOnly(read("src/components/vacation/vacation-attachment-history.tsx"));
  assert.match(attachmentHistory, /function formatUploadedAt\([^)]*\)\s*\{\s*return cairoDateTime12h\(value\);/, "🔴 the vacation evidence list formats each upload time through cairoDateTime12h");
  assert.doesNotMatch(attachmentHistory, /Intl\.DateTimeFormat|toLocale(?:Date|Time)?String|hour12/, "🔴 the vacation evidence list must not ask the browser for a time — an Apple device spaces PM differently from the server");

  // (d2) The same bug a third time, on Access Control (System Audit, "/admin/access", 31 Oct 2026):
  // "Updated Oct 28, 11:16 AM" on every account row and audit line, from `Intl.DateTimeFormat("en-US",
  // { hour: "2-digit", … })` — no `hour12` written, but en-US with an hour IS the 12-hour clock.
  // cairoMonthDayTime12h prints exactly what the server printed, and asks the engine for nothing.
  const accessServerBefore = new Intl.DateTimeFormat("en-US", {
    day: "2-digit", hour: "2-digit", minute: "2-digit", month: "short", timeZone: "Africa/Cairo",
  });
  for (const iso of [
    "2026-10-28T08:16:59Z", "2026-09-05T22:05:00Z", "2026-01-01T00:00:00Z", "2026-06-15T09:00:00Z",
    "2026-04-24T21:59:00Z", "2026-10-29T21:00:00Z", "2026-12-31T22:00:00Z", "2026-03-10T11:59:00Z",
  ]) {
    assert.equal(cairoMonthDayTime12h(iso), accessServerBefore.format(new Date(iso)).replace(/[  ]/g, " "), `${iso}: Access Control's time must read exactly as the server printed it before`);
  }
  assert.equal(cairoMonthDayTime12h(null), "-", "an empty instant is a dash");
  try {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = function SafariLike() {
      return { format: () => "Jan 01, 01:00 AM", formatToParts: () => [], resolvedOptions: () => ({}) };
    } as unknown as typeof Intl.DateTimeFormat;
    assert.equal(cairoMonthDayTime12h("2026-10-28T08:16:59Z"), "Oct 28, 11:16 AM", "🔴 Access Control's time must not depend on the reader's engine at all");
  } finally {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
  }
  const accessControl = codeOnly(read("src/components/admin/access-control-manager.tsx"));
  assert.match(accessControl, /function formatDate\([^)]*\)\s*\{\s*return cairoMonthDayTime12h\(value\);/, "🔴 Access Control formats its times through cairoMonthDayTime12h");

  // (d3) Offers (System Audit, "/offers", 31 Oct 2026). Its four recorded #418s were the Cloudflare
  // email rewrite (every offer row prints the candidate's email; none in 13 days of use before the
  // 26 Oct move, two on each of the two days after). What remained was offerWhen — the "Sent" time on
  // every row — asking the reader's engine for an en-GB short month: "Sept" on the server, "Sep" in an
  // older browser, every September. 3f never saw it because offer-ui.ts is a plain module the client
  // composer imports, not a "use client" file. It now goes through formatStableEnGb, byte-identical.
  const offerWhenBefore = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", { day: "2-digit", hour: "2-digit", minute: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" });
  for (let month = 0; month < 12; month += 1) {
    const iso = new Date(Date.UTC(2026, month, 14, 9, 7)).toISOString();
    assert.equal(offerWhen(iso), offerWhenBefore(iso), `${iso}: the offer's Sent time must read exactly as the server printed it before`);
  }
  assert.equal(offerWhen(null), "—", "an unsent offer keeps its dash");
  assert.equal(offerWhen("not a date"), "—", "an unreadable instant keeps its dash");
  const septemberSend = "2026-09-14T09:07:00Z";
  const serverSeptember = offerWhen(septemberSend);
  try {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = function OlderEngine(locale?: string, options?: Intl.DateTimeFormatOptions) {
      const inner = new RealDateTimeFormat(locale, options);
      const old = (text: string) => text.replace(/\bSept\b/g, "Sep");
      return {
        format: (d: Date) => old(inner.format(d)),
        formatToParts: (d: Date) => inner.formatToParts(d).map((part) => ({ ...part, value: old(part.value) })),
        resolvedOptions: () => inner.resolvedOptions(),
      };
    } as unknown as typeof Intl.DateTimeFormat;
    assert.equal(offerWhen(septemberSend), serverSeptember, "🔴 an older engine that spells September 'Sep' must still get the server's exact Sent time");
  } finally {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
  }
  const offerUi = codeOnly(read("src/components/offers/offer-ui.ts"));
  assert.match(offerUi, /export function offerWhen\([^)]*\)[^{]*\{[\s\S]*?return formatStableEnGb\(parsed,/, "🔴 the offer's Sent time goes through formatStableEnGb");
  assert.doesNotMatch(offerUi, /\.toLocale(?:Date|Time)?String\(\s*["']en-GB["']/, "🔴 offer-ui must not ask the reader's engine for an en-GB date");

  // (d4) Recruitment (System Audit, "/recruitment", "/recruitment/previous" and a candidate's page,
  // 26–29 Oct 2026). All eight recorded #418s were one HR Resourcing reader from 26 Oct on — the
  // Cloudflare email rewrite #6718 ended; she used the same pages 20–25 Oct with none. What remained
  // asked the reader's engine for Africa/Cairo: the pool's Received time (`toLocaleTimeString` in
  // recruitment-workspace.tsx's own cairoDateTime) and every workspace row's stamp (`cairoStamp`, an
  // Intl formatter zoned to Africa/Cairo). An engine built before Egypt's 2023 return to daylight
  // saving prints those an hour early from late April to late October, on rows the server already
  // drew. Both now read the shipped offset table, and nothing on screen moves.
  const workspaceStampWith = (format: Intl.DateTimeFormat) => (iso: string, today: string) => {
    const parts = format.formatToParts(new Date(iso));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const day = `${Number(part("day"))} ${CAIRO_MONTHS[Number(part("month")) - 1]}`;
    return `${Number(part("year")) === Number(today.slice(0, 4)) ? day : `${day} ${part("year")}`} · ${part("hour")}:${part("minute")}`;
  };
  const workspaceStampOptions: Intl.DateTimeFormatOptions = {
    day: "numeric", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "numeric", timeZone: "Africa/Cairo", year: "numeric",
  };
  const workspaceStampBefore = workspaceStampWith(new RealDateTimeFormat("en-GB", workspaceStampOptions));
  const poolReceivedBefore = (iso: string) =>
    `${stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date(iso))} · ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" })}`;
  for (const iso of [
    "2026-01-15T08:05:00Z", "2026-04-23T21:59:00Z", "2026-04-23T22:00:00Z", "2026-07-01T21:30:00Z", "2026-09-14T09:07:00Z",
    "2026-10-19T14:32:00Z", "2026-10-29T20:59:00Z", "2026-10-29T21:00:00Z", "2026-12-31T22:00:00Z", "2025-06-01T09:05:00Z",
  ]) {
    assert.equal(cairoStamp(iso, "2026-10-31"), workspaceStampBefore(iso, "2026-10-31"), `${iso}: a workspace row's stamp must read exactly as the server printed it before`);
    assert.equal(cairoDateTime(iso), poolReceivedBefore(iso), `${iso}: the pool's Received time must read exactly as the server printed it before`);
  }
  const summerArrival = "2026-07-01T09:30:00Z";
  const [serverStamp, serverReceived] = [cairoStamp(summerArrival, "2026-10-31"), cairoDateTime(summerArrival)];
  try {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = function PreDaylightSavingEngine(locale?: string, options?: Intl.DateTimeFormatOptions) {
      return new RealDateTimeFormat(locale, options?.timeZone === "Africa/Cairo" ? { ...options, timeZone: "Etc/GMT-2" } : options);
    } as unknown as typeof Intl.DateTimeFormat;
    assert.notEqual(workspaceStampWith(new Intl.DateTimeFormat("en-GB", workspaceStampOptions))(summerArrival, "2026-10-31"), serverStamp, "the probe really is stale: asked for Cairo, it answers an hour early in July");
    assert.equal(cairoStamp(summerArrival, "2026-10-31"), serverStamp, "🔴 an engine with pre-2023 Cairo rules must still get the server's exact row stamp");
    assert.equal(cairoDateTime(summerArrival), serverReceived, "🔴 an engine with pre-2023 Cairo rules must still get the server's exact Received time");
  } finally {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
  }
  const workspaceFormat = codeOnly(read("src/components/recruitment/workspace/workspace-format.ts"));
  assert.match(workspaceFormat, /cairoWallClock\(instant\)/, "🔴 the workspace stamps read Cairo's wall clock from the shipped table");
  assert.doesNotMatch(workspaceFormat, /Intl\.DateTimeFormat|toLocale(?:Date|Time)?String|Africa\/Cairo/, "🔴 workspace-format must not ask the reader's engine for Cairo's time");
  const recruitmentPool = codeOnly(read("src/components/recruitment/recruitment-workspace.tsx"));
  assert.match(recruitmentPool, /import \{[^}]*\bcairoDateTime\b[^}]*\} from "@\/lib\/format\/cairo-datetime";/, "🔴 the recruitment pool prints its times through the shared cairoDateTime");
  assert.doesNotMatch(recruitmentPool, /function cairoDateTime\(|toLocaleTimeString\(|timeZone:\s*["']Africa\/Cairo["']/, "🔴 the recruitment pool must not keep its own Cairo formatter or ask the reader's engine for Cairo's time");

  // (d5) My Map (System Audit, "/employee-portals/my-map", 28 Oct 2026, a rep's iPhone). Its customer list is
  // sorted during the first render, and a bare `localeCompare` sorts by the ENGINE'S own language: Node (en-US)
  // and a phone set to Arabic disagree about أحمد / احمد, مستشفى / مستشفي and where the English-written names go,
  // and one row apart is #418. The owner: "make all names arabic" — every name on My Map sorts by Arabic rules,
  // on the server and on every phone alike, whatever language the engine itself speaks.
  const myMapNames = ["Campaign visit 3", "مستشفي الأمل", "أحمد علي", "مستشفى السلام", "احمد سمير", "آمال حسن", "ENT Clinic", "ليلي", "ليلى"];
  const arabicOrder = [...myMapNames].sort((left, right) => left.localeCompare(right, "ar"));
  assert.notDeepEqual([...myMapNames].sort((left, right) => left.localeCompare(right, "en")), arabicOrder, "the probe really separates the two languages: English rules order these names differently");
  assert.ok(arabicOrder.indexOf("آمال حسن") < arabicOrder.indexOf("Campaign visit 3"), "Arabic names lead, the English-written ones follow");
  const RealLocaleCompare = String.prototype.localeCompare;
  for (const engineLanguage of ["en-US", "ar-EG"]) {
    (String.prototype as { localeCompare: unknown }).localeCompare = function (this: string, that: string, locales?: string | string[], options?: Intl.CollatorOptions) {
      return RealLocaleCompare.call(this, that, locales ?? engineLanguage, options);
    };
    try {
      assert.deepEqual([...myMapNames].sort(compareMyMapNames), arabicOrder, `🔴 My Map's names must sort the Arabic way on an engine whose own language is ${engineLanguage}`);
    } finally {
      (String.prototype as { localeCompare: unknown }).localeCompare = RealLocaleCompare;
    }
  }
  const myMapScreen = codeOnly(read("src/components/phoenix-crm/my-map/my-map-screen.tsx"));
  assert.match(myMapScreen, /compareMyMapNames\(left\.customer\.name, right\.customer\.name\)/, "🔴 My Map's customer list sorts through compareMyMapNames");
  assert.doesNotMatch(myMapScreen, /\.localeCompare\(/, "🔴 My Map's screen must not sort by the reader's own language — use compareMyMapNames");
  const myMapRules = codeOnly(read("src/lib/phoenix-crm/my-map-rules.ts"));
  assert.match(myMapRules, /compareMyMapNames\(String\(facts\.get\(left\.customerId\)/, "🔴 the server orders the pins by the same Arabic rules");

  // (d6) Direct Orders (System Audit, "/employee-portals/direct-orders/[id]", 26 and 27 Oct 2026, one
  // District Manager's iPhone, both on Back to an order she raised). No app code on her screen drew text
  // that differs between server and phone, and neither order carried an email for Cloudflare to rewrite;
  // the probe now names the outside rewriter it could not see (error-monitor-third-party-attribution).
  // What the page DID hold was one engine-dependent day: the "Sent back to you" card printed
  // `toLocaleDateString("en-GB")` with no zone — the server's UTC day, the phone's Cairo day — so a
  // return sent between midnight and 3 AM Cairo was a day apart on the requester's own order.
  const lateReturn = "2026-10-29T22:30:00Z"; // 30 Oct, 00:30 in Cairo
  assert.notEqual(
    new Date(lateReturn).toLocaleDateString("en-GB", { timeZone: "UTC" }),
    new Date(lateReturn).toLocaleDateString("en-GB", { timeZone: "Africa/Cairo" }),
    "the probe really is engine-dependent: the UTC server and a Cairo phone print different days",
  );
  assert.equal(cairoDate(lateReturn), "30 Oct 2026", "🔴 a return sent at 00:30 Cairo reads as the Cairo day");
  try {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = function PreDaylightSavingEngine(locale?: string, options?: Intl.DateTimeFormatOptions) {
      return new RealDateTimeFormat(locale, options?.timeZone === "Africa/Cairo" ? { ...options, timeZone: "Etc/GMT-2" } : options);
    } as unknown as typeof Intl.DateTimeFormat;
    assert.equal(cairoDate("2026-07-01T21:30:00Z"), "02 Jul 2026", "🔴 an engine with pre-2023 Cairo rules must still get the server's return day");
  } finally {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
  }
  const correctResubmit = codeOnly(read("src/components/direct-orders/direct-order-correct-resubmit.tsx"));
  assert.match(correctResubmit, /returnComment\.at \? ` · \$\{cairoDate\(returnComment\.at\)\}`/, "🔴 the return's day is printed through cairoDate");
  assert.doesNotMatch(correctResubmit, /\.toLocale(?:Date|Time)?String\(|Intl\.DateTimeFormat/, "🔴 the correction card must not ask the reader's engine for a date");

  // (e) No NEW client component may ask the browser for a 12-hour time. `hour12: true`, an h11/h12
  // hourCycle, or an "en"/"en-US" call with an hour (whose default is 12-hour) all print the AM/PM
  // space that Safari's engine draws as U+202F and Node's as a plain space. A call that only runs
  // after the page has loaded (an effect, a handler, a ticking clock) is harmless, and the files
  // below were frozen on 31 Oct 2026 without that being checked one by one — so the list is a
  // ratchet: it may only shrink. A new file, or one more call in a listed file, is refused; route it
  // through cairoDateTime12h or a mount effect. A fixed call means lowering its number here.
  const KNOWN_CLIENT_12H_CALLS: Record<string, number> = {
    "src/components/admin/ceo-hero-clock.tsx": 1,
    "src/components/admin/email-notification-center.tsx": 1,
    "src/components/admin/notification-confidence-workspace.tsx": 1,
    "src/components/admin/workflow-registry-manager.tsx": 1,
    "src/components/coaching/employee-coaching-review-impl.tsx": 1,
    "src/components/employee-portal/employee-excuses-workspace.tsx": 1,
    "src/components/employee-portal/employee-portal-layout.tsx": 1,
    "src/components/employee-portal/marketing-control-workspace.tsx": 1,
    "src/components/employee-portal/my-visits-workspace.tsx": 2,
    "src/components/employee-portal/private-calendar.tsx": 1,
    "src/components/field-workforce-compliance/field-workforce-compliance-workspace.tsx": 1,
    "src/components/field-workforce-compliance/field-workforce-route-map.tsx": 1,
    "src/components/layout/in-app-notifications-bell.tsx": 1,
    "src/components/layout/internal-messages-menu.tsx": 1,
    "src/components/phoenix-signature-card/PhoenixIdentityNotices.tsx": 1,
    "src/components/sales/portal/portal-sos-dashboard-impl.tsx": 1,
  };
  const twelveHourCalls = new Map<string, number>();
  const callArguments = (source: string, from: number): string | null => {
    const open = source.indexOf("(", from);
    if (open === -1 || open - from > 2) return null;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    return null;
  };
  const sweepTwelveHour = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        sweepTwelveHour(rel);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = codeOnly(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
      if (!/^\s*["']use client["']/m.test(source.slice(0, 2000))) continue;
      const callPattern = /new Intl\.DateTimeFormat|\.toLocale(?:Date|Time)?String/g;
      for (let m; (m = callPattern.exec(source)); ) {
        const args = callArguments(source, m.index + m[0].length);
        if (!args) continue;
        const englishDefault = /^\(\s*["']en(?:-US)?["']/.test(args);
        const twelveHour =
          /hour12\s*:\s*true/.test(args) ||
          /hourCycle\s*:\s*["']h1[12]["']/.test(args) ||
          (englishDefault && /\b(?:hour|timeStyle)\s*:/.test(args) && !/hour12\s*:\s*false/.test(args) && !/hourCycle\s*:\s*["']h2[34]["']/.test(args));
        if (twelveHour) twelveHourCalls.set(rel, (twelveHourCalls.get(rel) ?? 0) + 1);
      }
    }
  };
  sweepTwelveHour("src");
  sweepTwelveHour("app");
  const ratchetBreaks: string[] = [];
  for (const [file, count] of twelveHourCalls) {
    const known = KNOWN_CLIENT_12H_CALLS[file] ?? 0;
    if (count > known) ratchetBreaks.push(`${file}: ${count} call(s), ${known} allowed — NEW, and a #418 on every Apple device if it draws during the first render`);
  }
  for (const [file, known] of Object.entries(KNOWN_CLIENT_12H_CALLS)) {
    const count = twelveHourCalls.get(file) ?? 0;
    if (count < known) ratchetBreaks.push(`${file}: ${count} call(s) now, ${known} listed — lower its number in KNOWN_CLIENT_12H_CALLS so it cannot creep back`);
  }
  assert.deepEqual(
    ratchetBreaks,
    [],
    `🔴 client components asking the browser for a 12-hour time — the AM/PM space Safari draws as U+202F and the server as a plain space, React #418:\n  ${ratchetBreaks.join("\n  ")}`,
  );
}
