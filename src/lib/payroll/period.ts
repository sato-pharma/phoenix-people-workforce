export type PayrollPeriod = {
  month: number;
  year: number;
};

export function assertValidPayrollPeriod(month: number, year: number): PayrollPeriod {
  if (!Number.isInteger(month) || !Number.isInteger(year)) {
    throw new Error("Payroll month and year must be whole numbers.");
  }

  if (month < 1 || month > 12) {
    throw new Error("Payroll month must be between 1 and 12.");
  }

  if (year < 2000 || year > 2100) {
    throw new Error("Payroll year must be between 2000 and 2100.");
  }

  return { month, year };
}
