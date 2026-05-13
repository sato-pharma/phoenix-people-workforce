export const STANDARD_FUEL_ALLOWANCE = 500;
export const DEFAULT_EXTRA_COST_OF_LIVING = 1500;
export const SALARY_ALLOWANCE_EFFECTIVE_MONTH = 4;
export const SALARY_ALLOWANCE_EFFECTIVE_YEAR = 2026;

type SalaryAllowanceInput = {
  departmentName?: string | null;
  jobTitle?: string | null;
  lineName?: string | null;
  month?: number | null;
  positionTitle?: string | null;
  teamName?: string | null;
  year?: number | null;
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

function isAllowancePolicyActive(input: SalaryAllowanceInput) {
  if (!input.month || !input.year) return true;
  if (input.year > SALARY_ALLOWANCE_EFFECTIVE_YEAR) return true;
  if (input.year < SALARY_ALLOWANCE_EFFECTIVE_YEAR) return false;
  return input.month >= SALARY_ALLOWANCE_EFFECTIVE_MONTH;
}

export function standardExtraCostOfLiving(input: SalaryAllowanceInput) {
  if (!isAllowancePolicyActive(input)) return 0;

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
    /\bmarketing manager\b/.test(title) ||
    /\bproduct manager\b/.test(title) ||
    /\bgroup product manager\b/.test(title)
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
  const active = isAllowancePolicyActive(input);

  return {
    extraCostOfLiving: active ? standardExtraCostOfLiving(input) : 0,
    fuelAllowance: active ? STANDARD_FUEL_ALLOWANCE : 0,
  };
}
