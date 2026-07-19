import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";

export type BirthdayEligibilitySubject = {
  employment_status?: string | null;
  birth_date?: string | null;
};

/** True when an employee should be considered for today's birthday notification run. */
export function isBirthdayEligibleEmployee(employee: BirthdayEligibilitySubject): boolean {
  return !isTerminalEmploymentStatus(employee.employment_status) && Boolean(employee.birth_date);
}
