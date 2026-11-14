import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

/**
 * The expenses export, which reads through the SAME function as the queue and the dashboard.
 *
 * OPT-IN, AND NOT BY OVERSIGHT. This journey is declared `mutates` and self-skips unless
 * SYNTHETIC_ALLOW_MUTATION=true, which the workflow never sets. The reason is one line in the route:
 * `/api/admin/outstation/expenses/export` calls `writeAuditLog`. Running it hourly would put 24
 * "exported expenses" rows a day into production audit data that no human performed — the same
 * reasoning that keeps the suite on an hourly cadence rather than every 15 minutes, so the one real
 * Super Admin login per run stays bounded. Audit data that records actions nobody took is worse than
 * a gap in coverage, because it is believed.
 *
 * `mutates` is declared in helpers/types.ts but nothing enforces it — the type comment says a
 * mutating journey "must set this and self-skip". This is the first journey to do so, so the skip is
 * implemented here rather than assumed.
 *
 * WHAT STILL COVERS THE EXPORT HOURLY. It shares `listUnifiedOutstationExpenses` with the dashboard
 * and the admin queue, both of which run every hour. The risky surface — the expense_claims read
 * path behind PHOENIX_EXPENSE_CLAIMS_READ — is therefore watched continuously. What this journey
 * adds, when run deliberately, is the workbook generation on top of that read.
 *
 * To run it: SYNTHETIC_ALLOW_MUTATION=true pnpm run synthetic:test
 */
test("Outstation Expenses export produces a workbook", async ({ page }, testInfo) => {
  test.skip(
    process.env.SYNTHETIC_ALLOW_MUTATION !== "true",
    "Downloading the export records that an administrator exported expenses, so an hourly run would record 24 exports a day that nobody made.",
  );

  await runJourney(
    page,
    testInfo,
    {
      id: "outstation-expenses-export",
      name: "Outstation Expenses export produces a workbook",
      route: "/admin/outstation/expenses",
      role: "Super Admin",
      mutates: true,
    },
    async (page) => {
      // Fetched from the page so the session cookie travels with it, exactly as a real download does.
      // The body is deliberately NOT read: it is a spreadsheet, and its size is not the assertion.
      const result = await page.evaluate(async () => {
        const res = await fetch("/api/admin/outstation/expenses/export", { credentials: "include" });
        return {
          status: res.status,
          contentType: res.headers.get("content-type") ?? "",
          disposition: res.headers.get("content-disposition") ?? "",
        };
      });

      // 429 is a real answer from this route (it is rate limited) and must not read as success.
      expect(result.status, `export returned ${result.status}`).toBe(200);
      expect(result.contentType).toContain("spreadsheetml.sheet");
      expect(result.disposition).toContain("attachment");
    },
  );
});
