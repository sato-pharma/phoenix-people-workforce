import assert from "node:assert/strict";
import path from "node:path";

import { cachedIsDirectory, cachedReaddir, cachedReadFile } from "./support/source-corpus.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Standing owner rule: "Report every time in Africa/Cairo local time, never raw UTC."
//
// An Intl date format with no `timeZone` uses THE RUNTIME'S zone. That is the
// whole defect, and it is invisible on this laptop, because this laptop's zone
// IS Africa/Cairo — so the wrong code and the right code print the same string
// here. Railway runs with no TZ set, which means UTC. Cairo is UTC+2/+3, so an
// unzoned instant renders 2–3 hours EARLY in production, and anything logged
// after 21:00 Cairo renders on the WRONG DAY.
//
// WHAT COUNTS
// A date-format call that renders a time-of-day component (`hour`, `minute`,
// `second`, `timeStyle`) and supplies no `timeZone`. Those two facts together
// mean a real instant is being rendered in whatever zone the process happens to
// be in.
//
// WHAT IS NOT A VIOLATION
//   - A DATE-ONLY format. `src/lib/i18n/format.ts` pins UTC on purpose for these:
//     they render a date-only literal anchored at T00:00:00Z, and re-zoning one
//     to Cairo shifts it a day backwards. formatDateOnly must not be "fixed".
//   - A call that supplies the zone as an ES6 SHORTHAND — `{ hour: "2-digit",
//     timeZone }`. This is not a hypothetical: the first census run for this
//     ratchet reported 20 sites where the truth was 19, because a colon-anchored
//     `timeZone:` regex missed the shorthand in two of the most careful helpers
//     in the repo (`src/lib/attendance/timezone.ts`, whose entire docstring is
//     about getting Cairo's offset right, and `src/lib/cron-control/
//     cron-expression.ts`). Both were flagged as bugs and neither was one. The
//     detector self-checks below now pin that case so it cannot come back.
//
// TWO ARMS, NOT ONE, BECAUSE THE RISK IS NOT UNIFORM
//   - A file carrying "use client" only ever runs in a browser. Every Phoenix
//     user is in Cairo, so those 17 are accidentally correct today and latent
//     rather than broken. They RATCHET: the count may fall, never rise.
//   - A file without the directive CAN render on the server, where the clock is
//     UTC. Those are wrong the moment they run. Zero tolerance, no baseline.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-08-29 in the worktree that fixed the two server-side sites.
 *
 * The pre-fix tree had 19: these same 17, plus `coaching-report-detail.tsx:73`
 * (every coaching-report timestamp, rendered server-side in UTC) and
 * `private-calendar/export.ts:86` (the "Generated" stamp inside every downloaded
 * sheet and PDF). Both now pass PHOENIX_BUSINESS_TIME_ZONE.
 *
 * An earlier census put the totals at 20/18. That figure counted a shorthand
 * `timeZone` as missing — see WHAT IS NOT A VIOLATION above. Nothing changed on
 * screen between 20 and 19; only the measurement stopped being wrong.
 *
 * Lower this when sites are genuinely retired; never raise it to make a red run green.
 */
// Lowered 17 -> 16 in the C6 deductions cutover (2026-08-30): removing the legacy governance
// client components (the governance workspace and the Payroll Copilot deduction-review table)
// deleted one unzoned client-side instant format, and the ratchet locks that ground in.
// Lowered 15 -> 13 retiring the legacy probation feedback path (2026-09-01): both sites were in
// feedback-form-panel.tsx — the submission stamp and the comment stamp, each an unzoned
// Intl.DateTimeFormat over a stored instant. That file is deleted, so they cannot come back.
// Lowered 13 -> 12 fixing admin-profile-form.tsx's React hydration error #418 (2026-09-05): its
// formattedCreatedAt was a bare, zone-less Intl.DateTimeFormat, now routed through the shared
// cairoDateTime() helper, so the site is zoned and no longer counts as unzoned.
// Lowered 12 -> 11 pinning plan-conversation-thread.tsx (2026-09-08): the comment stamp was a bare
// toLocaleString("en-GB") over comment.createdAt, naming no zone at all, so it rendered in the
// reader's device zone; now cairoDateTime(). The two sites fixed alongside it in the same commit
// (my-visits-workspace, double-visit-report-workspace) do NOT move this number and should not be
// expected to — both already named timeZone: "UTC" deliberately and were counted as zoned. Their
// bug was the en-GB month abbreviation, which this ratchet does not measure.
// Lowered 11 -> 9 in the Medical Rep portal polish (2026-09-25): two unzoned client stamps in the
// rep's deductions and ROI screens now format in Africa/Cairo, as every time the owner reads is.
// Lowered 9 -> 7 in the field-activity clock sweep (2026-10-05). Re-measured, not earned: this
// branch re-formatted no client site, so the two went with work done between 09-25 and now and
// nobody lowered the number. That is exactly what the warning below exists to catch, and leaving
// it at 9 would have left two sites' worth of slack for a new one to be added into unnoticed.
const CLIENT_BASELINE = 7;

/**
 * Not a baseline — a rule. A server-rendered instant with no zone is wrong in
 * production on the day it is written. It was 2 before this ratchet landed.
 */
const SERVER_CAPABLE_ALLOWED = 0;

const ROOTS = ["app", "src"];

/** Every way this codebase formats a date or an instant. */
const CALL_HEAD =
  /(?:Intl\.DateTimeFormat|\.toLocaleString|\.toLocaleDateString|\.toLocaleTimeString)\s*\(/g;

/** A time-of-day component: the thing that makes this an INSTANT and not a date. */
const TIME_FIELD = /\b(?:hour|minute|second|timeStyle|hour12|hourCycle)\s*:/;

/**
 * Deliberately a bare word, NOT `timeZone\s*:`. `{ hour: "2-digit", timeZone }`
 * supplies the zone exactly as surely as `timeZone: "Africa/Cairo"` does.
 */
const TIME_ZONE = /\btimeZone\b/;

/**
 * True only when the directive is the file's FIRST real line, which is the only
 * place Next honours it. A looser test would let a file that merely mentions the
 * string escape the zero-tolerance arm into the ratcheted one.
 */
function isClientComponent(strippedSource: string): boolean {
  const first = strippedSource.split("\n").find((line) => line.trim().length > 0);
  return first !== undefined && /^\s*["']use client["']/.test(first);
}

/**
 * Read the full argument list of the call whose `(` sits at `openIndex`.
 *
 * A fixed line window cannot do this. These options objects span 6–10 lines, and
 * the call almost always ends `.format(new Date(value))` — a nested paren pair
 * that a naive scan closes on, truncating the arguments and hiding the very
 * `timeZone` key being looked for. String literals are tracked so a `)` inside
 * one (`"h:mm a (z)"`) does not end the extraction early either.
 */
function extractArgs(source: string, openIndex: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

type Site = { site: string; isClient: boolean };

function scan(label: string, rawSource: string): { sites: Site[]; calls: number } {
  const source = stripComments(rawSource);
  const isClient = isClientComponent(source);
  const sites: Site[] = [];
  let calls = 0;
  CALL_HEAD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_HEAD.exec(source))) {
    calls += 1;
    const args = extractArgs(source, match.index + match[0].length - 1);
    if (args === null) continue;
    if (!TIME_FIELD.test(args)) continue;
    if (TIME_ZONE.test(args)) continue;
    sites.push({ site: `${label}:${source.slice(0, match.index).split("\n").length}`, isClient });
  }
  return { sites, calls };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of cachedReaddir(dir)) {
    const full = path.join(dir, entry);
    if (cachedIsDirectory(full)) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runInstantFormatTimezoneRatchetTests() {
  // ───────────────────────────────────────────────────────────────────────────
  // Check the detector against known inputs BEFORE trusting it on ~2,900 files.
  // A ratchet whose regex is wrong does not fail loudly — it reports a number,
  // and a wrong number looks exactly as authoritative as a right one. Two of
  // these cases are here because the detector really did get them wrong while it
  // was being written, and the wrong answer was a confident accusation against
  // correct code.
  // ───────────────────────────────────────────────────────────────────────────
  const count = (snippet: string) => scan("probe.ts", snippet).sites.length;

  assert.equal(
    count('new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(d)'),
    1,
    "an instant format with no timeZone is the violation this whole file exists for",
  );
  assert.equal(
    count('new Intl.DateTimeFormat("en-US", { hour: "2-digit", timeZone: "Africa/Cairo" }).format(d)'),
    0,
    "an explicit zone is compliant",
  );
  assert.equal(
    count('new Intl.DateTimeFormat("en-US", { hour: "2-digit", timeZone }).format(d)'),
    0,
    "a SHORTHAND zone is compliant — the census that read 20 instead of 19 missed exactly this, and accused two correct helpers",
  );
  assert.equal(
    count('new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(d)'),
    0,
    "a DATE-ONLY format is out of scope: formatDateOnly pins UTC on purpose and re-zoning it shifts the day backwards",
  );
  assert.equal(
    count('d.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit" })'),
    1,
    "toLocaleString is the same defect wearing a different name",
  );
  assert.equal(
    count('d.toLocaleTimeString("en-GB", { hour: "2-digit", timeZone: TZ })'),
    0,
    "a zone from a constant is still a zone",
  );
  assert.equal(
    count("// no timeZone here, so it would render in UTC — prose describing the rule\nconst x = 1;"),
    0,
    "a comment naming the rule is documentation, not a violation",
  );

  // The nested-paren case: `.format(new Date(v))` closes two pairs after the
  // options object. A scanner that stops at the first `)` never sees `timeZone`.
  assert.equal(
    count(
      'new Intl.DateTimeFormat("en-US", {\n  hour: "2-digit",\n  minute: "2-digit",\n  timeZone: "Africa/Cairo",\n}).format(new Date(value))',
    ),
    0,
    "balanced-paren extraction must read past a nested .format(new Date(v)) to find the zone that is really there",
  );
  // ...and the same shape WITHOUT a zone must still be caught, or the check above
  // could be passing because the extraction failed rather than because it worked.
  assert.equal(
    count('new Intl.DateTimeFormat("en-US", {\n  hour: "2-digit",\n}).format(new Date(value))'),
    1,
    "the multi-line shape must still be caught when the zone is genuinely absent",
  );
  assert.equal(
    count('new Intl.DateTimeFormat("en-US", { hour: "2-digit", dayPeriod: "short" }).format(d) + ")"'),
    1,
    "a parenthesis inside a string literal must not end the argument extraction early",
  );

  // The client/server split decides which arm a site lands in, so it is checked too.
  assert.equal(
    scan("probe.tsx", '"use client";\nconst s = d.toLocaleString("en-GB", { hour: "2-digit" });').sites[0]?.isClient,
    true,
    "a leading use-client directive puts the site in the ratcheted arm",
  );
  assert.equal(
    scan("probe.ts", 'const s = d.toLocaleString("en-GB", { hour: "2-digit" });').sites[0]?.isClient,
    false,
    "no directive means the file can render on the server, where the clock is UTC",
  );
  assert.equal(
    scan("probe.ts", 'const help = "use client";\nconst s = d.toLocaleString("en-GB", { hour: "2-digit" });').sites[0]
      ?.isClient,
    false,
    "the directive only counts as the FIRST real line — otherwise a string mentioning it would buy an exemption from the strict arm",
  );

  // Line numbers survive stripping, or every file:line reported below is shifted
  // upward by the size of whatever comment block sat above it.
  assert.equal(
    scan("probe.ts", '/*\n * a note\n */\nd.toLocaleString("en-GB", { hour: "2-digit" });').sites[0]?.site,
    "probe.ts:4",
    "stripping must preserve line numbers, or every site this test prints is wrong",
  );

  // ───────────────────────────────────────────────────────────────────────────

  const files = ROOTS.flatMap((r) => walk(r));
  assert.ok(
    files.length > 1000,
    `only ${files.length} source files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  let dateFormatCalls = 0;
  const clientSites: string[] = [];
  const serverCapableSites: string[] = [];
  for (const file of files) {
    const { sites, calls } = scan(file.replace(/\\/g, "/"), cachedReadFile(file));
    dateFormatCalls += calls;
    for (const found of sites) (found.isClient ? clientSites : serverCapableSites).push(found.site);
  }

  assert.ok(
    dateFormatCalls > 600,
    `only ${dateFormatCalls} date-format calls were found across ${files.length} files — the call regex has stopped matching, so a count of zero violations would mean nothing`,
  );

  // ARM 1 — zero tolerance. These render in production, in UTC.
  assert.equal(
    serverCapableSites.length,
    SERVER_CAPABLE_ALLOWED,
    `${serverCapableSites.length} instant(s) are formatted with no timeZone in a file that can render on the SERVER, ` +
      `whose clock is UTC. In production these read 2-3 hours early, and after 21:00 Cairo they read on the wrong DAY.\n` +
      `Pass timeZone: PHOENIX_BUSINESS_TIME_ZONE from @/lib/i18n/format.\n` +
      `Sites:\n  ${serverCapableSites.join("\n  ")}`,
  );

  // ARM 2 — the ratchet over the browser-only sites.
  assert.ok(
    clientSites.length <= CLIENT_BASELINE,
    `${clientSites.length - CLIENT_BASELINE} new unzoned instant format(s) were added to client components — ` +
      `the count went ${CLIENT_BASELINE} -> ${clientSites.length}.\n` +
      `These are only correct because every Phoenix user's browser is in Cairo. Pass ` +
      `timeZone: PHOENIX_BUSINESS_TIME_ZONE and the site stops depending on that.\n` +
      `Sites now present:\n  ${clientSites.join("\n  ")}`,
  );

  // ARM 3 — the clocks this file cannot see at all.
  //
  // Both arms above look for an Intl call. The defect the owner reported on 2026-10-05 used none:
  // `/admin/field-activity` read the outstation claim's own GPS fix — a real timestamptz — by
  // SLICING "HH:MM" out of its string, which prints the UTC reading. B-1's 21:34 Cairo fix on
  // 2026-10-04 rendered as 18:34, beside CRM visit times that were correct to the second, and
  // nothing in this file would ever have noticed.
  //
  // String surgery on a timestamp is not itself wrong — it is how this repository reads a VENDOR
  // stamp, which is already Cairo wearing a `+00` label and must never be re-zoned. It is wrong
  // only when the value is a real instant. That is a judgement about the DATA, which no regex can
  // make, so this arm does the one thing it can: it pins the set of files allowed to do it, each
  // with the reason it is safe. A new file reading a clock by hand has to be classified here
  // first — which is the review that was missing.
  const HAND_ROLLED_CLOCK_READERS = new Map<string, string>([
    [
      "app/api/admin/field-activity/pdf/route.ts",
      "the route map's `Own GPS` label — the LOADER converts that instant first (cairoWallClockIso), so the slice reads a Cairo wall clock",
    ],
    ["src/lib/crm/dates.ts", "hasRealVendorTime — inspects a vendor stamp's time-of-day to reject the midnight placeholder"],
    ["src/lib/crm/sfe-field-analytics.ts", "crmMinutesPastMidnight — vendor check_date/crm_save_date, read as written"],
    ["src/lib/double-visit-analytics/audit-export.ts", "the coaching sheet's check-in span — vendor check_date"],
    ["src/lib/field-activity/document.ts", "clock12 — every value the field-activity model hands it is already a Cairo wall clock"],
    ["src/lib/field-activity/model.ts", "wallClock (vendor) and minutesOfDay (an already-extracted HH:MM, not a timestamp)"],
    ["src/lib/hr-ops-reports/field-section.ts", "wallClockTime — the vendor's crm_save_date, already a Cairo wall clock, read as written; the one true instant (a manager's own loggedAt) goes through cairoClockTime's Africa/Cairo formatter"],
    ["src/lib/field-workforce-compliance/ireports360-source.ts", "clockStringToMinutes — parses an HH:MM this module formatted itself"],
    ["src/lib/outstation/expense-fraud-checks.ts", "vendorClockMinutes — the vendor half of the pair whose other half, cairoClockMinutes, converts a real instant"],
    ["src/lib/sales/offline-lookup-workbook.ts", "the workbook's build stamp, whose own text says UTC"],
    ["src/lib/system-audit/sinks/file-sink.ts", "cairoDateAndTime — the instant goes through cairoWallClock FIRST, so the slice reads the Cairo date and clock of an audit finding"],
  ]);

  /** A clock read out of a timestamp by hand, with no formatter and therefore no zone to state. */
  const HAND_ROLLED = [
    /\.(?:slice|substring|substr)\(\s*11\s*,/,
    /\(\\d\{2\}\)\s*:\s*\(\\d\{2\}\)/,
    /split\(\s*["']T["']\s*\)\s*\[\s*1\s*\]/,
  ];
  const readsClockByHand = (source: string): boolean => HAND_ROLLED.some((pattern) => pattern.test(source));

  // The detector, before it is trusted on the tree — same discipline as the two arms above.
  assert.equal(readsClockByHand('const t = value.slice(11, 16);'), true, "slicing at 11 is reading a clock out of a timestamp");
  assert.equal(readsClockByHand('const d = value.slice(0, 10);'), false, "slicing the DATE half states no clock and is not this defect");
  assert.equal(readsClockByHand('/[T ](\\d{2}):(\\d{2})/.exec(value)'), true, "a hand-rolled HH:MM regex is the same read wearing a different shape");
  assert.equal(readsClockByHand('const [, time] = iso.split("T")[1];'), true, "taking the half after the T is the same read again");
  assert.equal(readsClockByHand('formatStableEnGb(d, { hour: "2-digit", timeZone: "Africa/Cairo" })'), false, "a real formatter is arms 1 and 2's business, not this one");

  const handRolled = files
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => readsClockByHand(stripComments(cachedReadFile(file))))
    .sort();
  const unclassified = handRolled.filter((file) => !HAND_ROLLED_CLOCK_READERS.has(file));
  assert.deepEqual(
    unclassified,
    [],
    `${unclassified.length} file(s) read a clock out of a timestamp by hand without being classified here.\n` +
      `That is correct ONLY for a vendor stamp (already Cairo, tagged +00) or a value something upstream has ` +
      `already converted. For a real timestamptz it prints the UTC reading — 2-3 hours early, and on the wrong ` +
      `DAY after 21:00 Cairo. Decide which it is, convert it at the seam if it is an instant, then add the file ` +
      `to HAND_ROLLED_CLOCK_READERS with the reason.\n` +
      `Unclassified:\n  ${unclassified.join("\n  ")}`,
  );
  const retired = [...HAND_ROLLED_CLOCK_READERS.keys()].filter((file) => !handRolled.includes(file)).sort();
  assert.deepEqual(
    retired,
    [],
    `${retired.length} file(s) are listed as hand-rolled clock readers but no longer read one. Remove them from ` +
      `HAND_ROLLED_CLOCK_READERS — a stale entry is a standing exemption for a file nobody has looked at since.\n` +
      `Retired:\n  ${retired.join("\n  ")}`,
  );

  // Improvement direction: fewer unzoned client formats than the baseline is a win, not a failure — a
  // PR must never go red for making the app better. Warn (so CLIENT_BASELINE can be lowered later) and
  // pass. The regression guard above (clientSites.length <= CLIENT_BASELINE) still fails on any NEW one,
  // and ARM 1's server-side guard is zero-tolerance (SERVER_CAPABLE_ALLOWED = 0), which cannot improve.
  if (clientSites.length < CLIENT_BASELINE) {
    console.warn(
      `Good news: unzoned client instant formats dropped ${CLIENT_BASELINE} -> ${clientSites.length}. Lower ` +
        `CLIENT_BASELINE in this file to ${clientSites.length} so the ground that was won cannot be given back.`,
    );
  }
}
