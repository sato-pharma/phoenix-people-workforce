import assert from "node:assert/strict";

import {
  normalizeMarketingValidationInput,
  resolveMarketingSystemValidationStatus,
} from "@/lib/marketing-requests/service";
import type { MarketingValidationInput } from "@/lib/marketing-requests/types";

const timestamp = "2026-05-21T10:00:00.000Z";

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
}
