/**
 * The HR landing page's task list and its seat arithmetic.
 *
 * WHY THIS EXISTS. On 2026-09-01 the owner looked at this board and asked how the open vacancies
 * could possibly be three. They could, and the number was true: the tile counted ATS
 * REQUISITIONS, of which production held exactly five ever and three in an open status — and all
 * three stood on seats that were already FILLED, while 45 seats stood genuinely empty in the
 * organogram with no requisition raised against any of them. Two true numbers, one word, and no
 * screen putting them beside each other.
 *
 * Everything below pins one of the two ways that defect can come back:
 *   - by SUMMING the two answers into a third that describes nobody, or
 *   - by COUNTING the raw `position_vacancies` rows, which is one row per vacancy EVENT and reads
 *     45 where every other seat surface in the product reads 33.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildHrTodayTasks,
  openWorkforceSeats,
  splitVacanciesByRequisition,
} from "../src/lib/hr/today-tasks.ts";
import { countUnoccupiedWorkforceSeats } from "../src/lib/platform/metrics.ts";
import { isProbationDecisionOutstanding } from "../src/lib/probation/service.ts";
import type { ProbationDecision, ProbationRow } from "../src/lib/probation/types.ts";

function requisition(id: number, status: string, vacancyId: number | null) {
  return { id: `REQ-${id}`, status, vacancyId };
}

function seat(vacancyId: number) {
  return { vacancyId };
}

function probationRow(decision: ProbationDecision | null | undefined): Pick<ProbationRow, "workflow"> {
  return { workflow: decision === undefined ? null : ({ decision } as ProbationRow["workflow"]) };
}

export async function runHrTodayTasksTests() {
  // ── 1. The split that the whole page was rebuilt around ────────────────────
  {
    // The production shape as measured on 2026-09-01: three open requisitions, every one of them
    // pointing at a seat that is no longer open. Seat 90 carries a genuinely live requisition, so
    // it is being recruited. Seat 92's only requisition is CLOSED, which must not protect it —
    // history is not recruiting, and reading it as recruiting is how a seat nobody is working on
    // disappears from the one tile that exists to surface it.
    const requisitions = [
      requisition(1, "req_open", 41),
      requisition(2, "req_published", 42),
      requisition(3, "req_open", 43),
      requisition(4, "req_open", 90),
      requisition(5, "req_closed", 92),
      requisition(6, "req_cancelled", 93),
    ];
    const openSeats = [seat(90), seat(92), seat(93)];

    const split = splitVacanciesByRequisition(requisitions, openSeats);

    assert.equal(
      split.openRequisitions.length,
      4,
      "only req_open and req_published are live recruiting — a closed or cancelled requisition is history",
    );
    assert.equal(
      split.staleRequisitions.length,
      3,
      "three of the four open requisitions stand on seats that are no longer open — this was the entire content of 'Open Vacancies 3'",
    );
    assert.deepEqual(
      split.unrecruitedSeats.map((row) => row.vacancyId),
      [92, 93],
      "seat 90 has an OPEN requisition so it is being recruited; 92 and 93 carry only a closed and a cancelled one, which is nobody working on them",
    );

    // The defect itself: adding the two produces a number that describes neither queue. A stale
    // requisition and an unrecruited seat are, by construction, never the same thing — one is
    // recruiting already done, the other recruiting never started.
    assert.notEqual(
      split.staleRequisitions.length + split.unrecruitedSeats.length,
      split.openRequisitions.length,
      "the two answers must never be summed into a single 'vacancies' figure",
    );
    for (const stale of split.staleRequisitions) {
      assert.equal(
        split.unrecruitedSeats.some((row) => row.vacancyId === stale.vacancyId),
        false,
        "a seat cannot be both already-recruited and never-recruited",
      );
    }
  }

  {
    // A requisition with a null vacancyId is raised against no seat at all. It is open recruiting,
    // but it can never be "stale on a filled seat" — there is no seat to be filled.
    const split = splitVacanciesByRequisition(
      [requisition(6, "req_open", null), requisition(7, "req_open", 50)],
      [seat(50)],
    );
    assert.equal(split.openRequisitions.length, 2, "a seatless requisition is still open recruiting");
    assert.equal(
      split.staleRequisitions.length,
      0,
      "a null vacancyId must not be read as 'the seat is filled' — that would invent work that does not exist",
    );
    assert.equal(split.unrecruitedSeats.length, 0, "seat 50 is requisitioned");
  }

  // ── 2. Seats are counted as SEATS, never as vacancy rows ───────────────────
  {
    // `position_vacancies` is one row per vacancy EVENT. Seat A emptied twice (two rows, one
    // seat); seat B is already filled by an active employee but keeps its stale open row.
    const directory = {
      employees: [
        {
          areaName: "Nasr City",
          employmentStatus: "active",
          fullName: "Filled Seat Holder",
          hrId: "B-1",
          jobTitle: "Medical Representative",
          lineName: "Pedia",
          managerHrId: "DSM-1",
          positionTitle: "Medical Representative",
        },
      ],
      lookups: {
        workforceVacancies: [
          { areaName: "Giza", jobTitle: "Medical Representative", lineName: "CNS", managerHrId: "DSM-2", positionTitle: "Medical Representative", vacancyCode: "VAC-A", vacancyId: 1 },
          { areaName: "Giza", jobTitle: "Medical Representative", lineName: "CNS", managerHrId: "DSM-2", positionTitle: "Medical Representative", vacancyCode: "VAC-A2", vacancyId: 2 },
          { areaName: "Nasr City", jobTitle: "Medical Representative", lineName: "Pedia", managerHrId: "DSM-1", positionTitle: "Medical Representative", vacancyCode: "VAC-B", vacancyId: 3 },
        ],
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a directory literal, not a fetch
    const seats = openWorkforceSeats(directory as any);

    assert.equal(
      seats.length,
      1,
      "three vacancy ROWS collapse to one open SEAT: two are the same seat emptying twice, and the third is a seat an active employee already fills",
    );
    assert.equal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same literal
      countUnoccupiedWorkforceSeats({ employees: directory.employees as any, vacancies: directory.lookups.workforceVacancies as any }),
      seats.length,
      "the count and the list must be the same rule — countUnoccupiedWorkforceSeats is .length of listUnoccupiedWorkforceSeats",
    );
    assert.notEqual(
      seats.length,
      directory.lookups.workforceVacancies.length,
      "if these ever agree the dedup has stopped running, which is the 45-vs-33 defect exactly",
    );
  }

  {
    // The source pin. Both readers on this page must go through the shared helper: the tile and
    // the task under it link to the same page, so a second way of counting would put a different
    // number on each of them.
    const commandCenter = readFileSync("src/lib/hr/command-center.ts", "utf8");
    const todayTasks = readFileSync("src/lib/hr/today-tasks.ts", "utf8");

    for (const [name, source] of [
      ["src/lib/hr/command-center.ts", commandCenter],
      ["src/lib/hr/today-tasks.ts", todayTasks],
    ] as const) {
      assert.doesNotMatch(
        source,
        /lookups\.workforceVacancies\.length/,
        `${name} must not count the raw vacancy lookup — that is the number the Organogram disagrees with`,
      );
      assert.doesNotMatch(
        source,
        /lookups\.medicalRepVacancies\.length\s*\+|\+\s*\w*\.lookups\.medicalRepVacancies\.length/,
        `${name} must not add medicalRepVacancies to workforceVacancies — the first is a SUBSET of the second and the sum printed 88 for 45 seats`,
      );
    }

    assert.match(
      commandCenter,
      /openWorkforceSeats\(directory\)\.length/,
      "the Vacant Seats tile reads the deduped seat list",
    );
    assert.match(
      commandCenter,
      /splitVacanciesByRequisition\(\s*dashboard\.requisitions,\s*openWorkforceSeats\(loaded\.directory\),/,
      "the recruiting tiles split the deduped seat list, not the raw lookup",
    );
    assert.match(
      todayTasks,
      /splitVacanciesByRequisition\(\s*loaded\.recruitment\.requisitions,\s*openWorkforceSeats\(loaded\.directory\),/,
      "the task list splits the same deduped list as the tiles above it",
    );
  }

  // ── 3. Every task can name itself when it is clear ─────────────────────────
  {
    // Sources PRESENT and EMPTY — day one for both HR seats, which start on 1 September 2026 with
    // every queue at zero. This is not the same as no sources at all: an ABSENT source drops its
    // task entirely, on purpose, because rendering it at zero would claim an all-clear nobody
    // measured. The assertion below pins that distinction in both directions.
    const emptySources = {
      directory: { employees: [], lookups: { workforceVacancies: [] } },
      offers: [],
      probation: [],
      recruitment: { applications: [], requisitions: [] },
      retention: { conversations: [] },
      supportRequests: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- literal fixtures, not fetches
    const tasks = buildHrTodayTasks(emptySources as any);
    assert.ok(tasks.length > 0, "a landing page whose sources all loaded empty must still render its queues, not nothing");

    assert.deepEqual(
      buildHrTodayTasks({}),
      [],
      "a source that did NOT load must drop its task rather than render at zero — 'nothing is waiting' and 'we could not look' are different answers, and only one of them is an all-clear",
    );

    for (const item of tasks) {
      for (const field of ["action", "clearLabel", "href", "hrefLabel", "key", "subject", "title"] as const) {
        assert.equal(
          typeof item[field] === "string" && item[field].length > 0,
          true,
          `task ${item.key} must carry a non-empty ${field} — a clear task collapses to its subject, and an unnamed queue is indistinguishable from one the product does not track`,
        );
      }
      assert.equal(
        item.subject.endsWith("."),
        false,
        `task ${item.key}: subject is a short queue NAME ("Interviews"), not a sentence`,
      );
      assert.equal(item.count, 0, `task ${item.key}: no source loaded, so nothing can be waiting`);
      assert.equal(item.urgency, "clear", `task ${item.key}: an empty queue is clear, never overdue`);
      assert.deepEqual(item.items, [], `task ${item.key}: no rows without a source`);
    }

    const keys = tasks.map((item) => item.key);
    assert.equal(new Set(keys).size, keys.length, "task keys are React keys and must be unique");
  }

  // ── 4. The probation queue agrees with the probation page ──────────────────
  {
    // The list and the tracker must answer "does this need a verdict" identically, or the board
    // links to a table that cannot contain the row it is counting.
    assert.equal(isProbationDecisionOutstanding(probationRow(undefined)), true, "no workflow yet — still needs a verdict");
    assert.equal(isProbationDecisionOutstanding(probationRow(null)), true, "a workflow with no decision still needs one");
    assert.equal(isProbationDecisionOutstanding(probationRow("pass")), false, "passed is decided");
    assert.equal(isProbationDecisionOutstanding(probationRow("terminate")), false, "terminated is decided");

    const todayTasks = readFileSync("src/lib/hr/today-tasks.ts", "utf8");
    assert.match(
      todayTasks,
      /loaded\.probation\.filter\(\(row\) => isProbationDecisionOutstanding\(row\)\)/,
      "the probation task must call the shared predicate, never re-implement 'pass or terminate means done' — a second local copy is what let the CEO count drift",
    );
  }
}
