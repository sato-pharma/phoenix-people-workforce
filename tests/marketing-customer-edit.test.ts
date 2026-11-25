import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  buildAddPharmacyEntry,
  canEditMarketingCustomer,
  normalizeCustomerDetailsEdit,
} from "../src/lib/marketing-requests/customer-edit.ts";
import { distributorCodeMatchKey } from "../src/lib/marketing-requests/service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Super Admin edits a customer already on file (owner, 2026-11-25: "make the super admin able
// to open the customer and edit"), and Save Validation finds before it creates.
//
// 25 Nov 2026 23:12: saving Dr Othman El Shewehy a second time, to add one pharmacy, copied him AND
// his four Damietta pharmacies. These pin the pieces that stop that: who may edit, what an edit may
// save, how an "add pharmacy" becomes the one entry the shared save receives, and the key two
// distributor codes are matched under.
// ─────────────────────────────────────────────────────────────────────────────

function access(role: string): AccessContext {
  return { hrId: "B-10", role, scope: "system" } as unknown as AccessContext;
}

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

export function runMarketingCustomerEditTests() {
  // Who may edit. The buttons hiding is UX; this is what every route asks.
  assert.equal(canEditMarketingCustomer(access("Super Admin")), true);
  for (const role of ["CEO", "SFE Manager", "Marketing Manager", "Medical Rep", "District Manager"]) {
    assert.equal(canEditMarketingCustomer(access(role)), false, `${role} must not edit a customer on file`);
  }
  assert.equal(canEditMarketingCustomer(null), false);

  // What the details form may save.
  assert.deepEqual(
    normalizeCustomerDetailsEdit({ displayName: "  Dr  Othman   El Shewehy ", mobileNumber: " 010 1234 5678 ", speciality: "cardiology" }),
    { displayName: "Dr Othman El Shewehy", mobileNumber: "010 1234 5678", speciality: "Cardiology" },
    "spacing is tidied and the speciality is matched to the list's own spelling",
  );
  assert.deepEqual(
    normalizeCustomerDetailsEdit({ displayName: "Dr A", mobileNumber: "", speciality: "" }),
    { displayName: "Dr A", mobileNumber: null, speciality: null },
    "an emptied phone or speciality is saved as not recorded",
  );
  assert.throws(() => normalizeCustomerDetailsEdit({ displayName: "   " }), /needs a name/);
  assert.throws(
    () => normalizeCustomerDetailsEdit({ displayName: "Dr A", speciality: "Astrology" }),
    (error) => code(error) === "unknown_speciality",
  );
  assert.throws(() => normalizeCustomerDetailsEdit({ displayName: "Dr A", mobileNumber: "call me" }), /only digits/);

  // Add a pharmacy ON FILE: the shared save receives only its id, so it is attached, never copied.
  assert.deepEqual(buildAddPharmacyEntry({ pharmacyId: " 47dfbc3f-5ef2-43db-9589-f641d424247b " }, "2026-11-25T21:00:00.000Z"), {
    existingPharmacyId: "47dfbc3f-5ef2-43db-9589-f641d424247b",
  });
  assert.throws(() => buildAddPharmacyEntry({ pharmacyId: "  " }, "x"), /Choose the pharmacy/);

  // Add a NEW pharmacy: a pharmacy, one distributor code, and the map pin is required.
  const pinnedAt = "2026-11-25T21:30:00.000Z";
  const fresh = buildAddPharmacyEntry(
    {
      address: "Hasab Allah El Kafrawy St",
      area: "New Damietta",
      displayName: " Salah El Hol ",
      distributorId: 3,
      governorate: "Damietta",
      latitude: 31.43,
      longitude: 31.67,
      pharmacyCode: " 372045 ",
    },
    pinnedAt,
  ) as unknown as { capturedAt?: string; displayName?: string; vendorCodes?: unknown; venueType?: string };
  assert.equal(fresh.venueType, "pharmacy");
  assert.equal(fresh.displayName, "Salah El Hol");
  assert.equal(fresh.capturedAt, pinnedAt, "the pin carries the moment it was placed, as a desk map pick does");
  assert.deepEqual(fresh.vendorCodes, [{ distributorId: 3, distributorPharmacyCode: "372045" }]);
  const unpinned = { displayName: "X", distributorId: 3, latitude: Number.NaN, longitude: 31, pharmacyCode: "1" };
  assert.throws(() => buildAddPharmacyEntry(unpinned, pinnedAt), /on the map/);
  assert.throws(() => buildAddPharmacyEntry({ ...unpinned, latitude: 120 }, pinnedAt), /on the map/);
  assert.throws(() => buildAddPharmacyEntry({ ...unpinned, latitude: 31, pharmacyCode: " " }, pinnedAt), /code/);

  // The key Save Validation matches a typed code to one already on file under.
  assert.equal(
    distributorCodeMatchKey(7, "0001513103"),
    distributorCodeMatchKey("7", " 1513103 "),
    "Overseas prints leading zeros a rep does not type; both are the same pharmacy",
  );
  assert.notEqual(distributorCodeMatchKey(7, "887"), distributorCodeMatchKey(8, "887"), "the same code at another distributor is another pharmacy");
  assert.equal(distributorCodeMatchKey(7, "000"), "7::0", "a code of zeros keeps one zero rather than becoming empty");
  assert.equal(distributorCodeMatchKey(7, "AB12"), distributorCodeMatchKey(7, "ab12"));

  // The "attach only" switch skips the customer write and revives removed links, so it may come
  // from the server's own call alone — never from what a browser sends.
  for (const route of [
    "app/api/marketing-requests/validation/route.ts",
    "app/api/marketing-requests/validated-customers/[id]/pharmacies/route.ts",
    "app/api/marketing-requests/validated-customers/[id]/edit/route.ts",
  ]) {
    const source = readFileSync(new URL(`../${route}`, import.meta.url), "utf8");
    assert.ok(!source.includes("attachPharmaciesOnly"), `${route} must not pass attachPharmaciesOnly from a request`);
  }
}
