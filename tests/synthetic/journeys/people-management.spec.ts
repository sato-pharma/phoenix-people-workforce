import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

test("People Management loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    { id: "people-management", name: "People Management loads", route: "/employees", role: "Super Admin" },
    async (page) => {
      await expect(page.getByPlaceholder(/Search by name, ID, email, or manager/i)).toBeVisible();
    },
  );
});
