import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { parseVisitDraft } from "../src/lib/phoenix-crm/entry-rules.ts";
import { buildOrgIndex, resolveVisitParticipants, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { VISIT_ASK_KIND_LABELS } from "../src/lib/phoenix-crm/visit-ask-rules.ts";

/**
 * Phoenix CRM — a PRODUCT MANAGER on a visit (owner's pick, 2026-10-02).
 *
 * He already lets a rep ASK for a visit with one of HIS line's product managers; this is the recording
 * half, in the same four words the ask uses (`VisitAskKind`).
 *
 * 🔴 WHAT THIS EXISTS TO STOP IS HIM BEING FILED AS A DOUBLE VISIT. A product manager holds NO SEAT in
 * the organogram at all, so he is in no territory's manager chain and nothing in the database can check
 * him; and `double_visits` is counted as `kind = 'double'` on every board, a number district managers
 * are judged on. The obvious-looking implementation — put him in `manager_hr_id` — would add a product
 * manager's call to those figures silently. So he has his own kind and his own column, and both the
 * resolver and the table's own CHECK refuse him anywhere else.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/**
 * The migration that defines a function LAST — the body the database actually runs.
 *
 * Asked of the directory rather than written down, so a later migration that patches the body cannot
 * leave a pin below reading SQL the database has stopped running.
 */
function lastDefinerOf(name: string): string {
  const files = readdirSync(new URL("supabase/migrations/", ROOT))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) =>
      stripSqlComments(readFileSync(new URL(`supabase/migrations/${file}`, ROOT), "utf8")).includes(
        `create or replace function public.${name}(`,
      ),
    );
  assert.ok(files.length > 0, `${name} is defined by some migration`);
  return files[files.length - 1];
}

// ── The organogram the resolver is tried against ────────────────────────────────────────────────

const CEO: OrgSeat = {
  seatId: "SEAT-ROOT-CEO",
  parentSeatId: null,
  tier: "CEO",
  path: ["SEAT-ROOT-CEO"],
  occupantHrId: "C-1",
  lineCode: null,
  lineName: null,
  areaName: null,
  regionName: null,
  seatLabel: "CEO",
};
/** A rep's manager chain stops below the CEO, so a chain visit needs a seat between. */
const NSM: OrgSeat = {
  ...CEO,
  seatId: "SEAT-CNS-NSM",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "NSM",
  path: ["SEAT-ROOT-CEO", "SEAT-CNS-NSM"],
  occupantHrId: "A-12",
  lineCode: "cns",
  lineName: "CNS",
  seatLabel: "CNS NSM",
};
const DM: OrgSeat = {
  ...CEO,
  seatId: "SEAT-CNS-DM-D1",
  parentSeatId: "SEAT-CNS-NSM",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-CNS-NSM", "SEAT-CNS-DM-D1"],
  occupantHrId: "B-12",
  lineCode: "cns",
  lineName: "CNS",
  seatLabel: "CNS Delta (1) DM",
};
const REP: OrgSeat = {
  ...DM,
  seatId: "SEAT-CNS-REP-D13",
  parentSeatId: "SEAT-CNS-DM-D1",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-CNS-NSM", "SEAT-CNS-DM-D1", "SEAT-CNS-REP-D13"],
  occupantHrId: "B-7",
  areaName: "Menoufia 2",
  seatLabel: "CNS D13 rep",
};

const org = buildOrgIndex([CEO, NSM, DM, REP]);

/** The line's product managers, as the server reads them (`loadLineProductManagers`). */
const LINE_PMS = [{ hrId: "PM-1" }, { hrId: "PM-2" }];

const onRep = { index: org, territorySeatId: REP.seatId, managerHrId: null, seniorHrId: null } as const;

function valueOf(result: ReturnType<typeof resolveVisitParticipants>) {
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return result.ok ? result.value : null;
}

function refusalOf(result: ReturnType<typeof resolveVisitParticipants>): string {
  assert.equal(result.ok, false, "this was expected to be refused");
  return result.ok ? "" : result.error;
}

const CHOOSE_PM = "Choose the product manager who was on the visit from your line's product managers.";

export function runPhoenixCrmVisitProductManagerTests(): void {
  // ── 1. The rep names one of HIS LINE's product managers ──────────────────────────────────────
  {
    const saved = valueOf(
      resolveVisitParticipants({
        ...onRep,
        actorHrId: "B-7",
        enteredAs: "rep",
        kind: "product_manager",
        productManagerHrId: "pm-1",
        productManagers: LINE_PMS,
      }),
    );
    assert.deepEqual(saved, { repHrId: "B-7", managerHrId: null, seniorHrId: null, productManagerHrId: "PM-1" },
      "the rep and the product manager, and NOTHING in the manager slot — that slot is the district manager");

    // Somebody not on the line's list is refused. 🔴 This is the whole check: he holds no seat, so the
    // organogram cannot answer for him and an unchecked id would be any hr id at all.
    assert.equal(
      refusalOf(resolveVisitParticipants({ ...onRep, actorHrId: "B-7", enteredAs: "rep", kind: "product_manager", productManagerHrId: "B-12", productManagers: LINE_PMS })),
      CHOOSE_PM,
      "the territory's own district manager is not a product manager of the line",
    );
    // An EMPTY list refuses the kind outright rather than letting the pick through.
    assert.equal(
      refusalOf(resolveVisitParticipants({ ...onRep, actorHrId: "B-7", enteredAs: "rep", kind: "product_manager", productManagerHrId: "PM-1", productManagers: [] })),
      CHOOSE_PM,
      "a line with no product manager cannot have a visit with one",
    );
    // And the list not being passed at all is the same refusal, never a pass.
    assert.equal(
      refusalOf(resolveVisitParticipants({ ...onRep, actorHrId: "B-7", enteredAs: "rep", kind: "product_manager", productManagerHrId: "PM-1" })),
      CHOOSE_PM,
      "a caller that forgets the list gets a refusal, not a free pass",
    );
    assert.equal(
      refusalOf(resolveVisitParticipants({ ...onRep, actorHrId: "B-7", enteredAs: "rep", kind: "product_manager", productManagers: LINE_PMS })),
      CHOOSE_PM,
      "nobody picked",
    );
    // Nobody is his own product manager, whatever roles one person happens to hold.
    assert.equal(
      refusalOf(resolveVisitParticipants({ ...onRep, actorHrId: "B-7", enteredAs: "rep", kind: "product_manager", productManagerHrId: "B-7", productManagers: [{ hrId: "B-7" }] })),
      CHOOSE_PM,
    );
  }

  // ── 2. It is the REP's visit, and no other kind carries a passenger ───────────────────────────
  {
    assert.equal(
      refusalOf(resolveVisitParticipants({ ...onRep, actorHrId: "B-12", enteredAs: "manager", kind: "product_manager", productManagerHrId: "PM-1", productManagers: LINE_PMS })),
      "A visit with a product manager is entered by the territory's rep.",
      "a manager entering it would record a visit nobody present entered",
    );

    // Every other kind answers null, so a stale pick on the form can never ride along.
    for (const kind of ["single", "double", "chain"] as const) {
      const result = resolveVisitParticipants({
        ...onRep,
        actorHrId: "B-7",
        enteredAs: "rep",
        kind,
        managerHrId: kind === "single" ? null : "B-12",
        seniorHrId: kind === "chain" ? "A-12" : null,
        productManagerHrId: "PM-1",
        productManagers: LINE_PMS,
      });
      assert.equal(valueOf(result)?.productManagerHrId, null, `a ${kind} visit never carries a product manager`);
    }
  }

  // ── 3. The draft parser: required for its kind, cleared for every other ──────────────────────
  {
    const base = {
      customerId: "11111111-1111-4111-8111-111111111111",
      products: ["Saginko"],
      comment: "Discussed the new pack",
      visitType: "planned",
      // The location fix every visit carries; it is not what this block is about.
      lat: 30.05,
      lon: 31.23,
      accuracyMeters: 12,
      deviceCapturedAt: "2026-10-02T09:00:00.000Z",
    };
    const parsed = parseVisitDraft({ ...base, kind: "product_manager", productManagerHrId: "PM-1" });
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
    if (parsed.ok) {
      assert.equal(parsed.value.productManagerHrId, "PM-1");
      assert.equal(parsed.value.managerHrId, null, "the manager slot is cleared by the kind, not merely left unset");
    }

    const missing = parseVisitDraft({ ...base, kind: "product_manager" });
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? "" : missing.error, "Choose the product manager who was on the visit.");

    // A caller that sends both gets the one its kind allows.
    const double = parseVisitDraft({ ...base, kind: "double", managerHrId: "B-12", productManagerHrId: "PM-1" });
    assert.equal(double.ok, true, double.ok ? "" : double.error);
    if (double.ok) {
      assert.equal(double.value.productManagerHrId, null, "a double visit drops a product manager the caller sent");
      assert.equal(double.value.managerHrId, "B-12");
    }

    // An unknown kind is still refused, so the union cannot be widened from the outside.
    const bad = parseVisitDraft({ ...base, kind: "pm_visit", productManagerHrId: "PM-1" });
    assert.equal(bad.ok, false);
    assert.equal(bad.ok ? "" : bad.error, "Choose who was on the visit.");
  }

  // ── 4. One wording with the ask it answers ────────────────────────────────────────────────────
  {
    assert.equal(VISIT_ASK_KIND_LABELS.product_manager, "Visit with a product manager");
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.match(
      visits,
      /product_manager: VISIT_ASK_KIND_LABELS\.product_manager,/,
      "the visit's label IS the ask's, so the request a rep sent and the visit it became read alike",
    );
    // His title is his APP ROLE: the sales-only organogram has no seat for him to take one from.
    assert.match(visits, /productManagerTitle: appRole\(row\.product_manager_hr_id\),/);
    assert.match(visits, /async function productManagerRolesFor\(/);
  }

  // ── 5. The database refuses him in any other slot ─────────────────────────────────────────────
  {
    const migration = readFileSync(new URL("supabase/migrations/20261002205436_phoenix_crm_visit_product_manager.sql", ROOT), "utf8");
    assert.match(migration, /add column if not exists product_manager_hr_id text;/);
    assert.match(migration, /check \(kind in \('single', 'double', 'product_manager', 'chain'\)\)/);
    // The column exists only for its own kind — the half that stops a quiet passenger on a double.
    assert.match(migration, /and \(kind = 'product_manager'\) = \(product_manager_hr_id is not null\)/);
    assert.match(migration, /product_manager_hr_id is null or product_manager_hr_id <> coalesce\(rep_hr_id, ''\)/);

    // And the writer stores it — read from the migration that defines `phoenix_crm_save_visit` LAST,
    // found by SORT ORDER rather than written here. 🔴 Asserting it against the file above would be
    // reading DEAD SQL the moment another migration patches the body again, which 20261002222403
    // already has: the text would still be in that file and the database would have stopped running
    // it. Every later replacer patches the body in place, so these two lines survive each one.
    const writer = readFileSync(new URL(`supabase/migrations/${lastDefinerOf("phoenix_crm_save_visit")}`, ROOT), "utf8");
    assert.match(writer, /v_product_manager text := upper\(nullif\(trim\(coalesce\(p ->> 'product_manager_hr_id', ''\)\), ''\)\);/);
    assert.match(writer, /v_senior, v_product_manager, v_actor, v_products,/);
    assert.match(writer, /\(v_kind = 'product_manager' and v_rep is not null and v_manager is null and v_senior is null and v_product_manager is not null\)/);

    // 🔴 `double_visits` must still count ONE kind. If this ever becomes `kind <> 'single'`, a product
    // manager's call lands in the district managers' double-visit figures.
    for (const file of ["supabase/migrations/20260926163000_phoenix_crm_unplanned_visits.sql"]) {
      const sql = readFileSync(new URL(file, ROOT), "utf8");
      assert.ok(sql.includes("filter (where v.kind = 'double')"), `${file} counts double visits as exactly that kind`);
      assert.ok(!/filter \(where v\.kind <> 'single'\)/.test(sql), `${file} must never count every non-single kind as a double visit`);
    }
  }

  console.log("phoenix-crm visit product manager: OK");
}
