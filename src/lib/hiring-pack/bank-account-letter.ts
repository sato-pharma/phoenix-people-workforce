// The bank account-opening letter — "فتح حسابات بنكية" — that HR sends First Abu Dhabi Bank Misr
// to open a current account for each new employee. Pure and client-safe: the screen and the Word
// builder (`bank-account-letter-docx.ts`) both read the rows from here, so what the table shows is
// exactly what the letter prints.
//
// THE COLUMNS ARE THE ORIGINAL LETTER'S, IN ITS ORDER (owner, 2026-10-31: "exactly to export fields
// as the one i uploaded"): a blank-headed serial, الاسم, الرقم القومي, رقم للتواصل, العنوان, الوظيفة,
// الأجر. Right to left, so the serial is the rightmost column on the page.
//
// THE WAGE IS THE BASE SALARY FOR EVERYONE (owner, 2026-10-31, "Base for everyone"). The typed
// original mixed net for the head office and base for the field; HR letters state
// `employees.base_salary` as it is, never basic, net or gross. A plain integer, no separators —
// "18000" — the way the original wrote it.

/** The screen, linked from the HR Forms hero. Written as `href: "/…"` so the navigation-reachability
 * guard's literal scan sees the link (a conditional prop value is a shape it does not match). */
export const BANK_LETTER_PAGE = { href: "/hiring-pack/bank-account-letter" } as const;

export const BANK_LETTER_BANK_NAME_AR = "بنك أبو ظبي الأول مصر";

/** The `employees.bank_name` code for First Abu Dhabi Bank. The other values on file are CIB and QNB. */
export const FAB_BANK_CODE = "FAB";

export const BANK_LETTER_HEADINGS = ["", "الاسم", "الرقم القومي", "رقم للتواصل", "العنوان", "الوظيفة", "الأجر"] as const;

export type BankLetterEmployee = {
  hrId: string;
  /** The name the screen shows (nickname or full name), never printed. */
  displayName: string;
  nameAr: string | null;
  nationalId: string | null;
  mobile: string | null;
  address: string | null;
  /** The Arabic title from the hiring profile; the letter prints this. */
  jobTitleAr: string | null;
  /** The English title from the employee record, printed only when there is no Arabic one. */
  jobTitleEn: string | null;
  baseSalary: number | null;
  /** `employees.bank_name` as stored — FAB, CIB, QNB or nothing. */
  bankName: string | null;
  hireDate: string | null;
};

export type BankLetterField = "nameAr" | "nationalId" | "mobile" | "address" | "jobTitleAr" | "baseSalary";

export const BANK_LETTER_FIELD_LABELS: Record<BankLetterField, string> = {
  address: "Address",
  baseSalary: "Base salary",
  jobTitleAr: "Arabic job title",
  mobile: "Mobile",
  nameAr: "Arabic name",
  nationalId: "National ID",
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** True when the record already shows a First Abu Dhabi Bank account. */
export function hasFabAccount(employee: Pick<BankLetterEmployee, "bankName">): boolean {
  return clean(employee.bankName).toUpperCase() === FAB_BANK_CODE;
}

/**
 * Who the screen ticks on arrival: everyone active whose record shows no First Abu Dhabi Bank
 * account. HR unticks anyone who is not on this letter.
 */
export function preselectedForBankLetter(employees: readonly BankLetterEmployee[]): string[] {
  return employees.filter((employee) => !hasFabAccount(employee)).map((employee) => employee.hrId);
}

/** The base salary as the letter writes it: a whole number, no separators. */
export function formatBankLetterSalary(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "";
  return String(Math.round(value));
}

/** The job title the letter prints: the Arabic one, or the English one when Arabic is missing. */
export function bankLetterJobTitle(employee: Pick<BankLetterEmployee, "jobTitleAr" | "jobTitleEn">): string {
  return clean(employee.jobTitleAr) || clean(employee.jobTitleEn);
}

/** Every field the letter would print blank (or not in the bank's form) for this person. */
export function bankLetterGaps(employee: BankLetterEmployee): BankLetterField[] {
  const gaps: BankLetterField[] = [];
  if (!clean(employee.nameAr)) gaps.push("nameAr");
  if (!/^\d{14}$/.test(clean(employee.nationalId))) gaps.push("nationalId");
  if (!clean(employee.mobile)) gaps.push("mobile");
  if (!clean(employee.address)) gaps.push("address");
  if (!clean(employee.jobTitleAr)) gaps.push("jobTitleAr");
  if (!formatBankLetterSalary(employee.baseSalary)) gaps.push("baseSalary");
  return gaps;
}

/** One printed row: the seven cells in the letter's own column order. */
export type BankLetterRow = readonly [string, string, string, string, string, string, string];

export function bankLetterRows(employees: readonly BankLetterEmployee[]): BankLetterRow[] {
  return employees.map((employee, index) => [
    String(index + 1),
    clean(employee.nameAr),
    clean(employee.nationalId),
    clean(employee.mobile),
    clean(employee.address),
    bankLetterJobTitle(employee),
    formatBankLetterSalary(employee.baseSalary),
  ]);
}

/**
 * The order the screen lists people and the letter prints them: grouped by Arabic job title, the way
 * the original grouped its head office, area managers and medical reps, then by Arabic name.
 */
export function sortForBankLetter<T extends BankLetterEmployee>(employees: readonly T[]): T[] {
  return [...employees].sort(
    (a, b) =>
      bankLetterJobTitle(a).localeCompare(bankLetterJobTitle(b), "ar") ||
      (clean(a.nameAr) || a.displayName).localeCompare(clean(b.nameAr) || b.displayName, "ar"),
  );
}

export function bankLetterFileName(cairoDate: string): string {
  return `sato-pharma-bank-accounts-${cairoDate}.docx`;
}
