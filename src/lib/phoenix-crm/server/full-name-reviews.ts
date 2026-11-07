import { forbiddenError, validationError } from "@/lib/http/api-errors";
import type { HeldFullName } from "@/lib/phoenix-crm/doctor-name-rules";
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

export async function decideHeldFullName(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ customerId: string; decision: "approve" | "reject" }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager decide these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.customerId)) throw validationError("Choose the doctor to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) throw validationError("Choose approve or reject.");
  const customerId = String(body.customerId).toLowerCase();
  await callPhoenixCrm<Row>("phoenix_crm_decide_full_name", {
    p: { customer_id: customerId, actor_hr_id: viewer.hrId, decision },
  });
  return { customerId, decision };
}
