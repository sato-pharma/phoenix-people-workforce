import { test, expect, type Page } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

/**
 * Reps Weekly Plans — the board renders and its plan-status filter agrees with its own tiles.
 *
 * ## Why this journey exists
 *
 * The status filter shipped on 2026-09-02 (#2898) and could not be verified by hand on production:
 * `/api/dev-auth` is correctly 404 there, so the only way onto the board is a real login. This
 * suite already holds one, and it is read-only by construction — which is the reason to put the
 * check here rather than click through production once and call it verified.
 *
 * It is also the first journey over `/admin/reps-list`. The page carries two controls an automated
 * run must NEVER press: **Verify**, which writes a plan's status into the customer's CRM and emails
 * the rep, and the admin **Refresh**, which starts a real vendor sync. So this journey navigates by
 * URL and asserts; it never clicks anything on the board. Keep it that way — a click located by
 * coordinate has already fired a real production collection run once in this repository's history.
 *
 * ## What it asserts, and why not the numbers themselves
 *
 * The board's figures change every week, so pinning "70 reps" would fail by Tuesday and teach
 * everyone to ignore the suite. What does not change is the ARITHMETIC — and that is exactly what
 * broke twice while the feature was being built:
 *
 *  - the four groups must PARTITION the week: `all = awaiting + verified + missing`. The tiles and
 *    the filter counted separately at one point, and a tile reading "Awaiting you 3" that narrows
 *    to two reps looks like a data problem rather than a bug.
 *  - each slice must hold exactly as many reps as its own option promised. The counts were briefly
 *    taken over the rep-narrowed cascade, so with a rep open the picker offered "Verified (0)" for
 *    a slice holding 61 people.
 *  - an unrecognised `?status=` must WIDEN to every rep, never empty the board. An empty board
 *    reads as "nobody in your reach filed a plan this week" — a statement about the reps, and one a
 *    manager acts on — rather than as a bad URL.
 *
 * Each holds whatever the week's numbers are, which is what makes them worth running against live
 * data six times a day.
 */

const ROUTE = "/admin/reps-list?tab=plans";

/** The status control. Implicitly labelled — the `<select>` sits inside its `<label>`. */
const statusSelect = (page: Page) => page.getByLabel("Plan status");

/**
 * A rep's link carries `&rep=` in its href; the four tiles carry `status=` and no rep.
 *
 * VISIBLE links only. Since the premium pass of 9 November 2026 (#171) the board prints every rep
 * TWICE in the page: once as a card for a phone (`md:hidden`) and once as a row of the team table for
 * a desktop (`hidden md:block`). Only one of the two is ever shown, so a manager sees each rep once —
 * but a count of every link in the page comes to exactly double, and this journey failed on that for
 * five days while the board itself was right. Counting what is shown is the count a person makes, and
 * it holds at either width.
 */
const repCards = (page: Page) => page.locator('a[href*="&rep="]:visible');

/**
 * Reads the four counts out of the option labels — "Awaiting verification (3)".
 *
 * The options are the honest source: they are rendered from the same `counts` object the tiles read
 * and the grid is filtered by, so if any of the three ever disagree, it shows here.
 */
async function readCounts(page: Page): Promise<Record<string, number>> {
  const options = await statusSelect(page).locator("option").allTextContents();
  const counts: Record<string, number> = {};
  for (const option of options) {
    const match = /^(.*?)\s*\((\d+)\)\s*$/.exec(option.trim());
    if (match) counts[match[1]!] = Number(match[2]);
  }
  return counts;
}

test("Reps Weekly Plans board and its plan-status filter", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    {
      id: "reps-weekly-plans-filter",
      name: "Reps Weekly Plans board and its plan-status filter",
      route: ROUTE,
      role: "Super Admin",
    },
    async (page) => {
      // 1. The board renders at all, with its filter present.
      await expect(statusSelect(page)).toBeVisible();

      const counts = await readCounts(page);
      const all = counts["All reps"];
      const awaiting = counts["Awaiting verification"];
      const verified = counts["Verified"];
      const missing = counts["No plan filed"];

      expect(
        [all, awaiting, verified, missing].every((n) => typeof n === "number"),
        `the filter must offer all four groups with a count each — got ${JSON.stringify(counts)}`,
      ).toBe(true);

      // 2. THE PARTITION. Every rep in reach lands in exactly one group.
      expect(
        awaiting! + verified! + missing!,
        `the four groups must partition the week: ${awaiting} awaiting + ${verified} verified + ${missing} missing should equal ${all} in reach`,
      ).toBe(all);

      // 3. The board must not scroll sideways — the owner's standing golden rule, and the reason it
      //    renders a table-fixed grid rather than the shared PortalDesktopTable.
      const main = await page.evaluate(() => {
        const el = document.querySelector("main");
        return el ? { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth } : null;
      });
      expect(main, "the board must render a <main>").not.toBeNull();
      expect(
        main!.scrollWidth,
        `the board scrolled sideways: main is ${main!.scrollWidth}px wide inside ${main!.clientWidth}px`,
      ).toBeLessThanOrEqual(main!.clientWidth);

      // 4. Each slice holds exactly what its own option promised. Reached by URL, never by click —
      //    the Verify button lives on this page.
      for (const [status, expected] of [
        ["awaiting", awaiting!],
        ["verified", verified!],
        ["missing", missing!],
      ] as const) {
        await page.goto(`${ROUTE}&status=${status}`);
        await expect(statusSelect(page)).toHaveValue(status);
        await expect(
          repCards(page),
          `?status=${status} must show the ${expected} rep(s) its own option counted`,
        ).toHaveCount(expected);
      }

      // 5. An unrecognised status WIDENS to everybody. Narrowing to none would read as "nobody
      //    filed a plan this week", which is a statement about the reps rather than about the URL.
      await page.goto(`${ROUTE}&status=not-a-real-status`);
      await expect(statusSelect(page)).toHaveValue("all");
      await expect(
        repCards(page),
        "an unrecognised ?status= must fall back to every rep in reach, never to an empty board",
      ).toHaveCount(all!);
    },
  );
});
