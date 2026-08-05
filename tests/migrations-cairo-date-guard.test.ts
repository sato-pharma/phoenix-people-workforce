import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Recurrence guard for the "SQL function reads an unzoned date" class.
//
// Root cause (see 20260801180000_cairo_date_in_lifecycle_and_seat_functions.sql): production
// Postgres runs `TimeZone = UTC`, but the business, the app and the SQL writers all work in
// Africa/Cairo (UTC+3 in summer). So a bare `current_date` inside a function body evaluates to
// YESTERDAY for the three hours between Cairo 00:00 and 03:00 — UTC 21:00-24:00 of the previous
// day. Nothing errors; the function just silently uses the wrong day every night.
//
// That is not a theoretical window. It shipped a wrong HIRE DATE
// (accept_offer_and_create_employee), which then propagates into the +90-day probation end date
// and the contract anniversary, and it moved SoS credit between people nightly, because
// au.f_seat_occupant_asof read in UTC while its writer stamped Cairo.
//
// The correct expression, used everywhere in this repo, is
// `(now() at time zone 'Africa/Cairo')::date`. The TypeScript-side equivalents are
// `currentCairoDateOnlyIso` / `currentCairoDateParts` in src/lib/i18n/format.ts.
//
// Migrations before the cutoff are grandfathered: the five replacement/vacancy-ownership
// functions still read unzoned `current_date` live and are tracked separately, because a parallel
// session was reshaping them when this guard landed. Re-emitting any of them in a NEW migration
// must carry the Cairo fix — which is exactly what this guard forces.
export function runMigrationsCairoDateGuardTests() {
  // Cutoff = the migration that Cairo-zoned the first four functions. Everything named on or
  // after it is held to the rule.
  const CUTOFF = "20260801180000";
  const CAIRO_MIGRATION = "20260801180000_cairo_date_in_lifecycle_and_seat_functions.sql";
  const dir = "supabase/migrations";

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /^\d{14}_/.test(f))
    .filter((f) => f.slice(0, 14) >= CUTOFF)
    .sort();

  // Strip anything that is inert text, so an explanatory comment describing the bug — this
  // guard's own migration header is full of them — cannot be mistaken for a real occurrence.
  // ONE left-to-right pass, deliberately not a sequence of .replace() calls. Two independent
  // passes are wrong in whichever order you pick:
  //   comments first → a `--` inside a literal, ('Split -- out', current_date), truncates the line
  //                    and the guard silently misses the current_date after it;
  //   literals first → an apostrophe inside a comment, `-- the owner's decision`, opens a literal
  //                    that swallows real code up to the next quote.
  // Only a single scan consuming whichever delimiter it meets first is correct in both directions.
  // Inert spans are blanked to spaces rather than deleted so newlines survive and the offender
  // line numbers reported below stay accurate.
  function stripInertText(raw: string): string {
    const blank = (s: string) => s.replace(/[^\n]/g, " ");
    let out = "";
    let i = 0;

    while (i < raw.length) {
      if (raw[i] === "-" && raw[i + 1] === "-") {
        const nl = raw.indexOf("\n", i);
        const stop = nl === -1 ? raw.length : nl;
        out += blank(raw.slice(i, stop));
        i = stop;
      } else if (raw[i] === "/" && raw[i + 1] === "*") {
        const close = raw.indexOf("*/", i + 2);
        const stop = close === -1 ? raw.length : close + 2;
        out += blank(raw.slice(i, stop));
        i = stop;
      } else if (raw[i] === "'") {
        let j = i + 1;
        while (j < raw.length) {
          if (raw[j] !== "'") {
            j += 1;
          } else if (raw[j + 1] === "'") {
            j += 2; // '' is an escaped quote — still inside the literal
          } else {
            j += 1;
            break;
          }
        }
        out += blank(raw.slice(i, j));
        i = j;
      } else {
        out += raw[i];
        i += 1;
      }
    }
    return out;
  }

  // The scanner is this guard's blind spot if it is wrong, so pin both failure directions.
  assert.match(
    stripInertText("insert into x values ('Split -- out of GZ6', current_date);"),
    /current_date/,
    "a -- inside a string literal must not hide the rest of the line from the guard",
  );
  // Two apostrophes, not one: a single apostrophe can never open a literal, so a one-apostrophe
  // case passes even under the broken literals-first ordering and proves nothing. With two, that
  // ordering opens a literal at `owner'` and closes it at `that'`, blanking the real statement
  // between them — measured, it swallows the entire input.
  assert.match(
    stripInertText(
      [
        "-- the owner's decision 2026-08-03",
        "insert into au.line_area_map values ('UE9', current_date);",
        "-- that's the whole change",
      ].join("\n"),
    ),
    /current_date/,
    "apostrophes in two comments must not open a literal spanning the real code between them",
  );
  assert.doesNotMatch(
    stripInertText("-- this comment merely describes current_date\nselect 1;"),
    /current_date/,
    "a comment naming the banned expression must still be inert",
  );
  assert.equal(
    stripInertText("a\n/* multi\nline */\nb").split("\n").length,
    4,
    "blanking must preserve newlines so offender line numbers stay accurate",
  );

  // Unzoned "today" expressions. `current_date` is the one that actually bit; `now()::date` and
  // `current_timestamp::date` are the same defect written differently, so close them too.
  const BANNED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    { label: "current_date", pattern: /\bcurrent_date\b/i },
    { label: "now()::date", pattern: /\bnow\s*\(\s*\)\s*::\s*date\b/i },
    { label: "current_timestamp::date", pattern: /\bcurrent_timestamp\s*::\s*date\b/i },
  ];

  const offenders: string[] = [];

  for (const file of files) {
    const sql = stripInertText(readFileSync(`${dir}/${file}`, "utf8"));
    const lines = sql.split("\n");
    for (const [i, line] of lines.entries()) {
      for (const banned of BANNED) {
        if (banned.pattern.test(line)) {
          offenders.push(`${file}:${i + 1} uses ${banned.label}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Every migration dated >= ${CUTOFF} must express "today" as (now() at time zone ` +
      `'Africa/Cairo')::date, never an unzoned current_date / now()::date. Production Postgres is ` +
      `on UTC, so an unzoned date is YESTERDAY between Cairo 00:00 and 03:00 every night — that is ` +
      `how a wrong hire date and nightly SoS credit drift shipped. Offenders: ${offenders.join(", ")}`,
  );

  // Sanity: the guard is actually scanning something, so a glob or cutoff regression cannot turn
  // it into a silent no-op that passes forever.
  assert.ok(
    files.includes(CAIRO_MIGRATION),
    `the Cairo date migration (${CAIRO_MIGRATION}) must exist and be scanned by this guard`,
  );

  // And the fix it pins is actually present: four Cairo-zoned function bodies, no bare date.
  const cairoSql = stripInertText(readFileSync(`${dir}/${CAIRO_MIGRATION}`, "utf8"));
  assert.equal(
    (cairoSql.match(/CREATE OR REPLACE FUNCTION/gi) ?? []).length,
    4,
    "the Cairo migration must re-emit all four function bodies (3 public + au.f_seat_occupant_asof)",
  );
  assert.equal(
    (cairoSql.match(/SECURITY DEFINER/gi) ?? []).length,
    4,
    "all four bodies must keep SECURITY DEFINER — CREATE OR REPLACE does not inherit it, and " +
      "dropping it would break every caller without direct table access",
  );
}
