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
  upcomingJoinerOffers,
} from "@/lib/hiring-documents/joiners-logic";
import type { HiringJoiner, HiringJoinersData, UpdateHiringJoinerInput } from "@/lib/hiring-documents/types";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
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
  const [contactResult, acceptanceResult] = await Promise.all([
    supabase
      .from("hiring_joiner_contacts")
      .select("offer_id,papers_confirmed,attendance_date,attendance_time,notes,updated_at,updated_by_hr_id")
      .in("offer_id", offerIds),
    supabase
      .from("offer_acceptances")
      .select("offer_id,mobile:payload->>mobileNumber")
      .in("offer_id", offerIds)
      .order("submitted_at", { ascending: true }),
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
