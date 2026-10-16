import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  canValidateReference,
  territoryForValidation,
  type PhoenixCrmViewer,
} from "../src/lib/phoenix-crm/server/access.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Phoenix CRM — a DISTRICT MANAGER validates a carried-over customer (owner's pick, 2026-10-02).
 *
 * The rep stays primary; this adds his managers beside him, and it covers the case nothing else does:
 * a VACANT territory has a reference list nobody can work through. The size of the job is why it was
 * asked for — measured on production on 2026-10-02, 0 of Delta (1)'s 1,551 carried-over customers were
 * validated the day before the team started, and every visit to one counts in nothing until it is.
 *
 * 🔴 TWO THINGS MUST NOT HAPPEN, and both are the obvious-looking implementation:
 *   1. widening `territoryForRepWrite`, which also guards the plan, the day activities, the forecast
 *      and every list change — the drop, the grade, the add, the hours — all of which are the rep's;
 *   2. letting a manager validate in the `new` or `outside` mode. Those FILE A REQUEST whose first step
 *      is the territory's reviewer, and that is him: he would be proposing and approving in one act.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

// ── The organogram ──────────────────────────────────────────────────────────────────────────────

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
const DM: OrgSeat = {
  ...CEO,
  seatId: "SEAT-AIF-DM-D1",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-DM-D1"],
  occupantHrId: "B-12",
  lineCode: "anti_infective",
  lineName: "Anti Infective",
  seatLabel: "AIF Delta (1) DM",
};
const REP: OrgSeat = {
  ...DM,
  seatId: "SEAT-AIF-REP-D13",
  parentSeatId: "SEAT-AIF-DM-D1",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-DM-D1", "SEAT-AIF-REP-D13"],
  occupantHrId: "B-7",
  areaName: "Menoufia 2",
  seatLabel: "AIF D13 rep",
};
/** A seat with no rep at all — the case the rep-only gate leaves nobody for. */
const VACANT: OrgSeat = { ...REP, seatId: "SEAT-AIF-REP-D14", path: ["SEAT-ROOT-CEO", "SEAT-AIF-DM-D1", "SEAT-AIF-REP-D14"], occupantHrId: null };
/** Another district's rep: a peer's territory, which scope must never reach sideways. */
const OTHER_DM: OrgSeat = { ...DM, seatId: "SEAT-AIF-DM-D2", occupantHrId: "B-20", seatLabel: "AIF Delta (2) DM" };
const OTHER_REP: OrgSeat = {
  ...REP,
  seatId: "SEAT-AIF-REP-D21",
  parentSeatId: "SEAT-AIF-DM-D2",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-DM-D2", "SEAT-AIF-REP-D21"],
  occupantHrId: "B-21",
};

const org = buildOrgIndex([CEO, DM, REP, VACANT, OTHER_DM, OTHER_REP]);

function viewer(patch: Partial<PhoenixCrmViewer> = {}): PhoenixCrmViewer {
  return {
    hrId: "B-12",
    role: "District Manager",
    isSuperAdmin: false,
    isSfeManager: false,
    isTestPersona: false,
    basis: "tree",
    canCreate: true,
    canApprove: true,
    canUpdate: true,
    org,
    config: { lineRollout: [] },
    cairoToday: "2026-10-02",
    visitDay: "2026-10-02",
    openLines: new Set(["anti_infective"]),
    ownTerritories: [],
    waitingTerritories: [],
    scopeTerritories: [REP, VACANT],
    waitingScopeTerritories: [],
    managerSeats: [DM],
    ...patch,
  } as unknown as PhoenixCrmViewer;
}

/** The territory's own rep. */
const repViewer = viewer({ hrId: "B-7", role: "Medical Rep", basis: "tree", canApprove: false, ownTerritories: [REP], scopeTerritories: [REP], managerSeats: [] });
/** Another district's manager, who can see nothing here. */
const peerViewer = viewer({ hrId: "B-20", scopeTerritories: [OTHER_REP], managerSeats: [OTHER_DM] });

function refused(run: () => unknown, pattern: RegExp, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof Error && pattern.test(error.message), message);
}

export function runPhoenixCrmManagerValidatesTests(): void {
  // ── 1. The rep, and now his manager — including on a VACANT seat ──────────────────────────────
  {
    assert.equal(territoryForValidation(repViewer, REP.seatId, false).validatedAs, "rep");
    assert.equal(territoryForValidation(viewer(), REP.seatId, false).validatedAs, "manager", "his district manager validates beside him");
    assert.equal(
      territoryForValidation(viewer(), VACANT.seatId, false).validatedAs,
      "manager",
      "a seat with no rep: the manager is the only person who can work through its reference list",
    );

    // Scope runs downward ONLY: a peer's territory is refused, not merely hidden.
    refused(() => territoryForValidation(peerViewer, REP.seatId, false), /rep or one of its managers/, "another district's manager is refused");
    // And a role that cannot create anything is refused before scope is even consulted.
    refused(
      () => territoryForValidation(viewer({ canCreate: false }), REP.seatId, false),
      /cannot validate a customer/,
      "a read-only role never validates",
    );
  }

  // ── 2. The screen flag says the same thing, and is NARROWER than canEdit ─────────────────────
  {
    assert.equal(canValidateReference(repViewer, REP, false), true, "the rep");
    assert.equal(canValidateReference(viewer(), REP, false), true, "and his manager");
    assert.equal(canValidateReference(viewer(), VACANT, false), true);
    assert.equal(canValidateReference(peerViewer, REP, false), false);
    assert.equal(canValidateReference(viewer({ canCreate: false }), REP, false), false);

    // 🔴 The flag must not be `canEdit` by another name. The list server sets both, apart, and the
    // customer screen offers the manager the Validate button and nothing else.
    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(list, /canEdit: canWriteAsRep\(viewer, seat, isTest\),/, "the rest of the list screen stays the rep's");
    assert.match(list, /canValidateReference: canValidateReference\(viewer, seat, isTest\),/);

    const screen = source("src/components/phoenix-crm/list-customer.tsx");
    assert.match(
      screen,
      // `!checking` (2026-10-03): while the Google check holds a place he already captured there is
      // nothing to validate — the narrow flag is still the only permission it reads.
      /const canValidateThis = pending && !checking && customer\.referenceContactCrmId !== null && view\.canValidateReference;/,
      "the Validate button reads the narrow flag",
    );
    for (const repOnly of ["Propose a grade", "Change the details", "Add another clinic"]) {
      const index = screen.indexOf(repOnly);
      assert.ok(index > 0, `${repOnly} was not found — the assertion below would prove nothing`);
      // Each of the rep's own buttons is gated on canEdit in its OWN condition, not by the block above.
      assert.ok(
        screen.slice(Math.max(0, index - 420), index).includes("view.canEdit"),
        `${repOnly} must stay the rep's: a manager validates and does nothing else here`,
      );
    }
  }

  // ── 3. A manager validates a customer ALREADY ON THE LIST, and no other mode ──────────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    // `listed` joined `reference` on the owner's answer of 2026-10-03, asked directly: a customer the
    // SFE loaded from a sheet is already on the list and already graded, so validating him is the same
    // act as validating a carried-over one — and without it a VACANT seat's loaded list could be worked
    // through by nobody. `new` and `outside` are still the rep's, for the reason they always were.
    assert.match(
      list,
      /if \(validatedAs === "manager" && mode !== "reference" && mode !== "listed"\) \{/,
      'the add and out-of-list modes file a request the manager himself decides — they stay the rep\'s',
    );
    // The gate is the new one, not the rep-write one widened.
    assert.match(list, /const \{ seat, isTest, validatedAs \} = territoryForValidation\(viewer, body\.seatId, readTestFlag\(body\.test\)\);/);
    // And every OTHER write on the list is still the rep's alone.
    const repWrites = list.match(/territoryForRepWrite\(/g) ?? [];
    assert.ok(repWrites.length >= 7, `only ${repWrites.length} list writes are still rep-only — the gate was widened too far`);

    const access = source("src/lib/phoenix-crm/server/access.ts");
    assert.match(access, /throw forbiddenError\("Only the territory's rep changes its list and plan\."\);/,
      "territoryForRepWrite is untouched, so the plan, the day activities and the forecast stay the rep's");
  }

  // ── 4. The camera: the FIRST step of validating must open for him too ────────────────────────
  {
    const photos = source("src/lib/phoenix-crm/server/photos.ts");
    assert.match(
      photos,
      /purpose === "place" \? territoryForValidation\(viewer, body\.seatId, test\)/,
      "the place photo slot matches validateCustomer's own gate — with the narrower one the manager gets a button whose camera is refused",
    );
    assert.doesNotMatch(photos, /territoryForRepWrite/, "and the old gate is gone from this file, not merely unused");

    // The shutter's wait (Phoenix CRM performance audit, 2026-10-16). Both doors share that one gate, and
    // the slot row and its signed URL are asked for together — settled, never raced, so the ROW's error
    // is read first and a URL for a path with no slot behind it is never handed out.
    assert.match(photos, /return issuePhotoSlot\(photoSlotInput\(viewer, raw\)\);/, "the browser's slot door asks the shared gate");
    assert.match(photos, /const input = photoSlotInput\(viewer, body\);/, "and so does the native app's upload");
    const issue = photos.slice(photos.indexOf("export async function issuePhotoSlot("), photos.indexOf("function photoSlotInput("));
    assert.match(issue, /await Promise\.allSettled\(\[\s*insertSlotRow\(input, path, issuedAt\),\s*getSupabaseAdmin\(\)\.storage\.from\(PHOENIX_CRM_PHOTO_BUCKET\)\.createSignedUploadUrl\(path\),/);
    assert.ok(
      issue.indexOf("throwIfError(slot.value.error);") < issue.indexOf("const { data, error } = signing.value;"),
      "a failed slot row answers before the signed URL is even looked at",
    );
    // The native app's upload writes the object with the service client — no URL signed for itself —
    // and only AFTER its slot row is in, so no object ever sits in the bucket without a slot.
    const direct = photos.slice(photos.indexOf("export async function uploadPhotoDirect("), photos.indexOf("export function photoPathTerritory("));
    assert.doesNotMatch(direct, /createSignedUploadUrl|fetch\(/, "the native upload signs nothing and PUTs to nothing");
    const rowAt = direct.indexOf("throwIfError(slotError);");
    const uploadAt = direct.indexOf(".upload(path, bytes, {");
    assert.ok(rowAt > 0 && uploadAt > rowAt, "the slot row is written before the bytes");
    assert.match(direct, /upsert: false,/, "and an object at the path is never overwritten");
  }

  console.log("phoenix-crm a manager validates: OK");
}
