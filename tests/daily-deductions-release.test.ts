import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";
import { assertNoDuplicateDailyLines, dailyLineKey, normalizeDailyLine } from "../src/lib/daily-deductions/lines.ts";
import {
  indexReleasedLines,
  linesToRelease,
  releaseLineKey,
  releaseStateOf,
  type ComparableLine,
} from "../src/lib/daily-deductions/release-state.ts";

function line(partial: Partial<ComparableLine> = {}): ComparableLine {
  return {
    category: "fingerprint",
    employeeHrIdCompact: "M101",
    daysCount: 2,
    amount: 300,
    dates: ["2026-09-02", "2026-09-03"],
    ...partial,
  };
}

/**
 * The Daily Deductions page releases ONE deduction at a time, like the weekly attendance review:
 * a tick and a Release button per line, a Release button per employee, and a bulk release. This
 * suite pins the three things that make that safe - the state each line reads as against what is
 * already released, which lines a click actually sends, and the validation every sent line passes -
 * plus the migration that makes a release MERGE into the snapshot instead of replacing it.
 */
export function runDailyDeductionsReleaseTests() {
  // ── a line's state against what is released ─────────────────────────────
  {
    const released = indexReleasedLines([line()]);
    assert.equal(releaseStateOf(line(), released), "released", "the same figures are Released");
    assert.equal(
      releaseStateOf(line({ employeeHrIdCompact: "M102" }), released),
      "not_released",
      "a different employee is not released by someone else's line",
    );
    assert.equal(
      releaseStateOf(line({ category: "crm" }), released),
      "not_released",
      "a different deduction type for the same employee is a separate line",
    );
    assert.equal(
      releaseStateOf(line({ daysCount: 3, amount: 450, dates: ["2026-09-02", "2026-09-03", "2026-09-04"] }), released),
      "changed",
      "a day added since release reads Changed, so it can be re-released",
    );
    assert.equal(
      releaseStateOf(line({ dates: ["2026-09-03", "2026-09-02"] }), released),
      "released",
      "the same days in another order are still the same release",
    );
  }

  // ── which lines a click sends ───────────────────────────────────────────
  {
    const released = indexReleasedLines([line({ employeeHrIdCompact: "M101" }), line({ employeeHrIdCompact: "M103", amount: 90, daysCount: 1, dates: ["2026-09-05"] })]);
    const selection = [
      line({ employeeHrIdCompact: "M101" }), // unchanged -> skipped
      line({ employeeHrIdCompact: "M102" }), // never released -> sent
      line({ employeeHrIdCompact: "M103", amount: 180, daysCount: 2, dates: ["2026-09-05", "2026-09-06"] }), // changed -> sent
    ];
    const sent = linesToRelease(selection, released, null);
    assert.deepEqual(
      sent.map((l) => l.employeeHrIdCompact),
      ["M102", "M103"],
      "a bulk release sends the unreleased and the changed, never the already-released",
    );
    assert.deepEqual(linesToRelease([], released, null), [], "an empty selection sends nothing");

    // A line the tally could not price (no base salary on file) reads 0.00 only because nothing could
    // be priced. Released, it emailed the employee "EGP 0.00 · N days" (audit, 2026-11-07).
    assert.deepEqual(
      linesToRelease([line({ employeeHrIdCompact: "M104", amount: 0, amountUnknown: true })], released, null),
      [],
      "REGRESSION: a line with no computable amount is never sent to release",
    );
    assert.throws(
      () =>
        normalizeDailyLine(
          {
            amount: 0,
            amountUnknown: true,
            category: "fingerprint",
            daysCount: 1,
            dates: ["2026-09-05"],
            employeeHrId: "M-104",
            employeeName: "Test Person",
            rawDaysCount: 1,
            sourceSystem: "fingerprint",
          },
          0,
        ),
      /has no computable amount/,
      "and the server refuses one that is sent anyway",
    );
  }

  // ── the key is employee x category x day, shared by the client and the server ──
  {
    assert.equal(releaseLineKey({ category: "crm", employeeHrIdCompact: "B7" }), "crm|B7|");
    assert.equal(releaseLineKey({ category: "crm", deductionDate: "2026-11-09", employeeHrIdCompact: "B7" }), "crm|B7|2026-11-09");
    assert.equal(
      dailyLineKey({ category: "crm", deductionDate: "2026-11-09", employeeHrIdCompact: "B7" }),
      releaseLineKey({ category: "crm", deductionDate: "2026-11-09", employeeHrIdCompact: "B7" }),
    );
    assert.equal(
      dailyLineKey({ category: "crm", employeeHrIdCompact: "B7" }),
      releaseLineKey({ category: "crm", employeeHrIdCompact: "B7" }),
      "the server's duplicate key and the client's release key are one definition",
    );
  }

  // ── what the server accepts for a released line ─────────────────────────
  {
    const ok = normalizeDailyLine(
      { category: "crm", employeeHrId: " M-101 ", employeeHrIdCompact: "FORGED", employeeName: " Sara ", daysCount: 2, rawDaysCount: 3, amount: 100.456, dates: ["2026-09-02", 5], unit: "days" },
      0,
    );
    assert.equal(ok.employeeHrId, "M-101", "the HR id is trimmed");
    assert.notEqual(ok.employeeHrIdCompact, "FORGED", "the compact id is re-derived server-side, never trusted from the client");
    assert.equal(ok.employeeName, "Sara");
    assert.equal(ok.amount, 100.46, "the amount is rounded to piastres");
    assert.deepEqual(ok.dates, ["2026-09-02"], "a non-string day is dropped");

    assert.throws(() => normalizeDailyLine({ category: "loan", employeeHrId: "M-101", daysCount: 1, rawDaysCount: 1, amount: 1 }, 0), /unknown category/);
    assert.throws(() => normalizeDailyLine({ category: "crm", employeeHrId: "", daysCount: 1, rawDaysCount: 1, amount: 1 }, 0), /HR id/);
    assert.throws(() => normalizeDailyLine({ category: "crm", employeeHrId: "M-101", daysCount: -1, rawDaysCount: 1, amount: 1 }, 0), /≥ 0/);
    assert.throws(() => normalizeDailyLine(null, 0), /not an object/);

    const a = normalizeDailyLine({ category: "crm", employeeHrId: "M-101", daysCount: 1, rawDaysCount: 1, amount: 1 }, 0);
    const b = normalizeDailyLine({ category: "crm", employeeHrId: "M101", daysCount: 2, rawDaysCount: 2, amount: 2 }, 1);
    assert.throws(() => assertNoDuplicateDailyLines([a, b]), /appears twice/, "one employee x type cannot be sent twice in one release");
    const c = normalizeDailyLine({ category: "fingerprint", employeeHrId: "M-101", daysCount: 1, rawDaysCount: 1, amount: 1 }, 2);
    assert.doesNotThrow(() => assertNoDuplicateDailyLines([a, c]), "the same employee under two types is two lines");
  }

  // ── the migration: a release MERGES, a withdraw removes ONE line, both are service_role only ──
  {
    const sql = readFileSync(new URL("../supabase/migrations/20261012132430_daily_deductions_per_line_release.sql", import.meta.url), "utf8");
    const code = stripSqlComments(sql);

    assert.ok(
      code.includes("on conflict (publication_id, employee_hr_id_compact, category) do update"),
      "a release upserts per employee x category, so it replaces only the line it names",
    );
    const release = code.slice(code.indexOf("function public.phx_release_daily_deduction_lines"), code.indexOf("function public.phx_withdraw_daily_deduction_line"));
    assert.ok(
      !/set status = 'superseded'/.test(release),
      "a release never supersedes the active snapshot - that is the replace-everything behaviour it exists to avoid",
    );
    assert.ok(release.includes("pg_advisory_xact_lock"), "a release takes the shared snapshot lock");

    for (const signature of [
      "phx_release_daily_deduction_lines(date, date, jsonb, text, text)",
      "phx_withdraw_daily_deduction_line(uuid, text)",
      "phx_publish_daily_deductions(date, date, jsonb, text, text)",
    ]) {
      assert.ok(
        code.includes(`revoke execute on function public.${signature} from public, anon, authenticated;`),
        `${signature} is revoked from public, anon and authenticated`,
      );
      assert.ok(code.includes(`grant execute on function public.${signature} to service_role;`), `${signature} is granted to service_role only`);
    }
    assert.equal(
      (code.match(/security definer\s+set search_path = public, pg_temp/g) ?? []).length,
      3,
      "all three functions are SECURITY DEFINER with a pinned search_path",
    );
  }
}
