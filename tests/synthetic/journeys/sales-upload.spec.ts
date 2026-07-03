import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

test("Sales Upload loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    { id: "sales-upload", name: "Sales Upload loads", route: "/sales/upload", role: "Super Admin" },
    async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Sales Upload" })).toBeVisible();
    },
  );
});
