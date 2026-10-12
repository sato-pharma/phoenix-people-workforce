/**
 * Location integrity — what the filter bar narrows by, and how a view of the board survives a reload.
 *
 * The owner asked to "be able to filter by every possible thing" (2026-10-13) and then picked every
 * group when they were put to him: rep · line · area · region · the visit day · the day it was filed
 * · the detector · the finding · strong or corroborating · open, settled or withdrawn · whether a
 * photograph is kept · customer · speciality · AM or PM · how far apart the readings are · free text.
 *
 * Pure and screen-free, modelled on `validation-review-filters.ts`, which is already proven on a
 * loaded-list board of this module: the view stays a thin shell of state and controls, and every rule
 * here is pinned by a test instead of being clicked through.
 *
 * 🔴 EVERY DROPDOWN IS DERIVED FROM THE ROWS, NEVER WRITTEN OUT. A fixed list of lines or
 * specialities goes stale the week somebody adds one, and a filter offering a value no case carries
 * reads as "no cases" when it means "no such value".
 */

import { distinctValues } from "@/lib/phoenix-crm/validation-review-filters";

/** Whether the finding stands on its own or only alongside others. */
export type IntegrityStrength = "all" | "strong" | "corroborating";

/** Where the case sits: nobody has decided it, the Super Admin has, or its own evidence gave way. */
export type IntegrityStanding = "all" | "open" | "settled" | "withdrawn";

/** Whether a photograph is kept for the case. "None kept" is an ordinary answer, not a gap. */
export type IntegrityPhoto = "all" | "kept" | "none";

/**
 * How far apart the case's own readings are.
 *
 * `identical` is its own band deliberately: *the photograph and the pin are the same reading* is the
 * single commonest finding on this board (130 of 164 cases, read on production 13 October 2026), and
 * folding it into "nearby" would make the one band he most needs to set aside unreachable.
 */
export type IntegrityDistanceBand = "all" | "identical" | "nearby" | "apart" | "far";

/** Metres: the upper edge of `nearby`, about a building and its forecourt. */
export const NEARBY_METRES = 100;
/** Metres: the upper edge of `apart` — still inside one town. */
export const APART_METRES = 1_000;

export type IntegrityFilters = {
  rep: string;
  line: string;
  area: string;
  region: string;
  source: string;
  flag: string;
  strength: IntegrityStrength;
  standing: IntegrityStanding;
  photo: IntegrityPhoto;
  customer: string;
  speciality: string;
  list: string;
  distance: IntegrityDistanceBand;
  /** The day the capture happened, as `yyyy-mm-dd`; either end may stand alone. */
  visitFrom: string;
  visitTo: string;
  /** The day the nightly pass filed the case. */
  filedFrom: string;
  filedTo: string;
  text: string;
};

export const EMPTY_INTEGRITY_FILTERS: IntegrityFilters = {
  rep: "",
  line: "",
  area: "",
  region: "",
  source: "",
  flag: "",
  strength: "all",
  standing: "all",
  photo: "all",
  customer: "",
  speciality: "",
  list: "",
  distance: "all",
  visitFrom: "",
  visitTo: "",
  filedFrom: "",
  filedTo: "",
  text: "",
};

/**
 * What every filterable row carries. The view builds one of these per case, from the loaded board
 * plus the two pure modules beside this one — so a filter reads the same words the reader does.
 */
export type IntegrityFilterable = {
  repName: string;
  repLine: string | null;
  repArea: string | null;
  repRegion: string | null;
  customerName: string;
  customerList: string | null;
  customerSpeciality: string | null;
  subjectLabel: string | null;
  brickName: string | null;
  /** The detector's own code, and the words it reads as — the dropdown offers the words. */
  source: string;
  sourceLabel: string;
  flags: ReadonlyArray<string>;
  /** Each finding in plain English. Both the dropdown and the free-text box read these. */
  reasons: ReadonlyArray<string>;
  strong: boolean;
  standing: "open" | "settled" | "withdrawn";
  hasPhoto: boolean;
  /** `yyyy-mm-dd`, Cairo. Null when the capture carries no visit day of its own. */
  visitDay: string | null;
  filedDay: string | null;
  /** The metres between the two readings furthest apart; null when the case has fewer than two. */
  spreadMeters: number | null;
  headline: string;
  story: ReadonlyArray<string>;
};

/** Which band a spread falls in. A case with fewer than two readings is in no band at all. */
export function integrityDistanceBandOf(spreadMeters: number | null): Exclude<IntegrityDistanceBand, "all"> | null {
  if (spreadMeters === null || !Number.isFinite(spreadMeters)) return null;
  if (spreadMeters <= 0) return "identical";
  if (spreadMeters <= NEARBY_METRES) return "nearby";
  if (spreadMeters <= APART_METRES) return "apart";
  return "far";
}

/** The words each band reads as on the screen. */
export const INTEGRITY_DISTANCE_BAND_LABELS: Record<IntegrityDistanceBand, string> = {
  all: "Any distance",
  identical: "The same reading, to the bit",
  nearby: `Within ${NEARBY_METRES} m`,
  apart: `${NEARBY_METRES} m to 1 km apart`,
  far: "More than 1 km apart",
};

export const INTEGRITY_STRENGTH_LABELS: Record<IntegrityStrength, string> = {
  all: "Strong and corroborating",
  strong: "Strong on its own",
  corroborating: "Corroborating only",
};

export const INTEGRITY_STANDING_LABELS: Record<IntegrityStanding, string> = {
  all: "Open, settled and withdrawn",
  open: "Nobody has decided it",
  settled: "Settled",
  withdrawn: "The evidence gave way",
};

export const INTEGRITY_PHOTO_LABELS: Record<IntegrityPhoto, string> = {
  all: "With and without a photograph",
  kept: "A photograph is kept",
  none: "No photograph kept",
};

/**
 * Every value the loaded board actually holds, per dropdown.
 *
 * The flag list is offered in the reader's words (`reasons`), not as codes — he decides about a
 * finding, and `photo_pin_identical` is not a finding, it is a column name.
 */
export function integrityFilterOptions(rows: ReadonlyArray<IntegrityFilterable>): {
  reps: string[];
  lines: string[];
  areas: string[];
  regions: string[];
  sources: string[];
  reasons: string[];
  customers: string[];
  specialities: string[];
  lists: string[];
} {
  return {
    reps: distinctValues(rows.map((row) => row.repName)),
    lines: distinctValues(rows.map((row) => row.repLine)),
    areas: distinctValues(rows.map((row) => row.repArea)),
    regions: distinctValues(rows.map((row) => row.repRegion)),
    sources: distinctValues(rows.map((row) => row.sourceLabel)),
    reasons: distinctValues(rows.flatMap((row) => [...row.reasons])),
    customers: distinctValues(rows.map((row) => row.customerName)),
    specialities: distinctValues(rows.map((row) => row.customerSpeciality)),
    lists: distinctValues(rows.map((row) => row.customerList)),
  };
}

/** Whether a day sits inside a `from`/`to` pair, where either end may be empty. Both ends are inclusive. */
function withinDays(day: string | null, from: string, to: string): boolean {
  if (from === "" && to === "") return true;
  // A row with no day of its own is kept only while neither end is set: dropping it would hide a case
  // because of a field it never had, and the reader would never know it had been narrowed away.
  if (day === null || day === "") return false;
  if (from !== "" && day < from) return false;
  if (to !== "" && day > to) return false;
  return true;
}

/** Whether a row passes every filter that is set. */
export function matchesIntegrityFilters(row: IntegrityFilterable, filters: IntegrityFilters): boolean {
  if (filters.rep !== "" && row.repName !== filters.rep) return false;
  if (filters.line !== "" && (row.repLine ?? "") !== filters.line) return false;
  if (filters.area !== "" && (row.repArea ?? "") !== filters.area) return false;
  if (filters.region !== "" && (row.repRegion ?? "") !== filters.region) return false;
  if (filters.source !== "" && row.sourceLabel !== filters.source) return false;
  if (filters.flag !== "" && !row.reasons.includes(filters.flag)) return false;
  if (filters.strength === "strong" && !row.strong) return false;
  if (filters.strength === "corroborating" && row.strong) return false;
  if (filters.standing !== "all" && row.standing !== filters.standing) return false;
  if (filters.photo === "kept" && !row.hasPhoto) return false;
  if (filters.photo === "none" && row.hasPhoto) return false;
  if (filters.customer !== "" && row.customerName !== filters.customer) return false;
  if (filters.speciality !== "" && (row.customerSpeciality ?? "") !== filters.speciality) return false;
  if (filters.list !== "" && (row.customerList ?? "") !== filters.list) return false;
  if (filters.distance !== "all" && integrityDistanceBandOf(row.spreadMeters) !== filters.distance) return false;
  if (!withinDays(row.visitDay, filters.visitFrom, filters.visitTo)) return false;
  if (!withinDays(row.filedDay, filters.filedFrom, filters.filedTo)) return false;
  const wanted = filters.text.trim().toLowerCase();
  if (wanted !== "") {
    const haystack: Array<string | null> = [
      row.repName,
      row.customerName,
      row.subjectLabel,
      row.brickName,
      row.repLine,
      row.repArea,
      row.repRegion,
      row.customerSpeciality,
      row.sourceLabel,
      row.headline,
      ...row.reasons,
      ...row.story,
    ];
    if (!haystack.some((value) => typeof value === "string" && value.toLowerCase().includes(wanted))) return false;
  }
  return true;
}

/** Whether anything is narrowing the board — what the "Clear" control and the chip row ask. */
export function hasActiveIntegrityFilter(filters: IntegrityFilters): boolean {
  return (
    filters.rep !== "" ||
    filters.line !== "" ||
    filters.area !== "" ||
    filters.region !== "" ||
    filters.source !== "" ||
    filters.flag !== "" ||
    filters.strength !== "all" ||
    filters.standing !== "all" ||
    filters.photo !== "all" ||
    filters.customer !== "" ||
    filters.speciality !== "" ||
    filters.list !== "" ||
    filters.distance !== "all" ||
    filters.visitFrom !== "" ||
    filters.visitTo !== "" ||
    filters.filedFrom !== "" ||
    filters.filedTo !== "" ||
    filters.text.trim() !== ""
  );
}

// ── The URL mirror ──────────────────────────────────────────────────────────────────────────────
//
// He asked for both halves: the filters narrow the screen instantly, and they are also written into
// the address, so a view survives a reload and can be kept. The keys are short because they end up
// in a URL he may paste to himself, and they are STABLE — a kept link must keep working.

const KEYS = {
  rep: "rep",
  line: "line",
  area: "area",
  region: "region",
  source: "src",
  flag: "flag",
  strength: "str",
  standing: "stand",
  photo: "photo",
  customer: "cust",
  speciality: "spec",
  list: "list",
  distance: "dist",
  visitFrom: "vfrom",
  visitTo: "vto",
  filedFrom: "ffrom",
  filedTo: "fto",
  text: "q",
} as const satisfies Record<keyof IntegrityFilters, string>;

/** Every query key this board owns — what a caller clears before writing a fresh view. */
export const INTEGRITY_FILTER_KEYS: ReadonlyArray<string> = Object.values(KEYS);

type ParamBag = URLSearchParams | Record<string, string | string[] | undefined>;

function readParam(params: ParamBag, key: string): string {
  if (params instanceof URLSearchParams) return params.get(key) ?? "";
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function oneOf<T extends string>(value: string, allowed: ReadonlyArray<T>, fallback: T): T {
  return (allowed as ReadonlyArray<string>).includes(value) ? (value as T) : fallback;
}

/**
 * The filters a URL asks for.
 *
 * An unknown value for a fixed group falls back to "all" rather than narrowing to nothing: a
 * hand-edited or half-truncated link must show the board, never an empty screen that reads as
 * "no cases".
 */
export function integrityFiltersFromParams(params: ParamBag): IntegrityFilters {
  return {
    rep: readParam(params, KEYS.rep),
    line: readParam(params, KEYS.line),
    area: readParam(params, KEYS.area),
    region: readParam(params, KEYS.region),
    source: readParam(params, KEYS.source),
    flag: readParam(params, KEYS.flag),
    strength: oneOf(readParam(params, KEYS.strength), ["all", "strong", "corroborating"] as const, "all"),
    standing: oneOf(readParam(params, KEYS.standing), ["all", "open", "settled", "withdrawn"] as const, "all"),
    photo: oneOf(readParam(params, KEYS.photo), ["all", "kept", "none"] as const, "all"),
    customer: readParam(params, KEYS.customer),
    speciality: readParam(params, KEYS.speciality),
    list: readParam(params, KEYS.list),
    distance: oneOf(readParam(params, KEYS.distance), ["all", "identical", "nearby", "apart", "far"] as const, "all"),
    visitFrom: readParam(params, KEYS.visitFrom),
    visitTo: readParam(params, KEYS.visitTo),
    filedFrom: readParam(params, KEYS.filedFrom),
    filedTo: readParam(params, KEYS.filedTo),
    text: readParam(params, KEYS.text),
  };
}

/**
 * The query string for a set of filters — only what is actually set, so a board with nothing narrowed
 * has a clean address. Round-trips through `integrityFiltersFromParams` exactly.
 */
export function integrityFiltersToQuery(filters: IntegrityFilters): URLSearchParams {
  const query = new URLSearchParams();
  const put = (key: string, value: string): void => {
    if (value !== "") query.set(key, value);
  };
  put(KEYS.rep, filters.rep);
  put(KEYS.line, filters.line);
  put(KEYS.area, filters.area);
  put(KEYS.region, filters.region);
  put(KEYS.source, filters.source);
  put(KEYS.flag, filters.flag);
  if (filters.strength !== "all") query.set(KEYS.strength, filters.strength);
  if (filters.standing !== "all") query.set(KEYS.standing, filters.standing);
  if (filters.photo !== "all") query.set(KEYS.photo, filters.photo);
  put(KEYS.customer, filters.customer);
  put(KEYS.speciality, filters.speciality);
  put(KEYS.list, filters.list);
  if (filters.distance !== "all") query.set(KEYS.distance, filters.distance);
  put(KEYS.visitFrom, filters.visitFrom);
  put(KEYS.visitTo, filters.visitTo);
  put(KEYS.filedFrom, filters.filedFrom);
  put(KEYS.filedTo, filters.filedTo);
  put(KEYS.text, filters.text.trim());
  return query;
}

/**
 * The filters that are set, each as one short phrase for a removable chip, with the key that clears it.
 *
 * The key is `keyof IntegrityFilters` rather than the URL spelling: the chip's job is to put one field
 * back to its empty value, and the URL is written from the filters afterwards.
 */
export function activeIntegrityFilterChips(filters: IntegrityFilters): Array<{ field: keyof IntegrityFilters; label: string }> {
  const chips: Array<{ field: keyof IntegrityFilters; label: string }> = [];
  if (filters.rep !== "") chips.push({ field: "rep", label: filters.rep });
  if (filters.line !== "") chips.push({ field: "line", label: `Line: ${filters.line}` });
  if (filters.area !== "") chips.push({ field: "area", label: `Area: ${filters.area}` });
  if (filters.region !== "") chips.push({ field: "region", label: `Region: ${filters.region}` });
  if (filters.source !== "") chips.push({ field: "source", label: filters.source });
  if (filters.flag !== "") chips.push({ field: "flag", label: filters.flag });
  if (filters.strength !== "all") chips.push({ field: "strength", label: INTEGRITY_STRENGTH_LABELS[filters.strength] });
  if (filters.standing !== "all") chips.push({ field: "standing", label: INTEGRITY_STANDING_LABELS[filters.standing] });
  if (filters.photo !== "all") chips.push({ field: "photo", label: INTEGRITY_PHOTO_LABELS[filters.photo] });
  if (filters.customer !== "") chips.push({ field: "customer", label: filters.customer });
  if (filters.speciality !== "") chips.push({ field: "speciality", label: filters.speciality });
  if (filters.list !== "") chips.push({ field: "list", label: `${filters.list} list` });
  if (filters.distance !== "all") chips.push({ field: "distance", label: INTEGRITY_DISTANCE_BAND_LABELS[filters.distance] });
  if (filters.visitFrom !== "") chips.push({ field: "visitFrom", label: `Captured from ${filters.visitFrom}` });
  if (filters.visitTo !== "") chips.push({ field: "visitTo", label: `Captured up to ${filters.visitTo}` });
  if (filters.filedFrom !== "") chips.push({ field: "filedFrom", label: `Filed from ${filters.filedFrom}` });
  if (filters.filedTo !== "") chips.push({ field: "filedTo", label: `Filed up to ${filters.filedTo}` });
  if (filters.text.trim() !== "") chips.push({ field: "text", label: `“${filters.text.trim()}”` });
  return chips;
}

/** One field back to its empty value — what a chip's own control does. */
export function clearIntegrityFilter(filters: IntegrityFilters, field: keyof IntegrityFilters): IntegrityFilters {
  return { ...filters, [field]: EMPTY_INTEGRITY_FILTERS[field] };
}
