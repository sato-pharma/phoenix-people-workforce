// ─────────────────────────────────────────────────────────────────────────────────────────────
// The people arriving, and what HR agreed with them (owner, 2026-11-02: "Contact the joiner, confirm
// papers and attendance time").
//
// THE OFFER SELECT IS NARROW ON PURPOSE. `listOffers` selects `*`, which carries the letter's money
// (total_monthly, cost_of_living, the template snapshot), and the HR Operations Specialist reads this
// panel. These columns are the whole of what it needs.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import {
  HiringJoinerInputError,
  joinerDayOneFacts,
  upcomingJoinerOffers,
  type JoinerDayOneReads,
} from "@/lib/hiring-documents/joiners-logic";
import type { HiringJoiner, HiringJoinersData, UpdateHiringJoinerInput } from "@/lib/hiring-documents/types";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const OFFER_COLUMNS = "id,candidate_name,candidate_email,title,territory,start_date,status,employee_hr_id";

type OfferRow = {
  candidate_email: string | null;
  candidate_name: string | null;
  employee_hr_id: string | null;
  id: string;
  start_date: string | null;
  status: string | null;
  territory: string | null;
  title: string | null;
};

type EmployeeRow = {
  full_name: string | null;
  hire_date: string | null;
  hr_id: string;
  mobile_number: string | null;
};

type ContactRow = {
  attendance_date: string | null;
  attendance_time: string | null;
  notes: string | null;
  offer_id: string;
  papers_confirmed: boolean;
  updated_at: string;
  updated_by_hr_id: string | null;
};

type AcceptanceRow = { mobile: string | null; offer_id: string };

type JoinerDetailsRow = {
  bank_account: string | null;
  hr_id: string;
  national_id: string | null;
  social_insurance_number: string | null;
};

function keyOf(hrId: string | null | undefined): string {
  return canonicalHrIdKey(hrId) ?? "";
}

async function readEmployees(hrIds: readonly string[]): Promise<Map<string, EmployeeRow>> {
  const wanted = [...new Set(hrIds.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,full_name,hire_date,mobile_number")
    .in("hr_id", wanted);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as EmployeeRow[]).map((row) => [keyOf(row.hr_id), row]));
}

/**
 * One Day one read, which may fail alone. A person's mailbox status or device count is worth less
 * than the list of who is arriving, so a failure here says "Not read" on those lines and costs nothing
 * else. Nor does it become a "no": `joinerDayOneFacts` keeps the null.
 */
async function dayOneRead<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[hiring-joiners] the ${what} read failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Status and count only. `new_hire_mailbox_tasks` also holds the address and a sealed first password,
 * and `device_assignments` joins to what a device is worth, and this panel needs neither.
 */
async function readDayOne(hrIds: readonly string[]): Promise<JoinerDayOneReads> {
  const supabase = getSupabaseAdmin();
  const spellings = [...new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId)))];
  const keys = [...new Set(hrIds.map(keyOf).filter(Boolean))];
  if (keys.length === 0) return { details: new Map(), deviceCounts: new Map(), logins: new Set(), mailboxes: new Map() };

  const [logins, mailboxes, deviceCounts, details] = await Promise.all([
    dayOneRead("account", async () => {
      const { data, error } = await supabase.from("app_auth_users").select("hr_id").in("hr_id", spellings).eq("is_active", true);
      if (error) throw new Error(error.message);
      return new Set(((data ?? []) as Array<{ hr_id: string | null }>).map((row) => keyOf(row.hr_id)));
    }),
    dayOneRead("mailbox", async () => {
      const { data, error } = await supabase
        .from("new_hire_mailbox_tasks")
        .select("employee_hr_id_key,status")
        .in("employee_hr_id_key", keys);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ employee_hr_id_key: string; status: string | null }>;
      return new Map(rows.map((row) => [keyOf(row.employee_hr_id_key), row.status]));
    }),
    dayOneRead("device", async () => {
      const { data, error } = await supabase
        .from("device_assignments")
        .select("employee_hr_id")
        .in("employee_hr_id", spellings)
        .eq("status", "outstanding")
        .eq("is_placeholder", false);
      if (error) throw new Error(error.message);
      const counts = new Map<string, number>();
      for (const row of (data ?? []) as Array<{ employee_hr_id: string | null }>) {
        const key = keyOf(row.employee_hr_id);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    }),
    // THE NUMBERS STOP HERE. This is the one place on this screen they are read, and they leave as
    // yes or no: a national ID and a bank account have no business in this panel's payload.
    dayOneRead("details", async () => {
      const { data, error } = await supabase
        .from("employees")
        .select("hr_id,national_id,social_insurance_number,bank_account")
        .in("hr_id", spellings);
      if (error) throw new Error(error.message);
      return new Map(
        ((data ?? []) as JoinerDetailsRow[]).map((row) => [
          keyOf(row.hr_id),
          {
            bankAccount: Boolean(row.bank_account?.trim()),
            insuranceNumber: Boolean(row.social_insurance_number?.trim()),
            nationalId: Boolean(row.national_id?.trim()),
          },
        ]),
      );
    }),
  ]);
  return { details, deviceCounts, logins, mailboxes };
}

export async function getHiringJoiners(): Promise<HiringJoinersData> {
  const todayKey = todayInCairo();
  const supabase = getSupabaseAdmin();

  const { data: offerData, error: offerError } = await supabase
    .from("offers")
    .select(OFFER_COLUMNS)
    .eq("status", "accepted");
  if (offerError) throw new Error(offerError.message);
  const offers = (offerData ?? []) as OfferRow[];

  const employees = await readEmployees(offers.map((offer) => offer.employee_hr_id ?? ""));
  const hireDateByHrId = new Map<string, string>();
  for (const [key, row] of employees) {
    if (row.hire_date) hireDateByHrId.set(key, row.hire_date);
  }

  const upcoming = upcomingJoinerOffers(
    offers.map((offer) => ({
      employeeHrId: offer.employee_hr_id,
      id: offer.id,
      name: offer.candidate_name ?? "",
      row: offer,
      startDate: offer.start_date,
      status: offer.status,
    })),
    { hireDateByHrId, todayKey },
  );
  if (upcoming.length === 0) return { joiners: [], todayKey };

  const offerIds = upcoming.map(({ offer }) => offer.id);
  const [contactResult, acceptanceResult, dayOneReads] = await Promise.all([
    supabase
      .from("hiring_joiner_contacts")
      .select("offer_id,papers_confirmed,attendance_date,attendance_time,notes,updated_at,updated_by_hr_id")
      .in("offer_id", offerIds),
    supabase
      .from("offer_acceptances")
      .select("offer_id,mobile:payload->>mobileNumber")
      .in("offer_id", offerIds)
      .order("submitted_at", { ascending: true }),
    readDayOne(upcoming.map(({ offer }) => offer.employeeHrId ?? "").filter(Boolean)),
  ]);
  if (contactResult.error) throw new Error(contactResult.error.message);
  if (acceptanceResult.error) throw new Error(acceptanceResult.error.message);

  const contacts = new Map(((contactResult.data ?? []) as ContactRow[]).map((row) => [row.offer_id, row]));
  // Oldest first, so the newest form a joiner submitted is the number kept.
  const formMobile = new Map(
    ((acceptanceResult.data ?? []) as unknown as AcceptanceRow[]).map((row) => [row.offer_id, row.mobile?.trim() || null]),
  );
  const updaters = await readEmployees([...contacts.values()].map((row) => row.updated_by_hr_id ?? ""));

  const joiners: HiringJoiner[] = upcoming.map(({ offer, startKey }) => {
    const contact = contacts.get(offer.id);
    const employee = employees.get(keyOf(offer.employeeHrId));
    return {
      attendanceDate: contact?.attendance_date ?? null,
      // Postgres answers `09:30:00`; the screen and the save speak `09:30`.
      attendanceTime: contact?.attendance_time?.slice(0, 5) ?? null,
      dayOne: joinerDayOneFacts(keyOf(offer.employeeHrId), dayOneReads),
      email: offer.row.candidate_email,
      employeeHrId: offer.employeeHrId,
      mobile: formMobile.get(offer.id) ?? employee?.mobile_number?.trim() ?? null,
      name: offer.name,
      notes: contact?.notes ?? null,
      offerId: offer.id,
      papersConfirmed: contact?.papers_confirmed ?? false,
      startKey,
      territory: offer.row.territory,
      title: offer.row.title,
      updatedAt: contact?.updated_at ?? null,
      updatedByName: updaters.get(keyOf(contact?.updated_by_hr_id))?.full_name ?? null,
    };
  });

  return { joiners, todayKey };
}

export async function saveHiringJoinerContact(access: AccessContext, input: UpdateHiringJoinerInput): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data: offerData, error: offerError } = await supabase
    .from("offers")
    .select("id,candidate_name,status")
    .eq("id", input.offerId)
    .maybeSingle();
  if (offerError) throw new Error(offerError.message);
  const offer = offerData as { candidate_name: string | null; id: string; status: string | null } | null;
  if (!offer || offer.status !== "accepted") {
    throw new HiringJoinerInputError("That offer is not an accepted one, so there is nobody to confirm.");
  }

  // Before-image, for the audit row: what was agreed before this save is the thing a dispute asks.
  const { data: beforeData, error: beforeError } = await supabase
    .from("hiring_joiner_contacts")
    .select("papers_confirmed,attendance_date,attendance_time,notes")
    .eq("offer_id", input.offerId)
    .maybeSingle();
  if (beforeError) throw new Error(beforeError.message);

  const next = {
    attendance_date: input.attendanceDate,
    attendance_time: input.attendanceTime,
    notes: input.notes,
    papers_confirmed: input.papersConfirmed,
  };

  const { error } = await supabase.from("hiring_joiner_contacts").upsert(
    {
      ...next,
      offer_id: input.offerId,
      updated_at: new Date().toISOString(),
      updated_by_hr_id: hrIdForStorage(access.hrId),
    },
    { onConflict: "offer_id" },
  );
  if (error) throw new Error(error.message);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: input.offerId,
    entityType: "hiring_joiner_contact",
    newValues: next,
    oldValues: (beforeData as Record<string, unknown> | null) ?? {},
    summary: `Joining confirmation for ${offer.candidate_name ?? "a joiner"} saved.`,
  });
}
