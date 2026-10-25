import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PRIVATE_FILE_CACHE_CONTROL_SECONDS } from "../src/lib/uploads/private-file-cache.ts";
import { isVacationSchemaMissing } from "../src/lib/vacation/service.ts";

/**
 * THE CACHE AUDIT'S P1 AND P2 FIXES (2026-10-26). The audit is
 * docs/production-audits/cache-audit-2026-10-26.md; the P0 (browser drafts and offline queues on a
 * shared device) is pinned by tests/browser-storage-owner-scoped.test.ts.
 *
 * Each fix stops a cache from keeping a wrong answer — a failed read cached as "nothing", a write that
 * did not expire the screen it moves, a private file kept for a year. Most of them live in route
 * handlers and cached loaders, so their half is read as source. Each target is read INSIDE the run
 * function (a module-level read cannot be break-tested in one process), and every pattern names a call
 * with its arguments, which a comment explaining it never spells out.
 */

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function count(text: string, pattern: RegExp): number {
  return (text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
}

export function runCacheAuditFixesTests() {
  // ── 1. A missing vacation table is told apart from a database that is restarting ─────────────────────
  {
    assert.equal(
      isVacationSchemaMissing({ code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }),
      false,
      "HEADLINE: a restarting database (PGRST002) is a failure, never 'the leave tables are missing' — that read " +
        "was answered as no requests, cached for 60 s, and the portal showed the whole entitlement as remaining",
    );
    assert.equal(
      isVacationSchemaMissing(new Error("Could not query the database for the schema cache. Retrying.")),
      false,
      "nor when only its message survived",
    );
    assert.equal(
      isVacationSchemaMissing({ code: "PGRST205", message: "Could not find the table 'public.vacation_requests' in the schema cache" }),
      true,
      "PostgREST's own missing-table answer is a missing table",
    );
    assert.equal(
      isVacationSchemaMissing({ code: "42P01", message: 'relation "public.vacation_requests" does not exist' }),
      true,
      "so is Postgres's",
    );
    assert.equal(
      isVacationSchemaMissing(new Error("Could not find the table 'public.vacation_requests' in the schema cache")),
      true,
      "and both still read when only the message was kept",
    );
    assert.equal(isVacationSchemaMissing(new Error('relation "public.vacation_requests" does not exist')), true);
    assert.equal(
      isVacationSchemaMissing({ code: "42501", message: "permission denied for table vacation_requests" }),
      false,
      "a permission error that merely names a leave table is a real failure",
    );
    assert.equal(
      isVacationSchemaMissing(new Error("permission denied for table vacation_requests")),
      false,
      "with or without its code",
    );
    assert.equal(
      isVacationSchemaMissing({ code: "42703", message: 'column "decided_by" of relation "vacation_requests" does not exist' }),
      false,
      "a missing COLUMN is never a missing table",
    );
    assert.equal(
      isVacationSchemaMissing(new Error('column "decided_by" of relation "vacation_requests" does not exist')),
      false,
      "even when only its message survived",
    );
  }

  // ── 2. Approving a leave signal expires the report at once, and nothing turns that back ──────────────
  {
    const route = source("app/api/vacation/company-report/approve/route.ts");
    assert.doesNotMatch(
      route,
      /revalidateTag\(/,
      "the approve route runs no cache bust of its own: its old revalidateTag(…, \"max\") ran after the service's " +
        "{ expire: 0 } in the same request and served the reviewer the signal they had just approved",
    );
    const invalidation = source("src/lib/dashboard/invalidation.ts");
    assert.doesNotMatch(invalidation, /revalidateTag\(COMPANY_VACATION_REPORT_CACHE_TAG, "max"\)/, "the report's tag is never busted with \"max\"");
  }

  // ── 3. A failed CRM scan is an error, never "nothing happened" for a minute ──────────────────────────
  {
    const master = source("src/lib/crm/master.ts");
    assert.match(
      master,
      /if \(error\) throw new Error\(`CRM double-visit scan failed: \$\{error\.message\}`\);/,
      "a failed double-visit page throws, so the 60 s memo never keeps 'no double visits' for every viewer",
    );
    assert.match(master, /if \(error\) throw new Error\(`CRM vacation scan failed: \$\{error\.message\}`\);/, "and so does a failed vacation page");
    assert.doesNotMatch(master, /if \(dv\.length === 0\) return \{ rows: \[\], byVisitId: new Map\(\), truncated: false \};/);
    assert.doesNotMatch(master, /if \(days\.length === 0\) return \{ periods: \[\], truncated: false \};/);
  }

  // ── 4. The Company Vacation Report never caches a half-read holiday calendar or fingerprint list ─────
  {
    const report = source("src/lib/vacation/company-vacation-report.ts");
    assert.match(
      report,
      /unstable_cache\(loadHolidayDatesComplete, \["company-vacation-report-holidays-complete"\]/,
      "the 6 h holiday cache holds only a range whose every month was read, under a key no outage entry was written to",
    );
    assert.match(
      report,
      /if \(results\.some\(\(result\) => !result \|\| !result\.calendarReachable\)\) \{\s*throw new Error\(/,
      "a month the calendar could not answer throws instead of caching the fixed-date holidays alone",
    );
    assert.match(
      report,
      /loadHolidayDatesCached\(historical\.start, historical\.end\)\.catch\(\(\) => loadHolidayDates\(historical\.start, historical\.end\)\)/,
      "and that one load falls back to the uncached best-effort read",
    );
    assert.match(
      report,
      /async \(\) => \[\.\.\.\(await loadActiveDeviceMappedHrIds\(\)\)\],\s*\["company-vacation-report-device-mapped-v2"\]/,
      "a failed fingerprint-mapping read throws, never cached as 'nobody is mapped' — which showed worked days as approvable leave",
    );
    assert.doesNotMatch(report, /loadActiveDeviceMappedHrIds\(\)\.catch\(/);
  }

  // ── 5. Writes that move a cached screen expire it ──────────────────────────────────────────────────────
  {
    const invalidation = source("src/lib/dashboard/invalidation.ts");
    assert.match(invalidation, /revalidateTag\(CRM_DAILY_FORECAST_CACHE_TAG, \{ expire: 0 \}\)/, "the daily forecast has its own bust");
    assert.match(
      source("src/lib/phoenix-crm/server/daily-forecast.ts"),
      /tags: \["sos-reference", CRM_DAILY_FORECAST_CACHE_TAG\]/,
      "and its cached closing wears that tag",
    );
    const publication = source("src/lib/sales/monthly-closing-publication.ts");
    assert.match(
      publication,
      /invalidateCrmDailyForecastCache\(`closing published — \$\{line\}\/\$\{period\}`\);/,
      "a publish moves the reps' forecast onto the published month at once",
    );
    assert.match(publication, /invalidateCrmDailyForecastCache\(`closing unpublished — \$\{input\.line\}\/\$\{period\}`\);/, "and so does an unpublish");
    assert.match(source("src/lib/sales/monthly-targets.ts"), /invalidateCrmDailyForecastCache\("monthly targets saved"\);/, "and a target save");
    assert.match(
      source("src/lib/sales/monthly-targets-drop.ts"),
      /invalidateCrmDailyForecastCache\(`monthly targets dropped — \$\{lineLabel\}\/\$\{input\.period\}`\);/,
      "and a target drop",
    );

    assert.match(invalidation, /revalidateTag\(COMPANY_VACATION_REPORT_CACHE_TAG, \{ expire: 0 \}\)/);
    assert.match(
      source("src/lib/vacation/holiday-override-store.ts"),
      /invalidateCompanyVacationReportCache\("holiday calendar overrides saved"\);/,
      "a re-dated holiday reaches the vacation report at once, not after its 6 h cache",
    );

    assert.equal(
      count(invalidation, /revalidateTag\(FINANCE_DASHBOARD_CACHE_TAG, \{ expire: 0 \}\)/),
      2,
      "the Finance Command Center is expired at once, by both of its busts",
    );
    assert.doesNotMatch(invalidation, /revalidateTag\(FINANCE_DASHBOARD_CACHE_TAG, "max"\)/, "never stale-while-revalidate");
    assert.match(invalidation, /revalidateTag\("sos-reference", \{ expire: 0 \}\)/, "the org tree, at once, after a hire or seat move");
    assert.doesNotMatch(invalidation, /revalidateTag\("sos-reference", "max"\)/);

    const orders = source("src/lib/direct-orders/service.ts");
    for (const reason of [
      "direct orders rejected with their venue",
      "held direct order revived",
      "held direct order cancelled",
      "direct order submitted",
      "direct order decided",
      "direct order sales month set",
    ]) {
      assert.match(orders, new RegExp(`invalidateFinanceDashboardCache\\("${reason}"\\);`), `a direct order's "${reason}" reaches the finance landing`);
    }
    assert.match(
      orders,
      /if \(affected\.length > 0\) invalidateFinanceDashboardCache\("direct orders rejected with their venue"\);/,
      "only when the venue rejection actually closed an order",
    );

    const requests = source("src/lib/marketing-requests/service.ts");
    const mappedAt = requests.indexOf("request = mapRequest(rpcData.request)");
    const bustAt = requests.indexOf('invalidateFinanceDashboardCache("marketing request step decided");');
    assert.ok(bustAt !== -1, "a marketing request decision reaches the finance landing");
    assert.ok(mappedAt !== -1 && bustAt > mappedAt, "once the decision is saved");

    assert.match(
      source("app/api/imports/employees/confirm/route.ts"),
      /invalidateExecutiveDashboardCache\("employee import confirmed", \["employees", "vacancies", "payroll"\]\);/,
      "an employee import busts what a single employee save busts: the org tree's seats and the finance headcount",
    );

    assert.match(
      source("src/lib/crm/contact-lists/service.ts"),
      /revalidateTag\(CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG, \{ expire: 0 \}\)/,
      "a contact-list change shows the new sizes on the manager's next read",
    );
  }

  // ── 6. A failed read is answered once, never cached ────────────────────────────────────────────────────
  {
    const employees = source("src/lib/sales/employees.ts");
    assert.equal(count(employees, /setMemoryCache\(rows\);/), 1, "only the full directory is cached");
    assert.ok(
      employees.indexOf("setMemoryCache(rows);") < employees.indexOf('.from("employees")'),
      "and the lean fallback with no line, region or area — which stamped every import row 'Unassigned' for five minutes — never is",
    );

    for (const path of ["src/lib/sales/normalizer/distributor-profile-store.ts", "src/lib/sales/weekly/weekly-column-profile-store.ts"]) {
      const store = source(path);
      assert.match(store, /if \(loaded\) cache = \{ at: Date\.now\(\), byCode \};/, `${path} caches the saved column overrides only after a read that worked`);
      assert.match(store, /loaded = true;/);
      assert.doesNotMatch(store, /^\s*cache = \{ at: Date\.now\(\), byCode \};/m, `${path} never caches the empty map a failed read leaves`);
    }
  }

  // ── 7. Private files are kept by a browser no longer than the link that opened them ──────────────────
  {
    assert.equal(PRIVATE_FILE_CACHE_CONTROL_SECONDS, "300", "five minutes, the signed link's own life");
    for (const [path, sites] of [
      ["src/lib/vacation/service.ts", 3],
      ["src/lib/hiring-documents/file-storage.ts", 1],
      ["src/lib/outstation/car-evidence-storage.ts", 5],
      ["src/lib/marketing-requests/evidence-photo-storage.ts", 2],
    ] as const) {
      const file = source(path);
      assert.equal(count(file, /cacheControl: PRIVATE_FILE_CACHE_CONTROL_SECONDS,/), sites, `${path} uploads every private file with the short cache`);
      assert.doesNotMatch(file, /"31536000"/, `${path} never asks a browser to keep a sick note, ID or evidence photo for a year`);
    }

    assert.match(source("app/api/payroll/[id]/payslips/route.ts"), /"Cache-Control": "private, no-store",/, "a payslip is never stored by a browser or proxy");
    assert.match(
      source("src/lib/recruitment/file-response.ts"),
      /"Cache-Control": "private, no-store",\s*"Content-Disposition": `\$\{inline \? "inline" : "attachment"\}/,
      "nor is a candidate's CV or ID scan — the file itself, not only the refusals before it",
    );
  }

  // ── 8. A replaced employee photo shows on the next look ────────────────────────────────────────────────
  {
    const route = source("app/api/employees/[hrId]/photo/route.ts");
    assert.match(
      route,
      /const cacheControl = versioned \? "private, max-age=86400, must-revalidate" : "private, no-cache";/,
      "a bare photo link asks every time; only a link versioned by the photo's update time is kept a day",
    );
    assert.match(route, /const etag = await employeePhotoEtag\(hrId\);/, "the photo carries a validator");
    assert.match(
      route,
      /if \(request\.headers\.get\("if-none-match"\) === etag\) \{\s*return new NextResponse\(null, \{ status: 304,/,
      "so asking again is a 304 without downloading the picture",
    );
    assert.match(route, /"Cache-Control": cacheControl,\s*ETag: etag,/);
    assert.doesNotMatch(route, /"Cache-Control": "private, max-age=86400, must-revalidate",/, "a bare link is never kept a day");
  }

  // ── 9. The AI note memos are bounded ───────────────────────────────────────────────────────────────────
  {
    for (const [path, limit, remember] of [
      ["src/lib/crm/campaign-account.ts", "CAMPAIGN_ACCOUNT_MEMO_MAX_ENTRIES", "rememberAccount(note, account);"],
      ["src/lib/crm/campaign-note-assist-model.ts", "CAMPAIGN_NOTE_ASSIST_MEMO_MAX_ENTRIES", "rememberReading(fragment, reading);"],
    ] as const) {
      const file = source(path);
      assert.match(file, new RegExp(`export const ${limit} = 2_000;`), `${path} keeps at most 2,000 readings`);
      assert.match(file, new RegExp(`while \\(memo\\.size > ${limit}\\) \\{`), `${path} forgets the oldest past the limit`);
      assert.ok(file.includes(remember), `${path} stores every reading through the bounded write`);
      assert.equal(count(file, /memo\.set\(/), 1, `${path} has no other, unbounded write`);
    }
  }
}
