import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Recurrence guard for the "a leaver's last working day is credited to nobody" defect.
//
// au.occupancy_history is read half-open everywhere — effective_from <= d < effective_to —
// so effective_to is the FIRST day the person is not in the seat. au.hire_into_seat and the
// transfer path both honour that. The three resignation writers did not: each handed
// au.resign_occupant the employee's LAST WORKING DAY, which closes the person's span and
// opens the vacant span on the very same date. The last working day then falls inside the
// VACANT row.
//
// It is invisible until that day is a month end, because monthly attribution resolves every
// seat as of the period END (au.f_monthly_achievement -> au.f_seat_occupant_asof(seat,
// period_end)). Measured on production 2026-10-12: 51 occupancy boundaries sit exactly on a
// last working day, 18 of them on a month end, and 10 (seat, period) pairs resolve to NULL
// today that would resolve to the person who worked the month — including a District Manager
// seat whose 8 areas all report dm_hr_id = NULL for 2026-08.
//
// Fixed by 20261012142941_resignation_vacates_the_day_after_the_last_working_day.sql, which
// passes `last working day + 1`. This file pins that, and it reads the LATEST definition of
// each function, because `create or replace` means the last migration wins — asserting over
// every historical definition would flag bodies the database no longer has.
//
// The files are read INSIDE this function, not at module load: a guard whose evidence is
// gathered at import time cannot be break-tested, because the runner has already read the
// fixed tree before the first assertion runs.
export function runAuResignVacatesDayAfterLastWorkingDayTests() {
  const dir = "supabase/migrations";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /^\d{14}_/.test(f))
    .sort();

  assert.ok(
    files.length > 100,
    `expected the full migration history in ${dir}, saw ${files.length} files — if this fails the ` +
      "guard is scanning the wrong tree and every assertion below would pass vacuously",
  );

  const HEADER = /^create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gim;

  /** Text of one create-function statement, cut just after its dollar-quoted body closes. */
  function statementBody(sql: string, start: number): string {
    const rest = sql.slice(start);
    const tag = /(\$[a-z_]*\$)/i.exec(rest);
    if (tag) {
      const open = rest.indexOf(tag[1]);
      const close = rest.indexOf(tag[1], open + tag[1].length);
      if (close > 0) return rest.slice(0, close + tag[1].length);
    }
    const semi = rest.indexOf(";");
    return semi > 0 ? rest.slice(0, semi + 1) : rest;
  }

  // A well-documented migration explains its own call in prose, so an un-stripped body
  // satisfies a source assertion on the COMMENT that describes the bug. Strip them first.
  function stripLineComments(sql: string): string {
    return sql
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
  }

  const latest = new Map<string, { file: string; body: string }>();
  for (const file of files) {
    const raw = readFileSync(`${dir}/${file}`, "utf8");
    HEADER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HEADER.exec(raw)) !== null) {
      const body = stripLineComments(statementBody(raw, match.index))
        .toLowerCase()
        .replace(/\s+/g, " ");
      latest.set(match[1].toLowerCase(), { file, body });
    }
  }

  const TODAY_CAIRO = "(now() at time zone 'africa/cairo')::date";

  // ── 1. Each resignation writer derives the first VACANT day, not the last worked one ──
  //
  // The coalesce fallback is load-bearing and deliberately NOT incremented: all three
  // functions have always treated a null date as "vacate from today", and tomorrow would
  // leave a departed person on the organogram for the rest of the day.
  const WRITERS: Array<[string, string]> = [
    // function name                                  the parameter holding the LAST WORKING DAY
    ["public.phx_resign_employee_and_open_vacancy", "p_effective_date"],
    ["public.phx_vacate_au_seats_for_employee", "p_effective_date"],
    ["public.phx_decline_offer_and_open_vacancy", "p_last_working_date"],
  ];

  for (const [name, param] of WRITERS) {
    const entry = latest.get(name);
    assert.ok(
      entry,
      `HEADLINE: no migration defines ${name} — either it was renamed or this guard is looking in ` +
        "the wrong place, and either way the off-by-one is no longer pinned by anything",
    );

    assert.ok(
      entry!.body.includes(`coalesce(${param} + 1, ${TODAY_CAIRO})`),
      `HEADLINE: ${name} (${entry!.file}) must vacate the seat on ${param} + 1. ${param} is the ` +
        "employee's LAST WORKING DAY and au.occupancy_history is half-open, so passing it " +
        "unchanged puts that day inside the VACANT span and credits the whole month to nobody " +
        "when it falls on a month end",
    );

    assert.ok(
      /au\.resign_occupant\(\s*v_seat_id\s*,\s*v_vacant_from\b/.test(entry!.body),
      `HEADLINE: ${name} (${entry!.file}) must hand au.resign_occupant the derived v_vacant_from, ` +
        "not a date computed anywhere else — the derivation above is worthless if the call still " +
        "passes its own expression",
    );

    assert.ok(
      !new RegExp(`au\\.resign_occupant\\([^)]*\\b${param}\\b`).test(entry!.body),
      `HEADLINE: ${name} (${entry!.file}) must not pass ${param} straight to au.resign_occupant — ` +
        "that is the defect itself",
    );
  }

  // ── 2. No FOURTH resignation writer may appear with the raw date ──────────────────────
  //
  // au.resign_occupant is also the primitive the TRANSFER path calls, and there the date
  // really is the first vacant day — so those callers are correct and are allow-listed by
  // name rather than by pattern. Anything else that closes a span must go through the same
  // + 1, or this defect simply comes back on a new path.
  const TRANSFER_CALLERS = new Set<string>([
    "au.transfer_occupant",
    "public.phx_transfer_au_seat",
  ]);
  const writerNames = new Set(WRITERS.map(([name]) => name));
  const unchecked: string[] = [];
  for (const [name, { file, body }] of latest) {
    // Search the executable body only. `body` starts at the CREATE header, so a function's own
    // signature — au.resign_occupant's loudest of all — would otherwise read as a call to itself.
    const tag = /\$[a-z_]*\$/.exec(body);
    const inner = tag ? body.slice(body.indexOf(tag[0]) + tag[0].length) : body;
    if (!inner.includes("au.resign_occupant(")) continue;
    if (TRANSFER_CALLERS.has(name) || writerNames.has(name)) continue;
    unchecked.push(`${name} (${file})`);
  }
  assert.deepEqual(
    unchecked,
    [],
    "a new caller of au.resign_occupant must either pass a first-vacant-day (the transfer shape, " +
      "allow-listed here by name) or derive last working day + 1 like the three resignation " +
      `writers. Unreviewed callers: ${unchecked.join(", ")}`,
  );
}
