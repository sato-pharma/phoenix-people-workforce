// Consolidated into the shared canonical geo module (@/lib/geo/egypt-locations),
// which is a strict superset of this file — it adds Arabic-orthography folding,
// town→governorate resolution, and centroid lookup. This path is kept as a thin
// re-export so existing imports keep working.
//
// Note: extractKnownPlace now routes through resolveGovernorate, so it recognises
// far more spellings/towns and returns the shared canonical labels (e.g.
// "Menoufia" rather than "Manoufia"; "New Cairo" folds to "Cairo").
export {
  placeAliases,
  escapeRegExp,
  containsArabic,
  extractKnownPlace,
} from "@/lib/geo/egypt-locations";
