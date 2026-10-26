import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { isRestrictedProductCode } from "@/lib/sales/access-scope";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import { SALES_LINES, lineName, loadProductNameMap } from "@/lib/sales/monthly-targets";
import { rankingHrKey } from "@/lib/sales/rankings";
import {
  isSemesterKey,
  semesterColumns,
  semesterMonths,
  semesterOf,
  semesterOptions,
  type RepAchievementData,
  type SemesterKey,
} from "@/lib/sales/rep-product-achievement";
import { buildRepAchievementRecords, type RepAchievementPerson } from "@/lib/sales/rep-product-achievement-build";
import { creditRepRowsByTenure, loadSeatTenure, type SeatTenure } from "@/lib/sales/seat-tenure-credit";
import {
  SALES_VS_TARGET_FLOOR,
  isRowPublished,
  loadAchievementRange,
  loadPublishedPeriodKeys,
  salesVsTargetPeriods,
} from "@/lib/sales/vs-target";

// ─────────────────────────────────────────────────────────────────────────────
// THE READS behind Rep Achievement by Product — the same loaders the Rankings board and the Top
// Achievers read (vs-target.ts), so a rep's percentage here is the one the published closing holds.
//
// The Training Manager holds no sales seat and no line: she reads the WHOLE field, every line, and
// filters it herself. Head Office is never a line here (rows with no sales line are dropped) and the
// restricted products never reach her.
// ─────────────────────────────────────────────────────────────────────────────

const SALES_LINE_CODES = new Set(SALES_LINES.map((line) => line.code));

/** A failed tenure read credits today's seat holders, the leaderboards' own fallback. */
async function seatTenureOrNull(): Promise<SeatTenure | null> {
  try {
    return await loadSeatTenure();
  } catch (error) {
    logError("Rep achievement seat-tenure read failed; crediting today's seat holders", {
      error,
      labels: { event: "rep_product_achievement_seat_tenure_failed" },
    });
    return null;
  }
}

export async function loadRepProductAchievement(requested?: string | null): Promise<RepAchievementData> {
  const { current } = salesVsTargetPeriods();
  const semesters = semesterOptions(SALES_VS_TARGET_FLOOR, current);
  const fallback = semesters[0]?.value ?? semesterOf(current);
  const semester: SemesterKey =
    isSemesterKey(requested) && semesters.some((option) => option.value === requested) ? requested : fallback;
  const columns = semesterColumns(semester);
  const months = semesterMonths(semester);
  const from = months[0] < SALES_VS_TARGET_FLOOR ? SALES_VS_TARGET_FLOOR : months[0];
  const to = months[months.length - 1] > current ? current : months[months.length - 1];
  const lines = SALES_LINES.map((line) => ({ label: lineName(line.code) || line.label, value: line.code }));
  const generatedAt = new Date().toISOString();

  if (!from || !to || to < from) {
    return { columns, currentPeriod: current, generatedAt, lines, publishedMonths: {}, records: [], semester, semesters };
  }

  const [rangeRows, publishedKeys, directory, productNames, tenure] = await Promise.all([
    loadAchievementRange(from, to),
    loadPublishedPeriodKeys(from, to),
    getEmployeeDirectoryRows({ includeInactive: true }),
    loadProductNameMap(),
    seatTenureOrNull(),
  ]);

  const rows = applyAchievementAreaMerges(rangeRows).filter(
    (row) => row.lineCode != null && SALES_LINE_CODES.has(row.lineCode) && !isRestrictedProductCode(row.productCode),
  );
  const credited = tenure ? creditRepRowsByTenure(rows, tenure) : rows;

  const people = new Map<string, RepAchievementPerson>();
  for (const employee of directory) {
    const key = rankingHrKey(employee.hrId);
    if (!key) continue;
    people.set(key, {
      areaName: employee.areaName ?? "",
      jobTitle: employee.positionTitle || employee.jobTitle || "",
      left: !isActiveLifecycleStatus(employee.employmentStatus),
      managerName: employee.managerName ?? "",
      name: employee.displayName || employee.fullName,
      regionName: employee.regionName ?? "",
    });
  }

  const publishedMonths: Record<string, string[]> = {};
  for (const line of lines) {
    publishedMonths[line.value] = months.filter(
      (month) => month <= current && isRowPublished({ lineCode: line.value, period: month }, publishedKeys),
    );
  }

  const records = buildRepAchievementRecords({
    columns,
    currentPeriod: current,
    lineNames: new Map(lines.map((line) => [line.value, line.label])),
    people,
    productNames,
    publishedKeys,
    rows: credited,
  });

  return { columns, currentPeriod: current, generatedAt, lines, publishedMonths, records, semester, semesters };
}
