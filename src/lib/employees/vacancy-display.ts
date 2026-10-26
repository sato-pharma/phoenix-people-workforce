import { resolveEmployeeDisplayName, tidyAllCapitalsName } from "@/lib/employees/display-name";
import {
  HR_ID_LOOKUP_CHUNK,
  type EmployeeNameLookupClient,
} from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { loadReferenceAreas, type ReferenceArea } from "@/lib/reference/reference-lists";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * What a MANAGER is allowed to read off an open vacancy, and how it reads.
 *
 * WHY THIS EXISTS (owner, 2026-10-26, looking at Line Vacancies as the Pedia National Sales
 * Manager). The page was printing `position_vacancies.note` straight onto the screen, and that
 * column is an ENGINE JOURNAL, not a sentence anybody wrote for a reader: one row carried
 * "Pending replacement ownership: temporarily moved from terminal manager PD-0006 to upstream
 * manager A-12 on 2026-08-28. Replacement ownership engine: moved live vacancy manager from
 * PD-0006 to PD-0031 on 2026-10-25." — four internal HR codes, two mechanism names and two ISO
 * dates, in the Position column of a manager's own team list. His instruction was to show a plain-
 * English reason built from the STRUCTURED fields instead, and to leave the raw note to Super
 * Admin / HR.
 *
 * So everything a reader sees about WHY a seat is open is derived here, from three columns on the
 * predecessor's own `employees` row — never parsed back out of the note. Parsing the note would
 * reproduce the defect one layer down: its wording changes whenever an engine changes, and four of
 * the seventeen open Pedia vacancies record no predecessor at all, so a parser would have had to
 * invent a reason for them. Those four get NO reason line, which is the honest answer.
 *
 * Dates are "30 Sep 2026", his stated form. The page's old formatter was `en-US`, which is the
 * same Intl call with a comma in it ("Sep 30, 2026").
 */

/* ---------- the vacancy's own identifier ---------- */

/**
 * The one label a vacancy is known by on screen.
 *
 * It replaced a `{ label, meta }` pair whose `meta` was the vacancy CODE spelled out in words.
 * On the legacy code `vacancy_12_sales_pedia_sharkia_2_medical_representative` that produced
 * "VAC-012" over "Sales · Pedia · Sharkia · #2 · Medical · Representative" — the line, the area
 * and the position already have their own columns one cell to the right, so the second line was
 * the same row read twice, with "Medical Representative" split in half by the underscore it was
 * stored with. On every MODERN code (`VAC-PD0019-DWF`) the label came back as the code itself and
 * `meta` came back empty, and the page's else-branch then printed the raw code underneath it — so
 * the code appeared TWICE, which is what he actually saw.
 *
 * A legacy `vacancy_<n>_…` code becomes "VAC-012"; anything else is already the identifier a
 * person reads, and is returned unchanged. Never two lines, never a spelled-out code.
 */
export function formatVacancyLabel(code: string | null | undefined): string {
  const raw = String(code ?? "").trim();
  if (!raw) return "";

  const legacyNumber = /^vacancy_(?:vac_)?(\d+)(?:_|$)/i.exec(raw);
  if (legacyNumber) return `VAC-${legacyNumber[1].padStart(3, "0")}`;

  return raw;
}

/* ---------- dates ---------- */

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "30 Sep 2026" — his stated form, for every date this page shows.
 *
 * Accepts both a date-only column (`last_working_date`, stored `2026-09-30`) and a timestamp
 * (`created_at`). A date-only string is read as plain calendar text rather than through `Date`,
 * because `new Date("2026-09-30")` parses as UTC midnight and anything rendering west of
 * Greenwich then prints the day before — an off-by-one that only shows on rows near a month
 * boundary, which is most of these: nine of the seventeen open Pedia vacancies are dated a 30th
 * or a 31st. A real timestamp is formatted in Africa/Cairo, the only timezone this app reports in.
 */
export function formatVacancyDate(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const month = MONTH_NAMES[Number(dateOnly[2]) - 1];
    if (month) return `${Number(dateOnly[3])} ${month} ${dateOnly[1]}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

/* ---------- why the seat is open ---------- */

/** The predecessor's own row, reduced to the three things a reason is built from. */
export type VacancyPredecessor = {
  /** The name a reader knows them by — nickname-aware, never the HR id. */
  displayName: string;
  /** `last_working_date` when the row has one, else `resignation_date`. */
  effectiveDate: string | null;
  /** `employees.employment_status`: `resigned`, `declined_offer`, `terminated`, … */
  employmentStatus: string | null;
};

export type VacancyPredecessorIndex = {
  /** Null when the vacancy records no predecessor, or the read could not name them. */
  get(hrId: string | null | undefined): VacancyPredecessor | null;
  readonly size: number;
};

const EMPTY_PREDECESSORS: VacancyPredecessorIndex = { get: () => null, size: 0 };

/**
 * The clause that says what happened, by status.
 *
 * `declined_offer` is its own case rather than a variant of resigning: the person never started,
 * and on both of those rows `resignation_date` (2026-10-10, the day the offer lapsed) is TEN DAYS
 * later than the last working day the vacancy is really dated from (2026-10-01) — which is why
 * `effectiveDate` prefers `last_working_date`. An unknown status degrades to "left the company"
 * rather than to the raw code, so a status that reaches the database before it reaches here still
 * never arrives on a manager's screen with an underscore in it.
 */
function departureClause(status: string | null): string {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "resigned":
      return "who resigned";
    case "declined_offer":
      return "who declined the offer";
    case "terminated":
      return "whose employment ended";
    case "not_renewed":
      return "whose contract was not renewed";
    default:
      return "who left the company";
  }
}

/**
 * "Replacing Bahaa Gamal, who resigned. Last working day 9 Aug 2026."
 *
 * Null when there is nothing true to say — no predecessor on the vacancy, or one the `employees`
 * read could not name. The caller then renders nothing at all; it does NOT fall back to the note,
 * which is the whole point of this module.
 */
export function describeVacancyReason(
  predecessor: VacancyPredecessor | null | undefined,
): string | null {
  const name = tidyAllCapitalsName(String(predecessor?.displayName ?? "").trim());
  if (!name) return null;

  const opening = `Replacing ${name}, ${departureClause(predecessor?.employmentStatus ?? null)}.`;
  const effective = formatVacancyDate(predecessor?.effectiveDate ?? null);
  return effective ? `${opening} Last working day ${effective}.` : opening;
}

type PredecessorDbRow = {
  employment_status?: string | null;
  full_name?: string | null;
  hr_id?: string | null;
  last_working_date?: string | null;
  nickname?: string | null;
  resignation_date?: string | null;
};

const PREDECESSOR_COLUMNS = "hr_id,full_name,nickname,employment_status,last_working_date,resignation_date";

/**
 * The predecessors of a set of open vacancies, read by HR id.
 *
 * 🔴 NOT `getEmployeeDirectory()`. Every one of these people has LEFT, and the directory holds
 * active staff only — the names, the statuses and the dates are all on rows it does not return.
 * This is the same shape as `namesByHrId` (chunked at 50 keys, every spelling asked for, a failed
 * chunk costing only the rows in it) for the same two reasons: PostgREST matches `hr_id`
 * case-sensitively, and a long enough `in` filter returns NOTHING with no error — a silently empty
 * result that reads exactly like "this vacancy has no predecessor". A read that threw would take
 * the whole vacancies page down for one explanatory line.
 */
export async function loadVacancyPredecessors(
  hrIds: Iterable<string | null | undefined>,
  client?: EmployeeNameLookupClient,
): Promise<VacancyPredecessorIndex> {
  const keys = [...new Set([...hrIds].flatMap((hrId) => hrIdLookupKeys(hrId)))];
  if (keys.length === 0) return EMPTY_PREDECESSORS;

  const db = client ?? (getSupabaseAdmin() as unknown as EmployeeNameLookupClient);
  const byCanonical = new Map<string, VacancyPredecessor>();

  for (let start = 0; start < keys.length; start += HR_ID_LOOKUP_CHUNK) {
    const { data, error } = await db
      .from("employees")
      .select(PREDECESSOR_COLUMNS)
      .in("hr_id", keys.slice(start, start + HR_ID_LOOKUP_CHUNK));
    if (error || !data) continue;

    for (const row of data as PredecessorDbRow[]) {
      const key = canonicalHrIdKey(row.hr_id);
      const fullName = String(row.full_name ?? "").trim();
      if (!key || !fullName) continue;
      byCanonical.set(key, {
        displayName: resolveEmployeeDisplayName(fullName, row.nickname ?? null, row.hr_id ?? null),
        effectiveDate: row.last_working_date ?? row.resignation_date ?? null,
        employmentStatus: row.employment_status ?? null,
      });
    }
  }

  return {
    get(hrId) {
      const key = canonicalHrIdKey(hrId);
      return key ? byCanonical.get(key) ?? null : null;
    },
    get size() {
      return byCanonical.size;
    },
  };
}

/* ---------- where the seat is, when the vacancy row forgot ---------- */

/** A seat's place on the organogram — the fallback for a vacancy row with no `area_id`. */
export type VacancySeatPlace = {
  areaId: number | null;
  areaName: string | null;
  regionName: string | null;
};

export type VacancySeatPlaceIndex = {
  get(seatId: string | null | undefined): VacancySeatPlace | null;
  readonly size: number;
};

const EMPTY_SEAT_PLACES: VacancySeatPlaceIndex = { get: () => null, size: 0 };

const SEAT_PLACE_CHUNK = 50;

type SeatPlaceDbRow = {
  area_code?: string | null;
  area_name?: string | null;
  region_name?: string | null;
  seat_id?: string | null;
};

/**
 * Seat id → the area and region that seat sits in, for the vacancies whose own `area_id` is NULL.
 *
 * WHY (owner, 2026-10-26): VAC-PD0019-DWF rendered as "Unknown Area" on his page. The row's
 * `area_id` is genuinely null, but its `seat_id` is `SEAT-PED-REP-D24`, which the organogram
 * places in Sharkia 1 / Delta (2) — the page had the answer one join away and printed "Unknown"
 * instead. The same null silently emptied the hire prefill as well: `buildSeatHireHref` carries
 * `vacancyArea` from `areaId`, so Add Employee opened with no area for exactly this row.
 *
 * ONE read of its own, and the shared area list for the rest. `au_v_org_tree` is the seat model
 * and carries `area_code`/`area_name` but NO `area_id` (confirmed against the live view,
 * 2026-10-26), while the hire prefill needs the numeric id — so the codes are matched against
 * `loadReferenceAreas()`, the one-minute shared list every other caller uses, rather than a second
 * query of `areas` (performance phase 3 ratchets a direct read of lines / areas / departments, and
 * rightly: this page would have paid for a table the process already holds).
 *
 * The match is on `code` ALONE. `areas` holds both spellings: the organogram's codes ("D24",
 * "CA6") on rows whose `line_id` is null, and slug codes ("sharkia_2") on line-scoped rows. No
 * organogram-style code appears twice, so the match is unambiguous without a line filter — and
 * filtering on `line_id` as well, the obvious way to write it, returns NOTHING, because the
 * organogram-coded rows have none.
 *
 * Both lookups are skipped entirely unless a vacancy actually needs them, so the normal case —
 * every row carrying its own area — costs nothing. A failure costs the fallback and nothing else.
 */
export async function loadVacancySeatPlaces(
  seatIds: Iterable<string | null | undefined>,
  client?: EmployeeNameLookupClient,
  readAreas: () => Promise<ReferenceArea[]> = loadReferenceAreas,
): Promise<VacancySeatPlaceIndex> {
  const wanted = [
    ...new Set([...seatIds].map((seatId) => String(seatId ?? "").trim()).filter(Boolean)),
  ];
  if (wanted.length === 0) return EMPTY_SEAT_PLACES;

  const db = client ?? (getSupabaseAdmin() as unknown as EmployeeNameLookupClient);

  const seatRows: SeatPlaceDbRow[] = [];
  for (let start = 0; start < wanted.length; start += SEAT_PLACE_CHUNK) {
    const { data, error } = await db
      .from("au_v_org_tree")
      .select("seat_id,area_code,area_name,region_name")
      .in("seat_id", wanted.slice(start, start + SEAT_PLACE_CHUNK));
    if (error || !data) continue;
    seatRows.push(...(data as SeatPlaceDbRow[]));
  }
  if (seatRows.length === 0) return EMPTY_SEAT_PLACES;

  const codes = new Set(
    seatRows.map((row) => String(row.area_code ?? "").trim()).filter(Boolean),
  );
  const areaIdByCode = new Map<string, number>();
  if (codes.size > 0) {
    const areas = await readAreas().catch(() => [] as ReferenceArea[]);
    for (const area of areas) {
      const code = String(area.code ?? "").trim();
      if (!code || !codes.has(code)) continue;
      if (typeof area.id === "number" && !areaIdByCode.has(code)) areaIdByCode.set(code, area.id);
    }
  }

  const bySeat = new Map<string, VacancySeatPlace>();
  for (const row of seatRows) {
    const seatId = String(row.seat_id ?? "").trim();
    if (!seatId || bySeat.has(seatId)) continue;
    const code = String(row.area_code ?? "").trim();
    bySeat.set(seatId, {
      areaId: (code ? areaIdByCode.get(code) : undefined) ?? null,
      areaName: row.area_name ?? null,
      regionName: row.region_name ?? null,
    });
  }

  return {
    get(seatId) {
      const key = String(seatId ?? "").trim();
      return key ? bySeat.get(key) ?? null : null;
    },
    get size() {
      return bySeat.size;
    },
  };
}
