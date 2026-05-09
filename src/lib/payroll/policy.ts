export type PayrollPaymentMode = "one_part" | "two_parts";

export type PayrollPartsInput = {
  deductions?: number | null;
  extraCostOfLiving?: number | null;
  fuelAllowance?: number | null;
  additions?: number | null;
  netSalary?: number | null;
  paymentMode?: string | null;
  previousExpenses?: number | null;
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

export function calculatePayrollParts(input: PayrollPartsInput): PayrollParts {
  const paymentMode = normalizePayrollPaymentMode(input.paymentMode);
  const netSalary = amount(input.netSalary);
  const extraCostOfLiving = amount(input.extraCostOfLiving);
  const fuelAllowance = amount(input.fuelAllowance);
  const previousExpenses = amount(input.previousExpenses);
  const additions = amount(input.additions);
  const deductions = amount(input.deductions);

  if (paymentMode === "two_parts") {
    const adjustedNet = netSalary - extraCostOfLiving - fuelAllowance;
    const basicSalary = money(adjustedNet * 0.7);
    const firstPart = basicSalary;
    const secondPart =
      money(adjustedNet * 0.3) +
      extraCostOfLiving +
      fuelAllowance +
      previousExpenses +
      additions -
      deductions;

    return {
      basicSalary,
      firstPart,
      paymentMode,
      previousExpenses: money(previousExpenses),
      secondPart: money(secondPart),
      totalPayable: money(firstPart + secondPart),
    };
  }

  const secondPart = money(previousExpenses + additions - deductions);

  return {
    basicSalary: money(netSalary),
    firstPart: money(netSalary),
    paymentMode,
    previousExpenses: money(previousExpenses),
    secondPart,
    totalPayable: money(netSalary + secondPart),
  };
}
