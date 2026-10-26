/**
 * How a stored region or area name is SHOWN. The organogram stores a few names in two spellings of
 * one pattern — "Delta (1)" beside "Upper Egypt 1", "Sohag1" beside "Qena 1" — so a page listing
 * them side by side reads as two naming schemes. Display only: every match, filter and write keeps
 * the stored name or the code, never this one, and the stored names are not renamed (an area holds
 * several teams, .claude/rules/org.md). Names such as "Gharbia 1 (Tanta)" are left exactly as they are.
 *
 *   "Delta (1)" → "Delta 1"     "Sohag1" → "Sohag 1"     "Upper Egypt 1" → unchanged
 */
export function displayPlaceName(name: string): string {
  return name
    .trim()
    .replace(/\s*\((\d+)\)$/u, " $1")
    .replace(/(\p{L})(\d+)$/u, "$1 $2");
}
