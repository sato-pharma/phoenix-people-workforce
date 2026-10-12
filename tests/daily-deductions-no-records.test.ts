import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { compactDeductionsHrId } from "../src/lib/deductions/candidate-key.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { clipDraftToRange } from "../src/lib/daily-deductions/compute.ts";
import {
  isOwnedByAnotherDeductionConnector,
  selectNoRecordsDrafts,
  type NoRecordsDay,
} from "../src/lib/daily-deductions/no-records-select.ts";
import {
  dailyDeductionCategories,
  dailyDeductionConnectorLabels,
  dailyDeductionConnectors,
} from "../src/lib/daily-deductions/types.ts";

/**
 * The Daily Deductions "No records" connector (owner, 2026-10-12): every active employee with
 * no punch AND no other activity on a working day. This suite pins the three things that make
 * it safe to turn on company-wide:
 *
 *   1. it never double-books a person another connector already owns (Medical Reps -> crm,
 *      district managers -> dsm_no_record, the SFE Manager -> the standing no-deduction rule);
 *   2. it never charges a company-wide outage day (punches arrive late, so "yesterday" can look
 *      like a dead device until the next sync — 11 Oct 2026 was exactly this);
 *   3. it never emits a deduction for a person with no base salary.
 */

const MONTH = 10;
const YEAR = 2026;

function day(employeeHrId: string, date: string, name = "Test Person"): NoRecordsDay {
  return { date, description: "No Activity Recorded", employeeHrId, employeeName: name };
}

function titles(entries: Array<[string, string | null]>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const [hrId, title] of entries) {
    const key = canonicalHrIdKey(hrId);
    if (key) map.set(key, title);
  }
  return map;
}

function salaries(entries: Array<[string, number | null]>): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const [hrId, salary] of entries) {
    const key = compactDeductionsHrId(hrId);
    if (key) map.set(key, salary);
  }
  return map;
}

function select(input: {
  days: NoRecordsDay[];
  titleEntries: Array<[string, string | null]>;
  salaryEntries: Array<[string, number | null]>;
  outage?: string[];
}) {
  return selectNoRecordsDrafts({
    days: input.days,
    jobTitleByCanonicalKey: titles(input.titleEntries),
    outageDates: new Set(input.outage ?? []),
    baseSalaryByCompact: salaries(input.salaryEntries),
    month: MONTH,
    year: YEAR,
  });
}

export async function runDailyDeductionsNoRecordsTests(): Promise<void> {
  // ── THE HAPPY PATH — one office employee, one empty day, one day's pay ────
  {
    // October has 31 days, so a 31,000 base is exactly 1,000.00 a day.
    const drafts = select({
      days: [day("A-10", "2026-10-11", "Nahed Hattab")],
      titleEntries: [["A-10", "Product Manager"]],
      salaryEntries: [["A-10", 31000]],
    });
    assert.equal(drafts.length, 1, "an office employee with an empty working day yields exactly one draft");
    const [draft] = drafts;
    assert.equal(draft.category, "no_records_activity");
    assert.deepEqual(draft.dates, ["2026-10-11"]);
    assert.equal(draft.rawValue, 1);
    assert.equal(draft.estimatedAmount, 1000);
    assert.equal(draft.unit, "days");

    // The daily module's own clip keeps it whole inside the range and drops it outside.
    const inside = clipDraftToRange(draft, "2026-10-01", "2026-10-12");
    assert.ok(inside, "an in-range day survives the clip");
    assert.equal(inside.daysCount, 1);
    assert.equal(inside.amount, 1000);
    assert.equal(clipDraftToRange(draft, "2026-10-12", "2026-10-20"), null, "an out-of-range day is dropped");
  }

  // ── A COMPANY-WIDE OUTAGE DAY IS NEVER CHARGED ────────────────────────────
  {
    const base = {
      days: [day("A-10", "2026-10-11"), day("A-10", "2026-10-13")],
      titleEntries: [["A-10", "Product Manager"]] as Array<[string, string | null]>,
      salaryEntries: [["A-10", 31000]] as Array<[string, number | null]>,
    };
    const withoutOutage = select(base);
    assert.equal(withoutOutage.length, 2, "sanity: with no outage both empty days are charged");
    const withOutage = select({ ...base, outage: ["2026-10-11"] });
    assert.deepEqual(
      withOutage.map((draft) => draft.dates),
      [["2026-10-13"]],
      "the outage day is skipped and the genuinely empty day is kept",
    );
  }

  // ── NEVER DOUBLE-BOOK A PERSON ANOTHER CONNECTOR OWNS ─────────────────────
  {
    const owned: Array<[string, string]> = [
      ["M-101", "Medical Representative"],
      ["M-102", "Senior Medical Representative"],
      ["M-103", "Employee Medical Rep"],
      ["D-201", "District Sales Manager"],
      ["D-202", "Senior District Manager"],
      ["S-301", "SFE Manager"],
    ];
    for (const [, title] of owned) {
      assert.equal(
        isOwnedByAnotherDeductionConnector(title),
        true,
        `${title} is owned by crm / dsm_no_record / the SFE rule and must be left out`,
      );
    }
    const drafts = select({
      days: owned.map(([hrId]) => day(hrId, "2026-10-11")),
      titleEntries: owned,
      salaryEntries: owned.map(([hrId]) => [hrId, 31000] as [string, number]),
    });
    assert.deepEqual(drafts, [], "no rep, district manager or SFE Manager ever gets a no-records line");

    // Break-the-fix guard: the SAME people with a non-owned title ARE charged, so the
    // exclusion above is the only thing keeping them out.
    const notOwned = select({
      days: owned.map(([hrId]) => day(hrId, "2026-10-11")),
      titleEntries: owned.map(([hrId]) => [hrId, "Talent Acquisition Specialist"] as [string, string]),
      salaryEntries: owned.map(([hrId]) => [hrId, 31000] as [string, number]),
    });
    assert.equal(notOwned.length, owned.length, "with an office title the same people are charged");
  }

  // ── "EVERY ACTIVE EMPLOYEE" — the people the other connectors do NOT own stay in ──
  {
    for (const title of [
      "Product Manager",
      "Group Product Manager",
      "Regional Sales Manager",
      "National Sales Manager",
      "HR Manager",
      "Regulatory Affairs Supervisor",
      null,
    ]) {
      assert.equal(
        isOwnedByAnotherDeductionConnector(title),
        false,
        `${title ?? "(no title)"} is not owned by another connector, so the no-records line applies`,
      );
    }
  }

  // ── NO SALARY BASIS => NO SALARY-BASED DEDUCTION ──────────────────────────
  {
    const drafts = select({
      days: [day("C-1", "2026-10-11"), day("C-2", "2026-10-11"), day("C-3", "2026-10-11")],
      titleEntries: [
        ["C-1", "Financial Advisor"],
        ["C-2", "Financial Advisor"],
        ["C-3", "Financial Advisor"],
      ],
      salaryEntries: [
        ["C-1", null],
        ["C-2", 0],
        // C-3 is absent from the salary map entirely.
      ],
    });
    assert.deepEqual(drafts, [], "no base salary on record means nothing to take a fraction of");
  }

  // ── WIRING — the connector is reachable through the daily module ──────────
  {
    assert.ok(
      (dailyDeductionConnectors as readonly string[]).includes("no_records_activity"),
      "no_records_activity is one of the connectors the daily tally steps through",
    );
    assert.ok(
      (dailyDeductionCategories as readonly string[]).includes("no_records_activity"),
      "a no_records_activity line is a valid published category",
    );
    assert.ok(
      dailyDeductionConnectorLabels.no_records_activity.length > 0,
      "the connector has a human label, never a raw code",
    );
    const service = readFileSync(new URL("../src/lib/daily-deductions/service.ts", import.meta.url), "utf8");
    assert.match(
      service,
      /no_records_activity:\s*\(input\)\s*=>\s*collectNoRecordsDailyCandidates\(input\)/,
      "service.ts runs the no-records collector for the no_records_activity connector",
    );
    const io = readFileSync(new URL("../src/lib/daily-deductions/no-records.ts", import.meta.url), "utf8");
    assert.match(io, /getCompanyWideOutageDates\(start,\s*end\)/, "the loader feeds the outage dates into the selection");
  }
}
