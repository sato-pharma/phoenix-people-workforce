import assert from "node:assert/strict";

import { createAccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  assertMarketingOnBehalfAccess,
  buildMarketingOnBehalfEmployees,
  buildUntrackedDistributorCodeNote,
  canValidateMarketingOnBehalf,
  normalizeMarketingValidationInput,
  resolveMarketingSystemValidationStatus,
  resolveMarketingValidationActor,
  resolveMarketingValidationRecordStatus,
} from "@/lib/marketing-requests/service";
import type {
  MarketingValidationCustomerInput,
  MarketingValidationInput,
} from "@/lib/marketing-requests/types";

const timestamp = "2026-05-21T10:00:00.000Z";

/**
 * Directory rows carry ~60 fields that none of these assertions read. Building them from overrides
 * keeps each case about the two or three fields it is actually testing.
 */
function directoryRow(overrides: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    areaId: null,
    areaName: null,
    displayName: overrides.fullName ?? overrides.hrId,
    employmentStatus: "active",
    fullName: overrides.hrId,
    jobTitle: null,
    lineId: null,
    lineName: null,
    managerHrId: null,
    ...overrides,
  } as EmployeeDirectoryRow;
}

const adminRow = directoryRow({
  fullName: "Omar Admin",
  hrId: "SA-1",
  jobTitle: "Super Admin",
});

const productManagerRow = directoryRow({
  areaId: 30,
  areaName: "Alexandria",
  fullName: "Nahed Hattab",
  hrId: "A-10",
  jobTitle: "Product Manager",
  lineId: 7,
  lineName: "Pedia",
  managerHrId: "GPM-1",
});

const hrSpecialistRow = directoryRow({
  fullName: "Hala HR",
  hrId: "HR-3",
  jobTitle: "HR Specialist",
});

const onBehalfDirectory = [adminRow, productManagerRow, hrSpecialistRow];

/**
 * The Super Admin "validate a customer for an employee" path. These cover the decision layer — who
 * may do it, who it may be done for, and what status the row lands on — because that is what makes
 * the customer reachable in the employee's marketing request dropdown, and what keeps a desk entry
 * distinguishable from a rep's field capture.
 */
function runMarketingOnBehalfValidationTests() {
  // --- who may act on behalf -------------------------------------------------------------------
  assert.equal(canValidateMarketingOnBehalf(createAccessContext({ hrId: "SA-1", role: "Super Admin" })), true);
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "Marketing Manager", "SFE Manager", "CEO"] as const) {
    assert.equal(
      canValidateMarketingOnBehalf(createAccessContext({ hrId: "X-1", role })),
      false,
      `${role} must not be able to validate on behalf of another employee`,
    );
    assert.throws(
      () => assertMarketingOnBehalfAccess(createAccessContext({ hrId: "X-1", role })),
      /cannot validate a customer on behalf of another employee/i,
      `${role} must be refused by assertMarketingOnBehalfAccess`,
    );
  }

  // A non-Super-Admin posting onBehalfOfHrId is refused before anything is written. The UI hiding
  // the panel is not the boundary — this is.
  assert.throws(
    () =>
      resolveMarketingValidationActor({
        access: createAccessContext({ hrId: "A-10", role: "Product Manager" }),
        employeeRows: onBehalfDirectory,
        onBehalfOfHrId: "A-10",
      }),
    /cannot validate a customer on behalf of another employee/i,
  );

  // --- the normal field-rep path is untouched --------------------------------------------------
  const selfActor = resolveMarketingValidationActor({
    access: createAccessContext({ hrId: "A-10", role: "Product Manager" }),
    employeeRows: onBehalfDirectory,
  });
  assert.equal(selfActor.isOnBehalf, false);
  assert.equal(selfActor.owner.hrId, "A-10");
  assert.equal(selfActor.actorHrId, "A-10");

  // A blank / whitespace value must not be read as "on behalf of nobody" and flip the desk rules on.
  const blankActor = resolveMarketingValidationActor({
    access: createAccessContext({ hrId: "A-10", role: "Product Manager" }),
    employeeRows: onBehalfDirectory,
    onBehalfOfHrId: "   ",
  });
  assert.equal(blankActor.isOnBehalf, false);
  assert.equal(blankActor.owner.hrId, "A-10");

  // --- the admin path ---------------------------------------------------------------------------
  const adminActor = resolveMarketingValidationActor({
    access: createAccessContext({ hrId: "SA-1", role: "Super Admin" }),
    employeeRows: onBehalfDirectory,
    onBehalfOfHrId: "A-10",
  });
  assert.equal(adminActor.isOnBehalf, true);
  // The customer must be OWNED by the employee — this is what puts it in their request dropdown.
  assert.equal(adminActor.owner.hrId, "A-10");
  assert.equal(adminActor.owner.lineId, 7);
  assert.equal(adminActor.owner.areaId, 30);
  assert.equal(adminActor.owner.managerHrId, "GPM-1");
  // ...while the audit trail still names the admin who actually typed it, in the employee master's
  // stored casing — the marketing tables' employees(hr_id) FKs are case-sensitive.
  assert.equal(adminActor.actorHrId, "SA-1");
  assert.equal(adminActor.actorIsKnownEmployee, true);
  assert.equal(adminActor.actorName, "Omar Admin");

  // The real Super Admin (PHX-1) is NOT in the active field directory: isActiveDirectoryEmployee
  // drops organogram_visible=false rows and system-admin accounts on purpose. Looking the actor up
  // in that slice found nothing, so a live desk validation recorded created_by_hr_id as the EMPLOYEE
  // and left validated_by_hr_id null — the row read as if Nahed had validated her own customer.
  // The actor must resolve from the unfiltered directory while the target stays restricted.
  const systemAdminRow = directoryRow({
    fullName: "Phoenix System Administrator",
    hrId: "PHX-1",
    jobTitle: "System Administrator",
  });
  const excludedAdminActor = resolveMarketingValidationActor({
    access: createAccessContext({ hrId: "PHX-1", role: "Super Admin" }),
    // Deliberately absent from employeeRows, present only in actorRows — exactly production's shape.
    actorRows: [...onBehalfDirectory, systemAdminRow],
    employeeRows: onBehalfDirectory,
    onBehalfOfHrId: "A-10",
  });
  assert.equal(excludedAdminActor.owner.hrId, "A-10", "the customer must still be owned by the employee");
  assert.equal(
    excludedAdminActor.actorHrId,
    "PHX-1",
    "a system-admin actor outside the field directory must still be named, not swapped for the employee",
  );
  assert.equal(excludedAdminActor.actorIsKnownEmployee, true);
  assert.equal(excludedAdminActor.actorName, "Phoenix System Administrator");

  // An actor with no employees row anywhere still must not be silently renamed to the employee.
  const unknownActor = resolveMarketingValidationActor({
    access: createAccessContext({ hrId: "GHOST-1", role: "Super Admin" }),
    actorRows: onBehalfDirectory,
    employeeRows: onBehalfDirectory,
    onBehalfOfHrId: "A-10",
  });
  assert.equal(unknownActor.actorIsKnownEmployee, false);
  assert.equal(unknownActor.owner.hrId, "A-10");

  // HR_ID casing must not decide whether the target resolves.
  assert.equal(
    resolveMarketingValidationActor({
      access: createAccessContext({ hrId: "SA-1", role: "Super Admin" }),
      employeeRows: onBehalfDirectory,
      onBehalfOfHrId: "a-10",
    }).owner.hrId,
    "A-10",
  );

  // Parking a customer on someone with no marketing screen would make it permanently unusable.
  assert.throws(
    () =>
      resolveMarketingValidationActor({
        access: createAccessContext({ hrId: "SA-1", role: "Super Admin" }),
        employeeRows: onBehalfDirectory,
        onBehalfOfHrId: "HR-3",
      }),
    /cannot raise marketing requests/i,
  );

  assert.throws(
    () =>
      resolveMarketingValidationActor({
        access: createAccessContext({ hrId: "SA-1", role: "Super Admin" }),
        employeeRows: onBehalfDirectory,
        onBehalfOfHrId: "GONE-99",
      }),
    /not found in the active employee directory/i,
  );

  // --- what the picker offers -------------------------------------------------------------------
  const pickerHrIds = buildMarketingOnBehalfEmployees(onBehalfDirectory).map((employee) => employee.hrId);
  assert.deepEqual(pickerHrIds, ["A-10", "SA-1"]);
  assert.equal(pickerHrIds.includes("HR-3"), false, "HR Specialist must not be offered as an on-behalf target");

  // --- the status that decides dropdown visibility ---------------------------------------------
  // Desk rows carry no live GPS fix and no stamped photo, so the system rule would return "pending"
  // — and a pending row never reaches the customer dropdown. sfe_validated is what makes the whole
  // feature work, so assert it against the WORST input the desk path can produce.
  assert.equal(
    resolveMarketingValidationRecordStatus({
      isOnBehalf: true,
      systemStatus: resolveMarketingSystemValidationStatus({
        customerEvidenceStatus: "missing",
        pharmacyEvidenceStatus: "missing",
      }),
    }),
    "sfe_validated",
  );
  // The field path must be completely unchanged by this feature.
  assert.equal(
    resolveMarketingValidationRecordStatus({ isOnBehalf: false, systemStatus: "pending" }),
    "pending",
  );
  assert.equal(
    resolveMarketingValidationRecordStatus({ isOnBehalf: false, systemStatus: "system_validated" }),
    "system_validated",
  );
}

/**
 * A stand-in for the stamped JPEG the camera modal produces.
 *
 * Added 2026-08-04: this fixture previously carried `evidencePhotoName` with NO image, and asserted
 * that it normalized to evidence_status 'complete' — it was pinning the defect. The captured bytes
 * were being dropped in the browser, so 'complete' was being granted on a filename. A name without
 * an image is now refused outright; see marketing-evidence-photo-storage.test.ts for that case.
 */
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from("stamped-jpeg").toString("base64")}`;

const completeInput: MarketingValidationInput = {
  customer: {
    capturedAccuracyMeters: 12,
    capturedAddress: "31.200000, 29.900000",
    capturedAt: timestamp,
    capturedLatitude: 31.2,
    capturedLongitude: 29.9,
    customerType: "clinic",
    displayName: "Test Customer Clinic",
    evidenceHasTimestamp: true,
    evidencePhotoCapturedAt: timestamp,
    evidencePhotoDataUrl: jpegDataUrl,
    evidencePhotoName: "customer-sign.jpg",
    extractedAreaName: "Glim",
    extractedGovernorateName: "Alexandria",
    mobileNumber: "01000000000",
    regionName: "Alexandria",
  },
  pharmacies: [
    {
      capturedAccuracyMeters: 8,
      capturedAddress: "31.201000, 29.901000",
      capturedAt: timestamp,
      capturedLatitude: 31.201,
      capturedLongitude: 29.901,
      displayName: "Test Pharmacy",
      evidenceHasTimestamp: true,
      evidencePhotoCapturedAt: timestamp,
      evidencePhotoDataUrl: jpegDataUrl,
      evidencePhotoName: "pharmacy-sign.jpg",
      extractedAreaName: "Glim",
      extractedGovernorateName: "Alexandria",
      regionName: "Alexandria",
      // Stated, not assumed. Absent used to mean "pharmacy"; since 2026-08-26 it means nobody
      // answered, and capture refuses it — `pharmacyPayload` below spreads this row, so every
      // fixture in the file inherits a venue type that was actually chosen.
      venueType: "pharmacy",
      vendorCodes: [
        {
          distributorId: 1,
          distributorPharmacyCode: " PH-001 ",
        },
        {
          distributorId: 2,
          distributorPharmacyCode: " PH-002 ",
        },
      ],
    },
  ],
};

export function runMarketingValidationServiceTests() {
  // The legacy single-customer payload (`customer` + `pharmacies`) still normalizes, so an offline
  // replay queued before multi-customer shipped cannot 400 on arrival.
  const normalized = normalizeMarketingValidationInput(completeInput);
  assert.equal(normalized.customers.length, 1, "the legacy single-customer shape must still normalize");
  const [legacyCustomer] = normalized.customers;
  assert.equal(legacyCustomer.evidenceStatus, "complete");
  assert.equal(legacyCustomer.extractedAreaName, "Glim");
  assert.equal(legacyCustomer.extractedGovernorateName, "Alexandria");
  assert.equal(legacyCustomer.validationStatus, "system_validated");
  assert.equal(legacyCustomer.mobileNumber, "01000000000");
  assert.equal(legacyCustomer.speciality, null, "speciality is optional and defaults to null");
  assert.equal(legacyCustomer.pharmacies[0].evidenceStatus, "complete");
  assert.equal(legacyCustomer.pharmacies[0].extractedAreaName, "Glim");
  assert.equal(legacyCustomer.pharmacies[0].extractedGovernorateName, "Alexandria");
  assert.equal(legacyCustomer.pharmacies[0].validationStatus, "system_validated");
  assert.equal(legacyCustomer.pharmacies[0].vendorCodes.length, 2);
  assert.equal(legacyCustomer.pharmacies[0].vendorCodes[0].distributorPharmacyCode, "PH-001");
  assert.equal(legacyCustomer.pharmacies[0].vendorCodes[0].normalizedPharmacyCode, "ph-001");

  // OWNER RULING 2026-08-12 — complete field evidence is the WHOLE gate.
  //
  // This input reaches `system_validated` — the customer is in the marketing request dropdown —
  // whatever the pharmacy's distributor code turns out to be. Until this date the rule also took a
  // `referenceStatus` and returned "pending" for an unmatched code, which made a genuinely visited
  // customer invisible in the dropdown with no route back for the rep, since only Super Admin / CEO
  // can release a pending link. The reference status is no longer an input at all — the type is now
  // the guard against reintroducing it — and the consequence of an unmatched code is carried by
  // `buildUntrackedDistributorCodeNote` on the row instead of by a block.
  assert.equal(
    resolveMarketingSystemValidationStatus({
      customerEvidenceStatus: "complete",
      pharmacyEvidenceStatus: "complete",
    }),
    "system_validated",
  );
  assert.equal(
    buildUntrackedDistributorCodeNote("not_found"),
    "Distributor code is not found in the Phoenix reference database, so sales cannot be tracked for it yet.",
  );
  assert.equal(
    buildUntrackedDistributorCodeNote("ambiguous"),
    "Distributor code is ambiguous in the Phoenix reference database, so sales cannot be tracked for it yet.",
  );
  assert.equal(
    buildUntrackedDistributorCodeNote("matched"),
    null,
    "a matched code has nothing to warn about",
  );

  // Evidence is now the ONLY thing that can park a field row on pending. Both sides must be
  // complete — a customer photographed at a pharmacy that was not is still unproven.
  assert.equal(
    resolveMarketingSystemValidationStatus({
      customerEvidenceStatus: "pending",
      pharmacyEvidenceStatus: "complete",
    }),
    "pending",
  );
  assert.equal(
    resolveMarketingSystemValidationStatus({
      customerEvidenceStatus: "complete",
      pharmacyEvidenceStatus: "pending",
    }),
    "pending",
    "an incomplete pharmacy capture must still park the row — this is the case that hit production on 2026-08-11",
  );

  const partial = normalizeMarketingValidationInput({
    ...completeInput,
    pharmacies: completeInput.pharmacies?.map((pharmacy) => ({
      ...pharmacy,
      capturedAt: null,
      evidencePhotoName: "",
    })),
  });
  assert.equal(partial.customers[0].pharmacies[0].evidenceStatus, "pending");
  assert.equal(partial.customers[0].pharmacies[0].validationStatus, "pending");

  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        ...completeInput,
        pharmacies: completeInput.pharmacies?.map((pharmacy) => ({
          ...pharmacy,
          vendorCodes: [{ distributorId: "", distributorPharmacyCode: "PH-001" }],
        })),
      }),
    /vendor 1 is required/i,
  );

  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        ...completeInput,
        customer: {
          ...completeInput.customer!,
          displayName: "",
        },
      }),
    /customer name is required/i,
  );

  // A DELIBERATE contract change, 2026-08-26, not an oversight.
  //
  // A payload with no venue type used to normalize to `pharmacy` in silence. That silence is what
  // filed `حضانه النيل` as a pharmacy five hours after the picker shipped, so capture now refuses
  // it and says which two words it wants. The cost is real and bounded: a marketing draft saved
  // BEFORE 2026-08-23 — older than the column itself — is refused on replay with this sentence
  // instead of being filed as a pharmacy on the rep's behalf. Every draft saved since carries the
  // literal "pharmacy" and replays unchanged.
  //
  // The shape guarantee above is untouched: the legacy single-customer payload still normalizes.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        ...completeInput,
        pharmacies: [{ ...completeInput.pharmacies![0], venueType: undefined }],
      }),
    /pharmacy or nursery/i,
    "a venue nobody named must be refused, never filed as a pharmacy by default",
  );

  runMarketingMultiCustomerTests();
  runMarketingOnBehalfValidationTests();
  runMarketingReusedPharmacyTests();
}

/* ── "My Pharmacies": attaching a shop that was already validated ───────────────────────────── */

/**
 * The second half of the validation form's pharmacy tabs.
 *
 * Two customers a street apart routinely dispense through the same shop, and before this the only
 * way to record that was to capture the shop again — on production 2026-08-19, 7 of the 25
 * field-validated pharmacies were the same distributor code entered twice by the same rep. These
 * cover the normalizer's half of the contract: an attached pharmacy carries its ID and nothing
 * else, so the server reads the stored record instead of trusting a client re-description.
 */
function runMarketingReusedPharmacyTests() {
  const attached = normalizeMarketingValidationInput({
    customers: [
      {
        ...customerPayload({ displayName: "Dr Alaa Clinic" }),
        pharmacies: [{ existingPharmacyId: "  pharmacy-uuid-1  " }],
      },
    ],
  });
  const [reusedPharmacy] = attached.customers[0].pharmacies;
  assert.equal(
    reusedPharmacy.existingPharmacyId,
    "pharmacy-uuid-1",
    "an attached pharmacy must carry the id it points at, trimmed",
  );
  assert.equal(
    reusedPharmacy.vendorCodes.length,
    0,
    "an attached pharmacy must contribute no vendor codes — they are read from the stored record",
  );
  assert.equal(
    reusedPharmacy.displayName,
    "",
    "an attached pharmacy must not carry a client-supplied name that could overwrite the stored shop",
  );

  // Mixing the two tabs under one customer is the normal case: a shop captured today alongside one
  // the rep already has. Neither path may swallow the other.
  const mixed = normalizeMarketingValidationInput({
    customers: [
      {
        ...customerPayload({ displayName: "Dr Mona Clinic" }),
        pharmacies: [pharmacyPayload("New Pharmacy", "PH-500"), { existingPharmacyId: "pharmacy-uuid-2" }],
      },
    ],
  });
  assert.equal(mixed.customers[0].pharmacies.length, 2);
  assert.equal(mixed.customers[0].pharmacies[0].existingPharmacyId, null);
  assert.equal(mixed.customers[0].pharmacies[0].displayName, "New Pharmacy");
  assert.equal(mixed.customers[0].pharmacies[1].existingPharmacyId, "pharmacy-uuid-2");

  // An empty id is a picker that was never answered, not a request to create a nameless pharmacy.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        customers: [
          { ...customerPayload({ displayName: "Dr Sara Clinic" }), pharmacies: [{ existingPharmacyId: "" }] },
        ],
      }),
    /did not name which pharmacy to link/i,
    "an attached pharmacy with no id must be refused",
  );

  // The same shop twice under one customer would mint two identical link rows, and the request
  // form would then offer the same pharmacy twice with no way to tell them apart.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        customers: [
          {
            ...customerPayload({ displayName: "Dr Hani Clinic" }),
            pharmacies: [{ existingPharmacyId: "pharmacy-uuid-3" }, { existingPharmacyId: "pharmacy-uuid-3" }],
          },
        ],
      }),
    /same existing pharmacy attached twice/i,
    "attaching one pharmacy twice to the same customer must be refused",
  );
}

/* ── Several customers in one submission, each with its OWN pharmacies ──────────────────────── */

function customerPayload(
  overrides: Partial<MarketingValidationCustomerInput> = {},
): MarketingValidationCustomerInput {
  return { ...completeInput.customer!, ...overrides };
}

function pharmacyPayload(displayName: string, code: string) {
  return {
    ...completeInput.pharmacies![0],
    displayName,
    vendorCodes: [{ distributorId: 1, distributorPharmacyCode: code }],
  };
}

function runMarketingMultiCustomerTests() {
  const twoCustomers = normalizeMarketingValidationInput({
    customers: [
      {
        ...customerPayload({ displayName: "Dr Alaa Clinic", speciality: "Cardiology" }),
        pharmacies: [pharmacyPayload("Alaa Pharmacy", "PH-100")],
      },
      {
        ...customerPayload({ displayName: "Dr Mona Clinic", speciality: "Paediatrics" }),
        pharmacies: [pharmacyPayload("Mona Pharmacy A", "PH-200"), pharmacyPayload("Mona Pharmacy B", "PH-201")],
      },
    ],
  });

  assert.equal(twoCustomers.customers.length, 2, "both customers must survive normalization");
  assert.equal(twoCustomers.customers[0].displayName, "Dr Alaa Clinic");
  assert.equal(twoCustomers.customers[1].displayName, "Dr Mona Clinic");

  // The whole point of "per customer": the pharmacy lists must NOT pool. If they merged, Dr Alaa
  // would silently acquire Dr Mona's two pharmacies and any request raised against her would
  // attribute sales from a pharmacy she has nothing to do with.
  assert.equal(twoCustomers.customers[0].pharmacies.length, 1, "customer 1 keeps only its own pharmacy");
  assert.equal(twoCustomers.customers[1].pharmacies.length, 2, "customer 2 keeps only its own pharmacies");
  assert.equal(twoCustomers.customers[0].pharmacies[0].displayName, "Alaa Pharmacy");
  assert.deepEqual(
    twoCustomers.customers[1].pharmacies.map((pharmacy) => pharmacy.displayName),
    ["Mona Pharmacy A", "Mona Pharmacy B"],
  );

  assert.equal(twoCustomers.customers[0].speciality, "Cardiology");
  assert.equal(twoCustomers.customers[1].speciality, "Paediatrics");

  // Canonical casing: a payload carrying "cardiology" stores "Cardiology", so the values can be
  // grouped later instead of fragmenting the way the raw CRM speciality text does.
  const lowercased = normalizeMarketingValidationInput({
    customers: [{ ...customerPayload({ speciality: "cardiology" }), pharmacies: [pharmacyPayload("P", "PH-1")] }],
  });
  assert.equal(lowercased.customers[0].speciality, "Cardiology");

  // A speciality outside the list is refused rather than stored, so the dropdown is a real
  // constraint and not merely a UI convenience that the API ignores.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        customers: [{ ...customerPayload({ speciality: "Astrology" }), pharmacies: [pharmacyPayload("P", "PH-1")] }],
      }),
    /is not a recognised speciality/i,
    "an unknown speciality must be rejected",
  );

  // Two rows for the same customer would mint two separate records that both appear in the request
  // dropdown, indistinguishable to whoever picks one.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        customers: [
          { ...customerPayload({ displayName: "Dr Alaa Clinic" }), pharmacies: [pharmacyPayload("P1", "PH-1")] },
          { ...customerPayload({ displayName: "dr  alaa   clinic" }), pharmacies: [pharmacyPayload("P2", "PH-2")] },
        ],
      }),
    /appears more than once/i,
    "the same customer twice in one submission must be rejected",
  );

  // Each customer needs its own pharmacy — an empty list must name WHICH customer is short.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        customers: [
          { ...customerPayload({ displayName: "Dr Alaa Clinic" }), pharmacies: [pharmacyPayload("P1", "PH-1")] },
          { ...customerPayload({ displayName: "Dr Mona Clinic" }), pharmacies: [] },
        ],
      }),
    /Customer 2 needs at least one pharmacy/i,
  );

  // Validation errors stay traceable to the right customer once there are several.
  assert.throws(
    () =>
      normalizeMarketingValidationInput({
        customers: [
          { ...customerPayload({ displayName: "Dr Alaa Clinic" }), pharmacies: [pharmacyPayload("P1", "PH-1")] },
          {
            ...customerPayload({ displayName: "Dr Mona Clinic" }),
            pharmacies: [{ ...pharmacyPayload("P2", "PH-2"), displayName: "" }],
          },
        ],
      }),
    /Customer 2 pharmacy 1 name is required/i,
  );

  // A VENUE WITH NO CODE IS NEVER SAVED IN MARKETING (owner, 2026-10-21: "any thing with no
  // distributor code never reach the marketing requests"). A codeless pharmacy is refused with or
  // without its licence, and a nursery is refused outright — both belong to Direct Orders. The
  // server is the gate that counts — the form's own gate is only a hint.
  const codeless = { ...pharmacyPayload("Codeless Pharmacy", "unused"), vendorCodes: [] };
  const refusedAsCodeless = (error: unknown) =>
    (error as { code?: string }).code === "venue_without_distributor_code"
    && /has no distributor code[\s\S]*validated in Direct Orders/.test(String((error as Error).message));
  assert.throws(
    () => normalizeMarketingValidationInput({ customers: [{ ...customerPayload(), pharmacies: [codeless] }] }),
    refusedAsCodeless,
    "no code and no licence: refused, pointing to Direct Orders",
  );
  assert.throws(
    () => normalizeMarketingValidationInput({
      customers: [{
        ...customerPayload(),
        pharmacies: [{
          ...codeless,
          licenseFileDataUrl: `data:application/pdf;base64,${Buffer.from("%PDF-1.7 a trade licence").toString("base64")}`,
          licenseFileName: "licence.pdf",
        }],
      }],
    }),
    refusedAsCodeless,
    "a licence no longer stands in for a distributor code (the 2026-10-14 licence route is retired)",
  );
  assert.throws(
    () => normalizeMarketingValidationInput({
      customers: [{ ...customerPayload(), pharmacies: [{ ...codeless, displayName: "حضانة النيل", venueType: "nursery" }] }],
    }),
    refusedAsCodeless,
    "a nursery is validated in Direct Orders, never in Marketing",
  );
}
