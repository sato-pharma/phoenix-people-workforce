import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { matchAddedPharmacy, type ListedPharmacy } from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";

/**
 * Phoenix CRM — Add a pharmacy, when the rep ALSO captures a pin or phone on a match that was
 * already on his list.
 *
 * Production, 2026-10-15: Mostafa Galal (SEAT-PED-REP-GZ1) added a pin to nine pharmacies already
 * on his list, each typed without the "صيدلية" word the list's own row carries — and got nine new
 * `pending` rows instead of nine pins filed on the pharmacies he meant. The TypeScript match
 * (`matchAddedPharmacy`) was never wrong: it already reads "طاهر رمضان" and "صيدلية طاهر رمضان" as
 * the same pharmacy. The bug was that `addPharmacy()` only trusted that answer when the rep
 * captured NOTHING extra — the moment he also sent a pin, it fell through to
 * `phoenix_crm_add_pharmacy`, whose own existing-row lookup compared names with
 * `lower(btrim(...))` alone and never found the match, so it inserted a second row.
 *
 * This pins the fix: `addPharmacy()` now sends the match's OWN resolved id
 * (`existing_customer_id`) whenever TypeScript already found one, and the database function
 * tries that id FIRST, before its own name search — so the two layers can never disagree about
 * whether a pharmacy is already on his list.
 */

const source = (path: string) => stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
const raw = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const MIGRATION = "supabase/migrations/20261015234627_phoenix_crm_add_pharmacy_matches_by_resolved_id.sql";

export function runPhoenixCrmAddPharmacyMatchesByResolvedIdTests() {
  // ── 1. The real pair that broke in production: TypeScript already matches it ─────────────────
  {
    const listed: ListedPharmacy[] = [{ customerId: "4b118112-08d1-4d6b-9b86-8a5c9fcb748e", name: "صيدلية طاهر رمضان", status: "pending" }];
    const match = matchAddedPharmacy("طاهر رمضان", listed);
    assert.deepEqual(
      match,
      { kind: "existing", customerId: "4b118112-08d1-4d6b-9b86-8a5c9fcb748e", name: "صيدلية طاهر رمضان" },
      "the rep's shorter spelling, with no 'صيدلية', is the SAME pharmacy by key — this was never the broken half",
    );

    // Every name Mostafa Galal actually typed on 2026-10-15, each against the list row the bulk
    // import gave it — the "صيدلية" prefix is the only difference, and the key folds it away.
    const pairs: Array<[string, string]> = [
      ["صيدلية طاهر رمضان", "طاهر رمضان"],
      ["صيدلية منى", "منى"],
      ["صيدلية مصطفى عبدالرحمن", "مصطفى عبدالرحمن"],
      ["صيدلية محمود سعيد", "محمود سعيد"],
      ["صيدلية أيمن", "أيمن"],
      ["صيدلية محمد", "محمد"],
      ["صيدلية اميرة عبدالمنعم", "اميرة عبدالمنعم"],
    ];
    for (const [listedName, typed] of pairs) {
      const result = matchAddedPharmacy(typed, [{ customerId: "the-existing-row", name: listedName, status: "pending" }]);
      assert.deepEqual(
        result,
        { kind: "existing", customerId: "the-existing-row", name: listedName },
        `"${typed}" must resolve to the already-listed "${listedName}", not "new"`,
      );
    }
  }

  // ── 2. The server: the resolved id travels to the database, and only on an existing match ────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    const addPharmacy = list.slice(list.indexOf("export async function addPharmacy("), list.indexOf("export async function setPharmacyDetails("));
    assert.ok(
      addPharmacy.includes('...(match.kind === "existing" ? { existing_customer_id: match.customerId } : {}),'),
      "the id TypeScript already resolved is sent to the database, and only when the match is existing — never on a genuinely new pharmacy",
    );
    // The early return for a plain existing match (nothing captured) is untouched: this fix adds a
    // second line of defense for the path that falls through, it does not remove the first one.
    assert.ok(
      addPharmacy.includes('if (match.kind === "existing" && phone.value === null && pin.value === null) {'),
      "an existing match with nothing extra captured still returns before ever reaching the database",
    );
  }

  // ── 3. The migration: the database trusts a resolved id before re-deriving one by name ───────
  {
    const sql = raw(MIGRATION);
    const body = sql.slice(sql.indexOf("begin;"));

    assert.ok(body.includes("create or replace function public.phoenix_crm_add_pharmacy(p jsonb)"), "the same signature — no caller has to change");

    // The new input: a resolved id, cast to uuid, and a bad or absent one is never an error — it
    // just means "fall back to the name search", exactly as a caller that never sends it gets.
    assert.ok(
      body.includes("v_resolved_id := nullif(trim(coalesce(p ->> 'existing_customer_id', '')), '')::uuid;"),
      "the resolved id is read from the new optional key",
    );
    assert.ok(body.includes("exception when invalid_text_representation then"), "a malformed id never raises — it just falls through to the name search");

    // The resolved id is tried FIRST, re-checked against this seat, this world, this list type and
    // not-dropped — never trusted blindly — and only the fallback uses the weaker name compare.
    const resolvedLookup = body.slice(body.indexOf("if v_resolved_id is not null then"), body.indexOf("if v_existing.id is null then"));
    assert.ok(resolvedLookup.includes("c.id = v_resolved_id"), "the resolved id is looked up by its own primary key, never re-derived");
    for (const guard of ["c.seat_id = v_seat", "c.is_test = v_is_test", "c.list_type = 'Pharmacy'", "c.status in ('active', 'pending', 'outside')"]) {
      assert.ok(resolvedLookup.includes(guard), `the resolved id is still checked against ${guard} — a stale or cross-seat id is never trusted blindly`);
    }

    const fallbackLookup = body.slice(body.indexOf("if v_existing.id is null then"), body.indexOf("if v_existing.id is not null then"));
    assert.ok(
      fallbackLookup.includes("lower(btrim(regexp_replace(c.name, '\\s+', ' ', 'g'))) = lower(v_name)"),
      "the ORIGINAL name search still runs when no resolved id was sent, or it did not check out — behaviour for an older caller is unchanged",
    );

    // Everything the fill-only-empty update and the insert already did is untouched by this fix.
    assert.ok(
      body.includes("case when v_phone is not null and c.phone is null then v_phone else c.phone end"),
      "a phone already on the pharmacy still survives an add — untouched by this change",
    );
    assert.ok(body.includes("insert into public.phoenix_crm_customers ("), "the insert-when-genuinely-new branch is unchanged");

    // Still revoked from every browser role, still granted to the service role alone.
    assert.ok(
      body.includes("revoke execute on function public.phoenix_crm_add_pharmacy(jsonb) from public, anon, authenticated;"),
      "the function stays unreachable from a browser",
    );
    assert.ok(body.includes("grant execute on function public.phoenix_crm_add_pharmacy(jsonb) to service_role;"), "and callable by the service role alone");
  }
}
