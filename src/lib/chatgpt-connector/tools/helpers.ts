/**
 * Pure helpers the ChatGPT connector tools share: name search, period words, money words, row caps,
 * and field projection. No database, no Next.js and no permission logic lives here — every tool asks
 * its own domain service and permission check. Pinned by tests/chatgpt-connector-tools.test.ts.
 */
import { normalizeArabic } from "@/lib/geo/egypt-locations";
import { hrIdsMatch } from "@/lib/hr-id";

import { ToolRefusal } from "@/lib/chatgpt-connector/types";

/** The most rows any tool hands back in `data`, unless the tool says otherwise. */
const DEFAULT_ROW_CAP = 200;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ── Text and names ───────────────────────────────────────────────────────────

/** Lower-case, Arabic spelling variants folded, Latin accents dropped, punctuation to single spaces. */
export function normalizeSearchText(value: string | null | undefined): string {
  return normalizeArabic(String(value ?? "").toLowerCase())
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim();
}

export type PersonSearchFields = {
  hrId: string;
  fullName?: string | null;
  displayName?: string | null;
  nickname?: string | null;
  nameAr?: string | null;
};

/**
 * How well one person matches a search, 0 for no match. An exact HR id wins outright; then a whole
 * name, a name that starts with the query, every query word starting a word of the name, and last a
 * name that merely contains the query. English, Arabic and nickname are all tried.
 */
export function scorePersonMatch(query: string, person: PersonSearchFields): number {
  const raw = String(query ?? "").trim();
  if (!raw) return 0;
  if (hrIdsMatch(raw, person.hrId)) return 100;
  const q = normalizeSearchText(raw);
  if (!q) return 0;
  const queryWords = q.split(" ");
  let best = 0;
  for (const name of [person.fullName, person.displayName, person.nickname, person.nameAr]) {
    const n = normalizeSearchText(name);
    if (!n) continue;
    if (n === q) best = Math.max(best, 90);
    else if (n.startsWith(q)) best = Math.max(best, 80);
    else {
      const nameWords = n.split(" ");
      if (queryWords.every((word) => nameWords.some((nameWord) => nameWord.startsWith(word)))) best = Math.max(best, 70);
      else if (n.includes(q)) best = Math.max(best, 60);
    }
  }
  if (best > 0) return best;

  // Last, the same name in another Latin spelling (owner, 17 Nov 2026: he asked for "Ibtissam" and
  // Phoenix holds "Ebtissam"). Below every real match, so a true spelling always wins, and a tie between
  // two loose matches is refused with both names, never guessed.
  // A word under five letters must still be spelled as it is ("Ali" is not "Alaa": both fold to "ala").
  for (const name of [person.fullName, person.displayName, person.nickname]) {
    const nameWords = normalizeSearchText(name).split(" ").filter(Boolean);
    if (!nameWords.length) continue;
    const looseName = nameWords.map(looseLatinWord);
    const fits = queryWords.every((word) => {
      if (nameWords.some((nameWord) => nameWord.startsWith(word))) return true;
      const loose = word.length >= 5 ? looseLatinWord(word) : "";
      return Boolean(loose) && looseName.some((nameWord) => Boolean(nameWord) && nameWord.startsWith(loose));
    });
    if (fits) return 50;
  }
  return 0;
}

/**
 * One Latin word reduced to how it sounds across the usual transliterations of an Arabic name: every
 * vowel (and y) is one sound, a doubled letter is one letter, "ph" is "f", "q" and "c" are "k".
 * Ibtissam = Ebtissam = Ebtesam; Mohamed = Muhammad; Youssef = Yousef. Empty for a non-Latin word.
 */
export function looseLatinWord(word: string): string {
  if (!/^[a-z]+$/.test(word)) return "";
  return word
    .replace(/ph/g, "f")
    .replace(/[qc]/g, "k")
    .replace(/[aeiouy]/g, "a")
    .replace(/(.)\1+/g, "$1");
}

/** Every row that matches, best first, then by name. */
export function matchPeople<T extends PersonSearchFields>(rows: readonly T[], query: string): T[] {
  return rows
    .map((row) => ({ row, score: scorePersonMatch(query, row) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        String(left.row.displayName || left.row.fullName || "").localeCompare(
          String(right.row.displayName || right.row.fullName || ""),
        ),
    )
    .map((entry) => entry.row);
}

/**
 * The ONE person a name or HR id means, or a refusal that says why: nobody matched, or several did
 * equally well (then the refusal lists them, with HR ids, so the next call can name one).
 */
export function pickOnePerson<T extends PersonSearchFields>(rows: readonly T[], query: string): T {
  const scored = rows
    .map((row) => ({ row, score: scorePersonMatch(query, row) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) {
    throw new ToolRefusal(`Nobody you can see matches "${query}". Try another spelling, the Arabic name or the HR id.`);
  }
  const top = scored[0].score;
  const tied = scored.filter((entry) => entry.score === top);
  if (tied.length > 1) {
    const names = tied
      .slice(0, 10)
      .map((entry) => `${entry.row.displayName || entry.row.fullName} (${entry.row.hrId})`)
      .join(", ");
    throw new ToolRefusal(`"${query}" matches more than one person: ${names}. Ask again with the HR id.`);
  }
  return scored[0].row;
}

/** Resolve a line the way a person types it ("CNS", "anti infective", "Pedia") to its code, or null. */
export function resolveLineCode(
  value: string | null | undefined,
  lines: ReadonlyArray<{ code: string; label: string }>,
): string | null {
  const wanted = normalizeSearchText(value).replace(/ /g, "");
  if (!wanted) return null;
  for (const line of lines) {
    const code = normalizeSearchText(line.code).replace(/ /g, "");
    const label = normalizeSearchText(line.label).replace(/ /g, "");
    if (wanted === code || wanted === label) return line.code;
  }
  if (wanted === "ai" || wanted === "antiinf" || wanted === "antiinfectives") {
    return lines.find((line) => line.code === "anti_infective")?.code ?? null;
  }
  return null;
}

// ── Periods ──────────────────────────────────────────────────────────────────

/** `YYYY-MM` → its year and month, or null for anything else. */
export function parsePeriod(value: string | null | undefined): { year: number; month: number } | null {
  const match = PERIOD_RE.exec(String(value ?? "").trim());
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

export function isIsoDate(value: string | null | undefined): value is string {
  if (!DATE_RE.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Calendar days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** A from/to pair of ISO dates, defaulting to the 1st of `today`'s month through `today`. */
export function resolveDateWindow(
  from: string | null | undefined,
  to: string | null | undefined,
  today: string,
): { from: string; to: string } {
  const start = String(from ?? "").trim() || `${today.slice(0, 7)}-01`;
  const end = String(to ?? "").trim() || today;
  if (!isIsoDate(start) || !isIsoDate(end)) throw new ToolRefusal("Dates must be written YYYY-MM-DD, for example 2026-10-01.");
  if (end < start) throw new ToolRefusal(`The window ends (${end}) before it starts (${start}).`);
  return { from: start, to: end };
}

/** Every month from `from` to `to`, both included, ascending. Empty for a bad or backwards range. */
export function monthsBetween(from: string, to: string): string[] {
  const start = parsePeriod(from);
  const end = parsePeriod(to);
  if (!start || !end) return [];
  const months: string[] = [];
  let year = start.year;
  let month = start.month;
  while (year < end.year || (year === end.year && month <= end.month)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    if (months.length > 240) break;
  }
  return months;
}

/** "July 2026". */
export function monthLabel(period: string): string {
  const parsed = parsePeriod(period);
  return parsed ? `${MONTH_NAMES[parsed.month - 1]} ${parsed.year}` : period;
}

/** "July–September 2026", "December 2025–February 2026", or one month's name. */
export function periodRangeLabel(from: string, to: string): string {
  const start = parsePeriod(from);
  const end = parsePeriod(to);
  if (!start || !end) return `${from}–${to}`;
  if (from === to) return monthLabel(from);
  if (start.year === end.year) return `${MONTH_NAMES[start.month - 1]}–${MONTH_NAMES[end.month - 1]} ${end.year}`;
  return `${monthLabel(from)}–${monthLabel(to)}`;
}

/**
 * The newest calendar quarter whose three months are ALL in `months` (the published months), as a
 * from/to pair — what "last quarter" means for a sales question. Null when no quarter is complete.
 */
export function latestCompleteQuarter(months: Iterable<string>): { from: string; to: string } | null {
  const have = new Set(months);
  const quarters = new Map<string, number>();
  for (const period of have) {
    const parsed = parsePeriod(period);
    if (!parsed) continue;
    const key = `${parsed.year}-${Math.floor((parsed.month - 1) / 3)}`;
    quarters.set(key, (quarters.get(key) ?? 0) + 1);
  }
  const complete = [...quarters.entries()]
    .filter(([, count]) => count === 3)
    .map(([key]) => key)
    .sort((left, right) => {
      const [ly, lq] = left.split("-").map(Number);
      const [ry, rq] = right.split("-").map(Number);
      return ry - ly || rq - lq;
    });
  if (complete.length === 0) return null;
  const [year, quarter] = complete[0].split("-").map(Number);
  const firstMonth = quarter * 3 + 1;
  return {
    from: `${year}-${String(firstMonth).padStart(2, "0")}`,
    to: `${year}-${String(firstMonth + 2).padStart(2, "0")}`,
  };
}

/**
 * The from/to a month-range question reads: as asked (one end alone means that one month), or, with
 * neither, the newest calendar quarter whose three months are all in `availableMonths` — else the
 * newest available month. Refuses a malformed, backwards, pre-floor or over-wide range in plain words.
 */
export function resolveMonthRange(
  from: string | null | undefined,
  to: string | null | undefined,
  availableMonths: readonly string[],
  options: { floor: string; maxMonths: number },
): { from: string; to: string } {
  let start = String(from ?? "").trim() || String(to ?? "").trim();
  let end = String(to ?? "").trim() || String(from ?? "").trim();
  if (!start) {
    const sorted = [...availableMonths].sort();
    const quarter = latestCompleteQuarter(sorted);
    const newest = sorted[sorted.length - 1];
    if (quarter) {
      start = quarter.from;
      end = quarter.to;
    } else if (newest) {
      start = newest;
      end = newest;
    } else {
      throw new ToolRefusal("No Monthly Closing has been published yet, so there are no figures to report.");
    }
  }
  if (!parsePeriod(start) || !parsePeriod(end)) {
    throw new ToolRefusal("Months must be written YYYY-MM, for example 2026-07.");
  }
  if (end < start) throw new ToolRefusal(`The range ends (${monthLabel(end)}) before it starts (${monthLabel(start)}).`);
  if (start < options.floor) {
    throw new ToolRefusal(`Figures start in ${monthLabel(options.floor)}, the first published Monthly Closing.`);
  }
  if (monthsBetween(start, end).length > options.maxMonths) {
    throw new ToolRefusal(`Ask for at most ${options.maxMonths} months at a time.`);
  }
  return { from: start, to: end };
}

/**
 * Which months in a range are WITHHELD (no line in scope has a published closing) and which are
 * partly published. A line is "in scope" for a month when a row of it is present; a month with no
 * rows at all is judged against every line. `publishedKeys` are `lineCode|YYYY-MM`.
 */
export function publicationGaps(
  rows: ReadonlyArray<{ period: string; lineCode: string | null }>,
  months: readonly string[],
  publishedKeys: ReadonlySet<string>,
  allLineCodes: readonly string[],
): { withheld: string[]; partial: Array<{ period: string; unpublishedLineCodes: string[] }> } {
  const withheld: string[] = [];
  const partial: Array<{ period: string; unpublishedLineCodes: string[] }> = [];
  for (const period of months) {
    const lines = new Set<string>();
    for (const row of rows) if (row.period === period && row.lineCode) lines.add(row.lineCode);
    const scopeLines = lines.size > 0 ? [...lines].sort() : [...allLineCodes];
    const unpublished = scopeLines.filter((code) => !publishedKeys.has(`${code}|${period}`));
    if (unpublished.length === scopeLines.length) withheld.push(period);
    else if (unpublished.length > 0) partial.push({ period, unpublishedLineCodes: unpublished });
  }
  return { withheld, partial };
}

/** The bare months a set of `lineCode|YYYY-MM` publication keys covers, ascending. */
export function monthsOfPublicationKeys(keys: Iterable<string>): string[] {
  const months = new Set<string>();
  for (const key of keys) {
    const period = key.slice(key.indexOf("|") + 1);
    if (parsePeriod(period)) months.add(period);
  }
  return [...months].sort();
}

// ── Money and percentages ────────────────────────────────────────────────────

/** "EGP 1,234,567.89" — whole pounds when the figure has no piastres. */
export function formatEgp(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "no figure";
  const rounded = Math.round(value * 100) / 100;
  const hasPiastres = Math.round(rounded * 100) % 100 !== 0;
  return `EGP ${rounded.toLocaleString("en-US", {
    minimumFractionDigits: hasPiastres ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** A 0..1 ratio as "87.3%"; "no target" for null (never 0%). */
export function formatRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "no target";
  return `${(Math.round(value * 1000) / 10).toFixed(1)}%`;
}

/** A ratio rounded for `data` (4 decimals), null kept as null. */
export function roundRatio(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

export function roundMoney(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** At most `cap` rows, and whether any were left out. */
export function capRows<T>(rows: readonly T[], cap: number = DEFAULT_ROW_CAP): { rows: T[]; total: number; capped: boolean } {
  return { rows: rows.slice(0, cap), total: rows.length, capped: rows.length > cap };
}

/** The sentence a summary adds when rows were capped, else "". */
export function cappedNote(total: number, shown: number): string {
  return total > shown ? ` Showing the first ${shown} of ${total}; ask a narrower question for the rest.` : "";
}

/** Only the named keys of an object, in that order; a missing key becomes null. */
export function pickFields<T extends object, K extends keyof T>(row: T, keys: readonly K[]): { [P in K]: T[P] | null } {
  const out = {} as { [P in K]: T[P] | null };
  for (const key of keys) out[key] = (row[key] ?? null) as T[K] | null;
  return out;
}

/** The top-level string, number, boolean and null fields of an object — arrays and objects dropped. */
export function scalarFields(value: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (field === null || typeof field === "string" || typeof field === "boolean") out[key] = field;
    else if (typeof field === "number" && Number.isFinite(field)) out[key] = field;
  }
  return out;
}

/** The person's name as Phoenix shows it, with the HR id beside it. */
export function personLabel(row: { hrId: string; displayName?: string | null; fullName?: string | null }): string {
  const name = row.displayName || row.fullName || "Unnamed employee";
  return `${name} (${row.hrId})`;
}

/**
 * A domain gate throws `Forbidden: …` (assertPermission and its siblings — the prefix ~200 route
 * handlers key their 403 on). The person reads that as a refusal, not a crash. Anything else passes
 * through unchanged.
 */
export function asPlainRefusal(error: unknown): unknown {
  if (error instanceof ToolRefusal) return error;
  const message = error instanceof Error ? error.message : "";
  if (/^forbidden\b/i.test(message)) return new ToolRefusal("Your Phoenix role is not allowed to see this.");
  return error;
}
