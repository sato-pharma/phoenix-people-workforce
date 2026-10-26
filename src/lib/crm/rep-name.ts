// ─────────────────────────────────────────────────────────────────────────────
// A CRM agent name is a LOGIN HANDLE with a territory bolted on the end —
// `"Aisha.Ehab ( Minia 2 / E )"` — because that is literally what the vendor
// stores in `agent_name`. Two boards need to take it apart, so the taking-apart
// lives here once rather than as a regex copied into each of them.
//
// The pattern is anchored at the END on purpose: a bracket in the middle of a
// name is part of the name, not a territory. `"( Behira 2 / C )"` — a handle
// that is territory and nothing else, six of which exist in production — yields
// an empty name half, which every caller must therefore be willing to reject.
// ─────────────────────────────────────────────────────────────────────────────

/** The trailing `( … )` group, anchored at the end so a mid-name bracket is never eaten. */
const CRM_TERRITORY = /\(\s*([^()]+?)\s*\)\s*$/;

/** The territory a CRM agent name carries, or null when it carries none. */
export function crmTerritoryFrom(crmName: string | undefined | null): string | null {
  if (!crmName) return null;
  const territory = CRM_TERRITORY.exec(crmName)?.[1]?.trim();
  return territory ? territory : null;
}

/**
 * Split a CRM agent name into the person half and the territory half.
 *
 * Why this exists at all: a mobile record card WRAPS its title below `md`, and that wrap is
 * deliberate — #2268 (2026-08-21) chose it over `whitespace-nowrap`, which pushed a 375px phone
 * page out to 455px of sideways scroll, and over an ellipsis, which the owner rejects everywhere.
 * So the way to stop a rep name wrapping is not to fight the wrap: it is to stop making the string
 * long. `"Adel.Srour ( Down-town / C )"` is 28 characters; `"Adel.Srour"` is 10, and the territory
 * loses nothing by sitting on the card's own meta line, one row below, where it is still read.
 *
 * `name` is never empty when the input has any non-bracket text. When the whole handle is a
 * territory the name half comes back empty and the caller decides — this returns what is there
 * rather than inventing a label for it.
 */
export function splitCrmRepName(crmName: string | undefined | null): {
  name: string;
  territory: string | null;
} {
  const raw = crmName?.trim() ?? "";
  const territory = crmTerritoryFrom(raw);
  if (!territory) return { name: raw, territory: null };
  return { name: raw.replace(CRM_TERRITORY, "").trim(), territory };
}

/**
 * The words a screen shows for a CRM agent handle when no HR name is at hand. The territory group
 * is taken off (`"Aisha.Ehab ( Minia 2 / E )"` → `"Aisha.Ehab"`); a handle that is a territory and
 * nothing else (`"( Alex Center 2 / P )"`, owner's NSM audit 2026-10-26) reads `"Alex Center 2 rep"`
 * — the line letter after the slash is the CRM's code, not a word anyone reads.
 */
export function crmRepDisplayName(crmName: string | undefined | null): string | null {
  const { name, territory } = splitCrmRepName(crmName);
  if (name) return name;
  if (!territory) return null;
  const place = territory.replace(/\s*\/\s*[^/]*$/, "").trim();
  return place ? `${place} rep` : null;
}
