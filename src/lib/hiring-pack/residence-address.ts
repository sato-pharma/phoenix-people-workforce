// The hiring pack's structured address block, turned into a residence record.
//
// Why this exists. On 2026-09-28 five active employees had no usable residence coordinate: four
// had none at all, and one sat on the generic "Cairo, Egypt" node stamped `geocode_status =
// 'success'`. Every one of them HAD an address on file. The problem was that the only address the
// residence record ever sees is a single free-text string typed at import — "ش التحرير - مركز ببا
// - بني سويف" — which a geocoder places to a town at best.
//
// Meanwhile the hiring pack ALREADY collects a structured address for social-insurance Form 1. It
// names the fields (`Building number`, `Street`, `Governorate`), flags them as missing until they
// are filled, reads all five columns and writes all five columns. On that date 0 of 188 profiles
// had a single part filled — and nothing connected `employee_hiring_profile` to
// `employee_locations` even if they had, so filling one would never have reached the other.
//
// The composition is PURE and lives apart from the service so the rule that makes it safe can be
// asserted without a Supabase client or a live geocoder — the same reason
// `residence-geocode-policy.ts` was extracted after an employee save destroyed data.

export type HiringAddressParts = {
  addressBuilding?: string | null;
  addressDistrict?: string | null;
  addressGovernorate?: string | null;
  addressMarkaz?: string | null;
  addressStreet?: string | null;
};

export type ComposedResidence = {
  residenceAddress: string;
  residenceArea: string | null;
  residenceCity: string | null;
};

function clean(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

/**
 * The residence this address block describes, or `null` when it describes no particular place.
 *
 * 🔴 Returns null unless a STREET or a BUILDING is present, and that is the load-bearing rule.
 *
 * The pack flags building, street and governorate as missing *independently*, so a half-filled
 * block holding only "بني سويف" is a normal intermediate state, not an error. Composing one would
 * hand the geocoder a governorate name and overwrite a stored "ش التحرير - مركز ببا - بني سويف"
 * with it — turning a town-level coordinate into a governorate-level one 20 km away, which is the
 * exact failure this whole path exists to end. A residence may only ever be made MORE specific
 * through here, never less.
 *
 * The joined shape deliberately matches what the import already writes (street - markaz -
 * governorate), so a composed address and an imported one geocode identically and neither reads
 * as the odd one out on screen.
 */
export function composeResidenceFromHiringAddress(
  parts: HiringAddressParts,
): ComposedResidence | null {
  const building = clean(parts.addressBuilding);
  const street = clean(parts.addressStreet);
  const district = clean(parts.addressDistrict);
  const markaz = clean(parts.addressMarkaz);
  const governorate = clean(parts.addressGovernorate);

  if (!street && !building) return null;

  const residenceAddress = [building, street, district, markaz, governorate]
    .filter((part): part is string => Boolean(part))
    .join(" - ");

  return {
    residenceAddress,
    // `markaz` is the administrative unit the import stores as the area; `district` is the urban
    // equivalent for a city address that has no markaz. One of the two, never both concatenated.
    residenceArea: markaz ?? district,
    residenceCity: governorate,
  };
}
