import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { parseDoctorFullName, type HeldFullName } from "@/lib/phoenix-crm/pm-name-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { canDecideValidationReviews, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const HELD_LIMIT = 200;

export async function loadHeldFullNames(viewer: PhoenixCrmViewer): Promise<HeldFullName[]> {
  if (!canDecideValidationReviews(viewer)) return [];
  const read = await getSupabaseAdmin()
    .from("phoenix_crm_customers")
    .select("id, name, is_test, full_name_held, full_name_held_at, full_name_held_by_hr_id, full_name_held_score, full_name_held_board")
    .not("full_name_held", "is", null)
    .order("full_name_held_at", { ascending: true })
    .limit(HELD_LIMIT);
  throwIfError(read.error);
  const rows = (read.data ?? []) as Row[];
  const names = await loadPeopleNames(rows.map((row) => String(row.full_name_held_by_hr_id ?? "")));
  return rows.map((row) => ({
    customerId: String(row.id),
    currentName: String(row.name ?? ""),
    fullName: String(row.full_name_held ?? ""),
    percent: numberOrNull(row.full_name_held_score),
    boardNames: Array.isArray(row.full_name_held_board) ? row.full_name_held_board.map(String) : [],
    repName: nameOf(names, String(row.full_name_held_by_hr_id ?? ""), "A rep"),
    heldAt: String(row.full_name_held_at ?? ""),
    isTest: row.is_test === true,
  }));
}

/**
 * 🔴 ONLY THE SUPER ADMIN CORRECTS A HELD NAME — NEVER THE SFE MANAGER (owner, 2026-11-08: "make an option to
 * the admin only, not the SFE, to edit the name by the reps to correct it, or add the third name"). The SFE
 * Manager still approves and rejects the name as the rep wrote it (`canDecideValidationReviews`); writing a
 * different name is the Super Admin's alone. `canUpdate` is the verb the SFE Manager does not hold. The route
 * asks `approve` (one permission per route, the module's rule) and this is the gate for a correction, checked
 * before the database is called. Never a test account.
 */
export function canCorrectHeldFullName(viewer: PhoenixCrmViewer): boolean {
  return !viewer.isTestPersona && viewer.isSuperAdmin && viewer.canUpdate;
}

/** Whether a request carries a corrected name, which only `canCorrectHeldFullName` may send. */
export function correctsHeldFullName(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && (raw as Row).nameParts !== undefined && (raw as Row).nameParts !== null);
}

export async function decideHeldFullName(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; decision: "approve" | "reject"; corrected: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager decide these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.customerId)) throw validationError("Choose the customer to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) throw validationError("Choose approve or reject.");
  const customerId = String(body.customerId).toLowerCase();

  // A corrected name: the Super Admin's alone, on approve only, and held to the same three-name rules a rep's
  // own boxes are (no title, no place word, one name a box). The board match is not asked again — he is the
  // one deciding that the board was misread.
  let name: string | null = null;
  if (correctsHeldFullName(body)) {
    if (!canCorrectHeldFullName(viewer)) throw forbiddenError("Only the Super Admin corrects a name.");
    if (decision !== "approve") throw validationError("A corrected name is saved with Approve.");
    const parsed = parseDoctorFullName(body.nameParts, null);
    if (!parsed.ok) throw validationError(parsed.error);
    name = parsed.value;
  }

  await callPhoenixCrm<Row>("phoenix_crm_decide_full_name", {
    p: name === null ? { customer_id: customerId, actor_hr_id: viewer.hrId, decision } : { customer_id: customerId, actor_hr_id: viewer.hrId, decision, name },
  });
  return { customerId, decision, corrected: name !== null };
}
