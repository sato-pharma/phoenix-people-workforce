export type PayrollPaymentMode = "one_part" | "two_parts";

export const BASIC_SALARY_RATE = 0.7;

export type PayrollPartsInput = {
  // Fixed basic salary used as-is for incentive calculations.
  basicSalary?: number | null;
  // Base salary excludes fuel/cost of living and monthly payroll variables.
  baseSalary?: number | null;
  deductions?: number | null;
  employmentIncomeTax?: number | null;
  extraCostOfLiving?: number | null;
  fuelAllowance?: number | null;
  grossSalary?: number | null;
  additions?: number | null;
  // Net Salary is fixed salary + cost of living + fuel, before monthly variables.
  netSalary?: number | null;
  paymentMode?: string | null;
  previousExpenses?: number | null;
  secondPartAdditions?: number | null;
  socialInsurance?: number | null;
  taxes?: number | null;
};

export type PayrollParts = {
  basicSalary: number;
  firstPart: number;
  paymentMode: PayrollPaymentMode;
  previousExpenses: number;
  secondPart: number;
  totalPayable: number;
};

export type FixedSalaryAmounts = {
  baseSalary: number;
  basicSalary: number;
  grossSalary: number;
  netSalary: number;
};

function amount(value: number | null | undefined) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function nonNegativeMoney(value: number) {
  return money(Math.max(0, value));
}

function taxAmount(input: PayrollPartsInput) {
  return amount(input.employmentIncomeTax ?? input.taxes);
}

export function normalizePayrollPaymentMode(
  value: string | null | undefined,
): PayrollPaymentMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (
    normalized === "two_parts" ||
    normalized === "two_part" ||
    normalized === "split" ||
    normalized === "split_salary" ||
    normalized === "2" ||
    normalized === "2_parts"
  ) {
    return "two_parts";
  }

  if (
    normalized === "one_part" ||
    normalized === "one_parts" ||
    normalized === "single" ||
    normalized === "single_salary" ||
    normalized === "1" ||
    normalized === "1_part"
  ) {
    return "one_part";
  }

  return "two_parts";
}

export function payrollPaymentModeLabel(mode: PayrollPaymentMode) {
  return mode === "two_parts" ? "Two Parts" : "One Part";
}

export function calculateBaseSalary(input: PayrollPartsInput) {
  const explicitBaseSalary = amount(input.baseSalary);
  if (explicitBaseSalary > 0) {
    return money(explicitBaseSalary);
  }

  const explicitBasicSalary = amount(input.basicSalary);
  if (explicitBasicSalary > 0) {
    return money(explicitBasicSalary / BASIC_SALARY_RATE);
  }

  const netSalary = amount(input.netSalary);
  const extraCostOfLiving = amount(input.extraCostOfLiving);
  const fuelAllowance = amount(input.fuelAllowance);
  if (netSalary > 0) {
    return money(Math.max(0, netSalary - extraCostOfLiving - fuelAllowance));
  }

  const grossSalary = amount(input.grossSalary);
  if (grossSalary > 0) {
    return money(Math.max(0, grossSalary - amount(input.socialInsurance) - taxAmount(input)));
  }

  return 0;
}

export function calculateBasicSalary(input: PayrollPartsInput) {
  return money(calculateBaseSalary(input) * BASIC_SALARY_RATE);
}

export function calculateGrossSalary(input: PayrollPartsInput) {
  return money(calculateBaseSalary(input) + amount(input.socialInsurance) + taxAmount(input));
}

export function calculateNetSalary(input: PayrollPartsInput) {
  return money(
    calculateBaseSalary(input) +
      amount(input.extraCostOfLiving) +
      amount(input.fuelAllowance),
  );
}

export function resolveFixedSalaryAmounts(input: PayrollPartsInput): FixedSalaryAmounts {
  const baseSalary = calculateBaseSalary(input);

  return {
    baseSalary,
    basicSalary: calculateBasicSalary({ ...input, baseSalary }),
    grossSalary: calculateGrossSalary({ ...input, baseSalary }),
    netSalary: calculateNetSalary({ ...input, baseSalary }),
  };
}

export function calculatePayrollParts(input: PayrollPartsInput): PayrollParts {
  const paymentMode = normalizePayrollPaymentMode(input.paymentMode);
  const fixedSalary = resolveFixedSalaryAmounts(input);
  const netSalary = fixedSalary.netSalary;
  const basicSalary = fixedSalary.basicSalary;
  const previousExpenses = amount(input.previousExpenses);
  const additions = amount(input.additions);
  const deductions = amount(input.deductions);
  const variableAdjustments = previousExpenses + additions - deductions;
  const totalPayable = nonNegativeMoney(netSalary + variableAdjustments);
  const forcedSecondPart = nonNegativeMoney(
    Math.min(
      totalPayable,
      amount(input.secondPartAdditions ?? (paymentMode === "one_part" ? variableAdjustments : 0)),
    ),
  );

  if (paymentMode === "two_parts") {
    const firstPart = money(Math.min(basicSalary, totalPayable - forcedSecondPart));
    const secondPart = nonNegativeMoney(totalPayable - firstPart);

    return {
      basicSalary,
      firstPart,
      paymentMode,
      previousExpenses: money(previousExpenses),
      secondPart,
      totalPayable,
    };
  }

  const secondPart = forcedSecondPart;
  const firstPart = nonNegativeMoney(totalPayable - secondPart);

  return {
    basicSalary,
    firstPart,
    paymentMode,
    previousExpenses: money(previousExpenses),
    secondPart,
    totalPayable,
  };
}
