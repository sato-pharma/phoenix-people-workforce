import assert from "node:assert/strict";

import { createAccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  assertMarketingOnBehalfAccess,
  buildMarketingOnBehalfEmployees,
  canValidateMarketingOnBehalf,
  normalizeMarketingValidationInput,
  resolveMarketingSystemValidationStatus,
  resolveMarketingValidationActor,
  resolveMarketingValidationRecordStatus,
} from "@/lib/marketing-requests/service";
import type { MarketingValidationInput } from "@/lib/marketing-requests/types";

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
        referenceStatus: "not_found",
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
      evidencePhotoName: "pharmacy-sign.jpg",
      extractedAreaName: "Glim",
      extractedGovernorateName: "Alexandria",
      regionName: "Alexandria",
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
  const normalized = normalizeMarketingValidationInput(completeInput);
  assert.equal(normalized.customer.evidenceStatus, "complete");
  assert.equal(normalized.customer.extractedAreaName, "Glim");
  assert.equal(normalized.customer.extractedGovernorateName, "Alexandria");
  assert.equal(normalized.customer.validationStatus, "system_validated");
  assert.equal(normalized.customer.mobileNumber, "01000000000");
  assert.equal(normalized.pharmacies[0].evidenceStatus, "complete");
  assert.equal(normalized.pharmacies[0].extractedAreaName, "Glim");
  assert.equal(normalized.pharmacies[0].extractedGovernorateName, "Alexandria");
  assert.equal(normalized.pharmacies[0].validationStatus, "system_validated");
  assert.equal(normalized.pharmacies[0].vendorCodes.length, 2);
  assert.equal(normalized.pharmacies[0].vendorCodes[0].distributorPharmacyCode, "PH-001");
  assert.equal(normalized.pharmacies[0].vendorCodes[0].normalizedPharmacyCode, "ph-001");

  assert.equal(
    resolveMarketingSystemValidationStatus({
      customerEvidenceStatus: "complete",
      pharmacyEvidenceStatus: "complete",
      referenceStatus: "matched",
    }),
    "system_validated",
  );

  assert.equal(
    resolveMarketingSystemValidationStatus({
      customerEvidenceStatus: "complete",
      pharmacyEvidenceStatus: "complete",
      referenceStatus: "not_found",
    }),
    "pending",
  );

  assert.equal(
    resolveMarketingSystemValidationStatus({
      customerEvidenceStatus: "pending",
      pharmacyEvidenceStatus: "complete",
      referenceStatus: "matched",
    }),
    "pending",
  );

  const partial = normalizeMarketingValidationInput({
    ...completeInput,
    pharmacies: completeInput.pharmacies?.map((pharmacy) => ({
      ...pharmacy,
      capturedAt: null,
      evidencePhotoName: "",
    })),
  });
  assert.equal(partial.pharmacies[0].evidenceStatus, "pending");
  assert.equal(partial.pharmacies[0].validationStatus, "pending");

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
          ...completeInput.customer,
          displayName: "",
        },
      }),
    /customer name is required/i,
  );

  runMarketingOnBehalfValidationTests();
}
