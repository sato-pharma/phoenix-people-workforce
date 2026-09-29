import { getSupabaseAdmin } from "@/lib/supabase/server";

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

  const digits = digitsOf(raw);
  // A name OR a phone, in one round trip. The phone half is only added when what was typed is
  // actually digits — otherwise `%%`-wrapping a name into a phone column matches nothing and
  // costs a scan. PostgREST's `or` takes `*` as its wildcard, not `%`.
  const escaped = raw.replace(/[,()*]/g, " ").trim();
  if (!escaped) return [];
  const filters = [`full_name.ilike.*${escaped}*`];
  if (digits.length >= 4) filters.push(`phone.ilike.*${digits}*`);

  const { data: candidateRows, error } = await supabase
    .from("ats_candidates")
    .select("id, full_name, phone")
    .or(filters.join(","))
    // Deliberately wider than `limit`: the CV filter below removes candidates, and taking exactly
    // `limit` here would silently return fewer than asked for whenever one of them has no CV.
    .limit(limit * 5);
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

  const matches: CandidateCvMatch[] = [];
  for (const row of candidateRows) {
    const id = String((row as { id?: string | null }).id ?? "").trim();
    const cv = newest.get(id);
    if (!cv) continue;
    matches.push({
      candidateId: id,
      candidateName: String((row as { full_name?: string | null }).full_name ?? "").trim() || "Unnamed candidate",
      cvFileName: cv.fileName,
      cvUploadedAt: cv.createdAt,
      phoneTail: phoneTailOf((row as { phone?: string | null }).phone),
    });
  }

  matches.sort((a, b) => Date.parse(b.cvUploadedAt ?? "") - Date.parse(a.cvUploadedAt ?? "") || 0);
  return matches.slice(0, limit);
}
