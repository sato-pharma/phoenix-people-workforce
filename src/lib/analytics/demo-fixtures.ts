// In-memory demo fixtures for analytics dashboards — obviously-fake rows used
// only when isAnalyticsDemoMode() is true (see demo-mode.ts). Shapes match
// service.ts's real loader return types exactly so pages can branch on demo
// mode without any other code change. No database access anywhere in this file.

import type {
  AnalyticsDimensions,
  ClosingByEmployeeRow,
  CrossSourceRow,
  SosByAreaRow,
  SosByCustomerRow,
  SosByLineRow,
  SosByProductRow,
  SosKpiRow,
  WeeklyFactRow,
} from "./service";
import { safeDividePct } from "./validation";

const DEMO_PERIODS = ["2026-04", "2026-05", "2026-06"];

export function demoSosByPeriod(): SosKpiRow[] {
  return DEMO_PERIODS.map((period, i) => ({
    period,
    year: 2026,
    month: 4 + i,
    channel: "Distributor",
    units: 12000 + i * 800,
    bonusUnits: 400 + i * 20,
    value: 1_800_000 + i * 120_000,
  }));
}

export function demoSosByArea(): SosByAreaRow[] {
  // `operationalRegion*` is the district the ORGANOGRAM gives the area; `region*` is where it sits
  // geographically. Gamma deliberately differs between the two, because that is the real shape this
  // page exists to show — on production 15 of 48 areas are owned by a district other than their
  // geographic region on at least one line. A demo where the two always agree would hide it.
  const areas = [
    { regionCode: "DEMO-R1", regionName: "Demo Region North", operationalRegionCode: "DEMO-R1", operationalRegionName: "Demo Region North", areaCode: "DEMO-A1", areaName: "Demo Area Alpha" },
    { regionCode: "DEMO-R1", regionName: "Demo Region North", operationalRegionCode: "DEMO-R1", operationalRegionName: "Demo Region North", areaCode: "DEMO-A2", areaName: "Demo Area Beta" },
    { regionCode: "DEMO-R2", regionName: "Demo Region South", operationalRegionCode: "DEMO-R2-1", operationalRegionName: "Demo Region South 1", areaCode: "DEMO-A3", areaName: "Demo Area Gamma" },
  ];
  return DEMO_PERIODS.flatMap((period, i) =>
    areas.map((area, j) => ({
      period,
      ...area,
      channel: "Distributor",
      units: 3000 + i * 200 + j * 150,
      value: 450_000 + i * 30_000 + j * 20_000,
    })),
  );
}

export function demoSosByProduct(): SosByProductRow[] {
  const products = [
    { productCode: "DEMO-P1", productName: "Demo Product Alpha", family: "Demo Family A", familyCode: "DFA", line: "Demo Line 1" },
    { productCode: "DEMO-P2", productName: "Demo Product Beta", family: "Demo Family A", familyCode: "DFA", line: "Demo Line 1" },
    { productCode: "DEMO-P3", productName: "Demo Product Gamma", family: "Demo Family B", familyCode: "DFB", line: "Demo Line 2" },
  ];
  return DEMO_PERIODS.flatMap((period, i) =>
    products.map((product, j) => ({
      period,
      ...product,
      channel: "Distributor",
      units: 2000 + i * 150 + j * 100,
      value: 300_000 + i * 25_000 + j * 15_000,
    })),
  );
}

export function demoSosByLine(): SosByLineRow[] {
  const lines = ["Demo Line 1", "Demo Line 2"];
  return DEMO_PERIODS.flatMap((period, i) =>
    lines.map((line, j) => ({
      period,
      year: 2026,
      month: 4 + i,
      line,
      channel: "Distributor",
      units: 6000 + i * 300 + j * 500,
      value: 900_000 + i * 60_000 + j * 80_000,
    })),
  );
}

export function demoSosByCustomer(): SosByCustomerRow[] {
  const customers = [
    { clientCode: "DEMO-C001", customerName: "Demo Pharmacy Alpha", line: "Demo Line 1", regionCode: "DEMO-R1", regionName: "Demo Region North" },
    { clientCode: "DEMO-C002", customerName: "Demo Pharmacy Beta", line: "Demo Line 2", regionCode: "DEMO-R2", regionName: "Demo Region South" },
  ];
  return DEMO_PERIODS.flatMap((period, i) =>
    customers.map((customer) => ({
      period,
      year: 2026,
      month: 4 + i,
      ...customer,
      activeBatches: 1 + (i % 2),
    })),
  );
}

export function demoClosingByEmployee(): ClosingByEmployeeRow[] {
  const employees = [
    { employeeHrId: "DEMO-001", employeeName: "Demo Rep One", managerHrId: "DEMO-MGR-1", managerName: "Demo Manager One", territory: "Demo Territory A", line: "Demo Line 1" },
    { employeeHrId: "DEMO-002", employeeName: "Demo Rep Two", managerHrId: "DEMO-MGR-1", managerName: "Demo Manager One", territory: "Demo Territory B", line: "Demo Line 1" },
    { employeeHrId: "DEMO-003", employeeName: "Demo Rep Three", managerHrId: "DEMO-MGR-2", managerName: "Demo Manager Two", territory: "Demo Territory C", line: "Demo Line 2" },
  ];
  return DEMO_PERIODS.flatMap((period) =>
    employees.map((emp, j) => {
      const salesValue = 80_000 + j * 10_000;
      const targetValue = 100_000;
      return {
        period,
        ...emp,
        salesValue,
        targetValue,
        salesUnits: 500 + j * 50,
        targetUnits: 600,
        achievementPct: safeDividePct(salesValue, targetValue),
      };
    }),
  );
}

export function demoWeeklyFact(): WeeklyFactRow[] {
  const weeks = [
    { weekStart: "2026-06-01", weekLabel: "Wk 23 2026" },
    { weekStart: "2026-06-08", weekLabel: "Wk 24 2026" },
    { weekStart: "2026-06-15", weekLabel: "Wk 25 2026" },
  ];
  return weeks.flatMap((week, i) => [
    {
      ...week,
      period: "2026-06",
      distributorCode: "DEMO-D1",
      distributorName: "Demo Distributor A",
      regionCode: "DEMO-R1",
      regionName: "Demo Region North",
      productCode: "DEMO-P1",
      productName: "Demo Product Alpha",
      line: "Demo Line 1",
      family: "Demo Family A",
      salesQty: 800 + i * 40,
      salesValue: 120_000 + i * 6_000,
      stockQty: 2000 - i * 50,
    },
  ]);
}

export function demoCrossSource(): CrossSourceRow[] {
  const lines = ["Demo Line 1", "Demo Line 2"];
  return DEMO_PERIODS.flatMap((period, i) =>
    lines.map((line, j) => {
      const sosValue = 900_000 + i * 60_000 + j * 80_000;
      const closingValue = sosValue * 0.92;
      const targetValue = sosValue * 0.95;
      return {
        period,
        line,
        sosValue,
        sosUnits: 6000 + i * 300 + j * 500,
        closingValue,
        closingUnits: 5500 + i * 280,
        targetValue,
        weeklyValue: sosValue * 0.3,
        weeklyUnits: 1800 + i * 90,
        closingAchievementPct: safeDividePct(closingValue, targetValue),
      };
    }),
  );
}

export function demoAnalyticsDimensions(): AnalyticsDimensions {
  return {
    periods: DEMO_PERIODS.map((period, i) => ({
      period,
      year: 2026,
      month: 4 + i,
      periodLabel: period,
    })),
    weeks: [
      { weekStart: "2026-06-01", year: 2026, month: 6, isoWeek: 23, weekLabel: "Wk 23 2026" },
      { weekStart: "2026-06-08", year: 2026, month: 6, isoWeek: 24, weekLabel: "Wk 24 2026" },
      { weekStart: "2026-06-15", year: 2026, month: 6, isoWeek: 25, weekLabel: "Wk 25 2026" },
    ],
    distributors: [
      { code: "DEMO-D1", name: "Demo Distributor A" },
      { code: "DEMO-D2", name: "Demo Distributor B" },
    ],
    lines: ["Demo Line 1", "Demo Line 2"],
    families: ["Demo Family A", "Demo Family B"],
    regions: [
      { code: "DEMO-R1", name: "Demo Region North" },
      { code: "DEMO-R2", name: "Demo Region South" },
    ],
    areas: [
      { areaCode: "DEMO-A1", areaName: "Demo Area Alpha", regionCode: "DEMO-R1", regionName: "Demo Region North" },
      { areaCode: "DEMO-A2", areaName: "Demo Area Beta", regionCode: "DEMO-R1", regionName: "Demo Region North" },
      { areaCode: "DEMO-A3", areaName: "Demo Area Gamma", regionCode: "DEMO-R2", regionName: "Demo Region South" },
    ],
    products: [
      { code: "DEMO-P1", name: "Demo Product Alpha", line: "Demo Line 1", family: "Demo Family A" },
      { code: "DEMO-P2", name: "Demo Product Beta", line: "Demo Line 1", family: "Demo Family A" },
      { code: "DEMO-P3", name: "Demo Product Gamma", line: "Demo Line 2", family: "Demo Family B" },
    ],
  };
}
