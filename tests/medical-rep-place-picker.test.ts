import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { validateMedicalRepSimpleExpenseInput } from "@/lib/outstation/medical-rep-expenses";

/**
 * The medical rep manual expense path had a free-text destination box.
 *
 * The only submission ever made through it — request 169, 21/09/2026, 420 EGP — stored
 * `"Baniseaf"` as the trip's destination: a misspelling of Beni Suef that no report can group,
 * match or map. The rep types it because that flow has no place picker; it has no GPS step
 * either, by design, because a rep files a ticket amount and an attachment rather than driving.
 *
 * Reusing `PlacesAutocompleteInput` was not a component swap: it read
 * `/api/admin/outstation/places-autocomplete`, which asserts outstation ADMIN access. A rep would
 * have got 403 and an empty dropdown with nothing to explain it. Hence a second route, gated on
 * the permission the rep already holds to file the expense at all.
 */

function baseInput() {
  return {
    attachments: [
      { bytes: Buffer.from("x"), contentType: "image/png", fileName: "t.png", size: 1 },
      { bytes: Buffer.from("y"), contentType: "image/png", fileName: "u.png", size: 1 },
    ],
    goTicketAmount: 210,
    notes: "Conference travel",
    returnTicketAmount: 210,
    toLocation: "Beni Suef",
    tripEndDate: "2026-09-21",
    tripStartDate: "2026-09-21",
  };
}

export function runMedicalRepPlacePickerTests() {
  // --- the place id is carried, and normalised to null rather than "" -----------------------

  assert.equal(
    validateMedicalRepSimpleExpenseInput({ ...baseInput(), toPlaceId: "ChIJabc123" }).toPlaceId,
    "ChIJabc123",
  );
  assert.equal(
    validateMedicalRepSimpleExpenseInput({ ...baseInput(), toPlaceId: "" }).toPlaceId,
    null,
    "an empty place id must normalise to null, or the column reads as chosen-but-blank",
  );
  assert.equal(
    validateMedicalRepSimpleExpenseInput({ ...baseInput(), toPlaceId: "   " }).toPlaceId,
    null,
  );
  assert.equal(validateMedicalRepSimpleExpenseInput(baseInput()).toPlaceId, null);

  // --- 🔴 a missing place id must NEVER refuse the claim -------------------------------------

  // This path refuses nothing — it files a ticket amount and sends the row to a human. Requiring
  // a place id would reject a real expense because a Google lookup was slow or the key was down,
  // which is the same shape as the Maps outage that silently blanked residences in August.
  assert.doesNotThrow(() => validateMedicalRepSimpleExpenseInput(baseInput()));
  assert.doesNotThrow(() =>
    validateMedicalRepSimpleExpenseInput({ ...baseInput(), toPlaceId: null }),
  );
  // A destination is still required — a place id is not a substitute for one.
  assert.throws(
    () => validateMedicalRepSimpleExpenseInput({ ...baseInput(), toLocation: "  " }),
    /Destination is required/,
  );

  // --- the two routes differ ONLY in who may call them ---------------------------------------

  const repRoute = readFileSync(
    new URL("../app/api/outstation/places-autocomplete/route.ts", import.meta.url),
    "utf8",
  );
  const adminRoute = readFileSync(
    new URL("../app/api/admin/outstation/places-autocomplete/route.ts", import.meta.url),
    "utf8",
  );

  // Scoped to the HANDLER BODY, not the file. A whole-file `includes` matches the doc comment
  // above each route — which explains the other route's gate by name — so it would report the rep
  // route as admin-gated on the strength of prose. Same lesson as geocode-precision.test.ts.
  const repGet = repRoute.slice(repRoute.indexOf("export async function GET"));
  const adminGet = adminRoute.slice(adminRoute.indexOf("export async function GET"));
  assert.ok(repGet.length > 0 && adminGet.length > 0, "both routes must export a GET handler");

  assert.ok(
    repGet.includes('assertPermission(access, "outstation", "create")'),
    "the rep route must be gated on outstation:create — the permission the submission needs",
  );
  assert.ok(
    !repGet.includes("assertOutstationAdminAccess"),
    "the rep route must not require admin access, or a rep gets 403 and an empty dropdown",
  );

  // 🔴 THE SECOND GATE, and it is the one that actually narrows anything.
  //
  // `outstation:create` alone admits TWELVE roles — measured against the live permission matrix
  // on 2026-09-28 — including District Manager, Product Manager, SFE Manager and the generic
  // **Employee**, because it is the permission for filing ANY outstation expense. The submission
  // this route serves is narrower: the service also calls `assertMedicalRepExpenseRole`.
  //
  // Without this check every Employee could spend billable Google Places calls on the company key
  // while being unable to file the expense those calls are for. The first version of this route
  // shipped that way (#4644); this is the correction.
  assert.ok(
    repGet.includes("isMedicalRepExpenseViewer(access)"),
    "the rep route must ALSO narrow to Medical Rep — outstation:create admits 12 roles including "
    + "the generic Employee, far wider than the submission it serves",
  );
  assert.ok(
    /isMedicalRepExpenseViewer\(access\)[\s\S]{0,400}status: 403/.test(repGet),
    "failing the Medical Rep check must return 403, not fall through to a Google call",
  );
  // Order matters: the narrowing must run BEFORE anything is fetched, or a refused caller has
  // already cost a billable lookup by the time they are told no.
  assert.ok(
    repGet.indexOf("isMedicalRepExpenseViewer(access)") < repGet.indexOf("fetchPlacePredictions("),
    "the Medical Rep check must run before the Google call, not after it",
  );
  // The ADMIN route must NOT gain it — it exists for reviewers, who are not Medical Reps.
  assert.ok(
    !adminGet.includes("isMedicalRepExpenseViewer"),
    "the admin route serves reviewers and must not be narrowed to Medical Rep",
  );
  assert.ok(
    adminGet.includes('assertOutstationAdminAccess(access, "approve")'),
    "the admin route must KEEP its stricter gate — this change must not widen it",
  );
  assert.ok(
    !adminGet.includes('assertPermission(access, "outstation", "create")'),
    "the admin route must not be quietly loosened to the filer gate",
  );
  // Neither may be left ungated: it spends billable Google Places calls on the company key.
  for (const [name, source] of [["rep", repRoute], ["admin", adminRoute]] as const) {
    assert.ok(
      source.includes("resolveAccessContext(request)"),
      `the ${name} route must resolve an access context before calling Google`,
    );
  }
  // One producer for the Google call, so region lock and mapping cannot drift between them.
  for (const [name, source] of [["rep", repRoute], ["admin", adminRoute]] as const) {
    assert.ok(
      source.includes("fetchPlacePredictions("),
      `the ${name} route must call the shared fetchPlacePredictions, not its own fetch`,
    );
    assert.ok(
      !source.includes("places.googleapis.com"),
      `the ${name} route must not carry its own copy of the Google endpoint`,
    );
  }

  const shared = readFileSync(
    new URL("../src/lib/outstation/places-autocomplete.ts", import.meta.url),
    "utf8",
  );
  // Scoped to the function body for the same reason as the route gates above — the module's own
  // comment quotes this line to explain why it matters, so a whole-file check passes on prose
  // while the real call queries another continent. (Caught by the break harness, not by review.)
  const fetchFn = shared.slice(shared.indexOf("export async function fetchPlacePredictions"));
  assert.ok(fetchFn.length > 0, "the shared module must export fetchPlacePredictions");
  assert.ok(
    fetchFn.includes('includedRegionCodes: ["eg"]'),
    "the region lock is load-bearing: this path stores the chosen text verbatim as the destination",
  );

  // --- the component points at the right source ----------------------------------------------

  const input = readFileSync(
    new URL("../src/components/outstation/places-autocomplete-input.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    input.includes("endpoint = ADMIN_PLACES_ENDPOINT"),
    "the default must stay the ADMIN route, or existing callers silently change behaviour",
  );
  assert.ok(
    input.includes("}, [endpoint]);"),
    "endpoint must be in the useCallback deps, or the callback closes over a stale route",
  );

  const form = readFileSync(
    new URL("../src/components/employee-portal/medical-rep-expenses.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    form.includes("endpoint={EXPENSE_PLACES_ENDPOINT}"),
    "the rep form must use the filer-gated route, not the admin one",
  );
  assert.ok(
    !form.includes("onChange={(event) => setToLocation(event.target.value)}"),
    "the free-text destination box must be gone — it is what stored 'Baniseaf'",
  );
  assert.ok(
    form.includes('formData.set("toPlaceId", toPlaceId)'),
    "the chosen place id must reach the server",
  );

  // --- 🔴 the scope boundary: this must NOT switch on distance gating for reps ----------------

  // The path's character is that no route is computed and no minimum applies — the row says so in
  // two columns and is sent to a human. Giving it a resolvable destination must not quietly turn
  // it into a gated claim, which would start rejecting reps on a threshold nobody told them about.
  const service = readFileSync(
    new URL("../src/lib/outstation/service.ts", import.meta.url),
    "utf8",
  );
  const submitFn = service.slice(
    service.indexOf("export async function submitMedicalRepSimpleExpenseRequest"),
  );
  const insertBlock = submitFn.slice(0, submitFn.indexOf("transportation_type: \"other\""));
  assert.ok(
    insertBlock.includes("minimum_required_distance_km: 0"),
    "the minimum must stay 0 — this path applies no manager distance rule",
  );
  assert.ok(
    insertBlock.includes("distance_km: null"),
    "no distance is computed on this path and none must start being computed",
  );
  assert.ok(
    insertBlock.includes("to_place_id: normalized.toPlaceId"),
    "the place id must be stored",
  );
  assert.ok(
    insertBlock.includes('eligibility_status: "needs_review"'),
    "the row must still go to a human",
  );
}
