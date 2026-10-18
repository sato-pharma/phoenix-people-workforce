import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { identityNameKey, identityPairKey } from "@/lib/customer-identity/suggestions";
import type { EvidenceBand, IdentityKind, IdentitySource } from "@/lib/customer-identity/types";

/**
 * Phoenix CRM Wave 2 — recording the owner's decisions, and only his.
 *
 * 🔴 EVERY WRITE IN THIS FILE IS A HUMAN'S DECISION. Nothing here runs on a schedule, nothing acts
 * on a score, and nothing is inferred: the engine offers pairs and the Super Admin confirms them,
 * in bulk or one at a time (his ruling, 2026-09-30). A row appears in `customer_identity_links`
 * because he clicked, or it does not appear at all.
 *
 * 🔴 AND NOTHING IS WRITTEN BACK to `phoenix_crm_*`, `marketing_*`, `direct_order_*` or `crm_*`.
 * Confirming that two rows are one doctor does not merge them, rename either, move either's
 * territory or touch a rep's board — the treasure rule stands, and a link is an annotation.
 */

export type DecisionSide = { source: IdentitySource; sourceId: string };

export type LinkDecision = {
  kind: IdentityKind;
  band: EvidenceBand;
  displayName: string;
  left: DecisionSide;
  right: DecisionSide;
};

type LinkRow = { master_id: string; source: string; source_id: string };

async function writeEvent(
  actorHrId: string,
  event: string,
  masterId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  const admin = getSupabaseAdmin();
  // A failed audit row must never swallow the decision it describes, but it must be visible: the
  // insert is awaited and its error thrown, so a broken audit path stops the write rather than
  // leaving a confirmed link nobody can account for.
  const { error } = await admin
    .from("customer_identity_events")
    .insert({ actor_hr_id: actorHrId, detail, event, master_id: masterId });
  if (error) throw new Error(`customer-identity: writing the audit event failed — ${error.message}`);
}

/**
 * EVERY master the two sides already sit on — not the first one found.
 *
 * 🔴 RETURNING THE FIRST WAS A SILENT RE-CUT OF SOMEBODY'S IDENTITY. If the left row sat on master
 * A and the right on master B, the caller upserted both onto A — which REPOINTED the right row
 * away from B with no error, no event and no mention, leaving whatever else was on B holding a
 * master that no longer describes the same person. Two separate identities quietly became one and
 * a half. Confirming A↔B when both are already known is a MERGE, and a merge has to move B's
 * other members too or it is just a quiet deletion.
 */
async function mastersFor(sides: readonly DecisionSide[]): Promise<string[]> {
  const admin = getSupabaseAdmin();
  const masters: string[] = [];
  for (const side of sides) {
    const { data, error } = await admin
      .from("customer_identity_links")
      .select("master_id, source, source_id")
      .eq("source", side.source)
      .eq("source_id", side.sourceId)
      .maybeSingle();
    if (error) throw new Error(`customer-identity: reading the existing link failed — ${error.message}`);
    const row = data as LinkRow | null;
    const master = row?.master_id ? String(row.master_id) : null;
    if (master && !masters.includes(master)) masters.push(master);
  }
  return masters;
}

/**
 * Fold one master into another: every link moves, then the emptied master goes.
 *
 * 🔴 THE LINKS MOVE FIRST AND THE DELETE COMES SECOND, and the order is the whole safety of it.
 * `customer_identity_links.master_id` is `on delete cascade`, so deleting the loser while it still
 * held links would delete those links with it — the exact opposite of a merge, and it would look
 * like it worked.
 */
async function mergeMasters(keep: string, drop: string, actorHrId: string): Promise<number> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("customer_identity_links")
    .update({ master_id: keep })
    .eq("master_id", drop)
    .select("id");
  if (error) throw new Error(`customer-identity: moving the links failed — ${error.message}`);
  const moved = (data ?? []).length;

  const { error: dropError } = await admin.from("customer_identity_masters").delete().eq("id", drop);
  if (dropError) throw new Error(`customer-identity: removing the emptied master failed — ${dropError.message}`);

  await writeEvent(actorHrId, "masters_merged", keep, { droppedMasterId: drop, linksMoved: moved });
  return moved;
}

/**
 * Confirm one pair, or a whole selection of them.
 *
 * 🔴 BULK AND BY HAND ARE THE SAME PATH (owner, 2026-09-30: "bulk or by hand, full control"). One
 * decision and forty go through this function identically, so there is no bulk route that skips a
 * check the single route makes — the commonest way a "confirm all" button ends up writing
 * something the careful path would have refused.
 *
 * Each pair joins whichever master either side is already on, so confirming A↔B and then B↔C puts
 * all three on ONE master rather than building two that disagree. The `unique (source, source_id)`
 * constraint is what guarantees that: a row can only ever be on one master, so there is no state
 * in which the question "who is this?" has two answers.
 *
 * 🔴 AND WHERE THE TWO SIDES ARE ALREADY ON DIFFERENT MASTERS, THE MASTERS MERGE. He has just said
 * those two rows are one person, which means the two identities were one identity all along;
 * everything on the second moves to the first and the emptied one goes, under a `masters_merged`
 * event naming both. The first cut repointed only the row in front of him and left the rest of
 * the second master behind — a merge that half happened, with nothing to show it had.
 */
export async function confirmLinks(
  decisions: readonly LinkDecision[],
  actorHrId: string,
): Promise<{ confirmed: number; masters: number; merged: number }> {
  const admin = getSupabaseAdmin();
  const mastersTouched = new Set<string>();
  let confirmed = 0;
  let merged = 0;

  for (const decision of decisions) {
    const sides = [decision.left, decision.right];
    const existing = await mastersFor(sides);
    // The OLDEST master wins by id order, so the same selection confirmed twice in either order
    // settles on the same one rather than ping-ponging two identities between each other.
    const [keep, ...rest] = [...existing].sort();
    let masterId = keep ?? null;
    for (const drop of rest) {
      await mergeMasters(keep as string, drop, actorHrId);
      merged += 1;
    }

    if (!masterId) {
      const { data, error } = await admin
        .from("customer_identity_masters")
        .insert({
          created_by_hr_id: actorHrId,
          display_name: decision.displayName,
          kind: decision.kind,
          name_key: identityNameKey(decision.displayName),
          updated_by_hr_id: actorHrId,
        })
        .select("id")
        .single();
      if (error) throw new Error(`customer-identity: creating the master failed — ${error.message}`);
      masterId = String((data as { id: string }).id);
      await writeEvent(actorHrId, "master_created", masterId, { displayName: decision.displayName, kind: decision.kind });
    }

    for (const side of sides) {
      // `upsert` on the one-per-source-row constraint: re-confirming a pair he has already
      // confirmed re-points nothing and errors on nothing, which is what makes a bulk confirm safe
      // to press twice.
      const { error } = await admin.from("customer_identity_links").upsert(
        {
          band: decision.band,
          confirmed_by_hr_id: actorHrId,
          kind: decision.kind,
          master_id: masterId,
          source: side.source,
          source_id: side.sourceId,
        },
        { onConflict: "source,source_id" },
      );
      if (error) throw new Error(`customer-identity: linking ${side.source}:${side.sourceId} failed — ${error.message}`);
    }

    mastersTouched.add(masterId);
    confirmed += 1;
    await writeEvent(actorHrId, "pair_confirmed", masterId, {
      band: decision.band,
      pairKey: identityPairKey(decision.left, decision.right),
    });
  }

  bumpCustomer360Cache("identity links confirmed");
  return { confirmed, masters: mastersTouched.size, merged };
}

/**
 * "These two are NOT the same person."
 *
 * Kept for good, so the pair is never offered again — and withdrawable, because the owner asked
 * for that explicitly. The row is never deleted: a withdrawal stamps `withdrawn_at` and who did
 * it, so the decision survives its own reversal and the history reads honestly either way.
 */
export async function ruleNotTheSame(
  pairs: readonly { kind: IdentityKind; left: DecisionSide; right: DecisionSide }[],
  actorHrId: string,
  reason: string | null,
): Promise<{ ruled: number }> {
  const admin = getSupabaseAdmin();
  let ruled = 0;

  for (const pair of pairs) {
    const pairKey = identityPairKey(pair.left, pair.right);
    const { error } = await admin.from("customer_identity_rulings").insert({
      kind: pair.kind,
      left_source: pair.left.source,
      left_source_id: pair.left.sourceId,
      pair_key: pairKey,
      reason,
      right_source: pair.right.source,
      right_source_id: pair.right.sourceId,
      ruled_by_hr_id: actorHrId,
    });
    // A live ruling on this pair already exists — the partial unique index refused the duplicate.
    // That is the right answer, not an error worth surfacing: he has already said this.
    //
    // 🔴 MATCHED ON THE SQLSTATE, NEVER ON THE INDEX NAME. The first cut looked for
    // "customer_identity_rulings_live_pair_idx" inside the message, so renaming that index in any
    // later migration would have turned "he has already said this" into a 500 on a button he
    // presses every day — and nothing in the rename would have hinted at it.
    const duplicate = (error as { code?: string } | null)?.code === "23505";
    if (error && !duplicate) {
      throw new Error(`customer-identity: recording the ruling failed — ${error.message}`);
    }
    if (!error) {
      ruled += 1;
      await writeEvent(actorHrId, "pair_ruled_not_the_same", null, { pairKey, reason });
    }
  }

  bumpCustomer360Cache("identity pair ruled not the same");
  return { ruled };
}

/**
 * Undo a "not the same" ruling.
 *
 * The pair comes back as a suggestion the moment this lands, because the engine reads the LIVE
 * rulings and a withdrawn one is simply absent from that set — there is no cache to clear and no
 * second place the decision is remembered.
 */
export async function withdrawRuling(pairKey: string, actorHrId: string): Promise<{ withdrawn: number }> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("customer_identity_rulings")
    .update({ withdrawn_at: new Date().toISOString(), withdrawn_by_hr_id: actorHrId })
    .eq("pair_key", pairKey)
    .is("withdrawn_at", null)
    .select("id");
  if (error) throw new Error(`customer-identity: withdrawing the ruling failed — ${error.message}`);
  const withdrawn = (data ?? []).length;
  if (withdrawn > 0) await writeEvent(actorHrId, "ruling_withdrawn", null, { pairKey });
  bumpCustomer360Cache("identity ruling withdrawn");
  return { withdrawn };
}
