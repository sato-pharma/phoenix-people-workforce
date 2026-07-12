// Consolidated into the shared canonical geo module. This path is kept as a thin
// re-export so existing imports keep working. See @/lib/geo/egypt-locations.
export {
  resolveGovernorate,
  canonicalizeLocation,
  canonicalizeTransport,
} from "@/lib/geo/egypt-locations";
