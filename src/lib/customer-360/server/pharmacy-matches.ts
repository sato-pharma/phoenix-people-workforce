/**
 * Customer 360 — writing the Super Admin's decision on a pharmacy named on a visit.
 *
 * 🔴 ONLY THE SUPER ADMIN DECIDES (owner, 2026-10-18: "make another tab in the same module for me, the
 * admin, to confirm it"). The route gates on `customer_identity:update`, his alone; this file trusts
 * its caller for that and checks everything else.
 *
 * 🔴 IT WRITES ONLY `customer_360_pharmacy_matches`. No visit, no Phoenix CRM customer, no marketing or
 * direct-order row, and no `customer_identity_links` row is touched: a tie is an annotation this
 * report reads, never a merge.
 *
 * One LIVE row per name + brick (a partial unique index). A decision withdraws the live row and writes
 * its own; Undo withdraws his decision and the rule decides again. Nothing is ever deleted.
 *
 * 🔴 AN AUTOMATIC TIE IS NEVER STORED. The rule runs live on every build (`matchNamedPharmacy`), so a
 * second shop of that name appearing in the brick sends the item back to his tab on the next read with
 * nothing to re-queue. Only his own decisions are rows.
 */

import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { MatchPair } from "../pharmacy-matcher";

export type MatchDecisionInput =
  | { action: "confirm"; nameKey: string; brickId: string; typedExample: string; pairs: MatchPair[] }
  | { action: "reject"; nameKey: string; brickId: string; typedExample: string }
  | { action: "undo"; nameKey: string; brickId: string };

export class MatchDecisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type LiveRow = { id: string; status: string; method: string; pairs: unknown };

async function liveRow(nameKey: string, brickId: string): Promise<LiveRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("customer_360_pharmacy_matches")
    .select("id, status, method, pairs")
    .eq("name_key", nameKey)
    .eq("brick_id", brickId)
    .is("withdrawn_at", null)
    .maybeSingle();
  if (error) throw new Error(`customer-360: reading the live match failed — ${error.message}`);
  return (data as LiveRow | null) ?? null;
}

async function withdraw(id: string, actor: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("customer_360_pharmacy_matches")
    .update({ withdrawn_at: new Date().toISOString(), withdrawn_by_hr_id: actor })
    .eq("id", id)
    .is("withdrawn_at", null);
  if (error) throw new Error(`customer-360: withdrawing a match failed — ${error.message}`);
}

function pairsJson(pairs: readonly MatchPair[]) {
  return pairs.map((pair) => ({
    brick_id: pair.brickId,
    customer_code: pair.customerCode.trim(),
    customer_name: pair.customerName,
    distributor_code: pair.distributorCode.trim().toUpperCase(),
  }));
}

/** Every pair he confirms must be a live shop on the closing's own map — never a typed code. */
async function assertPairsOnMap(pairs: readonly MatchPair[]): Promise<MatchPair[]> {
  const db = getSupabaseAdmin();
  const out: MatchPair[] = [];
  for (const pair of pairs) {
    const distributorCode = pair.distributorCode.trim();
    const customerCode = pair.customerCode.trim();
    if (!distributorCode || !customerCode) throw new MatchDecisionError("A pharmacy in the confirmation has no distributor code.", 400);
    const { data, error } = await db
      .from("source_of_sales_customer_map")
      .select("id, distributor_code, customer_code, customer_name, brick_id")
      .ilike("distributor_code", distributorCode)
      .eq("customer_code", customerCode)
      .eq("active", true)
      .limit(1);
    if (error) throw new Error(`customer-360: checking the map failed — ${error.message}`);
    const row = (data ?? [])[0] as { distributor_code: string; customer_code: string; customer_name: string | null; brick_id: string | null } | undefined;
    if (!row) throw new MatchDecisionError("One of the pharmacies is no longer on the sales customer map. Reload the page.", 409);
    out.push({ brickId: row.brick_id, customerCode: row.customer_code, customerName: row.customer_name ?? pair.customerName, distributorCode: row.distributor_code.toUpperCase() });
  }
  return out;
}

/** His decision on one item. Returns the status now standing. */
export async function decidePharmacyMatch(input: MatchDecisionInput, actorHrId: string): Promise<{ status: string }> {
  const nameKey = input.nameKey.trim();
  const brickId = input.brickId.trim();
  if (!nameKey || !brickId) throw new MatchDecisionError("The pharmacy or its brick is missing. Reload the page.", 400);
  const current = await liveRow(nameKey, brickId);

  if (input.action === "undo") {
    if (!current || current.method !== "admin") throw new MatchDecisionError("There is no decision of yours on this pharmacy to undo. Reload the page.", 409);
    await withdraw(current.id, actorHrId);
    bumpCustomer360Cache("customer-360 pharmacy match undone");
    return { status: "undone" };
  }

  const pairs = input.action === "confirm" ? await assertPairsOnMap(input.pairs) : [];
  if (input.action === "confirm" && pairs.length === 0) throw new MatchDecisionError("Pick the pharmacy this name is.", 400);

  if (current) await withdraw(current.id, actorHrId);
  const { error } = await getSupabaseAdmin()
    .from("customer_360_pharmacy_matches")
    .insert({
      brick_id: brickId,
      decided_at: new Date().toISOString(),
      decided_by_hr_id: actorHrId,
      method: "admin",
      name_key: nameKey,
      pairs: pairsJson(pairs),
      status: input.action === "confirm" ? "confirmed" : "rejected",
      typed_example: input.typedExample.trim().slice(0, 200) || nameKey,
    });
  if (error) {
    if (error.code === "23505") throw new MatchDecisionError("Someone decided this pharmacy a moment ago. Reload the page.", 409);
    throw new Error(`customer-360: saving the match failed — ${error.message}`);
  }
  bumpCustomer360Cache("customer-360 pharmacy match decided");
  return { status: input.action === "confirm" ? "confirmed" : "rejected" };
}
