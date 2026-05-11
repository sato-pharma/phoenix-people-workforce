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
