import { canonicalSalesLine } from "../sales/others.ts";

type LineScopedEntity = {
  line?: string | null;
  lineId?: number | null;
  lineName?: string | null;
};

export type PortalSalesLineScope = {
  lineCandidates: string[];
  lineId: number | null;
  lineName: string | null;
};

function normalizeLineName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function canonicalPortalSalesLine(value: string) {
  const line = canonicalSalesLine(value);
  if (line.includes("anti") && (line.includes("inf") || line.includes("infect"))) {
    return "anti infective";
  }
  return line;
}

function uniqueLines(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalized = String(value ?? "").trim();
    const key = normalizeLineName(normalized);
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  });

  return result;
}

export function portalSalesLinesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  if (!leftText || !rightText) return false;

  return (
    normalizeLineName(leftText) === normalizeLineName(rightText) ||
    canonicalPortalSalesLine(leftText) === canonicalPortalSalesLine(rightText)
  );
}

export function createPortalSalesLineScope({
  fallbackLine,
  lineId,
  lineName,
}: {
  fallbackLine?: string | null;
  lineId?: number | null;
  lineName?: string | null;
}): PortalSalesLineScope {
  const lineCandidates = uniqueLines([lineName, fallbackLine]);

  return {
    lineCandidates,
    lineId: typeof lineId === "number" ? lineId : null,
    lineName: lineCandidates[0] ?? null,
  };
}

export function lineMatchesPortalSalesScope(
  line: string | null | undefined,
  scope: Pick<PortalSalesLineScope, "lineCandidates">,
) {
  return scope.lineCandidates.some((candidate) =>
    portalSalesLinesMatch(line, candidate),
  );
}

export function employeeMatchesPortalSalesScope(
  employee: LineScopedEntity,
  scope: PortalSalesLineScope,
) {
  if (
    scope.lineId !== null &&
    typeof employee.lineId === "number" &&
    employee.lineId === scope.lineId
  ) {
    return true;
  }

  const employeeLine = employee.lineName ?? employee.line ?? null;
  return lineMatchesPortalSalesScope(employeeLine, scope);
}

export function salesRecordMatchesPortalSalesScope(
  record: Pick<LineScopedEntity, "line">,
  scope: PortalSalesLineScope,
) {
  if (!record.line || scope.lineCandidates.length === 0) return true;
  return lineMatchesPortalSalesScope(record.line, scope);
}
