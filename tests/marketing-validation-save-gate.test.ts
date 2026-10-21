import { strict as assert } from "node:assert";

import {
  canSaveMarketingValidation,
  describeMissingSaveRequirement,
  type SaveGateCapture,
  type SaveGateCustomer,
  type SaveGatePharmacy,
  withoutBlankCodeRows,
} from "../src/lib/marketing-requests/validation-save-gate.ts";
import { VENUE_TYPE_UNANSWERED_MESSAGE } from "../src/lib/venues/venue-type.ts";

const jpeg = `data:image/jpeg;base64,${Buffer.from("a-real-jpeg-frame").toString("base64")}`;

function emptyCapture(): SaveGateCapture {
  return {
    capturedAt: null,
    latitude: null,
    longitude: null,
    photoCapturedAt: null,
    photoDataUrl: null,
    photoName: "",
  };
}

/** A capture complete enough to stand as a venue's proof: pin, time, and the stamped photo. */
function fullCapture(): SaveGateCapture {
  return {
    capturedAt: "2026-10-03T12:00:00.000Z",
    latitude: 31.1303563,
    longitude: 30.1226590,
    photoCapturedAt: "2026-10-03T12:00:00.000Z",
    photoDataUrl: jpeg,
    photoName: "venue-live.jpg",
  };
}

/** GPS fixed, no photo — a desk-mode map pin, which is a pin and nothing more. */
function pinOnlyCapture(): SaveGateCapture {
  return { ...emptyCapture(), latitude: 31.1303563, longitude: 30.1226590 };
}

function pharmacy(overrides: Partial<SaveGatePharmacy> = {}): SaveGatePharmacy {
  return {
    capture: emptyCapture(),
    existingPharmacyId: "",
    name: "صيدلية النيل",
    source: "new",
    vendorCodes: [{ distributorCode: "0010453", distributorId: "dist-pos" }],
    venueType: "pharmacy",
    ...overrides,
  };
}

function customer(overrides: Partial<SaveGateCustomer> = {}): SaveGateCustomer {
  return {
    capture: emptyCapture(),
    customerComplete: false,
    name: "د. احمد محارب",
    pharmacies: [pharmacy()],
    ...overrides,
  };
}

export async function runMarketingValidationSaveGateTests() {
  // ---------------------------------------------------------------- the defect this module exists for

  /*
   * A nursery has no distributor account, so the form hides its vendor-codes block entirely — the
   * default empty code row stays in state with nothing on screen to fill it. A greyed Save with no
   * sentence is the dead form this module exists to prevent, so the nursery case must always have
   * a sentence. Since 2026-10-21 that sentence is the refusal itself (owner: "any thing with no
   * distributor code never reach the marketing requests"): a nursery is validated in Direct Orders.
   */
  const nursery = [customer({ pharmacies: [pharmacy({ name: "حضانة النيل", venueType: "nursery", vendorCodes: [{ distributorCode: "", distributorId: "" }] })] })];
  assert.match(
    describeMissingSaveRequirement(nursery, false) ?? "",
    /"حضانة النيل" has no distributor code[\s\S]*validated in Direct Orders/,
    "a nursery is refused in Marketing, in the shared sentence that points to Direct Orders",
  );
  assert.equal(canSaveMarketingValidation(nursery, false), false, "and Save is disabled — WITH that sentence beside it");
  assert.equal(
    canSaveMarketingValidation([customer({ pharmacies: [pharmacy({ venueType: "nursery", vendorCodes: [] })] })], false),
    false,
    "a nursery with no code row at all is refused too",
  );

  // ---------------------------------- a PHARMACY with no code is refused, licence or not (2026-10-21)

  /*
   * Owner, 2026-10-14 had a pharmacy with no distributor code saved on its licence, held as not
   * usable in requests. Retired 2026-10-21: a licence never stands in for a code in Marketing. The
   * form opens with ONE blank code row, so an attached licence still drops that untouched row from
   * the payload — and the sentence then names the missing code and where codeless venues go.
   */
  const licence = { dataUrl: "data:application/pdf;base64,AAAA", fileName: "licence.pdf", isPdf: true };
  const blankRow = [{ distributorCode: "", distributorId: "dist-pos" }];
  const licenceOnly = [customer({ pharmacies: [pharmacy({ license: licence, vendorCodes: blankRow })] })];
  assert.match(
    describeMissingSaveRequirement(licenceOnly, false) ?? "",
    /needs at least one distributor code\. Venues without a distributor code \(nurseries included\) are validated in Direct Orders\./,
    "a codeless pharmacy with its licence attached is NOT savable in Marketing",
  );
  assert.equal(canSaveMarketingValidation(licenceOnly, false), false, "and Save is disabled for it");
  assert.equal(
    canSaveMarketingValidation([customer({ pharmacies: [pharmacy({ license: licence, vendorCodes: [] })] })], false),
    false,
    "also with the code rows removed outright",
  );
  assert.match(
    describeMissingSaveRequirement([customer({ pharmacies: [pharmacy({ vendorCodes: blankRow })] })], false) ?? "",
    /Enter the distributor code for/,
    "WITHOUT a licence a blank code row is still refused, exactly as before",
  );
  assert.match(
    describeMissingSaveRequirement([customer({ pharmacies: [pharmacy({ vendorCodes: [] })] })], false) ?? "",
    /needs at least one distributor code\. Venues without a distributor code/,
    "with no code at all, the sentence names the code and points codeless venues to Direct Orders",
  );
  assert.doesNotMatch(
    describeMissingSaveRequirement([customer({ pharmacies: [pharmacy({ vendorCodes: [] })] })], false) ?? "",
    /attach its pharmacy licence/,
    "the retired licence route is never offered again",
  );
  assert.match(
    describeMissingSaveRequirement(
      [customer({ pharmacies: [pharmacy({ license: licence, vendorCodes: [{ distributorCode: "0010453", distributorId: "" }] })] })],
      false,
    ) ?? "",
    /Pick a distributor for/,
    "a code the rep DID type is still checked even with a licence",
  );
  assert.deepEqual(
    withoutBlankCodeRows({ license: licence, vendorCodes: [...blankRow, { distributorCode: "0010453", distributorId: "dist-pos" }] }),
    [{ distributorCode: "0010453", distributorId: "dist-pos" }],
    "the submit drops blank code rows once the licence is on file, so the payload matches the gate",
  );
  assert.equal(
    withoutBlankCodeRows({ license: null, vendorCodes: blankRow }).length,
    1,
    "and drops nothing when there is no licence",
  );

  // ------------------------------------------------------- the button and the sentence never disagree

  /*
   * The invariant, stated as a test rather than as a comment on two functions: Save is disabled
   * exactly when there is a sentence to show, and enabled exactly when there is not. Every case
   * below is a real form state, and each one asserts BOTH halves.
   */
  const cases: Array<{ customers: SaveGateCustomer[]; isDeskMode: boolean; expect: RegExp | null; what: string }> = [
    { customers: [], expect: null, isDeskMode: false, what: "an empty form has nothing to name" },
    {
      customers: [customer({ name: "   " })],
      expect: /Enter a name for Customer 1\./,
      isDeskMode: false,
      what: "an unnamed customer",
    },
    {
      customers: [customer({ pharmacies: [] })],
      expect: /needs at least one pharmacy/,
      isDeskMode: false,
      what: "a customer with no venue",
    },
    {
      customers: [customer({ pharmacies: [pharmacy({ name: "  " })] })],
      expect: /Enter a name for Pharmacy 1 under/,
      isDeskMode: false,
      what: "an unnamed venue",
    },
    {
      customers: [customer({ pharmacies: [pharmacy({ venueType: null })] })],
      expect: new RegExp(VENUE_TYPE_UNANSWERED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      isDeskMode: false,
      what: "a venue type nobody answered",
    },
    {
      customers: [customer({ pharmacies: [pharmacy({ vendorCodes: [] })] })],
      expect: /needs at least one distributor code/,
      isDeskMode: false,
      what: "a pharmacy with no code row",
    },
    {
      customers: [customer({ pharmacies: [pharmacy({ vendorCodes: [{ distributorCode: "0010453", distributorId: "" }] })] })],
      expect: /Pick a distributor for/,
      isDeskMode: false,
      what: "a code with no distributor",
    },
    {
      customers: [customer({ pharmacies: [pharmacy({ vendorCodes: [{ distributorCode: "  ", distributorId: "dist-pos" }] })] })],
      expect: /Enter the distributor code for/,
      isDeskMode: false,
      what: "a distributor with no code",
    },
    {
      customers: [customer({ pharmacies: [pharmacy({ existingPharmacyId: "", source: "existing" })] })],
      expect: /Choose which pharmacy to attach/,
      isDeskMode: false,
      what: "the My Pharmacies tab with nothing picked",
    },
    {
      customers: [customer({ pharmacies: [pharmacy({ existingPharmacyId: "ph-1", source: "existing", vendorCodes: [] })] })],
      expect: null,
      isDeskMode: false,
      what: "an attached pharmacy needs only the pick — its codes come from its stored record",
    },
    {
      customers: [customer()],
      expect: /Pin "د\. احمد محارب"'s location on the map\./,
      isDeskMode: true,
      what: "desk mode with no customer pin",
    },
    {
      customers: [customer({ capture: pinOnlyCapture() })],
      expect: /Pin "صيدلية النيل"'s location on the map\./,
      isDeskMode: true,
      what: "desk mode with no venue pin",
    },
    {
      customers: [customer({ capture: pinOnlyCapture(), pharmacies: [pharmacy({ capture: pinOnlyCapture() })] })],
      expect: null,
      isDeskMode: true,
      what: "desk mode with both pins placed",
    },
    {
      customers: [customer({ customerComplete: true, pharmacies: [pharmacy({ existingPharmacyId: "ph-1", source: "existing" })] })],
      expect: /Capture the venue's live photo and location for/,
      isDeskMode: false,
      what: "a complete customer whose only reason to save is a venue capture it does not have",
    },
    {
      customers: [customer({
        customerComplete: true,
        pharmacies: [pharmacy({ capture: fullCapture(), existingPharmacyId: "ph-1", source: "existing" })],
      })],
      expect: null,
      isDeskMode: false,
      what: "the same customer once the venue capture is in hand",
    },
    { customers: [customer()], expect: null, isDeskMode: false, what: "the ordinary field path" },
  ];

  for (const testCase of cases) {
    const reason = describeMissingSaveRequirement(testCase.customers, testCase.isDeskMode);
    if (testCase.expect === null) {
      assert.equal(reason, null, `${testCase.what}: nothing should be reported, got ${JSON.stringify(reason)}`);
    } else {
      assert.ok(reason, `${testCase.what}: a blocked form must name its reason, never leave the rep guessing`);
      assert.match(reason, testCase.expect, `${testCase.what}: the reason names the right thing`);
    }

    // The invariant. A disabled Save with no sentence is the defect; a sentence under an enabled
    // Save is the mirror of it. Neither is reachable while the boolean is the sentence.
    const expectedSave = testCase.expect === null && testCase.customers.length > 0;
    assert.equal(
      canSaveMarketingValidation(testCase.customers, testCase.isDeskMode),
      expectedSave,
      `${testCase.what}: Save ${expectedSave ? "must be enabled" : "must be disabled"}, in step with the reason shown`,
    );
  }

  // --------------------------------------------------------------- the first unmet thing, not any of them

  // Several customers: the sentence names the one the rep must fix first, in form order, so the
  // message does not jump between rows as fields are filled.
  assert.match(
    describeMissingSaveRequirement([customer(), customer({ name: "", pharmacies: [] })], false) ?? "",
    /Enter a name for Customer 2\./,
    "the second customer's first gap is reported once the first customer is complete",
  );
  assert.equal(
    canSaveMarketingValidation([customer(), customer({ name: "د. سيد" })], false),
    true,
    "two complete customers save together",
  );
}
