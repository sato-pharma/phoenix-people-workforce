import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { composeResidenceFromHiringAddress } from "@/lib/hiring-pack/residence-address";

/**
 * The hiring pack collects a structured address; the residence record needs one.
 *
 * Measured on production 2026-09-28: `employee_hiring_profile` held 188 rows and **not one** had a
 * single address part filled, while five active employees had no usable residence coordinate --
 * four with none at all and one sitting on the generic "Cairo, Egypt" node stamped
 * `geocode_status = 'success'`, 10 km from the Nasr City she actually lives in. Every one of them
 * had an address on file. Nothing connected the two tables, so the pack could have been filled in
 * completely and no coordinate would have moved.
 *
 * The tests below pin the composition and the three things the sync must not do.
 */

export function runHiringPackResidenceAddressTests() {
  // --- it composes the shape the import already writes -------------------------------------

  // Hanan Safwat's real stored address is "ش التحرير - مركز ببا - بني سويف", with area
  // "مركز ببا" and city "بني سويف". A composed address must be indistinguishable from that, or
  // the two paths geocode differently and one of them reads as the odd one out.
  assert.deepEqual(
    composeResidenceFromHiringAddress({
      addressStreet: "ش التحرير",
      addressMarkaz: "مركز ببا",
      addressGovernorate: "بني سويف",
    }),
    {
      residenceAddress: "ش التحرير - مركز ببا - بني سويف",
      residenceArea: "مركز ببا",
      residenceCity: "بني سويف",
    },
  );

  // The building number is the part the pack asks for that the import never had -- it is the
  // whole reason this path is worth wiring, so it must survive into the address.
  assert.equal(
    composeResidenceFromHiringAddress({
      addressBuilding: "12",
      addressStreet: "ش التحرير",
      addressMarkaz: "مركز ببا",
      addressGovernorate: "بني سويف",
    })?.residenceAddress,
    "12 - ش التحرير - مركز ببا - بني سويف",
  );

  // A city address has a district and no markaz; the area takes whichever exists, never both
  // concatenated.
  assert.equal(
    composeResidenceFromHiringAddress({
      addressStreet: "ش عباس العقاد",
      addressDistrict: "مدينة نصر أول",
      addressGovernorate: "القاهرة",
    })?.residenceArea,
    "مدينة نصر أول",
  );
  assert.equal(
    composeResidenceFromHiringAddress({
      addressStreet: "ش عباس العقاد",
      addressDistrict: "مدينة نصر أول",
      addressMarkaz: "مركز ما",
      addressGovernorate: "القاهرة",
    })?.residenceArea,
    "مركز ما",
    "a markaz outranks a district for the area -- they are never joined",
  );

  // --- 🔴 the clobber guard: a half-filled block is NOT an address --------------------------

  // This is the load-bearing assertion. The pack flags building, street and governorate as
  // missing INDEPENDENTLY, so a block holding only a governorate is a normal intermediate state.
  // Composing it would hand the geocoder "بني سويف, Egypt" and overwrite a town-level coordinate
  // with a governorate one 20 km away -- the exact failure this path exists to end.
  assert.equal(
    composeResidenceFromHiringAddress({ addressGovernorate: "بني سويف" }),
    null,
    "a governorate alone must never become a residence address",
  );
  assert.equal(
    composeResidenceFromHiringAddress({
      addressMarkaz: "مركز ببا",
      addressGovernorate: "بني سويف",
    }),
    null,
    "markaz + governorate is still not a street -- it must not overwrite a stored address",
  );
  assert.equal(
    composeResidenceFromHiringAddress({
      addressDistrict: "مدينة نصر أول",
      addressGovernorate: "القاهرة",
    }),
    null,
    "a district is not a street either",
  );

  // Nothing at all, and whitespace that looks like something.
  assert.equal(composeResidenceFromHiringAddress({}), null);
  assert.equal(
    composeResidenceFromHiringAddress({
      addressStreet: "   ",
      addressBuilding: "\t",
      addressGovernorate: "بني سويف",
    }),
    null,
    "whitespace is not a street",
  );

  // A building with no street IS specific enough -- a tower block name places a home.
  assert.equal(
    composeResidenceFromHiringAddress({
      addressBuilding: "ابراج الحمام",
      addressGovernorate: "سوهاج",
    })?.residenceAddress,
    "ابراج الحمام - سوهاج",
  );

  // --- the wiring, not just the rule --------------------------------------------------------

  const serviceSource = readFileSync(
    new URL("../src/lib/hiring-pack/service.ts", import.meta.url),
    "utf8",
  );

  // Scoped to the function body, not the file: an import at the top would satisfy a whole-file
  // `includes` while the save never called it, which is precisely how this feature was dead for
  // 188 profiles in the first place.
  const saveFn = serviceSource.slice(
    serviceSource.indexOf("export async function saveHiringPackProfile"),
  );
  const syncAt = saveFn.indexOf("syncResidenceFromHiringAddress(hrId, input)");
  const returnAt = saveFn.indexOf("return getHiringPack(hrId);");
  assert.ok(
    syncAt > 0,
    "saveHiringPackProfile must call the residence sync, or the address block goes nowhere",
  );
  assert.ok(syncAt < returnAt, "the sync must run before the pack is re-read and returned");

  const syncFn = serviceSource.slice(
    serviceSource.indexOf("async function syncResidenceFromHiringAddress"),
  );

  // It must skip an unchanged address. Without this, every contract save re-geocodes -- the same
  // bug `residenceUnchanged` was written to close on the Employee Management form.
  assert.ok(
    syncFn.includes("=== composed.residenceAddress"),
    "the sync must compare against the stored address and skip when unchanged",
  );

  // It must go through the shared writer, never its own upsert: the coordinate-omission rule
  // lives there and a second copy would drift silently.
  assert.ok(
    syncFn.includes("writeEmployeeResidenceLocation(hrId, composed)"),
    "the sync must reuse writeEmployeeResidenceLocation, not carry its own residence upsert",
  );
  assert.ok(
    !syncFn.slice(0, syncFn.indexOf("\n}")).includes("residence_latitude"),
    "the sync must not write coordinate columns itself",
  );

  // It must not fail the profile save.
  assert.ok(
    syncFn.includes("catch (syncError)"),
    "a geocoder outage must not reject a contract save",
  );

  // And the shared writer must still be the one holding the omission rule.
  const directorySource = readFileSync(
    new URL("../src/lib/employees/employee-directory.ts", import.meta.url),
    "utf8",
  );
  const writerFn = directorySource.slice(
    directorySource.indexOf("export async function writeEmployeeResidenceLocation"),
  );
  assert.ok(
    writerFn.includes("residenceCoordinateColumns(geocoded)"),
    "writeEmployeeResidenceLocation must keep using residenceCoordinateColumns -- a null "
    + "coordinate under merge-duplicates overwrites a good stored one",
  );
}
