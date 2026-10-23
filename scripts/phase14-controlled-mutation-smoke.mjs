import { chromium } from "playwright";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "phase14-controlled-mutation-smoke",
  usage: `phase14-controlled-mutation-smoke: drive the mutation paths against a LOCAL dev server
with a fixture id that matches nothing, and write its report to the temp directory.

  node scripts/phase14-controlled-mutation-smoke.mjs      run it against http://localhost:3000
  node scripts/phase14-controlled-mutation-smoke.mjs -h   this text

It takes no arguments: the base URL and the fixture id are constants at the top of the file.`,
  hints: [
    "the base URL and the fixture id are constants in this file — edit them, do not pass them",
  ],
});

const baseUrl = "http://localhost:3000";
const fakeId = "PHASE14_NONEXISTENT_SAFE_FIXTURE";
const fakeUuid = "00000000-0000-0000-0000-000000000000";
const today = "2026-05-18";

function expectStatus(actual, expected) {
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

async function settledBodyText(page) {
  let text = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(1500);
    text = await page.locator("body").innerText({ timeout: 10000 }).catch((error) => `BODY_ERROR: ${error.message}`);
    if (text && !/^Loading Phoenix Workforce/.test(text) && !/^Loading /.test(text)) {
      return text;
    }
  }
  return text;
}

async function apiJson(page, label, path, init, expectedStatus) {
  const result = await page.evaluate(
    async ({ init, path }) => {
      const response = await fetch(path, init);
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text.slice(0, 300);
      }
      return { body, ok: response.ok, status: response.status };
    },
    { init, path },
  );

  return {
    body: result.body,
    expectedStatus,
    label,
    ok: expectStatus(result.status, expectedStatus),
    status: result.status,
  };
}

async function apiMultipartMissingFile(page, label, path, fields, expectedStatus = 400) {
  const result = await page.evaluate(
    async ({ fields, path }) => {
      const formData = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        formData.append(key, String(value));
      }
      const response = await fetch(path, { body: formData, method: "POST" });
      const body = await response.json().catch(() => null);
      return { body, status: response.status };
    },
    { fields, path },
  );

  return {
    body: result.body,
    expectedStatus,
    label,
    ok: expectStatus(result.status, expectedStatus),
    status: result.status,
  };
}

async function smokeEmployeeAddDrawer(page) {
  await page.goto(`${baseUrl}/employees`, { timeout: 45000, waitUntil: "domcontentloaded" });
  await settledBodyText(page);
  await page.getByRole("button", { name: /add employee/i }).click({ timeout: 30000 });
  await page.getByRole("button", { name: /create master record/i }).click({ timeout: 30000 });
  const body = await settledBodyText(page);

  return {
    label: "manual employee add drawer validation",
    ok: body.includes("New Employee Onboarding") && body.includes("Employee ID is required."),
    status: 200,
  };
}

async function smokeEmployeeUploadControl(page, invalidFilePath) {
  await page.goto(`${baseUrl}/employees`, { timeout: 45000, waitUntil: "domcontentloaded" });
  await settledBodyText(page);
  await page.locator('input[type="file"]').first().setInputFiles(invalidFilePath);
  await page.waitForTimeout(3000);
  const body = await settledBodyText(page);

  return {
    label: "employee bulk upload invalid file interaction",
    ok: body.toLowerCase().includes("upload an employee import excel file") || body.toLowerCase().includes("unsupported"),
    snippet: body.slice(0, 420).replace(/\s+/g, " "),
    status: 400,
  };
}

async function run() {
  const invalidFilePath = join(tmpdir(), `phase14-invalid-${Date.now()}.txt`);
  await writeFile(invalidFilePath, "phase14 invalid workbook fixture", "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/api/dev-auth?role=Super%20Admin&loginId=phase14.smoke&next=/admin`, {
      timeout: 45000,
      waitUntil: "domcontentloaded",
    }).catch(() => undefined);
    await page.waitForTimeout(1000);

    const baseline = {
      commandCenter: await apiJson(page, "Command Center baseline", "/admin", { method: "GET" }, [200, 405]),
      // Data Health and Monitoring retired into the System Audit on 23 Oct 2026.
      systemAudit: await apiJson(page, "System Audit baseline", "/admin/system-audit", { method: "GET" }, [200, 405]),
      auditLogs: await apiJson(page, "Audit Logs API baseline", "/api/admin/logs?pageSize=1", { method: "GET" }, 200),
    };

    const checks = [
      await smokeEmployeeAddDrawer(page),
      await smokeEmployeeUploadControl(page, invalidFilePath),
      await apiJson(page, "manual employee add validation", "/api/employees", {
        body: JSON.stringify({ employee: { hrId: "PHASE14_BAD" } }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 400),
      await apiMultipartMissingFile(page, "bulk employee dry-run missing file", "/api/imports/employees/dry-run", {}),
      await apiMultipartMissingFile(page, "bulk employee confirm missing file", "/api/imports/employees/confirm", {}),
      await apiJson(page, "accepted offer approval nonexistent fixture", `/api/offers/${fakeUuid}/approve`, {
        body: JSON.stringify({ hrId: "PHASE14-999" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 404),
      await apiJson(page, "resignation vacancy opening nonexistent fixture", `/api/employees/${fakeId}/resign`, {
        body: JSON.stringify({
          resignation: {
            effectiveDate: today,
            employeeStatus: "resigned",
            reason: "Phase 14 safe nonexistent fixture",
            submittedDate: today,
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 404),
      await apiJson(page, "probation invalid action guard", `/api/probation/${fakeId}/workflow`, {
        body: JSON.stringify({ action: "invalid" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 400),
      await apiJson(page, "probation termination nonexistent fixture", `/api/probation/${fakeId}/workflow`, {
        body: JSON.stringify({ action: "terminate", decisionReason: "Phase 14 safe nonexistent fixture" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, [404, 409]),
      await apiMultipartMissingFile(page, "sales import upload missing file", "/api/sales/imports/upload", { line: "Pedia" }),
      await apiJson(page, "sales import invalid action guard", `/api/sales/imports/${fakeId}/invalid`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 400),
      await apiJson(page, "sales import approve nonexistent fixture", `/api/sales/imports/${fakeUuid}/approve`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 404),
      await apiMultipartMissingFile(page, "payroll upload missing file", "/api/payroll/upload", { month: 4, year: 2026 }),
      await apiJson(page, "payroll workflow invalid action guard", `/api/payroll/${fakeId}/workflow`, {
        body: JSON.stringify({ action: "invalid" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 400),
      await apiJson(page, "payroll workflow approval nonexistent fixture", `/api/payroll/${fakeUuid}/workflow`, {
        body: JSON.stringify({ action: "approve" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 404),
      await apiMultipartMissingFile(page, "payroll replace missing file", `/api/payroll/${fakeUuid}/replace`, {}),
      await apiJson(page, "approved expenses import missing period", "/api/admin/outstation/expenses/import", {
        body: JSON.stringify({ fileName: "phase14-expenses.xls", records: [] }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 400),
      await apiJson(page, "vacation request validation guard", "/api/vacations/requests", {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 400),
      await apiJson(page, "vacation approval invalid decision guard", `/api/vacations/requests/${fakeId}/decision`, {
        body: JSON.stringify({ decision: "invalid" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 400),
      await apiJson(page, "outstation request validation guard", "/api/outstation/submit", {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, 400),
      await apiJson(page, "outstation admin invalid id guard", "/api/admin/outstation/not-a-number", {
        method: "GET",
      }, 400),
    ];

    const postChecks = [
      await apiJson(page, "Command Center post-smoke reachable", "/admin", { method: "GET" }, [200, 405]),
      await apiJson(page, "System Audit post-smoke reachable", "/admin/system-audit", { method: "GET" }, [200, 405]),
      await apiJson(page, "Audit Logs post-smoke reachable", "/api/admin/logs?pageSize=1", { method: "GET" }, 200),
    ];

    const results = [...Object.values(baseline), ...checks, ...postChecks];
    const failed = results.filter((result) => !result.ok);
    console.log(JSON.stringify({ failed, passed: results.length - failed.length, results }, null, 2));
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    await rm(invalidFilePath, { force: true });
  }
}

await run();
