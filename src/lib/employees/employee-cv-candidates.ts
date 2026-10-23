import { getSupabaseAdmin } from "@/lib/supabase/server";
import { ilikeContainsValue } from "@/lib/supabase/search-filter";

/**
 * Finding the candidate whose CV belongs on an employee's record.
 *
 * WHY A SEARCH AND NOT A MATCH. A new hire created from an application already carries their CV
 * across by itself (`copyCandidateCvToEmployee`, called on the create path): the application says
 * which candidate this employee is, so nothing has to be guessed. For somebody hired BEFORE that
 * link existed there is no such statement anywhere, and the tempting substitutes are all unsafe.
 *
 * 🔴 MATCHING ON PHONE IS WRONG, MEASURED, NOT SUSPECTED. On production 2026-09-29, 8 of the 189
 * employees with no CV matched a candidate who had one, on the last 9 digits of the mobile. THREE
 * of those 8 were different people: the National Sales Manager matched "Esraa Mabrouk.", the CEO
 * matched "Weaam Gweed", a Group Product Manager matched "Youssef hesham Tawfik". The cause is
 * ordinary and permanent — a CV arrives over WhatsApp from whoever forwarded it, so the candidate
 * row carries the FORWARDER's number. One HR person's own number carried three different
 * candidates' CVs. A name match is no better: "Samaa Shalaby" and "Samaa AbdelRahman AbdelRaouf
 * Shalabi" are one person, and two real reps here share a full name.
 *
 * So this module never decides. It offers the candidates who could be the person, with the
 * evidence a human needs to tell — their name as recruitment holds it, the tail of the phone on
 * the candidate record, and the CV's own filename, which in practice carries the person's name
 * and is the strongest single tell. The attach is somebody's deliberate click, and attaching the
 * wrong document is the one failure that matters: a CV is an identity document, and a stranger's
 * CV filed under an employee's name is worse than no CV at all.
 *
 * NOTHING HERE IS LISTED WITHOUT A QUERY. There is no "show me all candidates" branch — the caller
 * must say who they are looking for, so this cannot become a way to page the recruitment database
 * from the employee screen.
 */

/** One candidate who has a CV on file and matches what was typed. */
export type CandidateCvMatch = {
  candidateId: string;
  candidateName: string;
  /** The CV recruitment holds — its own filename is usually what identifies the person. */
  cvFileName: string;
  cvUploadedAt: string | null;
  /**
   * The last 4 digits of the candidate's phone, never the whole number. Enough to recognise a
   * number you already know, not enough to be a phone list of everyone who ever applied.
   */
  phoneTail: string | null;
};

/** Below this the search is refused outright — two letters would return half the database. */
export const MIN_CANDIDATE_QUERY_LENGTH = 3;

const DEFAULT_LIMIT = 10;

/** Digits only, so "+20 109 588 8700", "0109 588 8700" and "01095888700" are one query. */
export function digitsOf(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** The last four digits, which is all a person needs to recognise a number they already know. */
export function phoneTailOf(value: string | null | undefined): string | null {
  const digits = digitsOf(value);
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Keep the newest CV per candidate and drop every candidate that has none.
 *
 * Pure, and exported for the test: "newest wins" is the same rule `copyCandidateCvToEmployee`
 * applies when it actually copies the file, and the two must agree — offering a person the CV
 * from March and then attaching the one from May would be a quiet lie about what was attached.
 * A candidate who sends an updated CV gets a NEW `ats_files` row rather than an edit to the old
 * one, so the newest row is the one recruitment screened last.
 */
export function newestCvPerCandidate(
  files: readonly { candidateId: string; createdAt: string | null; fileName: string | null }[],
): Map<string, { createdAt: string | null; fileName: string }> {
  const newest = new Map<string, { createdAt: string | null; fileName: string }>();
  for (const file of files) {
    const id = String(file.candidateId ?? "").trim();
    if (!id) continue;
    const fileName = String(file.fileName ?? "").trim() || "CV";
    const at = Date.parse(String(file.createdAt ?? ""));
    const held = newest.get(id);
    if (!held) {
      newest.set(id, { createdAt: file.createdAt ?? null, fileName });
      continue;
    }
    const heldAt = Date.parse(String(held.createdAt ?? ""));
    // A row with no timestamp never displaces one that has a real date: an unknown date is not
    // evidence of being newer.
    if (Number.isFinite(at) && (!Number.isFinite(heldAt) || at > heldAt)) {
      newest.set(id, { createdAt: file.createdAt ?? null, fileName });
    }
  }
  return newest;
}

/**
 * How one typed query becomes a database filter — and why it is not the obvious one.
 *
 * 🔴 BOTH BRANCHES ARE FIXES FOR A DEFECT MEASURED AGAINST LIVE DATA, not theory. The first
 * version wrapped the whole typed string in one ilike, and probing production found it useless for
 * exactly the case the search exists for:
 *
 *   - THE NAME. Seeding the box with the employee's own name — "Samaa AbdelRahman AbdelRaouf
 *     Shalabi" — returned NOTHING, because recruitment holds her as "Samaa Shalaby". An employee
 *     record carries the full legal name and a CV carries whatever the person calls themselves, so
 *     a whole-string match is the one thing guaranteed to fail. Each WORD is searched instead, and
 *     the rows that match more of them rank first.
 *   - THE PHONE. "01095888700" matched only the candidates whose number happens to be stored
 *     unformatted; the same person stored as "+20 109 588 8700" did not match, because the digits
 *     are split by spaces in the column. So the database filter now uses only the LAST FOUR digits,
 *     which survive every format seen here, and the real comparison is done on digits-only values
 *     afterwards — which also throws out the accidental substring hits that a 4-digit filter drags
 *     in.
 *
 * Pure and exported so the test drives it directly: this is the half that decides what a person is
 * shown, and it must not be reachable only through the network.
 */
export function planCandidateQuery(query: string | null | undefined): {
  /** PostgREST `or` filters, each value double-quoted through `@/lib/supabase/search-filter`. */
  filters: string[];
  /** Set when the query is a phone: the digits every result must end with. */
  phoneTailDigits: string | null;
  /** The name words to rank on, lower-cased. */
  tokens: string[];
} {
  const raw = String(query ?? "").trim();
  if (raw.length < MIN_CANDIDATE_QUERY_LENGTH) return { filters: [], phoneTailDigits: null, tokens: [] };

  const digits = digitsOf(raw);
  // "Mostly digits" rather than "only digits": a pasted number arrives as "+20 109 588 8700" and
  // as "0109 588 8700 (work)". A name never reaches this ratio.
  const looksLikePhone = digits.length >= 6 && digits.length >= raw.replace(/\s/g, "").length - 4;
  if (looksLikePhone) {
    // The last 9 digits are the Egyptian subscriber number without the country code — the widest
    // comparison that cannot confuse two people. The FILTER is the last 4, because that is the
    // longest run that stays contiguous through "+20 109 588 8700".
    const tail = digits.slice(-9);
    const tailFilter = ilikeContainsValue(digits.slice(-4));
    return {
      filters: tailFilter ? [`phone.ilike.${tailFilter}`] : [],
      phoneTailDigits: tail,
      tokens: [],
    };
  }

  // `,` `(` `)` and `.` are separators HERE because a name is searched word by word — "Ahmed
  // (Acting), M." is three words to rank on, not one string. They are no longer dropped for the
  // filter's safety: each value below is double-quoted, so a token that did keep one would be
  // searched for rather than ending the clause. `*` goes to the shared wildcard rule.
  const tokens = raw
    .replace(/[,()*.]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3)
    .slice(0, 6);
  if (tokens.length === 0) return { filters: [], phoneTailDigits: null, tokens: [] };
  const filters = tokens
    .map((token) => ilikeContainsValue(token))
    .filter((value): value is string => value !== null)
    .map((value) => `full_name.ilike.${value}`);
  if (filters.length === 0) return { filters: [], phoneTailDigits: null, tokens: [] };
  return {
    filters,
    phoneTailDigits: null,
    tokens: tokens.map((token) => token.toLowerCase()),
  };
}

/**
 * How much of the typed name this candidate carries — the ranking, so the likeliest leads.
 *
 * THE FIRST WORD COUNTS DOUBLE, and that is not arbitrary. Measured against production: searching
 * "Samaa AbdelRahman AbdelRaouf Shalabi" matches "Samaa Shalaby" on one word and four unrelated
 * Abdelrahmans on one word each, so a flat count left the right person third behind strangers. A
 * given name is what a candidate is filed under and what a person recognises; the middle names in
 * an employee's full legal record are the part recruitment most often drops.
 */
export function nameTokenScore(fullName: string | null | undefined, tokens: readonly string[]): number {
  const name = String(fullName ?? "").toLowerCase();
  return tokens.reduce(
    (score, token, index) => (name.includes(token) ? score + (index === 0 ? 2 : 1) : score),
    0,
  );
}

/**
 * Candidates matching `query` who have a CV on file, newest CV first.
 *
 * Returns an empty list — never an error — for a query that is too short or matches nobody. The
 * caller is a search box, and a person typing a name they then correct should not be shown a
 * failure for it.
 */
export async function findCandidateCvMatches(input: {
  limit?: number;
  query: string | null | undefined;
}): Promise<CandidateCvMatch[]> {
  const raw = String(input.query ?? "").trim();
  if (raw.length < MIN_CANDIDATE_QUERY_LENGTH) return [];
  const limit = Math.min(Math.max(Number(input.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), 25);
  const supabase = getSupabaseAdmin();

  const plan = planCandidateQuery(raw);
  if (plan.filters.length === 0) return [];

  const { data: candidateRows, error } = await supabase
    .from("ats_candidates")
    .select("id, full_name, phone")
    .or(plan.filters.join(","))
    // Deliberately wider than `limit`: the CV filter and the phone check below both remove rows,
    // and taking exactly `limit` here would silently return fewer than asked for.
    .limit(limit * 8);
  if (error || !Array.isArray(candidateRows) || candidateRows.length === 0) return [];

  const ids = candidateRows
    .map((row) => String((row as { id?: string | null }).id ?? "").trim())
    .filter(Boolean);
  if (ids.length === 0) return [];

  const { data: fileRows } = await supabase
    .from("ats_files")
    .select("candidate_id, file_name, created_at")
    .in("candidate_id", ids)
    .eq("kind", "cv")
    // `drive_file_id` is the storage path (the column name is historical — Supabase Storage is the
    // backend, Drive is the owner's mirror). A row without one has no file behind it, so it is not
    // something that can be carried.
    .not("drive_file_id", "is", null)
    .order("created_at", { ascending: false });

  const newest = newestCvPerCandidate(
    (Array.isArray(fileRows) ? fileRows : []).map((row) => ({
      candidateId: String((row as { candidate_id?: string | null }).candidate_id ?? ""),
      createdAt: (row as { created_at?: string | null }).created_at ?? null,
      fileName: (row as { file_name?: string | null }).file_name ?? null,
    })),
  );

  const scored: { match: CandidateCvMatch; score: number }[] = [];
  for (const row of candidateRows) {
    const id = String((row as { id?: string | null }).id ?? "").trim();
    const cv = newest.get(id);
    if (!cv) continue;
    const phone = (row as { phone?: string | null }).phone ?? null;
    // The real phone comparison, on digits only. The database filter above could only ask for the
    // last four digits (the longest run that survives "+20 109 588 8700"), so without this a
    // search for one number would also return everyone whose number merely ENDS in those four.
    if (plan.phoneTailDigits && !digitsOf(phone).endsWith(plan.phoneTailDigits)) continue;
    scored.push({
      match: {
        candidateId: id,
        candidateName:
          String((row as { full_name?: string | null }).full_name ?? "").trim() || "Unnamed candidate",
        cvFileName: cv.fileName,
        cvUploadedAt: cv.createdAt,
        phoneTail: phoneTailOf(phone),
      },
      score: nameTokenScore((row as { full_name?: string | null }).full_name, plan.tokens),
    });
  }

  // Most of the typed name first, then the newest CV. Ranking matters more than it looks: seeded
  // with an employee's full legal name, the candidate recruitment holds under a shorter version of
  // it must come above the strangers who happen to share one common first name.
  scored.sort(
    (a, b) =>
      b.score - a.score
      || (Date.parse(b.match.cvUploadedAt ?? "") || 0) - (Date.parse(a.match.cvUploadedAt ?? "") || 0),
  );
  return scored.slice(0, limit).map((entry) => entry.match);
}
