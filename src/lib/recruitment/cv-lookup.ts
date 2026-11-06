// Recruitment / ATS — CV LOOKUP: find ONE person's CV and application by searching for them.
//
// ── WHAT THE OWNER ASKED FOR, AND WHY THIS IS NOT THE CANDIDATE POOL ────────────────────────────
//
// 2026-09-30, about Yasmeena Elsafory (`HR-009`, HR Operations): "i want to make something that she
// can search the cvs in admin account and finds only what it search for i dont want her to have
// access to all cvs."
//
// So the shape of the feature is the shape of the refusal. There is no list, no landing set, no
// "recent candidates", no export and no bulk anything: a blank box, and until somebody types into
// it the screen holds nothing at all. Every other CV surface in this codebase starts by loading the
// pool — the CV Database calls `listCandidates()` and the screening workspace ships ~683 kB of
// candidates to the browser — which is precisely what may not happen here.
//
// ── WHY IT CANNOT RIDE ON `candidates:read` ─────────────────────────────────────────────────────
//
// `cv-search.ts` (the recruiter's search, next door) states the principle this module has to work
// around: "search must never become a way around the gate on the pool — a caller who may not list
// candidates must not be able to ask 'who has cardiology on their CV' and get a list of ids back."
// That is exactly right for a seat that is simply not a recruiter, and it is why HR Operations is
// not quietly handed `candidates:read`.
//
// The resolution is a DIFFERENT gate, not a weaker one: `cv_lookup:read`, a resource capped at
// `read` for HR authority roles and nothing else (see the hard boundary in permissions.ts). The
// owner decided, in plain words, that this named seat may reach a CV she searched for. What the
// separate resource buys is that the decision stays a decision — withdrawable in one line, and
// unable to drag the pool, the pipeline or an export along behind it.
//
// ── THE SEARCH IS TWO HALVES, AND BOTH ARE MEASURED ─────────────────────────────────────────────
//
// He asked for "full cv and application", so both are searched:
//
//   1. THE CV, through `ats_search_candidate_cvs` — the same index-backed function the recruiter's
//      own CV search uses, so the two screens can never disagree about what a CV says. Measured on
//      production 2026-09-30: 135 ms for "pharmacist" at a 1,000 limit.
//   2. THE APPLICATION, as a plain scan of the candidate's own row — name, contact, where they
//      live, what they studied, who they work for, what they applied for, and their own declared
//      answers. Measured the same day: 37 ms across all 1,260 candidates.
//
// A THIRD SHAPE WAS BUILT FIRST AND THROWN AWAY: one SQL function that concatenated both halves
// into a document and tokenised it per query. It answered in 2,077 ms on production — `to_tsvector`
// over 1,260 documents, twice (once to filter, once to rank) — and would grow with the pool. The
// two-half version is ~175 ms and needs no migration, no new column and no trigger. The reason it
// is written down is that the one-document version looks tidier and is the obvious thing to try
// again.
//
// 🔒 `notes` AND `status_note` ARE NOT SEARCHED, AND THAT IS THE OWNER'S RULING, NOT A PREFERENCE
// (2026-09-30: "leave notes out of the CV Lookup search", asked and answered after the screen
// shipped). They are the recruiter's own commentary about a person — "weak call", "asked for too
// much" — not the CV and not the application, and this seat has no business searching what a
// colleague wrote about a candidate.
//
// 🔴 THE PRESSURE TO WIDEN IT WILL ARRIVE AS A HELPFUL BUG REPORT: "she searched for somebody and
// could not find them, so let us search the notes too." That is the one change this exclusion
// exists to refuse. A note is not a fact about the candidate, it is a judgement about them by a
// person who is not the reader — searchable notes turn a lookup into a way to find out what
// colleagues have said. If a real candidate cannot be found, the answer is a term that matches
// their CV or their application, never a wider column list.
//
// Pinned by `tests/cv-lookup.test.ts`, which reads THIS array and goes red if either name returns.
//
// ── NO CAP, AND THE ONE CEILING THAT IS NOT MINE ────────────────────────────────────────────────
//
// The owner chose "no cap" when asked how tightly a search should be limited, so nothing here caps
// her result set. The only ceiling in the path is inside `ats_search_candidate_cvs`, which clamps
// its own limit at 1,000 rows and is shared with the recruiter's search — raising it there would
// change a screen this feature has nothing to do with. It binds only on a query matching more than
// 1,000 of the 1,239 candidates who have a CV reading, and when it does, `truncated` says so on the
// screen rather than letting a cut list read as a complete answer.
//
// What DOES constrain her, by design and with the owner's agreement, is the floor: a search shorter
// than `CV_LOOKUP_MIN_LENGTH` returns nothing at all, so the box can never be used as a way to page
// out the whole database one letter at a time.

import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { recruitmentDb } from "@/lib/recruitment/db";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";

/**
 * The shortest query that runs at all.
 *
 * THREE, not the two the recruiter's CV search allows, and the difference is the point. This box is
 * held by a seat that may not list the pool, so a one- or two-character search — which matches most
 * of a corpus of Egyptian names — would hand her the thing being withheld while technically being a
 * search. Three characters is where a query starts naming somebody.
 */
export const CV_LOOKUP_MIN_LENGTH = 3;

/**
 * What the shared CV function is asked for. Its own body clamps at 1,000, so this is the ceiling
 * restated rather than a cap of ours — see the header. Asking for exactly its clamp means a
 * truncated answer is reported as truncated instead of silently sliced by two different numbers.
 */
const CV_HALF_LIMIT = 1000;

/**
 * The candidate's own row, as the application half searches it.
 *
 * Every column here is something the PERSON told us or something the CV said about them. `notes`,
 * `status_note` and `applied_for_evidence` are absent on purpose — 🔒 the first two by the owner's
 * ruling of 2026-09-30, see the header — and so is every salary column: a search by expected salary
 * is a way to sort the pool by price, not a way to find somebody.
 *
 * ADDING A NAME HERE WIDENS WHAT THIS SEAT CAN READ. Every entry is a column whose contents she can
 * pull a person out of, so a new one is an access decision rather than a convenience.
 */
const APPLICATION_SEARCH_COLUMNS = [
  "full_name",
  "email",
  "phone",
  "whatsapp",
  "national_id",
  "linkedin_url",
  "governorate",
  "address",
  "nationality",
  "place_of_birth",
  "university",
  "faculty",
  "degree",
  "current_employer",
  "current_job_title",
  "medical_rep_employer",
  "professional_summary",
  "current_role_responsibilities",
  "applied_for_job_title",
  "sent_for_job_title",
  "sent_for_area",
  "sent_for_line",
  "sent_for_region",
  "preferred_area_name",
  "preferred_region_name",
  "declared_background",
  "declared_experience",
] as const;

/** The columns the result rows are built from. Narrow on purpose: this is a result card, not a file. */
const DISPLAY_COLUMNS =
  "id,full_name,phone,email,governorate,university,current_employer,current_job_title," +
  "applied_for_job_title,status,created_at";

export type CvLookupHit = {
  candidateId: string;
  name: string;
  /** What they applied for, in words. Empty when the record never recorded one. */
  appliedFor: string;
  /** Where they live, as the record has it. */
  governorate: string;
  university: string;
  currentEmployer: string;
  currentJobTitle: string;
  phone: string;
  email: string;
  status: string;
  statusLabel: string;
  addedAt: string | null;
  /**
   * A slice of the CV that matched, so the row can say WHY it is here. Empty when the hit came from
   * the application half alone — an honest blank rather than an invented explanation.
   */
  matchedOn: string;
};

export type CvLookupResult = {
  query: string;
  hits: CvLookupHit[];
  /** True only when the shared CV function hit its own 1,000-row clamp. See the header. */
  truncated: boolean;
};

type CandidateRow = {
  applied_for_job_title?: string | null;
  created_at?: string | null;
  current_employer?: string | null;
  current_job_title?: string | null;
  email?: string | null;
  full_name?: string | null;
  governorate?: string | null;
  id?: string | null;
  phone?: string | null;
  status?: string | null;
  university?: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Candidates whose CV or whose application mentions the query.
 *
 * `cv_lookup: read`, asserted HERE as well as at the route. Two assertions on purpose, the same
 * reason the recruiter's CV search gives: a future caller that reaches this service by another
 * route must not be able to skip the gate, and this function returns candidate identities.
 */
export async function searchCvLookup(access: AccessContext, query: string): Promise<CvLookupResult> {
  await assertPermission(access, "cv_lookup", "read");

  const cleaned = String(query ?? "").trim().replace(/\s+/g, " ");
  // Short-circuited before any round trip. A blank box is the screen's normal state, not an error.
  if (cleaned.length < CV_LOOKUP_MIN_LENGTH) {
    return { hits: [], query: cleaned, truncated: false };
  }

  const supabase = recruitmentDb();

  // The application half's filter, built by the shared helper: each value double-quoted, so a name
  // holding a comma or a parenthesis is searched for instead of ending the clause, and the `%`/`*`
  // wildcards neutralised. This file used to carry its own copy of the quoting, which was correct
  // as far as it went and missed the wildcards entirely — a query of `%` matched EVERY candidate.
  // Empty means nothing searchable was typed; `.or("")` is a 400, so the half is skipped.
  const applicationFilter = ilikeAnyFilter(APPLICATION_SEARCH_COLUMNS, cleaned);
  if (!applicationFilter) return { hits: [], query: cleaned, truncated: false };

  // BOTH HALVES IN PARALLEL. They touch different tables and neither needs the other's answer, so
  // the search costs the slower of the two (~135 ms) rather than their sum.
  const [cvHalf, applicationRows] = await Promise.all([
    supabase.rpc("ats_search_candidate_cvs", { p_limit: CV_HALF_LIMIT, p_query: cleaned }),
    // Every match, paged to a short page by the unique `id`: the owner chose NO cap on a search, and an
    // unpaged read would stop at one response's worth with no error and no `truncated`.
    fetchAllRows<CandidateRow>(
      () => supabase.from("ats_candidates").select(DISPLAY_COLUMNS).or(applicationFilter),
      "id",
    ),
  ]);

  if (cvHalf.error) throw cvHalf.error;

  const cvRows = (cvHalf.data ?? []) as Array<{ candidate_id?: string | null; matched_on?: string | null }>;
  const matchedOnById = new Map<string, string>();
  // Kept in the order the function returned them — it ranks by ts_rank, so the best CV match leads.
  const cvOrder: string[] = [];
  for (const row of cvRows) {
    const id = text(row.candidate_id);
    if (!id || matchedOnById.has(id)) continue;
    matchedOnById.set(id, text(row.matched_on));
    cvOrder.push(id);
  }

  const rowById = new Map<string, CandidateRow>();
  for (const row of applicationRows) {
    const id = text(row.id);
    if (id) rowById.set(id, row);
  }

  // A CV hit whose candidate the application half did not return still needs its display fields.
  const missing = cvOrder.filter((id) => !rowById.has(id));
  if (missing.length > 0) {
    // Chunked because PostgREST puts an `in` list in the URL, and a 1,000-id list overruns it.
    for (let start = 0; start < missing.length; start += 200) {
      const batch = missing.slice(start, start + 200);
      const { data, error } = await supabase.from("ats_candidates").select(DISPLAY_COLUMNS).in("id", batch);
      if (error) throw error;
      for (const row of (data ?? []) as CandidateRow[]) {
        const id = text(row.id);
        if (id) rowById.set(id, row);
      }
    }
  }

  // CV matches first, in rank order, then the application-only matches by name. A row the CV half
  // found is the one most likely to be the person she meant; a row found only because her word
  // appears in an address is the weaker answer and reads better below.
  const applicationOnly = [...rowById.keys()]
    .filter((id) => !matchedOnById.has(id))
    .sort((left, right) => text(rowById.get(left)?.full_name).localeCompare(text(rowById.get(right)?.full_name)));

  const hits: CvLookupHit[] = [];
  for (const id of [...cvOrder, ...applicationOnly]) {
    const row = rowById.get(id);
    if (!row) continue;
    const status = text(row.status);
    hits.push({
      addedAt: text(row.created_at) || null,
      appliedFor: text(row.applied_for_job_title),
      candidateId: id,
      currentEmployer: text(row.current_employer),
      currentJobTitle: text(row.current_job_title),
      email: text(row.email),
      governorate: text(row.governorate),
      matchedOn: matchedOnById.get(id) ?? "",
      name: text(row.full_name) || "Unnamed candidate",
      phone: text(row.phone),
      status,
      statusLabel: candidateStatusLabel(status),
      university: text(row.university),
    });
  }

  return { hits, query: cleaned, truncated: cvRows.length >= CV_HALF_LIMIT };
}

/**
 * One row per search, readable by the owner alone.
 *
 * He asked for this directly on 2026-09-30 ("yes — logged, Super Admin only"), and it is written
 * from the ROUTE rather than from `searchCvLookup` so that a future caller of the service cannot
 * decide not to record itself.
 *
 * BEST-EFFORT (`writeAuditLog`, which swallows and logs). A search that fails because its own audit
 * row could not be written would be a diagnostic breaking the thing it observes, and the person on
 * the other end of it is doing her job.
 *
 * The row holds the term and the COUNT, never the people. Who was found is a question the same term
 * answers again at any time; writing 300 candidate names into an audit row would copy the pool into
 * a second table, which is the disclosure this whole module is built to avoid.
 */
export async function recordCvLookupSearch(input: {
  access: AccessContext;
  query: string;
  resultCount: number;
  truncated: boolean;
}): Promise<void> {
  const actor = input.access.loginId ?? input.access.hrId ?? null;
  await writeAuditLog({
    actorLoginId: actor,
    entityId: actor,
    entityType: "cv_lookup_search",
    newValues: {
      query: input.query,
      resultCount: input.resultCount,
      truncated: input.truncated,
    },
    summary: `CV Lookup search "${input.query}" returned ${input.resultCount} candidate(s)`,
  });
}
