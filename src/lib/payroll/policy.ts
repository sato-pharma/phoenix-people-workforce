export type PayrollPaymentMode = "one_part" | "two_parts";

export const BASIC_SALARY_RATE = 0.7;

export type PayrollPartsInput = {
  // Use this for employee_compensation.net_salary; that field is the fixed base salary.
  basicSalary?: number | null;
  baseSalary?: number | null;
  deductions?: number | null;
  employmentIncomeTax?: number | null;
  extraCostOfLiving?: number | null;
  fuelAllowance?: number | null;
  grossSalary?: number | null;
  additions?: number | null;
  // Use this for payroll rows where net salary already includes cost of living and fuel.
  netSalary?: number | null;
  paymentMode?: string | null;
  previousExpenses?: number | null;
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

function amount(value: number | null | undefined) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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

  return "one_part";
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
  if (netSalary > 0 || extraCostOfLiving > 0 || fuelAllowance > 0) {
    return money(Math.max(0, netSalary - extraCostOfLiving - fuelAllowance));
  }

  const grossSalary = amount(input.grossSalary);
  if (grossSalary > 0) {
    return money(Math.max(0, grossSalary - amount(input.socialInsurance) - taxAmount(input)));
  }

  return 0;
}

export function calculateBasicSalary(input: PayrollPartsInput) {
  const explicitBasicSalary = amount(input.basicSalary);
  if (explicitBasicSalary > 0) {
    return money(explicitBasicSalary);
  }

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

export function calculatePayrollParts(input: PayrollPartsInput): PayrollParts {
  const paymentMode = normalizePayrollPaymentMode(input.paymentMode);
  const netSalary = calculateNetSalary(input);
  const basicSalary = calculateBasicSalary(input);
  const previousExpenses = amount(input.previousExpenses);
  const additions = amount(input.additions);
  const deductions = amount(input.deductions);
  const variableAdjustments = previousExpenses + additions - deductions;

  if (paymentMode === "two_parts") {
    const firstPart = basicSalary;
    const secondPart = money(netSalary - firstPart + variableAdjustments);

    return {
      basicSalary,
      firstPart,
      paymentMode,
      previousExpenses: money(previousExpenses),
      secondPart: money(secondPart),
      totalPayable: money(firstPart + secondPart),
    };
  }

  const secondPart = money(variableAdjustments);

  return {
    basicSalary,
    firstPart: money(netSalary),
    paymentMode,
    previousExpenses: money(previousExpenses),
    secondPart,
    totalPayable: money(netSalary + secondPart),
  };
}
