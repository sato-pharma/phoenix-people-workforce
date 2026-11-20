import { foldCustomerName } from "@/lib/customer-master/name-key";
import type { BrickUniverseEntry, PharmacyActionItem } from "@/lib/sales/sos-pharmacy-actions";

// ─────────────────────────────────────────────────────────────────────────────
// The advanced filters on "Where my sales come from" and its sheet (owner, 2026-11-20: "an option
// of filtration of duration and … bricks, advanced filtering"). Pure, shared by the screen and the
// download route, so the sheet holds exactly the pharmacies the screen's filters describe.
//
// 🔴 A filter only NARROWS a list the viewer's scope already produced — it never widens it, and it is
// never a second rule for stopped / dropping / new. Brick is matched by NAME (the screen shows names,
// never codes); search reads the pharmacy's name, address and brick through the one customer name
// key (foldCustomerName), with ة read as ه for a person typing.
// ─────────────────────────────────────────────────────────────────────────────

export type PharmacyChannel = "direct" | "distributor";

export type PharmacyListFilter = {
  /** One area code (the screen's area pick). */
  areaCode?: string | null;
  /** One brick, by name. */
  brickName?: string | null;
  channel?: PharmacyChannel | null;
  /** Free text over name, address and brick. */
  search?: string | null;
};

export function readChannel(value: string | null | undefined): PharmacyChannel | null {
  return value === "direct" || value === "distributor" ? value : null;
}

/**
 * The one customer name key (foldCustomerName: alef forms, ى, harakat, tatweel, case, punctuation),
 * plus ة → ه for SEARCH only: a person typing "صيدليه" means "صيدلية". The key itself keeps the two
 * apart on purpose, so this extra step never reaches a match or a merge — only this filter.
 */
export function foldSearchText(value: string | null | undefined): string {
  return foldCustomerName(value).replace(/ة/g, "ه");
}

const sameName = (left: string | null | undefined, right: string | null | undefined) =>
  foldSearchText(left) === foldSearchText(right);

/** Any of brick, channel or search set. The area pick is the screen's own scope switch, not one of these. */
export function hasListFilter(filter: PharmacyListFilter): boolean {
  return Boolean(filter.brickName?.trim() || filter.channel || filter.search?.trim());
}

export function filterPharmacyItems<T extends PharmacyActionItem>(items: readonly T[], filter: PharmacyListFilter): T[] {
  const area = filter.areaCode?.trim().toUpperCase() || null;
  const brick = filter.brickName?.trim() || null;
  const words = foldSearchText(filter.search).split(" ").filter(Boolean);
  return items.filter((item) => {
    if (area && item.areaCode.toUpperCase() !== area) return false;
    if (brick && !sameName(item.brickName, brick)) return false;
    if (filter.channel === "direct" && !item.isDirect) return false;
    if (filter.channel === "distributor" && item.isDirect) return false;
    if (words.length > 0) {
      const haystack = foldSearchText(`${item.name} ${item.address} ${item.brickName}`);
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    return true;
  });
}

/** Untapped bricks have no pharmacy: area and brick narrow them, search reads the brick's name, channel has nothing to say. */
export function filterBricks(bricks: readonly BrickUniverseEntry[], filter: PharmacyListFilter): BrickUniverseEntry[] {
  const area = filter.areaCode?.trim().toUpperCase() || null;
  const brick = filter.brickName?.trim() || null;
  const words = foldSearchText(filter.search).split(" ").filter(Boolean);
  if (filter.channel) return [];
  return bricks.filter((entry) => {
    if (area && entry.areaCode.toUpperCase() !== area) return false;
    if (brick && !sameName(entry.brickName, brick)) return false;
    if (words.length > 0 && !words.every((word) => foldSearchText(entry.brickName).includes(word))) return false;
    return true;
  });
}

/** Every brick name the given lists reach, once, A to Z — the Brick picker's options. */
export function brickOptionsOf(lists: readonly (readonly { brickName: string }[])[]): string[] {
  const byFolded = new Map<string, string>();
  for (const list of lists) {
    for (const entry of list) {
      const name = entry.brickName?.trim();
      if (name && !byFolded.has(foldSearchText(name))) byFolded.set(foldSearchText(name), name);
    }
  }
  return [...byFolded.values()].sort((left, right) => left.localeCompare(right));
}

/** The filter in plain words for the sheet's subtitle; empty when nothing is set. */
export function listFilterWords(filter: PharmacyListFilter): string {
  return [
    filter.brickName?.trim() ? `brick ${filter.brickName.trim()}` : null,
    filter.channel === "direct" ? "direct orders only" : filter.channel === "distributor" ? "distributor orders only" : null,
    filter.search?.trim() ? `matching “${filter.search.trim()}”` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
