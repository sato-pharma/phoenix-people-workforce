import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  crmDoctorAreaChoices,
  crmDoctorAreaIsFixed,
  crmListFlag,
  crmSeatsOfArea,
  describeMissingDoctorPick,
  NOT_ON_CRM_LIST_FLAG,
  readsEveryCrmDoctorArea,
  readTypedCrmDoctorName,
  TYPED_CRM_DOCTOR_MAX_LENGTH,
  TYPED_CRM_DOCTOR_PREFIX,
  typedCrmDoctorValue,
  UNPICKED_CRM_DOCTOR,
} from "../src/lib/marketing-requests/crm-doctor-pick.ts";
import {
  describeMissingSaveRequirement,
  type SaveGateCapture,
  type SaveGateCustomer,
} from "../src/lib/marketing-requests/validation-save-gate.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Customer Validation's area → doctor pick (owner, 2026-10-23): "the district manager or the manager
 * is no more able to add in the customer validation free type doctor name … he will choose the area
 * … then cascading will appear the doctors in this area for the rep in his team", and "the area he
 * will put by his hand, it will not replace the area of the GPS". A doctor not on the list may still
 * be typed, "but flag, clearly flag in all approval steps".
 */

function seat(seatId: string, areaCode: string | null, areaName: string | null, overrides: Partial<OrgSeat> = {}): OrgSeat {
  return {
    seatId,
    parentSeatId: "DM-1",
    tier: "REP",
    path: ["CEO", "DM-1", seatId],
    occupantHrId: `HR-${seatId}`,
    lineCode: "CNS",
    lineName: "CNS",
    areaCode,
    areaName,
    regionName: "Delta",
    seatLabel: null,
    ...overrides,
  };
}

function emptyCapture(): SaveGateCapture {
  return { capturedAt: null, latitude: null, longitude: null, photoCapturedAt: null, photoDataUrl: null, photoName: "" };
}

function customer(overrides: Partial<SaveGateCustomer> = {}): SaveGateCustomer {
  return {
    capture: emptyCapture(),
    customerComplete: false,
    name: "",
    pharmacies: [
      {
        capture: emptyCapture(),
        existingPharmacyId: "",
        name: "صيدلية النيل",
        source: "new",
        vendorCodes: [{ distributorCode: "0010453", distributorId: "dist-pos" }],
        venueType: "pharmacy",
      },
    ],
    ...overrides,
  };
}

function code(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

export async function runMarketingCrmDoctorPickTests() {
  // ---------------------------------------------------------------- one area, many rep seats

  // Two lines' reps share Tanta (one area id, several seats); a pseudo-DM bucket is never an area.
  const reach = [
    seat("R-2", "D13", "Tanta", { lineCode: "PED", lineName: "Pedia" }),
    seat("R-1", "D13", "Tanta"),
    seat("R-3", "AB1", "Alexandria"),
    seat("R-9", "XX", "Others", { isOtherPseudoDm: true }),
  ];
  const areas = crmDoctorAreaChoices(reach);
  assert.deepEqual(
    areas.map((area) => area.areaName),
    ["Alexandria", "Tanta"],
    "one choice per AREA, by name, and the pseudo-DM bucket is never offered",
  );
  assert.equal(areas.find((area) => area.areaName === "Tanta")?.seatId, "R-1", "the area's first seat stands for it");

  const tanta = crmSeatsOfArea(reach, "R-2");
  assert.deepEqual(tanta?.map((entry) => entry.seatId).sort(), ["R-1", "R-2"], "choosing an area reads EVERY rep list of that area");
  assert.equal(crmSeatsOfArea(reach, "R-OUTSIDE"), null, "a seat outside the viewer's reach is refused, never widened");
  assert.equal(crmSeatsOfArea(reach, "R-9"), null, "the pseudo-DM bucket is refused as an area");
  assert.equal(crmSeatsOfArea(reach, ""), null, "no area chosen reads nothing");

  // ---------------------------------------------------------------- who chooses which areas

  for (const role of ["Super Admin", "CEO", "SFE Manager", "Marketing Manager", "Product Manager", "Group Product Manager"]) {
    assert.equal(readsEveryCrmDoctorArea(role), true, `${role} has no team, so chooses any area in the company`);
  }
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager"]) {
    assert.equal(readsEveryCrmDoctorArea(role), false, `${role} chooses only from the territories at and below him`);
  }
  assert.equal(readsEveryCrmDoctorArea("Medical Rep", "system"), true, "a system call reads everything");
  assert.equal(crmDoctorAreaIsFixed("Medical Rep"), true, "a rep's area is fixed — he picks from his own list");
  assert.equal(crmDoctorAreaIsFixed("District Manager"), false, "a manager chooses the area by hand");

  // ---------------------------------------------------------------- the save gate: no free typing

  const pickPending = { areasAvailable: true, areaSeatId: "", crmCustomerId: "", notOnList: false };
  assert.equal(
    describeMissingSaveRequirement([customer({ doctorPick: pickPending })], false),
    "Choose the area for Customer 1 first.",
    "the area comes first",
  );
  assert.equal(
    describeMissingSaveRequirement([customer({ doctorPick: { ...pickPending, areaSeatId: "R-1" } })], false),
    'Choose Customer 1 from the doctor list, or pick "Not on the list".',
    "with the area chosen, a doctor must be picked — typing is not offered by default",
  );
  assert.equal(
    describeMissingSaveRequirement(
      [customer({ name: "د. احمد محارب", doctorPick: { ...pickPending, areaSeatId: "R-1", crmCustomerId: "crm-1" } })],
      false,
    ),
    null,
    "area + picked doctor is a complete pick",
  );
  assert.equal(
    describeMissingSaveRequirement([customer({ doctorPick: { ...pickPending, areaSeatId: "R-1", notOnList: true } })], false),
    "Enter a name for Customer 1.",
    '"Not on the list" opens the typed name, and the name is then required',
  );
  assert.equal(
    describeMissingSaveRequirement(
      [customer({ name: "د. سمير", doctorPick: { ...pickPending, areaSeatId: "R-1", notOnList: true } })],
      false,
    ),
    null,
    "a typed doctor not on the list saves (flagged), never refused",
  );
  assert.equal(
    describeMissingSaveRequirement([customer({ name: "د. سمير", doctorPick: { ...pickPending, areasAvailable: false } })], false),
    null,
    "a viewer with no area holding a CRM list can still save a typed name",
  );
  assert.equal(
    describeMissingSaveRequirement([customer({ name: "د. سمير" })], false),
    null,
    "a customer already on record carries no pick — its name is locked, not re-chosen",
  );
  assert.equal(describeMissingDoctorPick({ ...pickPending, areaSeatId: "R-1", crmCustomerId: "crm-1" }, 2), null);

  // ---------------------------------------------------------------- one box: pick from the list OR type a name (2026-10-26)

  assert.equal(typedCrmDoctorValue("  د.   سمير  "), `${TYPED_CRM_DOCTOR_PREFIX}د. سمير`, "a typed name is trimmed and its spaces collapsed");
  assert.equal(typedCrmDoctorValue("   "), "", "nothing readable typed offers no row");
  assert.equal(readTypedCrmDoctorName(typedCrmDoctorValue("Dr Samir")), "Dr Samir", "the typed name round-trips");
  assert.equal(readTypedCrmDoctorName("crm-1"), null, "a CRM id is never read as a typed name");
  assert.equal(readTypedCrmDoctorName(""), null, "the placeholder is not a typed name");
  assert.equal(readTypedCrmDoctorName("__not_on_crm_list__"), null, 'the "Not on the list" row is not a typed name');
  assert.equal(readTypedCrmDoctorName(TYPED_CRM_DOCTOR_PREFIX), null, "a prefix with no name is not a name");
  assert.equal(
    typedCrmDoctorValue("x".repeat(TYPED_CRM_DOCTOR_MAX_LENGTH + 40)).length,
    TYPED_CRM_DOCTOR_PREFIX.length + TYPED_CRM_DOCTOR_MAX_LENGTH,
    "a typed name is capped",
  );

  const select = code("src/components/ui/searchable-select.tsx");
  assert.match(select, /freeTextValue\?: \(typed: string\) => string;/, "free typing is an opt-in prop of the shared select");
  assert.match(select, /if \(!freeTextValue\) return null;/, "without the prop the select offers no typed row — every other select is unchanged");
  assert.match(select, /option\.lowerLabel === lowerTyped\)\) return null;/, "typing a listed name picks the listed row, never a duplicate");
  assert.match(select, /\} else if \(freeTextRow\) \{\s*selectOption\(freeTextRow\.value\);/, "Enter takes the typed name only when nothing listed matches");
  assert.doesNotMatch(select.slice(select.indexOf("freeTextRow ? ("), select.indexOf("filteredOptions.length === 0 ? (")), /truncate|rounded/, "the typed row is square and never ellipsised");

  const doctorForm = code("src/components/employee-portal/marketing-validation-workspace.tsx");
  assert.match(doctorForm, /freeTextValue=\{typedCrmDoctorValue\}/, "the doctor box accepts a typed name");
  assert.match(
    doctorForm,
    /const typedName = readTypedCrmDoctorName\(value\);\s*if \(typedName\) \{\s*updateCustomer\(customer\.key, \{ crmCustomerId: "", name: typedName, notOnCrmList: true \}\);/,
    "a typed name becomes a flagged not-on-list customer, never a CRM link",
  );

  // ---------------------------------------------------------------- the flag every approver sees

  assert.equal(crmListFlag("not_on_list"), NOT_ON_CRM_LIST_FLAG, "a typed doctor is flagged");
  assert.equal(crmListFlag("on_list"), null, "a picked doctor is not flagged");
  assert.equal(crmListFlag(null), null, "a customer from before the rule is not flagged — it was never asked");
  assert.match(NOT_ON_CRM_LIST_FLAG, /Not on the rep's Phoenix CRM list/);
  assert.equal(UNPICKED_CRM_DOCTOR.crmListStatus, "not_on_list", "a save with nothing picked is flagged, never silently on_list");

  // ---------------------------------------------------------------- the wiring (source pins)

  const service = code("src/lib/marketing-requests/service.ts");
  const insert = service.slice(service.indexOf('customer_code: generateMarketingCode("MKT-HCP")') - 900, service.indexOf('customer_code: generateMarketingCode("MKT-HCP")') + 900);
  assert.match(insert, /crm_list_status: doctorPicks\.get\(normalizedCustomer\)\?\.crmListStatus \?\? "not_on_list"/, "the new customer row records on_list / not_on_list");
  assert.match(insert, /phoenix_crm_customer_id: doctorPicks\.get\(normalizedCustomer\)/, "the picked CRM doctor is linked on the row");
  assert.match(insert, /chosen_area_seat_id: doctorPicks\.get\(normalizedCustomer\)/, "the hand-chosen area is saved in its own column");
  assert.match(insert, /area_id: owner\.areaId \?\? null,/, "area_id still comes from the owner, never from the hand-chosen area");
  assert.doesNotMatch(insert, /extracted_area_name: [^,\n]*chosen/, "the GPS area is never overwritten by the chosen one");
  assert.match(service, /resolveCrmDoctorPick\(/, "the server re-checks every pick before anything is written");
  assert.match(service, /evidence_photo_captured_at, crm_list_status, crm_list_source"\)/, "the approval window reads the flag");
  assert.match(service, /customerCrmListFlag: crmListFlag\(customerRow\?\.crm_list_status, \{\s*check: listCheckFacts\.get\(request\.customerId \?\? ""\),\s*source: customerRow\?\.crm_list_source,/, "the approval summary carries the flag sentence");
  assert.equal((service.match(/customerCrmListFlag: customerCrmFlagById\.get\(request\.customerId\)/g) ?? []).length, 2, "the inbox row and the history row both carry the flag");

  const pickService = code("src/lib/marketing-requests/crm-doctor-pick-service.ts");
  assert.match(pickService, /\.in\("list_type", \["AM", "PM"\]\)/, "the drop-list holds doctors only, never a pharmacy");
  assert.match(pickService, /\.in\("status", \["active", "pending"\]\)/, "never a dropped or outside customer");
  assert.match(pickService, /\.eq\("is_test", false\)/, "never a test row");
  assert.doesNotMatch(pickService, /\.(insert|update|upsert|delete)\(/, "the pick never writes to Phoenix CRM");

  for (const path of [
    "src/components/marketing-requests/marketing-request-approver-detail.tsx",
    "src/components/employee-portal/marketing-request-decision-confirmation.tsx",
    "src/components/employee-portal/marketing-request-inbox.tsx",
  ]) {
    assert.match(code(path), /<NotOnCrmListFlag[^>]*flag=\{(detail|summary|row)\.customerCrmListFlag\}/, `${path} shows the flag on its approval step`);
  }

  const form = code("src/components/employee-portal/marketing-validation-workspace.tsx");
  assert.match(form, /!crmAreasAvailable \|\| customer\.notOnCrmList \? \(/, "a new customer's name box exists only for \"Not on the list\" (or no area at all)");
  assert.match(form, /<Input className="text-phx-md" disabled placeholder="Customer name" value=\{customer\.name\} \/>/, "a customer on record keeps its locked name");
  assert.match(form, /describeMissingSaveRequirement\(gateCustomers, isDeskMode\)/, "Save reads the gate WITH the doctor pick");
  assert.doesNotMatch(form, /describeMissingSaveRequirement\(customers, isDeskMode\)/, "no gate call without the pick");
}
