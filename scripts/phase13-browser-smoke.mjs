import { chromium } from "playwright";

const baseUrl = "http://localhost:3000";

const adminPages = [
  ["/admin", ["Command Center", "Total Structure", "Active Employees"]],
  // Data Health and Monitoring retired into the System Audit on 23 Oct 2026.
  ["/admin/system-audit", ["System Error & Data Integrity Audit"]],
  ["/admin/logs", ["Audit Logs"]],
  ["/employees", ["Employee Master Data", "Add Employee", "Upload"]],
  ["/reports/vacancies", ["Vacancies"]],
  ["/offers", ["Offer"]],
  ["/hiring-documents", ["Hiring Documents"]],
  ["/resignations", ["Resignations"]],
  ["/probation", ["Probation"]],
  ["/sales", ["Sales"]],
  ["/sales/import", ["Sales"]],
  ["/payroll", ["Payroll"]],
  ["/admin/outstation/expenses", ["Expenses"]],
  ["/admin/outstation/expenses/dashboard", ["Expenses"]],
  ["/leave-management/vacation-request", ["Vacation"]],
  ["/leave-management/vacation-report", ["Vacation"]],
  ["/admin/outstation/requests", ["Outstation"]],
];

const employeePages = [
  ["/employee-portals", ["Overview"]],
  ["/employee-portals/sales", ["Sales"]],
  ["/employee-portals/payroll", ["Payroll"]],
  ["/employee-portals/expenses", ["Expenses"]],
];

async function waitForSettledBody(page) {
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

async function smokePage(page, path, expected) {
  let text = "";
  try {
    await page.goto(`${baseUrl}${path}`, { timeout: 45000, waitUntil: "domcontentloaded" });
    text = await waitForSettledBody(page);
  } catch (error) {
    text = `GOTO_ERROR: ${error.message}`;
  }

  const lowerText = text.toLowerCase();
  const missing = expected.filter((value) => !lowerText.includes(value.toLowerCase()));
  const hardError = /application error|internal server error|runtime error|body_error|goto_error|typeerror|referenceerror|failed to compile/i.test(text);

  return {
    missing,
    ok: !hardError && missing.length === 0,
    path,
    snippet: text.slice(0, 420).replace(/\s+/g, " "),
  };
}

async function runContext(browser, authUrl, pages) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(authUrl, { timeout: 45000, waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForTimeout(1500);

  const results = [];
  for (const [path, expected] of pages) {
    results.push(await smokePage(page, path, expected));
  }

  await context.close();
  return results;
}

const browser = await chromium.launch({ headless: true });
try {
  const adminResults = await runContext(
    browser,
    `${baseUrl}/api/dev-auth?role=Super%20Admin&loginId=phase13.smoke&next=/admin`,
    adminPages,
  );
  const employeeResults = await runContext(
    browser,
    `${baseUrl}/api/dev-auth?role=Regional%20Manager&loginId=PD-0001&hrId=PD-0001&next=/employee-portals`,
    employeePages,
  );

  const results = [...adminResults, ...employeeResults];
  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ failed, passed: results.length - failed.length, results }, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
