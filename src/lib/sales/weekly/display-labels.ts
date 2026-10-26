// Weekly Sales — the words a screen prints for a region, a distributor and an area.
//
// DISPLAY ONLY. The stored spellings stay exactly as the sheets and the area master carry them
// ("overseas", "Ibn sina", "Sohag1", "October -Zayed", "Port said - Domiat"): codes, stored names and the
// area names the branch-area split matches governorates by are never rewritten, and nothing here may feed a
// join, a filter key or a workbook cell that is matched back to the data. A label is for a person's eyes.
//
// Client-safe on purpose (no server imports): the portal dashboard and its sibling views run it in the browser.

import { tidyAllCapitalsName } from "@/lib/employees/display-name";
import { WEEKLY_DISTRIBUTORS, weeklyDistributorByCode } from "@/lib/sales/weekly/distributors";

/** Letters and digits only, lower case — so "Ibn Sina-Lacto" and the registry's "Ibn Sina Lacto" are one key. */
function nameKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function squash(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Upper-cases the first letter of every word that starts in lower case; a word with any capital is left alone. */
function capitaliseLowerWords(value: string): string {
  return value.replace(/(^|[\s\-(/])([a-z])/g, (_match, edge: string, letter: string) => edge + letter.toUpperCase());
}

/**
 * A region's label. A region typed entirely in capitals ("UPPER EGYPT") reads in title case; any other
 * spelling — "Alex-BHR", "Delta (1)", "Upper Egypt 2" — is somebody's choice and is returned as stored.
 */
export function weeklyRegionLabel(name: string | null | undefined): string {
  return tidyAllCapitalsName(squash(name));
}

/**
 * A person's name as a screen prints it. A name stored entirely in capitals ("SAHAR EL GALLAD") reads in title
 * case; a name with any lower-case letter, and every Arabic name, is returned as stored.
 */
export function weeklyPersonLabel(name: string | null | undefined): string {
  return tidyAllCapitalsName(squash(name));
}

const DISTRIBUTOR_BY_NAME_KEY: ReadonlyMap<string, string> = new Map(
  WEEKLY_DISTRIBUTORS.map((distributor) => [nameKey(distributor.name), distributor.name] as const),
);

/**
 * A distributor's label. The registry (`WEEKLY_DISTRIBUTORS`) is the one list of canonical names, so the CODE
 * decides when the screen has it ("IS" → "Ibn Sina", "RM" → "RAMCO", "PS" → "Overseas"); a screen that holds only
 * the stored name is matched to the registry ignoring case, spaces and hyphens ("Ibn Sina-Lacto" → "Ibn Sina
 * Lacto"). A distributor the registry has never heard of keeps its stored words, capitalised.
 */
export function weeklyDistributorLabel(storedName: string | null | undefined, code?: string | null): string {
  const stored = squash(storedName);
  const byCode = code ? weeklyDistributorByCode(code) : undefined;
  if (byCode) return byCode.name;
  const byName = DISTRIBUTOR_BY_NAME_KEY.get(nameKey(stored));
  if (byName) return byName;
  return capitaliseLowerWords(tidyAllCapitalsName(stored));
}

/** An upload option reads "<distributor> · <date> · W<n>"; only its distributor part is a name to relabel. */
function weeklyUploadLabel(optionName: string): string {
  const [first, ...rest] = optionName.split(" · ");
  return [weeklyDistributorLabel(first), ...rest].join(" · ");
}

// The area master and the sheets spell a few places in ways nobody wants to read.
const AREA_SPELLINGS: readonly (readonly [RegExp, string])[] = [[/\bDomiat\b/gi, "Damietta"]];

/**
 * An area's label: "Sohag1" → "Sohag 1", "October -Zayed" → "October - Zayed", "Port said - Domiat" →
 * "Port Said - Damietta". Reads the stored name only — the governorate matching in branch-area-split.ts keeps
 * working on the stored spelling and never sees this.
 */
export function weeklyAreaLabel(name: string | null | undefined): string {
  let label = tidyAllCapitalsName(squash(name));
  // A number glued to the word before it: "Sohag1" → "Sohag 1".
  label = label.replace(/([A-Za-z])(\d+)(?=\s|-|$)/g, "$1 $2");
  // A dash with a space on one side only: "October -Zayed" → "October - Zayed". A tight "Alex-BHR" is left alone.
  label = label.replace(/\s+-\s*|\s*-\s+/g, " - ");
  label = capitaliseLowerWords(label);
  for (const [pattern, replacement] of AREA_SPELLINGS) label = label.replace(pattern, replacement);
  return label;
}

type Named = { name: string };
type CodedName = { code: string; name: string };

/**
 * The Weekly Sales dashboard payload with every region and distributor NAME relabelled for the screen. Codes,
 * counts and figures are carried through untouched. Returns the same object type, so a caller swaps it in where
 * the raw payload sat.
 */
export function labelWeeklyDashboardNames<
  T extends {
    availableRegions: CodedName[];
    availableUploads: Named[];
    distributors: CodedName[];
    regions: CodedName[];
    distributorBreakdown: CodedName[];
    branchBreakdown: { regionName: string }[];
    zeroSalesBranches: { regionName: string }[];
  },
>(data: T): T {
  const region = <R extends CodedName>(row: R): R => ({ ...row, name: weeklyRegionLabel(row.name) });
  const distributor = <R extends CodedName>(row: R): R => ({ ...row, name: weeklyDistributorLabel(row.name, row.code) });
  return {
    ...data,
    availableRegions: data.availableRegions.map(region),
    availableUploads: data.availableUploads.map((row) => ({ ...row, name: weeklyUploadLabel(row.name) })),
    distributors: data.distributors.map(distributor),
    regions: data.regions.map(region),
    distributorBreakdown: data.distributorBreakdown.map(distributor),
    branchBreakdown: data.branchBreakdown.map((row) => ({ ...row, regionName: weeklyRegionLabel(row.regionName) })),
    zeroSalesBranches: data.zeroSalesBranches.map((row) => ({ ...row, regionName: weeklyRegionLabel(row.regionName) })),
  };
}
