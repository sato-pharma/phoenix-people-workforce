/**
 * THE NEW HIRES WITH NO LOGIN AND NOTHING TRYING TO GIVE THEM ONE (REC-027, 2026-11-13).
 *
 * The hire hand-off ledger (`src/lib/employees/hire-handoff.ts`) makes every login a hiring door
 * tries to create leave a row, and the hourly reconciler retries the failed ones. This is the net
 * UNDER that ledger: a hire made before the ledger existed, a ledger write that was lost, or an
 * employee added by a path that never asks for a login (an import, a hand edit) has no row at all
 * and would otherwise stay invisible. So: every ACTIVE employee hired in the last 60 days (Cairo)
 * must hold a portal login, or have a login step still pending or failed — which the reconciler is
 * already working on. A login step that GAVE UP is not an excuse: that hire still has no login.
 *
 * Pure on purpose: the check in `checks/recruitment.ts` reads the rows, and this is the part a test
 * pins without a database. Its one import, `@/lib/hr-id`, imports nothing.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";

export const NEW_HIRE_LOGIN_WINDOW_DAYS = 60;

export type NewHireForLoginCheck = {
  hrId: string;
  name: string;
  /** As stored; only a leading YYYY-MM-DD is read, anything else is skipped rather than guessed. */
  hireDate: string | null;
  /** Already decided by the caller with the directory's own `isActiveLifecycleStatus`. */
  active: boolean;
};

export type NewHireWithoutLogin = { hrId: string; name: string; hireDate: string };

function dayNumber(dateOnly: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(at) ? Math.floor(at / 86_400_000) : null;
}

/** The one canonical key every HR id spelling (and legacy alias) matches on. */
function key(hrId: string | null | undefined): string {
  return canonicalHrIdKey(hrId) ?? "";
}

/**
 * The active employees hired from `today - windowDays` to `today` (inclusive) who hold no login and
 * have no login step in hand. `loginHrIds` and `loginStepsInHand` may hold any spelling of an HR id.
 * A hire date in the future (an employee added ahead of a start date) is in the window — he still
 * needs a login on his first day.
 */
export function findNewHiresWithoutLogin(input: {
  employees: readonly NewHireForLoginCheck[];
  loginHrIds: Iterable<string>;
  loginStepsInHand: Iterable<string>;
  today: string;
  windowDays?: number;
}): NewHireWithoutLogin[] {
  const today = dayNumber(input.today);
  if (today === null) throw new Error(`The check was given an unreadable today: ${input.today}`);
  const from = today - (input.windowDays ?? NEW_HIRE_LOGIN_WINDOW_DAYS);
  const withLogin = new Set([...input.loginHrIds].map(key).filter(Boolean));
  const inHand = new Set([...input.loginStepsInHand].map(key).filter(Boolean));

  const out: NewHireWithoutLogin[] = [];
  for (const employee of input.employees) {
    if (!employee.active) continue;
    const hired = employee.hireDate ? dayNumber(employee.hireDate) : null;
    if (hired === null || hired < from) continue;
    const id = key(employee.hrId);
    if (!id || withLogin.has(id) || inHand.has(id)) continue;
    out.push({ hireDate: String(employee.hireDate).slice(0, 10), hrId: employee.hrId, name: employee.name });
  }
  return out.sort((a, b) => a.hireDate.localeCompare(b.hireDate) || a.name.localeCompare(b.name));
}
