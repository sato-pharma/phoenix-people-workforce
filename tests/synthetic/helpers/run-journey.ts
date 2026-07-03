import type { Page, TestInfo } from "@playwright/test";

import type { JourneyDefinition, JourneyResult } from "./types";

function recommend(message: string, consoleErrors: string[], networkErrors: string[]): string {
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("net::err")) {
    return "The page did not respond in time. Check that SYNTHETIC_BASE_URL is reachable and the target server is running.";
  }
  if (networkErrors.some((e) => / 401 | 403 /.test(e))) {
    return "A request was rejected as unauthorized/forbidden. Check SYNTHETIC_ADMIN_HR_ID/SYNTHETIC_ADMIN_PASSWORD and that the account has Super Admin access.";
  }
  if (networkErrors.some((e) => / 404 /.test(e))) {
    return "A request returned 404. The route or an API it depends on may have moved or been removed.";
  }
  if (networkErrors.length > 0) {
    return "One or more API calls failed. Review the network errors listed for this journey and the server logs.";
  }
  if (consoleErrors.length > 0) {
    return "The page logged a JavaScript error to the console. Inspect the console errors listed for this journey.";
  }
  return "Review the error message and the failure screenshot above.";
}

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
    result.recommendation = recommend(message, consoleErrors, networkErrors);
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
