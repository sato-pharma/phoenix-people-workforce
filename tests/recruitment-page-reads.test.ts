import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  describeReadFailures,
  describeUnavailable,
  RECRUITMENT_READ_LABELS,
  RecruitmentReadTimeoutError,
  settleRead,
  settleRecruitmentPage,
  unavailableSources,
  type RecruitmentPageReads,
} from "../src/lib/recruitment/page-reads.ts";

// THE DEFECT. The Recruitment page ran seven reads in ONE `Promise.all` inside ONE `try`. Any single
// rejection blanked the whole page, wrote nothing to the log, and the workspace then said "apply the
// recruitment migrations on staging" -- advice for a fresh environment, shown on a production page that
// was only waiting on a slow database. On 18 Oct 2026 the Talent Acquisition seat met that wall while
// production timed out between 10:30 and 11:55 Cairo; five of the seven reads were optional extras.
//
// These tests pin the replacement: every read settles on its own, a failed read is named rather than
// thrown, and no failure can empty a screen that did not need the read that failed.

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The reads are typed against the real loaders; a test only needs their SHAPE, so the values are cast
// through unknown here rather than rebuilding a dashboard, a candidate and a vacancy report row.
function readsOf(overrides: Partial<Record<keyof RecruitmentPageReads, () => Promise<unknown>>> = {}) {
  const ok = (value: unknown) => async () => value;
  return {
    dashboard: ok({ requisitions: [{ id: "r1" }], applications: [] }),
    pool: ok([{ id: "c1" }, { id: "c2" }]),
    vacancies: ok([{ id: "v1" }]),
    positionCatalogue: ok([{ id: "p1" }]),
    hiringManagers: ok([{ hrId: "M-1" }]),
    employeeDirectory: ok([
      { hrId: "E-2", displayName: "Zeina" },
      { hrId: "E-1", displayName: "Amal" },
    ]),
    areaOptions: ok([{ id: "a1" }]),
    cvFolders: ok({ members: new Map([["f1", ["c1"]]]), rows: [{ id: "f1" }] }),
    whatsappQuestions: ok({ audiences: {}, questions: [] }),
    ...overrides,
  } as unknown as RecruitmentPageReads;
}

const boom = (message: string) => async () => {
  throw new Error(message);
};

export async function runRecruitmentPageReadsTests() {
  // ── 1 · settleRead never rejects ─────────────────────────────────────────────────────────────────
  {
    const good = await settleRead("pool", async () => [1, 2, 3]);
    assert.deepEqual(good, { ok: true, value: [1, 2, 3] });

    const supabaseShaped = { message: "canceling statement due to statement timeout", code: "57014" };
    const rejected = await settleRead("pool", () => Promise.reject(supabaseShaped));
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.failure.source, "pool");
      assert.equal(rejected.failure.label, RECRUITMENT_READ_LABELS.pool);
      assert.equal(rejected.failure.error, supabaseShaped, "the original throw travels with the failure, unchanged");
      assert.equal(rejected.failure.timedOut, false);
    }

    // A loader that throws before it ever returns a promise is still a settled failure, not a crash.
    const syncThrow = await settleRead("vacancies", () => {
      throw new Error("threw before returning a promise");
    });
    assert.equal(syncThrow.ok, false, "a synchronous throw is settled like a rejection");
  }

  // ── 2 · a deadline releases the page without waiting for the slow read ───────────────────────────
  {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const started = Date.now();
      const slow = await settleRead(
        "employeeDirectory",
        () =>
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error("rejected long after its deadline")), 80);
          }),
        { deadlineMs: 15 },
      );
      assert.ok(Date.now() - started < 70, "the page stops waiting at the deadline, not when the read finally answers");
      assert.equal(slow.ok, false);
      if (!slow.ok) {
        assert.equal(slow.failure.timedOut, true);
        assert.ok(slow.failure.error instanceof RecruitmentReadTimeoutError);
      }
      await sleep(120);
      assert.deepEqual(unhandled, [], "a read that rejects after its deadline must not become an unhandled rejection");

      const fast = await settleRead("areaOptions", async () => ["fine"], { deadlineMs: 500 });
      assert.deepEqual(fast, { ok: true, value: ["fine"] }, "a read inside its deadline is untouched by it");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }

  // ── 3 · the page: everything loads ───────────────────────────────────────────────────────────────
  {
    const data = await settleRecruitmentPage(readsOf());
    assert.deepEqual(data.failures, []);
    assert.equal(data.candidates.length, 2);
    assert.equal(data.openVacancies.length, 1);
    assert.deepEqual(
      data.managers.map((manager) => manager.fullName),
      ["Amal", "Zeina"],
      "the manager list is the directory sorted by name",
    );
    assert.deepEqual(
      data.cvFolderCabinet.members,
      { f1: ["c1"] },
      "the cabinet crosses into a client component as a plain object, never as a Map",
    );
  }

  // ── 4 · THE HEADLINE: one failed read no longer blanks the page ──────────────────────────────────
  {
    // An optional extra fails: everything else is still there.
    const noVacancies = await settleRecruitmentPage(readsOf({ vacancies: boom("vacancy report timed out") }));
    assert.ok(noVacancies.dashboard, "a failed vacancy list must not take the dashboard with it");
    assert.equal(noVacancies.candidates.length, 2, "nor the candidate pool");
    assert.deepEqual(noVacancies.openVacancies, []);
    assert.deepEqual(unavailableSources(noVacancies.failures), ["vacancies"]);

    // The POOL fails: the dashboard, vacancies and folders still draw -- which is how the page behaved
    // before it was rewritten to throw at the end, and the reason the pool was settled on its own.
    const noPool = await settleRecruitmentPage(readsOf({ pool: boom("pool read failed") }));
    assert.ok(noPool.dashboard, "a failed pool must not blank the pipeline and requisitions");
    assert.deepEqual(noPool.candidates, []);
    assert.deepEqual(unavailableSources(noPool.failures), ["pool"]);

    // The DASHBOARD fails: the candidate list -- where the work is -- is still there.
    const noDashboard = await settleRecruitmentPage(readsOf({ dashboard: boom("dashboard timed out") }));
    assert.equal(noDashboard.dashboard, null);
    assert.equal(noDashboard.candidates.length, 2, "the screen where the work happens must not depend on the dashboard");
    assert.deepEqual(unavailableSources(noDashboard.failures), ["dashboard"]);

    // The cabinet fails: an EMPTY cabinet, never a half-read one.
    const noCabinet = await settleRecruitmentPage(readsOf({ cvFolders: boom("folders timed out") }));
    assert.deepEqual(noCabinet.cvFolderCabinet, { members: {}, rows: [] });
    assert.deepEqual(unavailableSources(noCabinet.failures), ["cvFolders"]);
  }

  // ── 5 · everything fails: still no throw, every source is named, in the page's own order ─────────
  {
    const everything = await settleRecruitmentPage(
      readsOf({
        dashboard: boom("a"),
        pool: boom("b"),
        vacancies: boom("c"),
        positionCatalogue: boom("d"),
        hiringManagers: boom("e"),
        employeeDirectory: boom("f"),
        areaOptions: boom("g"),
        cvFolders: boom("h"),
        whatsappQuestions: boom("i"),
      }),
    );
    assert.deepEqual(unavailableSources(everything.failures), [
      "dashboard",
      "pool",
      "vacancies",
      "positionCatalogue",
      "hiringManagers",
      "employeeDirectory",
      "areaOptions",
      "cvFolders",
      "whatsappQuestions",
    ]);
    assert.equal(everything.dashboard, null);
    assert.equal(everything.whatsappQuestions, null, "a question list that did not load is null, never an empty list");
    assert.deepEqual(everything.candidates, []);
  }

  // ── 6 · only OPTIONAL reads carry a deadline ─────────────────────────────────────────────────────
  {
    const hang = () => new Promise<never>(() => undefined);
    const started = Date.now();
    const held = await settleRecruitmentPage(readsOf({ hiringManagers: hang }), { optionalDeadlineMs: 20 });
    assert.ok(Date.now() - started < 1000, "a hung optional read must not hold the page");
    assert.deepEqual(unavailableSources(held.failures), ["hiringManagers"]);
    assert.ok(held.failures[0].timedOut);

    // A required read is given the time it needs: slower than the optional deadline, still accepted.
    const slowButFine = await settleRecruitmentPage(
      readsOf({
        pool: async () => {
          await sleep(60);
          return [{ id: "c1" }];
        },
      }),
      { optionalDeadlineMs: 20 },
    );
    assert.deepEqual(slowButFine.failures, [], "the pool and the dashboard are never cut off by the optional deadline");
    assert.equal(slowButFine.candidates.length, 1);
  }

  // ── 7 · the words ────────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(describeUnavailable([]), "");
    assert.equal(describeUnavailable(["pool"]), "the candidate list");
    assert.equal(describeUnavailable(["pool", "cvFolders"]), "the candidate list and the CV folders");
    assert.equal(
      describeUnavailable(["dashboard", "pool", "cvFolders"]),
      "requisitions and the hiring pipeline, the candidate list and the CV folders",
    );
    assert.equal(describeUnavailable(["pool", "pool"]), "the candidate list", "a source named twice is said once");

    const failures = [
      { source: "pool" as const, label: RECRUITMENT_READ_LABELS.pool, error: { message: "statement timeout", code: "57014" }, timedOut: false },
      { source: "employeeDirectory" as const, label: RECRUITMENT_READ_LABELS.employeeDirectory, error: new RecruitmentReadTimeoutError("employeeDirectory", 8000), timedOut: true },
    ];
    const line = describeReadFailures(failures);
    assert.ok(line.includes("pool: ") && line.includes("57014"), "a Supabase-shaped throw keeps its code in the log line");
    assert.ok(!line.includes("[object Object]"), "the log line never says [object Object]");
    assert.ok(line.includes("employeeDirectory (timed out)"), "a missed deadline is marked as one");
    assert.ok(line.includes("2 reads"), "the line counts the reads that did not land");
  }

  // ── 8 · the pages and the workspace use it ───────────────────────────────────────────────────────
  for (const page of ["app/(admin)/recruitment/page.tsx", "app/employee-portals/recruitment/page.tsx"]) {
    const source = read(page);
    assert.ok(source.includes("await settleRecruitmentPage({"), `${page} settles its reads one by one`);
    assert.ok(!/Promise\.all\(\s*\[\s*getRecruitmentDashboard/.test(source), `${page} must not go back to one all-or-nothing Promise.all`);
    assert.ok(!source.includes("initialError"), `${page} no longer hands the workspace one raw error string`);
    assert.ok(source.includes("logRecruitmentReadFailures(access, failures,"), `${page} leaves a row in the error log when a read failed`);
    assert.ok(source.includes("unavailableSources={unavailableSources(failures)}"), `${page} tells the workspace which parts are missing`);
  }

  const logger = read("src/lib/recruitment/page-read-log.ts");
  assert.ok(logger.includes("if (failures.length === 0) return;"), "a clean load writes nothing");
  assert.ok(logger.includes("void logAppError("), "the log is fire-and-forget: the page is already waiting on a slow database");
  assert.equal((logger.match(/logAppError\(/g) ?? []).length, 1, "ONE row per load, never one per read");

  const workspace = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.ok(
    !workspace.includes("apply the recruitment migrations"),
    "the 'fresh environment' advice must not come back on a production page that was only slow",
  );
  assert.ok(workspace.includes("<RecruitmentUnavailableNotice"), "the workspace names what did not load");
  assert.ok(
    // The tiles are a RecruitmentKpiStrip since the 2026-10-19 premium sweep, so the value is an item field.
    workspace.includes('value: poolUnavailable ? "—" : candidateStats.arrivedToday,'),
    "a pool that did not load reads as a dash in the tiles, never as zero CVs",
  );
  assert.ok(
    workspace.includes('tab === "candidates" && poolUnavailable'),
    "the candidate tab says the list is unavailable instead of drawing an empty table",
  );
  assert.ok(
    workspace.includes('(tab === "pipeline" || tab === "requisitions") && !dashboard'),
    "only the tabs that need the dashboard are replaced when it did not load",
  );

  const notice = read("src/components/recruitment/recruitment-unavailable-notice.tsx");
  assert.ok(notice.includes("Try again"), "the notice offers the one thing that helps");
  assert.ok(!/\bhe\b|\bhis\b|\bhim\b/i.test(notice), "neutral wording");
}
