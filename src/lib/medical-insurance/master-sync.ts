// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE REGISTER FEEDS THE EMPLOYEE MASTER WHAT IT IS MISSING (owner, 27 Nov 2026: "synchronize from
// medical insurance module to employee master the needed data for employee master").
//
// The Libano-Suisse register holds, for every insured employee, the insurer's own card number and the
// identity the insurer priced them on (national ID, birth date, gender, phone). This is the one rule for
// what of that reaches `employees`:
//
//   - The card number ("Medical Insurance Card Number") IS the register's. Libano-Suisse issued it, the
//     policy in force is theirs, so a blank one is filled and one that differs (a card number from the
//     cancelled MetLife policy, 2 to 4 digits) is replaced with it.
//   - National ID, birth date, gender and mobile are the Employee Master's own facts. They are filled
//     ONLY where the Employee Master is blank. Where both hold a value and they differ, nothing is
//     written: the difference is listed for a person to settle, never decided here.
//   - "Card Received (Yes-No)" and its date are NOT the register's to say — the register knows the card
//     was issued, never that the employee holds it. They are never written.
//   - "Medical Insurance" (the monthly figure) is the module's cost — what the employee pays for the
//     payroll month on the Cost and Invoices tabs (planMedicalInsuranceAmounts, below; owner, 27 Nov 2026:
//     "cost in module in cost and invoices"). An active employee the module charges nothing holds 0; a
//     leaver keeps the figure history holds; an unpriced row is listed, never guessed. Payroll reads the
//     module itself from December 2026, so the figure cannot charge twice, and the column stays hidden
//     from seats that cannot see pay.
//
// Pure: the reads and the writes are `syncEmployeeMasterFromMedicalInsurance` in ./service.ts.
// Pinned by tests/medical-insurance-master-sync.test.ts.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One register row, as much of it as this rule reads. Only `employee` rows with an HR id feed the master. */
export type MasterSyncMember = {
  hrId: string | null;
  memberType: "employee" | "spouse" | "child";
  certificateNumber: string | null;
  nationalId: string | null;
  birthDate: string | null;
  gender: string | null;
  phone: string | null;
  coverageStart: string;
  coverageEnd: string | null;
};

/** One Employee Master row, the stored values exactly (null and "" both read as blank). */
export type MasterSyncEmployee = {
  hrId: string;
  name: string;
  nationalId: string | null;
  birthDate: string | null;
  gender: string | null;
  mobileNumber: string | null;
  medicalInsuranceNumber: string | null;
};

export type MasterSyncField = "medical_insurance_number" | "national_id" | "birth_date" | "gender" | "mobile_number";

export const MASTER_SYNC_FIELD_LABELS: Record<MasterSyncField, string> = {
  birth_date: "Birth Date",
  gender: "Gender",
  medical_insurance_number: "Medical Insurance Card Number",
  mobile_number: "Mobile Number",
  national_id: "National ID",
};

export type MasterSyncChange = {
  field: MasterSyncField;
  /** The stored value exactly as it is now — the write is guarded on it, so a value someone typed in between is never overwritten. */
  from: string | null;
  to: string;
  why: "blank" | "replaced";
};

export type MasterSyncUpdate = { hrId: string; name: string; changes: MasterSyncChange[] };

/** Both sides hold a value and they differ: listed, never written. */
export type MasterSyncDifference = { hrId: string; name: string; field: MasterSyncField; master: string; register: string };

export type MasterSyncPlan = { updates: MasterSyncUpdate[]; differences: MasterSyncDifference[] };

const blank = (value: string | null | undefined): boolean => value == null || value.trim() === "";

/** The insurer's 8-digit card number, or anything else it typed, trimmed. */
function cardNumber(value: string | null): string | null {
  return blank(value) ? null : value!.trim();
}

function nationalId(value: string | null): string | null {
  const digits = (value ?? "").replace(/\s+/g, "");
  return /^\d{14}$/.test(digits) ? digits : null;
}

function birthDate(value: string | null): string | null {
  const day = (value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The register stores M / F; the Employee Master stores male / female. */
function gender(value: string | null): string | null {
  const letter = (value ?? "").trim().toLowerCase();
  if (letter === "m" || letter === "male") return "male";
  if (letter === "f" || letter === "female") return "female";
  return null;
}

/**
 * The insurer's file drops the leading zero (1012345678); the Employee Master keeps an Egyptian mobile as
 * 01012345678. Anything that is not a mobile in one of those two shapes is not written.
 */
export function masterMobile(value: string | null): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  if (/^1[0125]\d{8}$/.test(digits)) return `0${digits}`;
  if (/^01[0125]\d{8}$/.test(digits)) return digits;
  return null;
}

/** The last ten digits — the same mobile written 01…, 1… or with spaces and a second number after it. */
function sameMobile(master: string, register: string): boolean {
  const first = master.split(/[-/,]/)[0] ?? master;
  return first.replace(/\D/g, "").slice(-10) === register.replace(/\D/g, "").slice(-10);
}

/** Each HR id's own employee row: the open one, else the one that started last. */
function registerRowByHrId(members: readonly MasterSyncMember[]): Map<string, MasterSyncMember> {
  const chosen = new Map<string, MasterSyncMember>();
  for (const member of members) {
    if (member.memberType !== "employee" || blank(member.hrId)) continue;
    const hrId = member.hrId!.trim();
    const held = chosen.get(hrId);
    const better =
      !held ||
      (held.coverageEnd !== null && member.coverageEnd === null) ||
      ((held.coverageEnd === null) === (member.coverageEnd === null) && member.coverageStart > held.coverageStart);
    if (better) chosen.set(hrId, member);
  }
  return chosen;
}

export function planEmployeeMasterSync(input: { members: readonly MasterSyncMember[]; employees: readonly MasterSyncEmployee[] }): MasterSyncPlan {
  const register = registerRowByHrId(input.members);
  const updates: MasterSyncUpdate[] = [];
  const differences: MasterSyncDifference[] = [];

  for (const employee of input.employees) {
    const row = register.get(employee.hrId);
    if (!row) continue;
    const changes: MasterSyncChange[] = [];

    const card = cardNumber(row.certificateNumber);
    if (card) {
      if (blank(employee.medicalInsuranceNumber)) changes.push({ field: "medical_insurance_number", from: employee.medicalInsuranceNumber, to: card, why: "blank" });
      else if (employee.medicalInsuranceNumber!.trim() !== card) {
        changes.push({ field: "medical_insurance_number", from: employee.medicalInsuranceNumber, to: card, why: "replaced" });
      }
    }

    // Filled where blank; a value on both sides that differs is listed, never written.
    const fillOnly = (field: MasterSyncField, master: string | null, registerValue: string | null, same: (a: string, b: string) => boolean) => {
      if (!registerValue) return;
      if (blank(master)) changes.push({ field, from: master, to: registerValue, why: "blank" });
      else if (!same(master!.trim(), registerValue)) differences.push({ field, hrId: employee.hrId, master: master!.trim(), name: employee.name, register: registerValue });
    };
    fillOnly("national_id", employee.nationalId, nationalId(row.nationalId), (a, b) => a.replace(/\s+/g, "") === b);
    fillOnly("birth_date", employee.birthDate, birthDate(row.birthDate), (a, b) => a.slice(0, 10) === b);
    fillOnly("gender", employee.gender, gender(row.gender), (a, b) => gender(a) === b);
    fillOnly("mobile_number", employee.mobileNumber, masterMobile(row.phone), sameMobile);

    if (changes.length > 0) updates.push({ changes, hrId: employee.hrId, name: employee.name });
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return { differences: differences.sort(byName), updates: updates.sort(byName) };
}

/** One line of the audit trail and the run's own report: "Medical Insurance Card Number: (blank) → 54296751". */
export function describeMasterSyncChange(change: MasterSyncChange): string {
  const from = blank(change.from) ? "(blank)" : change.from!.trim();
  return `${MASTER_SYNC_FIELD_LABELS[change.field]}: ${from} → ${change.to}`;
}

// ── The monthly cost (owner, 27 Nov 2026: "cost in module in cost and invoices") ────────────────────────
//
// The Employee Master's "Medical Insurance" (PAYROLL REFERENCE INFORMATION, a money column, hidden from every
// seat that cannot see pay) is the module's own monthly figure: `employeePays` of the employee's row of the
// Cost tab's "Who pays each month" — their share of their own cover (never under EGP 120), their spouse and
// children in full, and EGP 85 life insurance a person. It is the very figure payroll charges from the
// December 2026 payroll month (payrollChargesForWindow), so the master and the payslip say the same thing.
// An active employee the module charges nothing (excluded, or not on the register) holds 0. A leaver's figure
// is history and is left alone; a person the module cannot price is listed, never guessed.

export type MasterSyncCharge = { hrId: string; amount: number; unpriced: number };

export type MasterSyncAmountEmployee = { hrId: string; name: string; active: boolean; medicalInsurance: number | null };

export type MasterSyncAmountChange = { hrId: string; name: string; from: number | null; to: number; why: "module" | "not covered" };

export type MasterSyncAmountPlan = { changes: MasterSyncAmountChange[]; unpriced: Array<{ hrId: string; name: string; people: number }> };

const piastres = (value: number): number => Math.round(value * 100);

export function planMedicalInsuranceAmounts(input: {
  charges: readonly MasterSyncCharge[];
  employees: readonly MasterSyncAmountEmployee[];
}): MasterSyncAmountPlan {
  const charges = new Map(input.charges.map((charge) => [charge.hrId, charge]));
  const changes: MasterSyncAmountChange[] = [];
  const unpriced: MasterSyncAmountPlan["unpriced"] = [];
  for (const employee of input.employees) {
    const charge = charges.get(employee.hrId);
    if (charge) {
      if (charge.unpriced > 0) {
        unpriced.push({ hrId: employee.hrId, name: employee.name, people: charge.unpriced });
        continue;
      }
      const to = piastres(charge.amount) / 100;
      if (employee.medicalInsurance === null || piastres(employee.medicalInsurance) !== piastres(to)) {
        changes.push({ from: employee.medicalInsurance, hrId: employee.hrId, name: employee.name, to, why: "module" });
      }
      continue;
    }
    if (employee.active && (employee.medicalInsurance === null || piastres(employee.medicalInsurance) !== 0)) {
      changes.push({ from: employee.medicalInsurance, hrId: employee.hrId, name: employee.name, to: 0, why: "not covered" });
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return { changes: changes.sort(byName), unpriced: unpriced.sort(byName) };
}

const egp = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function describeMasterSyncAmountChange(change: MasterSyncAmountChange): string {
  const from = change.from === null ? "(blank)" : egp(change.from);
  return `Medical Insurance: ${from} → ${egp(change.to)}${change.why === "not covered" ? " (not on the policy)" : ""}`;
}
