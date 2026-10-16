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
  HR_ROLE_BUNDLES,
  type HrBundleName,
  type HrFunctionKey,
} from "../src/lib/auth/hr-functions.ts";
import { sourcesFor } from "../src/lib/hr/command-center.ts";
import {
  buildHrTodayTasks,
  openWorkforceSeats,
  splitVacanciesByRequisition,
} from "../src/lib/hr/today-tasks.ts";
import { currentCairoDateOnlyIso } from "../src/lib/i18n/format.ts";
import { countUnoccupiedWorkforceSeats } from "../src/lib/platform/metrics.ts";
import { isProbationDecisionOutstanding } from "../src/lib/probation/service.ts";
import type { ProbationDecision, ProbationRow } from "../src/lib/probation/types.ts";
import { stripComments } from "./support/comment-strip.ts";

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

  {
    // Seats the owner parked (2026-09-30, "neglect cairo pedia dm and reps now"; Menoufia 1 the same
    // way) are EMPTY but are not recruiting nobody has started — Talent Acquisition's board listed 7
    // of them among "Raise a requisition for 42 empty seats" on 2026-10-16. Every other seat stays.
    const parked = [
      { areaName: "Cairo", lineName: "Pedia", vacancyId: 348 },
      { areaName: "Heliopolis", lineName: "Pedia", vacancyId: 315 },
      { areaName: "Nasr City", lineName: "pedia", vacancyId: 330 },
      { areaName: "Cairo East 1", lineName: "Pedia", vacancyId: 292 },
      { areaName: "Cairo East 2", lineName: "Pedia", vacancyId: 293 },
      { areaName: "Cairo West", lineName: "Pedia", vacancyId: 246 },
      { areaName: "Menoufia 1", lineName: "Anti Infective", vacancyId: 369 },
    ];
    const live = [
      { areaName: "Kafr El-Sheikh 1", lineName: "CNS", vacancyId: 400 },
      { areaName: "Heliopolis", lineName: "CNS", vacancyId: 401 },
      { areaName: "Alexandria 1", lineName: "Pedia", vacancyId: 402 },
      { areaName: null, lineName: null, vacancyId: 403 },
    ];
    const split = splitVacanciesByRequisition([], [...parked, ...live]);
    assert.deepEqual(
      split.unrecruitedSeats.map((row) => row.vacancyId),
      [400, 401, 402, 403],
      "the seven parked seats are not 'raise a requisition' work; a same-named area on another line, another Pedia area, and a seat with no names all stay",
    );
    const withRequisition = splitVacanciesByRequisition([requisition(9, "req_open", 348)], parked);
    assert.equal(
      withRequisition.openRequisitions.length,
      1,
      "a requisition raised against a parked seat is still live recruiting",
    );
  }

  {
    // An application on a requisition that is filled, closed or cancelled waits on nothing: Hanaa
    // Mohamed Zaki sat at HR interview for 61 days on a `req_filled` requisition with no interview
    // ever booked, and was the whole of "Move 1 interview forward".
    const source = stripComments(readFileSync("src/lib/hr/today-tasks.ts", "utf8"));
    assert.match(
      source,
      /DEAD_REQUISITION_STATUSES = new Set\(\["req_filled", "req_closed", "req_cancelled"\]\)/,
      "the three terminal requisition statuses are named once",
    );
    assert.match(
      source,
      /const applications = loaded\.recruitment\.applications\.filter\(\s*\(row\) => !row\.requisition \|\| !DEAD_REQUISITION_STATUSES\.has\(row\.requisition\.status\)/,
      "both the screening and the interview queue read applications on a live requisition only; one with no requisition stays in",
    );
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
    const tasks = buildHrTodayTasks(emptySources as any, "HR Resourcing");
    assert.ok(tasks.length > 0, "a landing page whose sources all loaded empty must still render its queues, not nothing");

    assert.deepEqual(
      buildHrTodayTasks({}, "HR Resourcing"),
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

  // ── 5. BOTH seats get a day, not one of them ─────────────────────────
  {
    // THE DEFECT THIS PINS. "Your day" is the whole point of this landing page — it is the
    // panel that replaced a ring reading "5 of 18 waiting" after the owner said it showed nothing.
    // But until 2026-09-01 every task in it was built from a source in HR Advisory's bundle. HR
    // Operations holds seven sources, this page already fetched all seven for her tiles, and
    // exactly two of them answered anything here: her landing page opened on a two-row panel over
    // a wall of counters, with contracts, resignations and the attendance desk — her
    // entire job — present as figures and absent as work.
    //
    // The pin is deliberately NOT a list of expected keys, which would agree with itself forever.
    // It drives the REAL builder once per seat with that seat's REAL source set (from
    // `sourcesFor`, the same function the page loads by) and asserts the two properties that
    // actually matter: no seat is offered a task keyed to a function it does not hold, and no
    // seat's day collapses to a handful of rows while the other's is full.
    const EMPTY_SOURCE: Record<string, unknown> = {
      attendanceExceptions: [],
      contracts: { rows: [] },
      deductions: { pending: {}, willPublish: {} },
      directory: { employees: [], lookups: { workforceVacancies: [] } },
      offers: [],
      probation: [],
      // The probation OUTCOMES aggregate, which the Talent Acquisition seat's retention KPI
      // divides. Like `vacationsToday` it contributes no TASK — a decided probation window is not
      // a queue — but her page really loads it, so the key has to be here or this test drives her
      // seat short. Null is the honest empty: the loader's own `safe()` hands back nothing when
      // the read refuses, and the page renders a stated absence rather than a zero.
      probationOutcomes: null,
      recruitment: { applications: [], requisitions: [] },
      resignations: { records: [] },
      retention: { conversations: [] },
      supportRequests: [],
      // Today's absences. It contributes no TASK by design — nobody has to do anything about a
      // colleague being on leave — but it is a source HR Operations really loads, and a missing
      // fixture here would drive her seat short and make the count assertion below measure the
      // fixture instead of the product.
      vacationsToday: [],
    };

    const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];

    // A source with no fixture would silently drive that seat SHORT, and the count assertion
    // below would then be measuring the fixture rather than the product.
    for (const name of seats) {
      for (const key of sourcesFor(name)) {
        assert.ok(
          key in EMPTY_SOURCE,
          `no fixture for source '${key}' — add one, or this test drives ${name} with a source the page really loads and proves less than it claims`,
        );
      }
    }

    const dayFor = (name: HrBundleName) => {
      const sources = Object.fromEntries(sourcesFor(name).map((key) => [key, EMPTY_SOURCE[key]]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- literal fixtures, not fetches
      return buildHrTodayTasks(sources as any, name);
    };

    const days = new Map(seats.map((name) => [name, dayFor(name)] as const));

    for (const [name, tasks] of days) {
      const bundle = HR_ROLE_BUNDLES[name] as readonly HrFunctionKey[];
      for (const item of tasks) {
        assert.ok(
          bundle.includes(item.functionKey),
          `${name} is offered task '${item.key}' keyed to '${item.functionKey}', a function that seat does not hold — it draws another seat's icon and files the work under another seat's heading`,
        );
      }

      const keys = tasks.map((item) => item.key);
      assert.equal(
        new Set(keys).size,
        keys.length,
        `${name}: task keys are React keys and must be unique`,
      );

      // Six is the floor, not the target. HR Advisory's was four once recruiting left her seat, and
      // the seat was retired the same evening (2026-10-08). HR Operations has six, against the TWO
      // she had the day this was written. The floor was eight until the
      // Clearance module was removed (owner, 2026-09-01) and took three of her tasks with it — lower
      // it again only for a removal of that kind, never to make a thinning panel go green.
      const floor = 6;
      assert.ok(
        tasks.length >= floor,
        `${name} gets only ${tasks.length} task(s) — this page's opening panel IS the seat's day, and a day with ${tasks.length} rows in it is the two-row board this test exists to stop. Tasks: ${keys.join(", ") || "(none)"}`,
      );
    }

    // Each seat's day must actually SPAN its bundle. Counting rows alone would pass on nine
    // recruiting tasks, which is what HR Operations effectively had: everything from one half of
    // the department and nothing from hers.
    const functionsWithAQueue: Record<HrBundleName, HrFunctionKey[]> = {
      "HR Operations": ["people_records", "performance_probation", "time_attendance"],
      // The Talent Acquisition seat (2026-10-08): the pipeline and the two request desks she works.
      // workforce_context is read-only reference and carries no queue of its own.
      "HR Resourcing": ["recruiting", "employee_requests"],
    };
    for (const name of seats) {
      const covered = new Set((days.get(name) ?? []).map((item) => item.functionKey));
      for (const functionKey of functionsWithAQueue[name]) {
        assert.ok(
          covered.has(functionKey),
          `${name} has no task at all under '${functionKey}' — the page loads that function's source for her tiles, so the figures are on the screen and the work behind them is not`,
        );
      }
    }

    // And the two days are genuinely different work, not one list shown twice.
    const operationsKeys = new Set((days.get("HR Operations") ?? []).map((item) => item.key));
    // The recruiting tasks are the Talent Acquisition seat's (owner, 2026-10-08), never HR
    // Operations'.
    const resourcingKeys = new Set((days.get("HR Resourcing") ?? []).map((item) => item.key));
    for (const key of ["screen-candidates", "chase-offers"]) {
      assert.ok(resourcingKeys.has(key), `the Talent Acquisition seat lost her '${key}' task`);
      assert.ok(!operationsKeys.has(key), `HR Operations is offered '${key}', recruiting work she never held`);
    }
    // The support desk was the HR Business Partner's under engagement_retention; since that seat was
    // retired it is answered under employee_requests, by the Talent Acquisition seat.
    for (const key of ["answer-support-requests"]) {
      assert.ok(resourcingKeys.has(key), `the Talent Acquisition seat lost her '${key}' task`);
      assert.ok(
        !operationsKeys.has(key),
        `HR Operations is offered '${key}', which reads a source her bundle does not justify loading`,
      );
    }
    for (const key of [
      "process-resignations",
      "sign-off-contract-renewals",
      "raise-contract-renewals",
      "review-attendance-exceptions",
    ]) {
      assert.ok(operationsKeys.has(key), `HR Operations lost her '${key}' task`);
      assert.ok(
        !resourcingKeys.has(key),
        `the Talent Acquisition seat is offered '${key}', which reads a source her bundle does not justify loading`,
      );
    }
  }

  // ── 6. The leaver and contract rows tell the truth about a date ───────────
  {
    // Every one of the four new queues is measured from a DEADLINE rather than from an arrival,
    // which is the opposite sign to everything above them. Getting that backwards would render a
    // contract that lapsed a fortnight ago as "renews in 14 days", in calm slate, at the bottom.
    const today = currentCairoDateOnlyIso();
    const shift = (offsetDays: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + offsetDays * 86_400_000)
        .toISOString()
        .slice(0, 10);

    const named = (list: ReturnType<typeof buildHrTodayTasks>, key: string) => {
      const found = list.find((item) => item.key === key);
      if (!found) throw new Error(`task '${key}' was not built at all`);
      return found;
    };

    const contractRow = (hrId: string, renewalDate: string, workflow: unknown = null) => ({
      area: "Cairo 1",
      contract_renewal_date: renewalDate,
      full_name: `Employee ${hrId}`,
      hr_id: hrId,
      job_title: "Medical Rep",
      line: "CNS",
      workflow,
    });

    const contractSources = {
      contracts: {
        rows: [
          contractRow("a-1", shift(-3)),
          contractRow("a-2", shift(30)),
          contractRow("a-3", shift(200)),
          contractRow("a-4", shift(5), { id: "REQ-1", status: "manager_review" }),
          contractRow("a-5", shift(2), {
            createdAt: null,
            id: "REQ-2",
            managerReviewedAt: null,
            status: "hr_review",
          }),
        ],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- literal fixtures, not fetches
    const contractTasks = buildHrTodayTasks(contractSources as any, "HR Operations");

    const raise = named(contractTasks, "raise-contract-renewals");
    assert.deepEqual(
      raise.items.map((item) => item.id),
      ["a-1", "a-2"],
      "only a contract inside the horizon AND with no renewal request in flight is work: a-3 is 200 days out, a-4 and a-5 already have a request, and a-1 has already lapsed",
    );
    assert.equal(
      raise.items[0].age,
      "lapsed 3 days ago",
      "a renewal date that has passed reads as lapsed, never as a future renewal",
    );
    assert.equal(raise.items[0].urgent, true, "a lapsed contract is urgent");
    assert.equal(raise.items[1].age, "renews in 30 days");
    assert.equal(raise.items[1].urgent, false, "30 days out is a diary note, not a problem");
    assert.equal(raise.urgency, "overdue", "a task holding a lapsed contract is not calm");

    const signOff = named(contractTasks, "sign-off-contract-renewals");
    assert.deepEqual(
      signOff.items.map((item) => item.id),
      ["REQ-2"],
      "only a request actually sitting at hr_review is waiting on HR — manager_review is somebody else's step",
    );

    // `lastDayLabel` and `daysUntil` OUTLIVE the clearance tasks that were their first callers,
    // so their semantics are pinned here on the one that survives. The pair is easy to get
    // backwards: `daysSince` counts UP from something that happened, `daysUntil` counts DOWN to a
    // deadline, and a sign flip renders somebody who left last week as "last day in 5 days" —
    // a leaver who is already gone, shown to HR as one they still have a week to handle.
    const resignationRow = (
      id: string,
      effectiveDate: string,
      status: string,
    ) => ({
      effectiveDate,
      employeeName: `Employee ${id}`,
      id,
      jobTitle: "Medical Rep",
      lineName: "CNS",
      status,
    });

    const resignationSources = {
      resignations: {
        records: [
          resignationRow("R-1", shift(-5), "under_review"),
          resignationRow("R-0", shift(0), "submitted"),
          resignationRow("R-2", shift(3), "submitted"),
          resignationRow("R-3", shift(40), "submitted"),
          resignationRow("R-4", shift(1), "completed"),
        ],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- literal fixtures, not fetches
    const resignationTasks = buildHrTodayTasks(resignationSources as any, "HR Operations");

    const processing = named(resignationTasks, "process-resignations");
    assert.deepEqual(
      processing.items.map((item) => item.id),
      ["R-1", "R-0", "R-2", "R-3"],
      "only a resignation still waiting on HR is work, and the closest deadline sorts first — a last day already passed outranks one falling today, and R-4 is completed and has already moved",
    );
    assert.equal(
      processing.items[0].age,
      "last day was 5 days ago",
      "an effective date in the PAST must read as passed; the sign flip here shows a leaver who has already gone as one leaving next week",
    );
    assert.equal(
      processing.items[0].urgent,
      true,
      "a last working day that has already passed is urgent by definition",
    );
    assert.equal(
      processing.items[1].age,
      "last day is today",
      "the day itself is its own case: \"last day in 0 days\" is what a naive countdown prints, and it reads as a diary note on the one day the leaver actually walks out",
    );
    assert.equal(processing.items[1].urgent, true, "today is inside any urgency window");
    assert.equal(processing.items[2].age, "last day in 3 days");
    assert.equal(processing.items[2].urgent, true, "inside a week is urgent");
    assert.equal(processing.items[3].age, "last day in 40 days");
    assert.equal(
      processing.items[3].urgent,
      false,
      "40 days out is a diary note — the 7-day threshold is the whole distinction",
    );
  }

  // ── 7. A CV already decided on is not waiting for a read ───────────────────
  {
    // THE DEFECT THIS PINS (2026-10-16). The board counted applications by their STAGE, and no
    // decision screen moves the application: shortlisting, rejecting or hiring writes the
    // CANDIDATE's status. Production held three applications at CV screening, all three for people
    // already shortlisted, rejected or hired, and the Talent Acquisition seat read "waiting 61 days".
    const longAgo = new Date(Date.now() - 61 * 86_400_000).toISOString();
    const application = (id: string, stage: string, candidate: { status: string } | null) => ({
      candidate: candidate && { fullName: id, ...candidate },
      id,
      lastStageChangedAt: longAgo,
      requisition: { jobTitle: "District Sales Manager" },
      stage,
    });
    const sources = {
      recruitment: {
        applications: [
          application("undecided", "cv_screening", { status: "new" }),
          application("legacy-text", "cv_screening", { status: "Candidate created" }),
          application("no-candidate-row", "application_received", null),
          application("shortlisted", "cv_screening", { status: "shortlisted" }),
          application("rejected", "cv_screening", { status: "rejected" }),
          application("hired", "cv_screening", { status: "hired" }),
          application("with-manager", "phone_screening", { status: "sent_to_manager" }),
          application("backup", "cv_screening", { status: "backup" }),
          application("undecided-but-interviewing", "hr_interview", { status: "new" }),
        ],
        requisitions: [],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- literal fixtures, not fetches
    const screening = buildHrTodayTasks(sources as any, "HR Resourcing").find(
      (item) => item.key === "screen-candidates",
    );
    assert.ok(screening, "the screening task was not built");
    assert.deepEqual(
      screening.items.map((item) => item.id).sort(),
      ["legacy-text", "no-candidate-row", "undecided"],
      "only an application whose candidate is still undecided is waiting on a CV read — a decided candidate (shortlisted, rejected, hired, with a manager, backup) must never read as 'waiting 61 days', and a row with no candidate record cannot be judged so it stays rather than vanishing",
    );
  }

  // ── 7b. The Screen queue is the candidate pool when the caller loaded it ───
  {
    // THE DEFECT THIS PINS (owner, 2026-10-16: "count new candidates"). The queue read applications
    // against a requisition and showed 0 while 754 candidates sat at status New — the half of the
    // ATS people actually work is the pool. The total is the pool's `new` pile, the same figure as
    // "Awaiting Review"; the rows are only the longest-waiting few, so the count must NOT be the
    // number of rows.
    const longAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const sources = {
      recruitment: {
        applications: [],
        awaitingReview: [
          { fullName: "Mona Fathy", id: "c-1", receivedAt: longAgo, source: "whatsapp" },
          { fullName: null, id: "c-2", receivedAt: new Date().toISOString(), source: null },
        ],
        requisitions: [],
        summary: { candidatePool: { new: 754 } },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- literal fixtures, not fetches
    const screening = buildHrTodayTasks(sources as any, "HR Resourcing").find(
      (item) => item.key === "screen-candidates",
    );
    assert.ok(screening, "the screening task was not built");
    assert.equal(screening.count, 754, "RED the queue's count is the pool's undecided pile, not the two rows previewed");
    assert.equal(screening.totalItems, 754, "and the true number is carried beside the capped rows");
    assert.equal(screening.title, "Screen 754 candidates", "the heading says the true size");
    assert.equal(screening.urgency, "overdue", "a CV that has waited 40 days makes the queue overdue");
    assert.deepEqual(
      screening.items.map((item) => [item.id, item.meta, item.name]),
      [
        ["c-1", "WhatsApp", "Mona Fathy"],
        ["c-2", "Candidate pool", "Candidate record with no name"],
      ],
      "the longest-waiting CV comes first, the intake channel is a name and not a code, and a nameless record is said so",
    );
    assert.equal(
      buildHrTodayTasks(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- literal fixtures, not fetches
        { recruitment: { applications: [], awaitingReview: [], requisitions: [], summary: { candidatePool: { new: 0 } } } } as any,
        "HR Resourcing",
      ).find((item) => item.key === "screen-candidates")?.urgency,
      "clear",
      "an empty pool pile is a clear queue, never a phantom row",
    );

    // Both loaders must ask for it, or the page quietly falls back to the unused half.
    for (const file of ["../src/lib/hr/command-center.ts", "../src/lib/hr/talent-acquisition-overview.ts"]) {
      assert.match(
        readFileSync(new URL(file, import.meta.url), "utf8"),
        /getRecruitmentDashboard\(access, \{ awaitingReviewLimit: ITEM_PREVIEW_LIMIT, hiredWindow \}\)/,
        `${file} must load the longest-waiting CVs for the Screen queue`,
      );
    }
  }

  // ── 8. A rejected or hired candidate is not waiting at an interview ────────
  {
    // Same defect as §7, on the interview list: no decision screen moves the application's stage.
    // Only rejected and hired END a pipeline; shortlisted, backup and with-a-manager stay live, so
    // a person genuinely mid-interview is never hidden.
    const longAgo = new Date(Date.now() - 62 * 86_400_000).toISOString();
    const application = (id: string, stage: string, candidate: { status: string } | null) => ({
      candidate: candidate && { fullName: id, ...candidate },
      id,
      lastStageChangedAt: longAgo,
      requisition: { jobTitle: "Medical Representative" },
      stage,
    });
    const sources = {
      recruitment: {
        applications: [
          application("shortlisted", "hr_interview", { status: "shortlisted" }),
          application("new", "interview_scheduling", { status: "new" }),
          application("with-manager", "hiring_manager_interview", { status: "sent_to_manager" }),
          application("backup", "hr_interview", { status: "backup" }),
          application("no-candidate-row", "hr_interview", null),
          application("rejected", "hr_interview", { status: "rejected" }),
          application("hired", "hiring_manager_interview", { status: "hired" }),
          application("rejected-screening", "cv_screening", { status: "rejected" }),
        ],
        requisitions: [],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- literal fixtures, not fetches
    const interviews = buildHrTodayTasks(sources as any, "HR Resourcing").find(
      (item) => item.key === "advance-interviews",
    );
    assert.ok(interviews, "the interviews task was not built");
    assert.deepEqual(
      interviews.items.map((item) => item.id).sort(),
      ["backup", "new", "no-candidate-row", "shortlisted", "with-manager"],
      "a rejected or hired candidate must never read as an interview waiting 62 days; every live pile and a row with no candidate record stays",
    );
  }
}
