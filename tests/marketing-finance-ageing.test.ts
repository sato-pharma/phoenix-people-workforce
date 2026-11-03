import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { marketingRoiPageItems } from "../src/config/system-navigation.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { isForbiddenError } from "../src/lib/auth/server.ts";
import {
  buildFinanceAgeingRows,
  canViewMarketingFinanceAgeing,
  financeAgeingDaysLabel,
  isFinanceAgeingStep,
  MARKETING_FINANCE_AGEING_PATH,
  marketingWaitingBand,
  summarizeFinanceAgeing,
  type FinanceAgeingRequestInput,
  type FinanceAgeingStepInput,
} from "../src/lib/marketing-requests/finance-ageing.ts";
import {
  buildMarketingFinanceAgeingWorkbook,
  marketingFinanceAgeingFilename,
} from "../src/lib/marketing-requests/finance-ageing-export.ts";
import { getMarketingFinanceAgeing } from "../src/lib/marketing-requests/finance-ageing-service.ts";
import {
  classifyMarketingWaitingSla,
  marketingDaysWaiting,
  marketingWaitingSince,
} from "../src/lib/marketing-requests/service.ts";

const NOW = "2026-11-03T10:00:00.000Z";
const clock = { daysWaiting: marketingDaysWaiting, waitingSince: marketingWaitingSince };

const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function step(requestId: string, overrides: Partial<FinanceAgeingStepInput> = {}): FinanceAgeingStepInput {
  return {
    createdAt: daysAgo(90),
    isCc: false,
    openedAt: daysAgo(10),
    requestId,
    status: "current",
    stepCode: "finance_execution",
    updatedAt: daysAgo(1),
    ...overrides,
  };
}

function request(id: string, overrides: Partial<FinanceAgeingRequestInput> = {}): FinanceAgeingRequestInput {
  return {
    customerName: `Customer ${id}`,
    estimatedCost: 1000,
    id,
    lineName: "CNS",
    payDate: "2026-11-15",
    requestCode: `MKT-${id}`,
    requesterName: `Requester ${id}`,
    requestType: "Clinic support",
    status: "pending_approval",
    ...overrides,
  };
}

function build(steps: FinanceAgeingStepInput[], requests: FinanceAgeingRequestInput[]) {
  return buildFinanceAgeingRows({
    clock,
    now: NOW,
    requestsById: new Map(requests.map((row) => [row.id, row])),
    steps,
  });
}

export async function runMarketingFinanceAgeingTests() {
  // ── Who may read it ─────────────────────────────────────────────────────────────────────────────
  for (const role of ["Super Admin", "CEO", "Finance Manager"]) {
    assert.equal(canViewMarketingFinanceAgeing(role), true, `${role} is one of the page's three readers`);
  }
  for (const role of [
    "SFE Manager",
    "Marketing Manager",
    "Product Manager",
    "Group Product Manager",
    "Medical Rep",
    "District Manager",
    "Financial Advisor",
    "Employee",
    null,
    undefined,
    "",
  ]) {
    assert.equal(
      canViewMarketingFinanceAgeing(role),
      false,
      `${String(role)} must not read what Finance has not yet paid`,
    );
  }

  // ── Which rows belong ───────────────────────────────────────────────────────────────────────────
  assert.equal(isFinanceAgeingStep(step("a")), true);
  assert.equal(isFinanceAgeingStep(step("a", { isCc: true })), false, "a CC rung is not waiting on Finance");
  assert.equal(isFinanceAgeingStep(step("a", { status: "pending" })), false, "a rung not yet open is not waiting");
  assert.equal(isFinanceAgeingStep(step("a", { status: "approved" })), false, "an executed rung has stopped waiting");
  assert.equal(
    isFinanceAgeingStep(step("a", { stepCode: "ceo_approval" })),
    false,
    "only Finance Execution belongs: another rung's wait is not Finance's",
  );

  const filtered = build(
    [
      step("live"),
      step("held"),
      step("cancelled"),
      step("missing"),
      step("cc", { isCc: true }),
      step("ceo", { stepCode: "ceo_approval" }),
    ],
    [
      request("live"),
      request("held", { status: "finance_hold" }),
      request("cancelled", { status: "cancelled" }),
      request("cc"),
      request("ceo"),
    ],
  );
  assert.deepEqual(
    filtered.map((row) => row.requestId),
    ["live"],
    "only a current gating Finance Execution rung on a pending_approval request is a row; a hold never appears",
  );
  assert.equal(filtered[0].href, "/marketing-requests/live", "a row opens the Case File through the module's own link");

  // ── The clock: the step_opened event, never updated_at ──────────────────────────────────────────
  const [opened] = build([step("a", { openedAt: daysAgo(10), updatedAt: daysAgo(1) })], [request("a")]);
  assert.equal(opened.daysWaiting, 10, "a maintenance write to updated_at must not reset the wait");
  assert.equal(opened.reachedFinanceAt, daysAgo(10));
  assert.equal(opened.approximate, false, "a recorded opening is an exact clock");

  const [fellBack] = build([step("a", { createdAt: daysAgo(90), openedAt: null, updatedAt: daysAgo(40) })], [request("a")]);
  assert.equal(fellBack.approximate, true, "no step_opened event: the days come from row stamps and are approximate");
  assert.equal(fellBack.daysWaiting, 40, "the fallback is marketingWaitingSince's own order, updated_at before created_at");
  assert.equal(financeAgeingDaysLabel(fellBack), "about 40d");
  assert.equal(financeAgeingDaysLabel(opened), "10d", "an exact clock carries no about");

  const [noClock] = build(
    [step("a", { createdAt: null, openedAt: null, updatedAt: null })],
    [request("a", { estimatedCost: 500 })],
  );
  assert.equal(noClock.approximate, true, "a row with no usable clock keeps its money on the page, marked about");
  assert.equal(noClock.daysWaiting, 0);

  // ── Sort: oldest first, ties on the instant ─────────────────────────────────────────────────────
  const sorted = build(
    [
      step("new", { openedAt: daysAgo(1) }),
      step("old", { openedAt: daysAgo(75) }),
      step("tie-later", { openedAt: daysAgo(8.2) }),
      step("mid", { openedAt: daysAgo(8.5) }),
    ],
    [request("new"), request("old"), request("mid"), request("tie-later")],
  );
  assert.deepEqual(
    sorted.map((row) => row.requestId),
    ["old", "mid", "tie-later", "new"],
    "oldest first; two rows on the same day order by the earlier instant",
  );

  // ── Bands ───────────────────────────────────────────────────────────────────────────────────────
  assert.equal(marketingWaitingBand(0), "on_time");
  assert.equal(marketingWaitingBand(2), "on_time");
  assert.equal(marketingWaitingBand(3), "due_soon", "3 days opens due-soon");
  assert.equal(marketingWaitingBand(6), "due_soon");
  assert.equal(marketingWaitingBand(7), "overdue", "7 days opens overdue");
  assert.equal(marketingWaitingBand(75), "overdue");
  for (const [days, sla] of [[2, null], [3, "due_date_reminder"], [6, "due_date_reminder"], [7, "overdue_reminder"]] as const) {
    assert.equal(
      classifyMarketingWaitingSla({ now: NOW, waitingSince: daysAgo(days) }),
      sla,
      `the daily SLA scan and the page's band must agree at ${days} days: they share one pair of thresholds`,
    );
  }

  // ── Totals ──────────────────────────────────────────────────────────────────────────────────────
  const totals = summarizeFinanceAgeing(
    build(
      [
        step("a", { openedAt: daysAgo(75) }),
        step("b", { openedAt: daysAgo(7) }),
        step("c", { openedAt: daysAgo(6) }),
        step("d", { createdAt: daysAgo(2), openedAt: null, updatedAt: daysAgo(2) }),
      ],
      [
        request("a", { estimatedCost: 100_000 }),
        request("b", { estimatedCost: 30_000 }),
        request("c", { estimatedCost: 6_000 }),
        request("d", { estimatedCost: 450 }),
      ],
    ),
  );
  assert.deepEqual(
    totals,
    { approximateCount: 1, count: 4, oldestDays: 75, overdueCount: 2, totalCost: 136_450 },
    "overdueCount equals the rows painted overdue, so exactly 7 days counts",
  );
  assert.deepEqual(summarizeFinanceAgeing([]), { approximateCount: 0, count: 0, oldestDays: 0, overdueCount: 0, totalCost: 0 });

  // ── The workbook: same rows, Cairo stamp, numeric cost ──────────────────────────────────────────
  const rows = build([step("a", { openedAt: "2026-10-01T22:30:00.000Z" })], [request("a", { estimatedCost: 12_500 })]);
  const workbook = await buildMarketingFinanceAgeingWorkbook({
    generatedAtIso: NOW,
    rows,
    totals: summarizeFinanceAgeing(rows),
  });
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Report Info", "Finance Ageing"]);
  const generated = workbook.getWorksheet("Report Info")?.getRow(3);
  assert.equal(generated?.getCell(1).value, "Generated");
  assert.equal(generated?.getCell(2).value, "03 Nov 2026 · 12:00 Cairo", "the generated time is Cairo local, never UTC");
  const sheet = workbook.getWorksheet("Finance Ageing");
  const cost = sheet?.getColumn("estimatedCost");
  assert.equal(sheet?.getRow(2).getCell(cost?.number ?? 0).value, 12_500, "cost stays numeric so the column sums");
  assert.equal(cost?.numFmt, "#,##0", "money is whole EGP");
  assert.equal(
    sheet?.getRow(2).getCell(sheet.getColumn("reachedFinanceAt").number).value,
    "02 Oct 2026 · 01:30",
    "the moment it reached Finance is Cairo local",
  );
  assert.equal(marketingFinanceAgeingFilename(NOW), "marketing-finance-ageing-2026-11-03.xlsx");

  // ── The wiring a pure test cannot reach ─────────────────────────────────────────────────────────
  const read = (path: string) => readFileSync(path, "utf8");

  const card = marketingRoiPageItems.find((item) => item.href === MARKETING_FINANCE_AGEING_PATH);
  assert.deepEqual(card?.roles, ["Super Admin", "CEO", "Finance Manager"], "the nav shows only to the three readers");

  const adminAccess = read("app/(admin)/admin/marketing-requests/admin-access.ts");
  const wrapper = adminAccess.slice(adminAccess.indexOf("assertMarketingFinanceAgeingAdminPageAccess"));
  assert.match(wrapper, /canViewMarketingFinanceAgeing\(access\.role\)/, "the page gate is the narrow predicate");
  assert.doesNotMatch(wrapper, /canAccessMarketingAdminPage/, "that gate always admits SFE, Marketing, PM and GPM");

  const page = read("app/(admin)/admin/marketing-requests/finance-ageing/page.tsx");
  assert.ok(
    page.indexOf("assertMarketingFinanceAgeingAdminPageAccess()") < page.indexOf("getMarketingFinanceAgeing(access)"),
    "the access check runs before anything is read",
  );

  const exportRoute = read("app/api/marketing-requests/finance-ageing/export/route.ts");
  assert.ok(
    exportRoute.indexOf("canViewMarketingFinanceAgeing(access.role)") > 0 &&
      exportRoute.indexOf("canViewMarketingFinanceAgeing(access.role)") < exportRoute.indexOf("getMarketingFinanceAgeing(access)"),
    "the export refuses before it reads, by the same predicate as the page",
  );
  assert.doesNotMatch(exportRoute, /canAccessMarketingAdminPage|action: "export"/, "no wider door and no export key");
  assert.match(exportRoute, /assertExportRateLimit/);
  assert.match(exportRoute, /DOWNLOAD_NO_STORE_HEADERS/);
  assert.match(exportRoute, /status: 403/);

  await assert.rejects(
    getMarketingFinanceAgeing({ role: "SFE Manager" } as AccessContext),
    (error: unknown) => isForbiddenError(error),
    "the service refuses a role outside the three before it touches the database",
  );

  const desk = read("src/components/marketing-requests/marketing-finance-ageing-desk.tsx");
  assert.match(desk, /hidden md:block/, "desktop table");
  assert.match(desk, /md:hidden/, "mobile cards");
  assert.match(desk, /w-full table-fixed/, "fits the screen");
  assert.match(desk, /<colgroup>/);
  assert.doesNotMatch(desk, /overflow-x-auto|\brounded|\btruncate\b|line-clamp/, "no sideways scroll, round corner or cut text");
  assert.doesNotMatch(desk, /<button|fetch\(|method: "POST"/, "read-only: no execute control on this page");

  assert.match(
    read("src/components/admin/finance-command-center.tsx"),
    /count=\{data\.marketing\.awaitingMyStep\}\s+href="\/admin\/marketing-requests\/finance-ageing"/,
    "the waiting count on the Finance Command Center opens this page",
  );
}
