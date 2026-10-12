import { isSalesVacancyAreaCode } from "@/lib/workforce-classification";

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export function canonicalSalesLine(value: unknown) {
  return normalize(value)
    .replace(/\bline\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function otherBucketForLine(line: string | null | undefined) {
  const normalizedLine = canonicalSalesLine(line);
  if (normalizedLine === "cns") return "O-3";
  if (normalizedLine.includes("anti") && normalizedLine.includes("infective")) return "O-2";
  if (normalizedLine.includes("pedia")) return "O-1";
  return null;
}

export function isSalesOthersBucket(source: {
  employeeHrId?: string | null;
  employeeLookupKey?: string | null;
  employeeName?: string | null;
  line?: string | null;
}) {
  // A VACANT AREA IS NOT A LINE TOTAL. linkSalesRecordAgainstDirectory recognises a vacancy area
  // code, moves it to the lookup key and deliberately leaves the uploaded display name alone
  // ("display name can stay as uploaded" — tests/sales-linkage.test.ts), so a vacant area whose
  // sheet reads "Others" arrives here still carrying its code. Matching on the display name alone
  // would file that area under the line's aggregate bucket: service.ts drops an Others record from
  // every scoped read, labels it "Unassigned DSM" and excludes it from district attribution — so
  // the territory's sales would vanish from the manager who owns the vacancy.
  if (isSalesVacancyAreaCode(source.employeeHrId) || isSalesVacancyAreaCode(source.employeeLookupKey)) {
    return false;
  }

  const expectedHrId = otherBucketForLine(source.line);
  const hrId = normalize(source.employeeHrId);
  const lookup = normalize(source.employeeLookupKey);
  const name = normalize(source.employeeName);

  return Boolean(
    expectedHrId &&
      (hrId === normalize(expectedHrId) ||
        lookup === "others" ||
        lookup === "other" ||
        name === "others" ||
        name === "other")
  );
}
