// Vacant-seat stand-ins for role-addressed notices (owner, 2026-10-20).
//
// The HR employee who sat in the "HR Operations" seat moved that day to a seat of her own (the role
// key "HR Administration", shown as HR Operations Specialist), and "HR Operations" — shown as HR
// Generalist from the same day — stays open, with all its access, for a future hire. Asked where
// the notices addressed to that seat go in the meantime, the owner answered for every one of them:
// to him. So a seat named in VACANT_SEAT_STAND_INS, while NOBODY holds it, hands its copy to the
// role standing in for it, and takes it back the moment somebody is seated — nothing to undo on
// the day of the hire, and no HR id written anywhere that would strand the notice when the person
// in the chair changes.
//
// "NOBODY HOLDS IT" IS A FACT READ, NEVER AN ERROR GUESSED AT. A seat whose accounts could not be
// read is NOT treated as empty: that would hand the owner another seat's mail on every transient
// database error, and would make an outage look like a vacancy. It keeps exactly the audience it
// had and leaves a warning. Only a successful read that finds no active, current, real holder — a
// test account is never one (`activeRoleSignIns`), nor is somebody whose employee record is
// terminal — brings the stand-in in.
//
// NEVER TWICE. A stand-in already on the list is not added again, and that case needs no read at
// all. The resignation, retention-risk and accepted-offer audiences already name the Super Admin
// beside HR Operations, so on the day this landed the only default audience it changed was the CRM
// account-setup notice (SFE Manager + HR Operations). The person-level resolvers then merge one
// human's several accounts into one recipient, as they always did.

import { canonicalPersonHrId } from "@/lib/auth/identity-aliases";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { activeRoleSignIns } from "@/lib/employees/role-lookup";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { logInfo, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The HR Generalist seat. Its role key is "HR Operations" and stays so: the title is display only
 * (`HR_SEAT_JOB_TITLES` in src/lib/auth/hr-functions.ts). Named once here so the senders that
 * address the seat directly — the vacation "informed" notice, the business-card request — never
 * spell it, or a person's HR id, by hand.
 */
export const HR_GENERALIST_SEAT = "HR Operations" as const satisfies PhoenixRole;

/**
 * Each seat that may stand empty, and the role that receives its notices while it does. A future
 * open seat is one more line here; every role-addressed audience picks it up at once.
 */
export const VACANT_SEAT_STAND_INS: Readonly<Partial<Record<PhoenixRole, PhoenixRole>>> = {
  [HR_GENERALIST_SEAT]: "Super Admin",
};

/** What one read of a seat found. "unreadable" is never "vacant" — see the header. */
export type SeatState = "held" | "vacant" | "unreadable";

/**
 * The people holding one role right now. THROWS when the accounts cannot be read, so a caller can
 * tell an empty seat from a failed read. Injected in tests; the default is `readCurrentRoleHolders`.
 */
export type RoleHolderReader = (role: PhoenixRole) => Promise<string[]>;

/** One HR id per person, in the canonical person's display form (the console login PHX-1 is B-10), first seen first. */
export function onePerPerson(hrIds: readonly (string | null | undefined)[]): string[] {
  const byPerson = new Map<string, string>();
  for (const hrId of hrIds) {
    const person = canonicalPersonHrId(hrId);
    const key = canonicalHrIdKey(person);
    if (person && key && !byPerson.has(key)) byPerson.set(key, person);
  }
  return Array.from(byPerson.values());
}

/**
 * Every current, real holder of one role, one HR id per person.
 *
 * The sign-in read THROWS on error (`activeRoleSignIns`), which is what lets a vacancy be told from
 * an outage. The leaver check after it FAILS OPEN — an unreadable `employees` read drops nobody —
 * the same direction as `withoutDepartedHrIds` in role-recipients.ts: a seat must not read as empty
 * because a second table blinked.
 */
export async function readCurrentRoleHolders(role: PhoenixRole): Promise<string[]> {
  const hrIds = Array.from(new Set((await activeRoleSignIns([role])).map((signIn) => signIn.hrId)));
  if (hrIds.length === 0) return [];
  const departed = new Set<string>();
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id,employment_status")
      .in("hr_id", hrIds);
    if (error) throw error;
    for (const employee of (data ?? []) as Array<{ hr_id?: string | null; employment_status?: string | null }>) {
      if (isTerminalEmploymentStatus(employee.employment_status)) departed.add(String(employee.hr_id ?? "").trim().toUpperCase());
    }
  } catch (error) {
    logWarning(`The employment check for the ${role} role could not be read; no holder was dropped`, {
      error,
      labels: { event: "vacant_seat_employment_check_failed", role },
    });
  }
  return onePerPerson(hrIds.filter((hrId) => !departed.has(hrId)));
}

/** The seats on this list whose stand-in is not on it already — the only ones worth a read. Pure. */
export function seatsNeedingAHolderCheck(roles: readonly PhoenixRole[]): PhoenixRole[] {
  const listed = new Set<PhoenixRole>(roles);
  return Array.from(listed).filter((role) => {
    const standIn = VACANT_SEAT_STAND_INS[role];
    return Boolean(standIn) && !listed.has(standIn as PhoenixRole);
  });
}

/**
 * The roles, plus the stand-in of every seat READ as vacant, each role once and in list order. A
 * seat that is held, unreadable or simply not read changes nothing. Pure.
 */
export function applyVacantSeatStandIns(
  roles: readonly PhoenixRole[],
  states: ReadonlyMap<PhoenixRole, SeatState>,
): PhoenixRole[] {
  const out: PhoenixRole[] = [];
  const add = (role: PhoenixRole) => {
    if (!out.includes(role)) out.push(role);
  };
  for (const role of roles) add(role);
  for (const role of roles) {
    const standIn = VACANT_SEAT_STAND_INS[role];
    if (standIn && states.get(role) === "vacant") add(standIn);
  }
  return out;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function readSeatState(
  seat: PhoenixRole,
  warningLabel: string,
  warnings: string[] | undefined,
  readHolders: RoleHolderReader,
): Promise<SeatState> {
  try {
    const holders = await readHolders(seat);
    if (holders.length > 0) return "held";
    // An open seat is a known state, not a fault: INFO, so a months-long vacancy does not page anyone.
    logInfo(`${warningLabel}: nobody holds the ${seat} seat, so the ${VACANT_SEAT_STAND_INS[seat]} receives its copy`, {
      labels: { event: "vacant_seat_stand_in", role: seat },
    });
    return "vacant";
  } catch (error) {
    const note = `${warningLabel}: the ${seat} seat could not be read, so no stand-in was added`;
    warnings?.push(`${note}: ${failureText(error)}`.slice(0, 160));
    logWarning(note, { error, labels: { event: "vacant_seat_read_failed", role: seat } });
    return "unreadable";
  }
}

/**
 * The roles a role-addressed notice is about to be resolved to people from, with the stand-in added
 * for every listed seat nobody holds. NEVER THROWS — it sits inside `resolveNotificationRoleRecipients`,
 * whose callers have no guard of their own — and a seat it could not read keeps today's audience,
 * with the reason pushed onto `warnings` when the caller keeps one.
 */
export async function withVacantSeatStandIns(
  roles: readonly PhoenixRole[],
  warningLabel: string,
  warnings?: string[],
  readHolders: RoleHolderReader = readCurrentRoleHolders,
): Promise<PhoenixRole[]> {
  const seats = seatsNeedingAHolderCheck(roles);
  if (seats.length === 0) return [...roles];
  const states = new Map<PhoenixRole, SeatState>();
  await Promise.all(
    seats.map(async (seat) => {
      states.set(seat, await readSeatState(seat, warningLabel, warnings, readHolders));
    }),
  );
  return applyVacantSeatStandIns(roles, states);
}

export type SeatRecipients = {
  /** One HR id per person: the seat's holders, or — while it is empty — its stand-in's. */
  hrIds: string[];
  /** The role whose holders were used because the seat was empty, or null when the seat itself answered. */
  standIn: PhoenixRole | null;
  /** True when a read failed. `hrIds` is then empty: nobody is guessed at. */
  unreadable: boolean;
  warnings: string[];
};

/**
 * The people a notice addressed to ONE seat goes to: whoever holds it, or, while nobody does, whoever
 * holds its stand-in role. For the senders that address a seat directly rather than through an
 * admin-editable policy. Never throws.
 */
export async function resolveSeatOrStandInHrIds(
  seat: PhoenixRole,
  warningLabel: string,
  readHolders: RoleHolderReader = readCurrentRoleHolders,
): Promise<SeatRecipients> {
  const warnings: string[] = [];
  const unreadable = (role: PhoenixRole, standIn: PhoenixRole | null, error: unknown): SeatRecipients => {
    const note = `${warningLabel}: the ${role} role could not be read, so nobody was resolved`;
    warnings.push(`${note}: ${failureText(error)}`.slice(0, 160));
    logWarning(note, { error, labels: { event: "vacant_seat_read_failed", role } });
    return { hrIds: [], standIn, unreadable: true, warnings };
  };

  let holders: string[];
  try {
    holders = await readHolders(seat);
  } catch (error) {
    return unreadable(seat, null, error);
  }
  if (holders.length > 0) return { hrIds: onePerPerson(holders), standIn: null, unreadable: false, warnings };

  const standIn = VACANT_SEAT_STAND_INS[seat] ?? null;
  if (!standIn) return { hrIds: [], standIn: null, unreadable: false, warnings };
  try {
    const standIns = onePerPerson(await readHolders(standIn));
    logInfo(`${warningLabel}: nobody holds the ${seat} seat, so the ${standIn} receives its copy`, {
      labels: { event: "vacant_seat_stand_in", role: seat },
    });
    return { hrIds: standIns, standIn, unreadable: false, warnings };
  } catch (error) {
    return unreadable(standIn, standIn, error);
  }
}
