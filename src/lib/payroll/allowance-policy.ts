export const STANDARD_FUEL_ALLOWANCE = 500;
export const DEFAULT_EXTRA_COST_OF_LIVING = 1500;

type SalaryAllowanceInput = {
  departmentName?: string | null;
  jobTitle?: string | null;
  lineName?: string | null;
  positionTitle?: string | null;
  teamName?: string | null;
};

function normalizeTitle(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleText(input: SalaryAllowanceInput) {
  return normalizeTitle([
    input.jobTitle,
    input.positionTitle,
    input.departmentName,
    input.lineName,
    input.teamName,
  ].filter(Boolean).join(" "));
}

export function standardExtraCostOfLiving(input: SalaryAllowanceInput) {
  const title = titleText(input);
  const compactTitle = title.replace(/\s+/g, "");

  if (
    /\bnsms?\b/.test(title) ||
    /\bnsms?\b/.test(compactTitle) ||
    title.includes("national sales manager")
  ) {
    return 5000;
  }
  if (
    /\bdsms?\b/.test(title) ||
    /\bdsms?\b/.test(compactTitle) ||
    title.includes("district sales manager")
  ) {
    return 3000;
  }
  if (
    title.includes("marketing") ||
    title.includes("product manager") ||
    title.includes("brand manager")
  ) {
    return 3000;
  }
  if (title.includes("training") || title.includes("trainer")) return 3000;
  if (
    /\bmrs?\b/.test(title) ||
    /\bmrs?\b/.test(compactTitle) ||
    title.includes("medical representative") ||
    title.includes("medical rep")
  ) {
    return 2000;
  }

  return DEFAULT_EXTRA_COST_OF_LIVING;
}

export function resolveStandardSalaryAllowances(input: SalaryAllowanceInput) {
  return {
    extraCostOfLiving: standardExtraCostOfLiving(input),
    fuelAllowance: STANDARD_FUEL_ALLOWANCE,
  };
}
