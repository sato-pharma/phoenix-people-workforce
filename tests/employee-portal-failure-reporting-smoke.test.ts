import { strict as assert } from "node:assert";

import { reportEmployeePortalFailure } from "../src/lib/employee-portal/failure-reporting.ts";

export async function runEmployeePortalFailureReportingSmokeTests() {
  const originalSentryDsn = process.env.SENTRY_DSN;
  const originalPortalSentryDsn = process.env.EMPLOYEE_PORTAL_SENTRY_DSN;
  const originalPublicSentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  const originalWebhookUrl = process.env.EMPLOYEE_PORTAL_ERROR_WEBHOOK_URL;

  try {
    process.env.SENTRY_DSN = "";
    process.env.EMPLOYEE_PORTAL_SENTRY_DSN = "";
    process.env.NEXT_PUBLIC_SENTRY_DSN = "";
    delete process.env.EMPLOYEE_PORTAL_ERROR_WEBHOOK_URL;

    const supportReference = await reportEmployeePortalFailure(
      "sentry-unavailable-smoke",
      new Error("simulated portal reporting failure"),
    );

    assert.equal(typeof supportReference, "string");
    assert.match(supportReference, /^ep-sentry-unavailable-smoke-[0-9a-z]+$/);
  } finally {
    if (typeof originalSentryDsn === "undefined") {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalSentryDsn;
    }

    if (typeof originalPortalSentryDsn === "undefined") {
      delete process.env.EMPLOYEE_PORTAL_SENTRY_DSN;
    } else {
      process.env.EMPLOYEE_PORTAL_SENTRY_DSN = originalPortalSentryDsn;
    }

    if (typeof originalPublicSentryDsn === "undefined") {
      delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    } else {
      process.env.NEXT_PUBLIC_SENTRY_DSN = originalPublicSentryDsn;
    }

    if (typeof originalWebhookUrl === "undefined") {
      delete process.env.EMPLOYEE_PORTAL_ERROR_WEBHOOK_URL;
    } else {
      process.env.EMPLOYEE_PORTAL_ERROR_WEBHOOK_URL = originalWebhookUrl;
    }
  }
}
