// Recruitment / ATS — the database half of "I will call" / "Skip".
//
// The rule about who may see a phone number, what a refusal says and what a claim IS all live in
// candidate-call-claims.ts, which is pure. This file only reads and writes ats_candidate_call_actions
// and never re-decides any of it.
//
// DEGRADES, NEVER THROWS, ON A MISSING TABLE — the same contract manager-sends.ts and
// manager-folders.ts carry, for the same reason: code ships on a merge to `main` and serves traffic
// within minutes, while the migration that creates the table is a separate announced step. In that
// window PostgREST answers a read naming an unknown table with PGRST205 out of its own schema cache
// (never 42P01, which is what Postgres says once the cache is warm), and BOTH have to be treated as
// one condition or whichever you did not check is the one that arrives. On that condition a READ
// answers "nobody has claimed anything", which leaves every card in its pre-claim state — phone
// hidden, both buttons offered — and a WRITE reports that it could not be recorded, which is the
// honest answer and the only one that does not tell a manager he has reserved a CV when nothing was
// stored.

import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { logError } from "@/lib/observability/log";
import {
  type CandidateCallClaim,
  type CandidateCallClaims,
} from "@/lib/recruitment/candidate-call-claims";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";
import { districtReturnSuppressionKey } from "@/lib/recruitment/district-manager-folders";

/** The table, named once so a rename is one edit and a typo cannot half-apply. */
export const CALL_ACTIONS_TABLE = "ats_candidate_call_actions";

const CLAIM_COLUMNS = "candidate_id,manager_hr_id,manager_name,acted_at";

/** Shared empty results, so the common "no rows / no table" path allocates nothing. */
const EMPTY_CLAIMS: CandidateCallClaims = Object.freeze({});
const EMPTY_SUPPRESSIONS: ReadonlySet<string> = new Set<string>();

/**
 * True when the table is not in this database yet.
 *
 * Checks BOTH codes, and the schema-cache wording besides. Matching one of them leaves the other as
 * a thrown 500 on a whole page — see the header.
 */
function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "PGRST205" || code === "42P01") return true;
  const message = String((error as { message?: string } | null)?.message ?? "");
  return /schema cache/i.test(message) && message.includes(CALL_ACTIONS_TABLE);
}

/** True for a unique-violation — the partial index that makes a claim single. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

type ClaimRow = {
  candidate_id?: unknown;
  manager_hr_id?: unknown;
  manager_name?: unknown;
  acted_at?: unknown;
};

function mapClaim(row: ClaimRow): CandidateCallClaim | null {
  const candidateId = String(row.candidate_id ?? "").trim();
  const managerHrId = canonicalHrIdForDisplay(String(row.manager_hr_id ?? ""));
  if (!candidateId || !managerHrId) return null;
  return {
    candidateId,
    claimedAt: String(row.acted_at ?? ""),
    managerHrId,
    managerName: textOrNull(row.manager_name),
  };
}

/**
 * The manager's name, snapshotted at claim time so another manager's screen is a plain read with no
 * join to a directory a leaver drops out of. Same resolver, same reason, as recordDistrictReturn.
 */
async function resolveManagerName(managerHrId: string): Promise<string | null> {
  const names = await namesByHrId([managerHrId]);
  return textOrNull(names.get(managerHrId));
}

/**
 * Every claim standing against these candidates, keyed by candidate id.
 *
 * Batched through chunkIds: a manager's page can carry several hundred CVs once his district folders
 * are counted, and a PostgREST `.in()` carrying that many ids fails on the request-header cap with
 * an error naming neither the query nor the size.
 */
export async function loadCallClaims(candidateIds: readonly string[]): Promise<CandidateCallClaims> {
  const ids = Array.from(new Set(candidateIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) return EMPTY_CLAIMS;

  const claims: CandidateCallClaims = {};
  for (const batch of chunkIds(ids)) {
    const { data, error } = await recruitmentDb()
      .from(CALL_ACTIONS_TABLE)
      .select(CLAIM_COLUMNS)
      .eq("action", "will_call")
      .in("candidate_id", batch);
    if (error) {
      // A missing table is the expected deploy-before-migration state and must stay silent; anything
      // else is worth a line, but neither may take the page down — a claim nobody can read is a
      // hidden phone number and two buttons, which is exactly the pre-claim screen.
      if (!isMissingTable(error)) {
        logError("Candidate call claims could not be read", {
          error,
          labels: { event: "candidate_call_claims_read_failed" },
        });
      }
      return EMPTY_CLAIMS;
    }
    for (const row of (data ?? []) as ClaimRow[]) {
      const claim = mapClaim(row);
      if (claim) claims[claim.candidateId] = claim;
    }
  }
  return claims;
}

/** The claim on one CV, or null when nobody has taken it. */
export async function loadCallClaim(candidateId: string): Promise<CandidateCallClaim | null> {
  const claims = await loadCallClaims([candidateId]);
  return claims[String(candidateId ?? "").trim()] ?? null;
}

/**
 * The CVs this manager has SKIPPED, as suppression keys for the district-folder placement rule.
 *
 * Deliberately the same key function the returns table uses (`districtReturnSuppressionKey`), so the
 * two sets simply union at the call site and the pure placement rule never learns that there are two
 * ways for a CV to leave one manager's folder. A skip is per-manager for the identical reason a
 * return is: the same Nasr City CV sits in three managers' folders, and one of them passing must
 * leave it in front of the other two — which is the whole point of the claim beside it.
 */
export async function loadManagerSkipSuppressions(
  managerHrId: string | null | undefined,
): Promise<ReadonlySet<string>> {
  const key = canonicalHrIdForDisplay(managerHrId);
  if (!key) return EMPTY_SUPPRESSIONS;

  let data: Array<{ candidate_id: string }>;
  try {
    // Every skip of this manager, paged to a short page. `candidate_id` is unique within one manager
    // (unique index on candidate and manager), so the page boundary cannot repeat or drop a row, and a
    // skip a response cap dropped would put that CV back in front of him.
    data = await fetchAllRows<{ candidate_id: string }>(
      () =>
        recruitmentDb()
          .from(CALL_ACTIONS_TABLE)
          .select("candidate_id")
          .eq("manager_hr_id", key)
          .eq("action", "skipped"),
      "candidate_id",
    );
  } catch (error) {
    if (!isMissingTable(error)) {
      logError("Candidate skips could not be read for the folder view", {
        error,
        labels: { event: "candidate_call_skips_read_failed" },
      });
    }
    return EMPTY_SUPPRESSIONS;
  }

  const set = new Set<string>();
  for (const row of data) {
    set.add(districtReturnSuppressionKey(managerHrId, String((row as { candidate_id: string }).candidate_id)));
  }
  return set;
}

/**
 * The two numbers a claim reveals, read straight from the candidate row.
 *
 * Its own tiny read rather than `getCandidate`, and that is the point: the caller is a line manager,
 * and `getCandidate` gates on the recruiter's own scope. The gate that matters here has already been
 * asked by the route (the CV is his, or it is in his own district folder) and the claim has already
 * been proven to be his — this function is what hands back what he just bought, nothing more. It is
 * called from exactly one place for that reason.
 */
export async function loadCandidateContact(
  candidateId: string,
): Promise<{ phone: string | null; whatsapp: string | null }> {
  const id = String(candidateId ?? "").trim();
  if (!id) return { phone: null, whatsapp: null };
  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("phone,whatsapp")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return { phone: null, whatsapp: null };
  const row = data as { phone?: unknown; whatsapp?: unknown };
  return { phone: textOrNull(row.phone), whatsapp: textOrNull(row.whatsapp) };
}

export type CallActionOutcome =
  /** The write landed. `claim` is the claim now standing on the CV, or null after a release/skip. */
  | { ok: true; claim: CandidateCallClaim | null }
  /** Refused, with the sentence to show. `claim` is whatever stands instead. */
  | { ok: false; claim: CandidateCallClaim | null; message: string };

const NOT_RECORDED =
  "That could not be recorded just now. Reload the page and try again — nothing has been reserved.";

/**
 * "I will call this candidate."
 *
 * Idempotent for the same manager: a second press writes nothing new and answers with the claim he
 * already holds, because the second press means the same thing as the first and a refusal there
 * would read as his own reservation having failed.
 *
 * The race is decided by the DATABASE, never by the read above it. Two managers pressing within the
 * same second both see "nobody has claimed this" and both insert; the partial unique index lets
 * exactly one through and the loser is told who won. Checking first and inserting second, with no
 * index behind it, is the version of this that reserves one CV to two people.
 */
export async function claimCandidateCall(input: {
  candidateId: string;
  managerHrId: string;
}): Promise<CallActionOutcome> {
  const candidateId = String(input.candidateId ?? "").trim();
  const managerHrId = canonicalHrIdForDisplay(input.managerHrId);
  if (!candidateId || !managerHrId) return { claim: null, message: NOT_RECORDED, ok: false };

  const standing = await loadCallClaim(candidateId);
  if (standing) {
    if (canonicalHrIdKey(standing.managerHrId) === canonicalHrIdKey(managerHrId)) {
      return { claim: standing, ok: true };
    }
    return { claim: standing, message: takenMessage(standing), ok: false };
  }

  const managerName = await resolveManagerName(managerHrId);
  const { error } = await recruitmentDb()
    .from(CALL_ACTIONS_TABLE)
    .upsert(
      {
        action: "will_call",
        acted_at: new Date().toISOString(),
        candidate_id: candidateId,
        manager_hr_id: managerHrId,
        manager_name: managerName,
      },
      { onConflict: "candidate_id,manager_hr_id" },
    );

  if (error) {
    // The partial index fired: somebody else claimed it between the read above and this write. Read
    // back who, and tell him — that is the honest answer and the one his screen needs to render.
    if (isUniqueViolation(error)) {
      const winner = await loadCallClaim(candidateId);
      return {
        claim: winner,
        message: winner ? takenMessage(winner) : NOT_RECORDED,
        ok: false,
      };
    }
    if (!isMissingTable(error)) {
      logError("Candidate call claim could not be written", {
        error,
        labels: { candidateId, event: "candidate_call_claim_write_failed" },
      });
    }
    return { claim: null, message: NOT_RECORDED, ok: false };
  }

  return { claim: { candidateId, claimedAt: new Date().toISOString(), managerHrId, managerName }, ok: true };
}

function takenMessage(claim: CandidateCallClaim): string {
  const name = String(claim.managerName ?? "").trim() || claim.managerHrId;
  return `${name} has already said they will call this candidate.`;
}

/**
 * The claimer changes his mind. Deletes only HIS OWN claim row, so a stray call can never lift
 * somebody else's reservation — the manager hr id is part of the filter, never only the candidate.
 */
export async function releaseCandidateCall(input: {
  candidateId: string;
  managerHrId: string;
}): Promise<CallActionOutcome> {
  const candidateId = String(input.candidateId ?? "").trim();
  const managerHrId = canonicalHrIdForDisplay(input.managerHrId);
  if (!candidateId || !managerHrId) return { claim: null, message: NOT_RECORDED, ok: false };

  const { error } = await recruitmentDb()
    .from(CALL_ACTIONS_TABLE)
    .delete()
    .eq("candidate_id", candidateId)
    .eq("manager_hr_id", managerHrId)
    .eq("action", "will_call");

  if (error) {
    if (!isMissingTable(error)) {
      logError("Candidate call claim could not be released", {
        error,
        labels: { candidateId, event: "candidate_call_release_failed" },
      });
    }
    return { claim: await loadCallClaim(candidateId), message: NOT_RECORDED, ok: false };
  }
  return { claim: null, ok: true };
}

/**
 * "Skip" on a CV that reached him through one of his own area folders.
 *
 * Writes his own pass and nothing else: the candidate's status is untouched, so the recruitment team
 * and every other manager still see exactly what they saw before. The CV leaves this one manager's
 * folder because `loadManagerSkipSuppressions` feeds the same placement rule a district return does.
 *
 * It also RELEASES his claim, by writing over the (candidate, manager) row — a manager who said he
 * would call and then passed has plainly stopped intending to call, and leaving the CV reserved to
 * him would lock it away from everybody else with nobody working it.
 */
export async function skipCandidateForManager(input: {
  candidateId: string;
  managerHrId: string;
  note?: string | null;
}): Promise<CallActionOutcome> {
  const candidateId = String(input.candidateId ?? "").trim();
  const managerHrId = canonicalHrIdForDisplay(input.managerHrId);
  if (!candidateId || !managerHrId) return { claim: null, message: NOT_RECORDED, ok: false };

  const managerName = await resolveManagerName(managerHrId);
  const { error } = await recruitmentDb()
    .from(CALL_ACTIONS_TABLE)
    .upsert(
      {
        action: "skipped",
        acted_at: new Date().toISOString(),
        candidate_id: candidateId,
        manager_hr_id: managerHrId,
        manager_name: managerName,
        note: textOrNull(input.note),
      },
      { onConflict: "candidate_id,manager_hr_id" },
    );

  if (error) {
    if (!isMissingTable(error)) {
      logError("Candidate skip could not be written", {
        error,
        labels: { candidateId, event: "candidate_call_skip_write_failed" },
      });
    }
    return { claim: await loadCallClaim(candidateId), message: NOT_RECORDED, ok: false };
  }
  return { claim: null, ok: true };
}
