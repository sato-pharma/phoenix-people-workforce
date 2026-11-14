import type { Page, TestInfo } from "@playwright/test";

import { recommendNextStep } from "./recommend";
import type { JourneyDefinition, JourneyResult } from "./types";

/**
 * Shared runner for every journey spec: navigates to the route, captures
 * console/network diagnostics, times the check, and attaches a typed
 * JourneyResult that helpers/reporter.ts turns into the final report.
 * Re-throws on failure so Playwright's own screenshot-on-failure and
 * pass/fail reporting still fire correctly.
 */
export async function runJourney(
  page: Page,
  testInfo: TestInfo,
  definition: JourneyDefinition,
  check: (page: Page) => Promise<void>,
): Promise<void> {
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (request) => {
    networkErrors.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "request failed"}`);
  });
  page.on("response", (response) => {
    const resourceType = response.request().resourceType();
    if (response.status() >= 400 && (resourceType === "fetch" || resourceType === "xhr")) {
      networkErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const start = Date.now();
  const result: JourneyResult = {
    journeyId: definition.id,
    journeyName: definition.name,
    route: definition.route,
    role: definition.role,
    status: "passed",
    durationMs: 0,
    errors: [],
    consoleErrors,
    networkErrors,
  };

  try {
    await page.goto(definition.route);
    await check(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.status = "failed";
    result.errors.push(message);
    result.durationMs = Date.now() - start;
    // The sentence the Synthetic Journeys page prints under the failure — see helpers/recommend.ts.
    result.recommendation = recommendNextStep({
      baseUrl: process.env.SYNTHETIC_BASE_URL,
      consoleErrors,
      message,
      networkErrors,
    });
    await testInfo.attach("journey-result", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    throw error;
  }

  result.durationMs = Date.now() - start;
  await testInfo.attach("journey-result", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
}
