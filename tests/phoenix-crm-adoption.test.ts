import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ADOPTION_GRACE_DAYS,
  buildAdoptionReport,
  judgeAdoption,
  type AdoptionFacts,
} from "../src/lib/phoenix-crm/adoption-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — how far the rollout has got (F3 of the owner's plan).
 *
 * Every other board in the module measures work being done. This one measures whether it has BEGUN,
 * which is the only question worth asking while a rollout is still landing — and on production
 * today, with 809 carried-over customers and nothing validated, it is the one report with a real
 * answer.
 *
 * ## The five things that would be wrong quietly
 *
 *   1. **A closed line is nobody's fault.** A territory whose line has not opened cannot have
 *      adopted anything; calling it "never opened the module" accuses a rep of not using something
 *      he was never given.
 *   2. **Null days are not zero days.** An undated line has no age. Printing 0 reads as "opened
 *      today", and the difference between "we do not know" and "it started this morning" is the
 *      difference between a finding and a shrug.
 *   3. **"Touched" is wider than "visited".** A rep who validated three customers HAS started.
 *      Listing him beside a territory that has done literally nothing buries the one needing a call.
 *   4. **Nothing is dropped.** Unlike the exceptions board, a territory doing fine is the good news
 *      and belongs on a page about coverage of a rollout — and so does one whose line is still shut,
 *      which `scopeTerritories` alone would silently omit and make the rollout look finished.
 *   5. **A board naming who has never opened the module must not reach the field.** Same gate as the
 *      exceptions board and the place-vs-actual report.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const TODAY = "2026-09-27";

function facts(patch: Partial<AdoptionFacts> = {}): AdoptionFacts {
  return {
    seatId: "SEAT-1",
    territoryName: "Faisal",
    lineName: "Pedia",
    repName: "Mahmoud Adel",
    hasRep: true,
    lineOpenedOn: "2026-09-01",
    lineIsOpen: true,
    readiness: { total: 12, validated: 0, dropped: 0, dropPending: 0, ready: false },
    readyAt: null,
    firstVisitOn: null,
    visitsEver: 0,
    ...patch,
  };
}

export function runPhoenixCrmAdoptionTests(): void {
  // ── 1. A closed line is never an accusation ────────────────────────────────────────────────────
  {
    const row = judgeAdoption(facts({ lineIsOpen: false, lineOpenedOn: "2026-12-01" }), { cairoToday: TODAY });
    assert.equal(row.stage, "not_open", "a territory whose line has not opened cannot have failed to adopt it");
    assert.equal(row.overdue, false, "and it can never be overdue");
    assert.equal(row.daysOpen, null, "nor carry a days-open figure — there is nothing to be open for");
  }

  // ── 2. Null days are NEVER zero days ───────────────────────────────────────────────────────────
  {
    const undated = judgeAdoption(facts({ lineOpenedOn: null }), { cairoToday: TODAY });
    assert.equal(undated.stage, "never_touched");
    assert.equal(undated.daysOpen, null, "🔴 an undated line has NO age — 0 would read as 'opened today'");
    assert.equal(undated.overdue, false, "and an unknown age can never be called late");
    assert.equal(undated.detail, null, "the detail says nothing rather than inventing a number");

    // A dated line does count, from the opening and not from anywhere else.
    const dated = judgeAdoption(facts({ lineOpenedOn: "2026-09-01" }), { cairoToday: TODAY });
    assert.equal(dated.daysOpen, 26, "26 days from 1 Sept to 27 Sept");
  }

  // ── 3. The grace, and what "overdue" actually counts ───────────────────────────────────────────
  {
    const insideGrace = judgeAdoption(facts({ lineOpenedOn: "2026-09-20" }), { cairoToday: TODAY });
    assert.equal(insideGrace.stage, "never_touched", "still reported — absence is the fact");
    assert.equal(insideGrace.overdue, false, `7 days is inside the ${ADOPTION_GRACE_DAYS}-day grace`);

    // Exactly at the grace is not yet past it.
    const atGrace = judgeAdoption(facts({ lineOpenedOn: "2026-09-13" }), { cairoToday: TODAY });
    assert.equal(atGrace.daysOpen, ADOPTION_GRACE_DAYS);
    assert.equal(atGrace.overdue, false, "at the grace, not past it");

    const past = judgeAdoption(facts({ lineOpenedOn: "2026-09-12" }), { cairoToday: TODAY });
    assert.equal(past.overdue, true, "a day past the grace is overdue");
  }

  // ── 4. "Touched" is wider than "visited" ───────────────────────────────────────────────────────
  //
  // A rep who validated three customers HAS started. Reporting him beside a territory that has done
  // nothing at all buries the one that needs a phone call.
  {
    const validated = judgeAdoption(
      facts({ readiness: { total: 12, validated: 3, dropped: 0, dropPending: 0, ready: false } }),
      { cairoToday: TODAY },
    );
    assert.equal(validated.stage, "started", "three validations is a start");
    assert.equal(validated.detail, "3 of 12 validated");

    for (const [what, readiness] of [
      ["a drop", { total: 12, validated: 0, dropped: 1, dropPending: 0, ready: false }],
      ["a drop REQUEST", { total: 12, validated: 0, dropped: 0, dropPending: 1, ready: false }],
    ] as const) {
      assert.equal(judgeAdoption(facts({ readiness }), { cairoToday: TODAY }).stage, "started", `${what} counts as touching it`);
    }

    // A visit with no list movement counts too — the list is not the only door in.
    assert.equal(
      judgeAdoption(facts({ firstVisitOn: "2026-09-10", visitsEver: 1 }), { cairoToday: TODAY }).stage,
      "working",
      "a visit alone is adoption",
    );
  }

  // ── 5. Ready is a milestone, not the goal ──────────────────────────────────────────────────────
  //
  // A rep can finish all twelve in an afternoon and never enter a visit. That territory is the most
  // useful row on the board, so it gets its own rung ABOVE "started" and BELOW "working".
  {
    const readyNoVisit = judgeAdoption(
      facts({ readiness: { total: 12, validated: 12, dropped: 0, dropPending: 0, ready: true }, readyAt: "2026-09-15T08:00:00Z" }),
      { cairoToday: TODAY },
    );
    assert.equal(readyNoVisit.stage, "ready", "list finished, no visit — its own stage");
    assert.equal(readyNoVisit.detail, "list finished 2026-09-15");

    const readyAndVisiting = judgeAdoption(
      facts({
        readiness: { total: 12, validated: 12, dropped: 0, dropPending: 0, ready: true },
        firstVisitOn: "2026-09-16",
        visitsEver: 8,
      }),
      { cairoToday: TODAY },
    );
    assert.equal(readyAndVisiting.stage, "working");
    assert.equal(readyAndVisiting.detail, "first visit 2026-09-16");
  }

  // ── 6. NOTHING is dropped, and the order is worst-then-oldest ──────────────────────────────────
  {
    const report = buildAdoptionReport(
      [
        facts({ seatId: "S-fine", territoryName: "Alpha", firstVisitOn: "2026-09-05", visitsEver: 20 }),
        facts({ seatId: "S-shut", territoryName: "Bravo", lineIsOpen: false }),
        facts({ seatId: "S-new", territoryName: "Charlie", lineOpenedOn: "2026-09-25" }),
        facts({ seatId: "S-old", territoryName: "Delta", lineOpenedOn: "2026-08-01" }),
      ],
      { cairoToday: TODAY },
    );

    assert.equal(report.rows.length, 4, "🔴 every territory is listed — this board is about COVERAGE of a rollout");
    assert.deepEqual(
      report.rows.map((row) => row.territoryName),
      ["Delta", "Charlie", "Alpha", "Bravo"],
      "worst first, then the longest-open: the 57-day silence outranks the 2-day one, and a shut line is last",
    );
    assert.equal(report.summary.territories, 4);
    assert.equal(report.summary.open, 3, "a shut line is not part of what can adopt");
    assert.equal(report.summary.neverTouched, 2);
    assert.equal(report.summary.overdue, 1, "only Delta is past the grace — Charlie opened two days ago");
    assert.equal(report.summary.working, 1);
    assert.ok(
      report.summary.byStage.every((entry) => entry.count > 0),
      "a stage with no territories is left out rather than shown as a zero chip",
    );
  }

  // ── 7. The gate, and the seats the service actually reads ──────────────────────────────────────
  {
    const service = source("src/lib/phoenix-crm/server/adoption.ts");
    assert.match(
      service,
      /if \(!readsTeamReports\(viewer\)\) throw forbiddenError/,
      "a board naming who has never opened the module must not reach the field",
    );
    // 🔴 The waiting half matters: scopeTerritories is already filtered to OPEN lines, so using it
    // alone would drop every territory still waiting and make a rollout look complete.
    assert.ok(
      service.includes("...viewer.scopeTerritories, ...viewer.waitingScopeTerritories"),
      "the report reads the viewer's waiting territories too — otherwise the unopened half is invisible",
    );
    // Since 2026-10-16 the first visit and the count are COUNTED in the database, not read row by row:
    // the whole visit history, a thousand rows a page in series, for two numbers per territory.
    assert.ok(
      service.includes('callPhoenixCrm<unknown>("phoenix_crm_seat_visit_firsts", { p_seat_ids: part, p_is_test: isTest })'),
      "the first visit and the count come from one function per batch of territories",
    );
    assert.equal(service.includes('.from("phoenix_crm_visits")'), false, "never the raw table");
    {
      const sql = readFileSync(new URL("supabase/migrations/20261016180300_phoenix_crm_report_count_reads.sql", ROOT), "utf8").replace(/--.*$/gm, "");
      const start = sql.indexOf("create or replace function public.phoenix_crm_seat_visit_firsts(");
      assert.notEqual(start, -1, "the function is defined");
      const body = sql.slice(start, sql.indexOf("\n$$;", start));
      assert.match(body, /from public\.phoenix_crm_countable_visits v/, "the first visit comes from the countable view, never the raw table");
      assert.match(body, /min\(v\.visit_date\)/, "the EARLIEST visit, as the old loop kept");
      assert.match(body, /count\(\*\)::integer/, "and every countable visit, as the old loop counted");
      assert.match(body, /where v\.seat_id = any\(p_seat_ids\)\s+and v\.is_test = p_is_test\s+group by v\.seat_id/, "the seat and the world, and nothing else");
      // 🔴 The one board that counts a visit to a customer nobody has validated — it asks whether a
      //    territory has STARTED, so the function must not filter on validation either.
      assert.doesNotMatch(body, /customer_validated/, "no validation filter, deliberately, in the database as in the service");
    }
    // The ready date is the one readiness already carries — `phoenix_crm_seat_readiness` answers it
    // from `phoenix_crm_territory_readiness` when it is not asked to stamp — never a second read of it.
    assert.ok(service.includes("readyAt: list?.readyAt ?? null,"), "the ready date comes off the readiness answer");
    assert.ok(service.includes(": sharedReadiness(seatIds),"), "readiness shared with the exceptions board when the pack opens both");

    // Few reads for the whole company, not three per seat.
    const gather = service.slice(service.indexOf("export async function gatherAdoption"), service.indexOf("export async function loadAdoptionReport"));
    assert.equal((gather.match(/await Promise\.all\(\[/g) ?? []).length, 1, "the facts are gathered in ONE Promise.all");
    assert.equal(/for \(const seat of seats\)[\s\S]{0,200}await /.test(gather), false, "and never one query per seat");
  }

  // ── 8. The route, the screen and the workbook all carry it ─────────────────────────────────────
  {
    const route = source("app/api/phoenix-crm/reports/route.ts");
    assert.ok(route.includes('section === "adoption"'), "the reports route serves ?section=adoption");

    const screen = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.ok(screen.includes("function AdoptionSection("), "the screen draws it");
    assert.ok(
      // `offer(...)` builds the option from the report guide (2026-10-03); the gate is what matters
      // here and it is unchanged — the audience, not the option's spelling.
      screen.includes('...(view.canSeeLocations ? [offer("adoption")] : [])'),
      "and offers the chip only to the audience the service admits",
    );
    assert.ok(
      screen.includes('row.daysOpen === null ? "—" : plural(row.daysOpen, "day", "days")'),
      "the screen prints an em dash for an unknown age, never 0",
    );
    // It is about right now, so it reads neither a period nor a month.
    assert.ok(screen.includes('const TIMELESS_SECTIONS: ReadonlyArray<ReportSection> = ["exceptions", "adoption"]'), "it reads no period");

    const workbook = source("src/lib/phoenix-crm/server/reports-workbook.ts");
    assert.ok(workbook.includes("function writeAdoption("), "the pack has an adoption sheet");
    assert.ok(workbook.includes("input.adoption ? SECTION_TITLES.adoption : null"), "which the cover names only when it is there");
    assert.ok(
      workbook.includes('row.daysOpen === null ? "—" : row.daysOpen'),
      "and the sheet prints an em dash for an unknown age too — a 0 in a saved file outlives the screen that explained it",
    );

    const exportRoute = source("app/api/phoenix-crm/reports/export/route.ts");
    assert.match(
      exportRoute,
      /managerSections \? loadAdoptionReport\([^)]*\) : Promise\.resolve\(null\)/,
      "a viewer who may not read it never loads it, so the workbook has no adoption sheet at all",
    );
  }

  console.log("phoenix-crm adoption: OK");
}
