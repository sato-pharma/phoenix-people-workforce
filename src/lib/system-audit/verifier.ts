import { hrIdLookupKeys } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { transitionIssueStatus } from "@/lib/system-audit/repository";
import type { SystemAuditFamily, SystemAuditStatus } from "@/lib/system-audit/types";

/**
 * THE VERIFIER — the only thing that may say FIXED — VERIFIED, and the thing that takes it back.
 *
 * A person marks an issue FIX IMPLEMENTED with the commit that fixed it, and the ledger records when
 * that commit became a released build (`release_gates.recorded_at`). From then on, every night:
 *
 *   RECURRENCE → NOT FIXED. An occurrence after the fix went live reopens the issue, whether it is
 *     still FIX IMPLEMENTED or was already FIXED — VERIFIED (a verified fix that recurs was not a
 *     fix). Event families compare `occurred_at`; the state families — reconciliation and record
 *     linkage, which re-find the same row every night — compare `last_event_at`, because their row's
 *     `occurred_at` is the night it was FIRST found and never moves.
 *   OLDER BUILD → NOT A RECURRENCE. An occurrence after the fix went live that carries a release
 *     recorded BEFORE the fix — a browser still running yesterday's bundle — is marked
 *     `pre_fix_build` and set aside. A release nobody can place (unknown, or older than the gate
 *     table itself) counts as a recurrence: an unprovable excuse never closes an issue.
 *   SEVEN QUIET DAYS WITH REAL EXPOSURE → FIXED — VERIFIED. Quiet is not enough: a page nobody
 *     opened for a week proves nothing. Exposure is MEASURED:
 *       - an error shown to people: the pages it happened on were opened again since the fix — by
 *         the people it hit, when it hit anyone — at least three times, from `activity_events`;
 *       - a detector's finding: the detector that found it ran cleanly on at least three nights since
 *         the fix (for an integrity check, the check itself HELD on each of those nights).
 *     No measurable exposure → the issue waits, and the run says why.
 *
 * Never on half the evidence: if the release table cannot be read, nothing is decided tonight.
 */

export const VERIFIER_ACTOR = "system:verifier";
export const QUIET_DAYS = 7;
export const MIN_PAGE_VIEWS = 3;
export const MIN_CLEAN_NIGHTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Families whose rows are re-found every night, so `last_event_at` is what moves. */
export const STATE_FAMILIES: ReadonlySet<SystemAuditFamily> = new Set(["reconciliation", "data_linkage"]);

export type FixUnderReview = {
  issueId: string;
  signatureKey: string;
  family: SystemAuditFamily;
  status: SystemAuditStatus;
  title: string;
  fixId: string;
  fixSha: string;
  fixLiveAt: string;
};

export type RecurrenceCandidate = {
  id: string;
  occurredAt: string;
  lastEventAt: string;
  release: string | null;
};

export type ReleaseGate = { sha: string; recordedAt: string };

export type Exposure = { exposed: boolean; measure: string };

export interface VerifierStore {
  /** Every issue that is FIX IMPLEMENTED or FIXED — VERIFIED, with its newest fix still standing. */
  openFixes(): Promise<FixUnderReview[]>;
  /** Up to 50 occurrences after the fix went live, oldest first, excluding test, triaged and pre-fix rows. */
  recurrenceCandidates(fix: FixUnderReview, byLastEvent: boolean): Promise<RecurrenceCandidate[]>;
  /** Every released build, or null when the table does not exist (staging). Throws when unreadable. */
  releaseGates(): Promise<ReleaseGate[] | null>;
  markPreFixBuild(occurrenceIds: string[]): Promise<void>;
  /** HR keys of the people the issue reached before its fix went live (at most 50). */
  affectedPeople(issueId: string, beforeIso: string): Promise<string[]>;
  /** The page addresses the issue happened on — never an API path, at most 20. */
  pageRoutes(issueId: string): Promise<string[]>;
  /** Page views of `routes` since `sinceIso`, by `hrKeys` when given; counts up to `atLeast`. */
  pageViews(input: { routes: string[]; hrKeys: string[] | null; sinceIso: string; atLeast: number }): Promise<number>;
  /** The Cairo nights since `sinceIso` on which `detector` ran cleanly (and `checkId` held). */
  cleanNights(input: { detector: string; sinceIso: string; checkId: string | null }): Promise<string[]>;
  transition(input: Parameters<typeof transitionIssueStatus>[0]): Promise<unknown>;
}

/**
 * Pure: was this occurrence produced by a build older than the fix? `null` when nobody can say — no
 * release on the row, or a release the gate table does not hold.
 */
export function isOlderBuild(release: string | null, fixLiveAt: string, gates: readonly ReleaseGate[] | null): boolean | null {
  const sha = String(release ?? "").trim().toLowerCase();
  if (!gates || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const gate = gates.find((candidate) => candidate.sha.startsWith(sha));
  if (!gate) return null;
  return Date.parse(gate.recordedAt) < Date.parse(fixLiveAt);
}

/** Pure: split the candidates into the first true recurrence and the older-build rows to set aside. */
export function judgeRecurrence(
  candidates: readonly RecurrenceCandidate[],
  fix: Pick<FixUnderReview, "fixLiveAt">,
  gates: readonly ReleaseGate[] | null,
): { recurrence: RecurrenceCandidate | null; olderBuild: RecurrenceCandidate[] } {
  const olderBuild: RecurrenceCandidate[] = [];
  for (const candidate of candidates) {
    if (isOlderBuild(candidate.release, fix.fixLiveAt, gates) === true) {
      olderBuild.push(candidate);
      continue;
    }
    return { recurrence: candidate, olderBuild };
  }
  return { recurrence: null, olderBuild };
}

/** Pure: has the fix been live long enough to be judged quiet? */
export function quietLongEnough(fixLiveAt: string, nowMs: number): boolean {
  const live = Date.parse(fixLiveAt);
  return Number.isFinite(live) && nowMs - live >= QUIET_DAYS * DAY_MS;
}

/** An input every decision depends on could not be read, so NOTHING was decided tonight. */
export class VerifierInputUnreadable extends Error {
  readonly source: string;
  constructor(source: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : `${source} could not be read: ${String(cause)}`);
    this.name = "VerifierInputUnreadable";
    this.source = source;
  }
}

export type VerifierOutcome = {
  reviewed: number;
  reopened: Array<{ issueId: string; title: string; wasVerified: boolean; occurrenceId: string }>;
  verified: Array<{ issueId: string; title: string; measure: string }>;
  waiting: Array<{ issueId: string; title: string; why: string }>;
  olderBuildRows: number;
  unreadable: string[];
  budgetExhausted: boolean;
};

async function measureExposure(
  store: VerifierStore,
  fix: FixUnderReview,
  detectorIdByFamily: Partial<Record<SystemAuditFamily, string>>,
): Promise<Exposure> {
  if (fix.family === "app_error") {
    const routes = await store.pageRoutes(fix.issueId);
    if (routes.length === 0) {
      return { exposed: false, measure: "it happened on no page address that can be watched (an API call only)" };
    }
    const people = await store.affectedPeople(fix.issueId, fix.fixLiveAt);
    const views = await store.pageViews({
      routes,
      hrKeys: people.length > 0 ? people : null,
      sinceIso: fix.fixLiveAt,
      atLeast: MIN_PAGE_VIEWS,
    });
    const who = people.length > 0 ? `the ${people.length === 1 ? "person" : `${people.length} people`} it hit` : "anyone";
    return {
      exposed: views >= MIN_PAGE_VIEWS,
      measure: `${views >= MIN_PAGE_VIEWS ? `at least ${MIN_PAGE_VIEWS}` : views} page view(s) of ${routes.join(", ")} by ${who} since the fix went live`,
    };
  }

  const detector = detectorIdByFamily[fix.family];
  if (!detector) return { exposed: false, measure: "no detector re-measures this kind of issue" };
  const checkId = fix.family === "reconciliation" && fix.signatureKey.startsWith("recon:") ? fix.signatureKey.slice("recon:".length) : null;
  const nights = await store.cleanNights({ detector, sinceIso: fix.fixLiveAt, checkId });
  return {
    exposed: nights.length >= MIN_CLEAN_NIGHTS,
    measure: checkId
      ? `the check held on ${nights.length} night(s) since the fix went live`
      : `the detector ran cleanly on ${nights.length} night(s) since the fix went live`,
  };
}

/**
 * One pass over every standing fix. Throws VerifierInputUnreadable only when the standing fixes or
 * the release table cannot be read — the caller records that as a run that decided nothing. Every
 * per-issue read failure is recorded and skipped.
 */
export async function runVerifier(input: {
  store: VerifierStore;
  nowMs: number;
  deadline: number;
  now?: () => number;
  detectorIdByFamily: Partial<Record<SystemAuditFamily, string>>;
}): Promise<VerifierOutcome> {
  const { store } = input;
  const clock = input.now ?? (() => Date.now());
  const outcome: VerifierOutcome = {
    reviewed: 0,
    reopened: [],
    verified: [],
    waiting: [],
    olderBuildRows: 0,
    unreadable: [],
    budgetExhausted: false,
  };

  const fixes = await store.openFixes().catch((error: unknown) => {
    throw new VerifierInputUnreadable("system_audit_issues", error);
  });
  if (fixes.length === 0) return outcome;
  const gates = await store.releaseGates().catch((error: unknown) => {
    throw new VerifierInputUnreadable("release_gates", error);
  });

  for (const fix of fixes) {
    if (clock() >= input.deadline) {
      outcome.budgetExhausted = true;
      break;
    }
    outcome.reviewed += 1;
    try {
      const candidates = await store.recurrenceCandidates(fix, STATE_FAMILIES.has(fix.family));
      const { recurrence, olderBuild } = judgeRecurrence(candidates, fix, gates);
      if (olderBuild.length > 0) {
        await store.markPreFixBuild(olderBuild.map((row) => row.id));
        outcome.olderBuildRows += olderBuild.length;
      }

      if (recurrence) {
        const when = STATE_FAMILIES.has(fix.family) ? recurrence.lastEventAt : recurrence.occurredAt;
        await store.transition({
          issueId: fix.issueId,
          to: "not_fixed",
          actor: VERIFIER_ACTOR,
          occurrenceId: recurrence.id,
          reason: `It happened again after the fix went live (fix live ${fix.fixLiveAt}, seen again ${when}).`,
          evidence: {
            fixSha: fix.fixSha,
            fixLiveAt: fix.fixLiveAt,
            recurredAt: when,
            release: recurrence.release,
            wasVerified: fix.status === "fixed_verified",
          },
        });
        outcome.reopened.push({
          issueId: fix.issueId,
          title: fix.title,
          wasVerified: fix.status === "fixed_verified",
          occurrenceId: recurrence.id,
        });
        continue;
      }

      if (fix.status !== "fix_implemented") continue;
      if (!quietLongEnough(fix.fixLiveAt, input.nowMs)) {
        outcome.waiting.push({ issueId: fix.issueId, title: fix.title, why: `quiet for less than ${QUIET_DAYS} days` });
        continue;
      }
      const exposure = await measureExposure(store, fix, input.detectorIdByFamily);
      if (!exposure.exposed) {
        outcome.waiting.push({ issueId: fix.issueId, title: fix.title, why: `not enough exposure yet: ${exposure.measure}` });
        continue;
      }
      await store.transition({
        issueId: fix.issueId,
        to: "fixed_verified",
        actor: VERIFIER_ACTOR,
        reason: `No recurrence in ${QUIET_DAYS} days since the fix went live, with real exposure: ${exposure.measure}.`,
        evidence: { fixSha: fix.fixSha, fixLiveAt: fix.fixLiveAt, exposure: exposure.measure, quietDays: QUIET_DAYS },
      });
      outcome.verified.push({ issueId: fix.issueId, title: fix.title, measure: exposure.measure });
    } catch (error) {
      outcome.unreadable.push(`${fix.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return outcome;
}

// ─── The database half ────────────────────────────────────────────────────────────────────────────

type Client = ReturnType<typeof getSupabaseAdmin>;
const IN_CHUNK = 200;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function readFailure(what: string, error: { message?: string; code?: string } | null): Error {
  return new Error(`Verifier could not read ${what}${error?.code ? ` (${error.code})` : ""}: ${error?.message ?? "unknown error"}`);
}

/** Cairo calendar day of an instant. */
function cairoNight(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(
    new Date(iso),
  );
}

export function createDatabaseVerifierStore(override?: Client): VerifierStore {
  const supabase = () => override ?? getSupabaseAdmin({ requestTimeoutMs: 20_000 });
  return {
    async openFixes() {
      const issues = await fetchAllRows<{ id: string; signature_key: string; family: SystemAuditFamily; status: SystemAuditStatus; title: string }>(
        () => supabase().from("system_audit_issues").select("id,signature_key,family,status,title").in("status", ["fix_implemented", "fixed_verified"]),
        "id",
      );
      if (issues.length === 0) return [];
      const fixes: Array<{ id: string; issue_id: string; generation: number; fix_commit_sha: string; fix_live_at: string }> = [];
      for (const batch of chunks(issues.map((issue) => issue.id), IN_CHUNK)) {
        const { data, error } = await supabase()
          .from("system_audit_issue_fixes")
          .select("id,issue_id,generation,fix_commit_sha,fix_live_at")
          .in("issue_id", batch)
          .is("invalidated_at", null);
        if (error) throw readFailure("the fixes", error);
        fixes.push(...((data ?? []) as typeof fixes));
      }
      const newest = new Map<string, (typeof fixes)[number]>();
      for (const fix of fixes) {
        const current = newest.get(fix.issue_id);
        if (!current || fix.generation > current.generation) newest.set(fix.issue_id, fix);
      }
      return issues.flatMap((issue) => {
        const fix = newest.get(issue.id);
        if (!fix) return [];
        return [{
          issueId: issue.id,
          signatureKey: issue.signature_key,
          family: issue.family,
          status: issue.status,
          title: issue.title,
          fixId: fix.id,
          fixSha: fix.fix_commit_sha,
          fixLiveAt: fix.fix_live_at,
        }];
      });
    },
    async recurrenceCandidates(fix, byLastEvent) {
      const { data, error } = await supabase()
        .from("system_audit_occurrences")
        .select("id,occurred_at,last_event_at,release")
        .eq("issue_id", fix.issueId)
        .eq("is_test", false)
        .eq("pre_fix_build", false)
        .is("triage_override", null)
        .gt(byLastEvent ? "last_event_at" : "occurred_at", fix.fixLiveAt)
        .order(byLastEvent ? "last_event_at" : "occurred_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(50);
      if (error) throw readFailure("the occurrences", error);
      return ((data ?? []) as Array<{ id: string; occurred_at: string; last_event_at: string; release: string | null }>).map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at,
        lastEventAt: row.last_event_at,
        release: row.release,
      }));
    },
    async releaseGates() {
      try {
        const rows = await fetchAllRows<{ sha: string; recorded_at: string }>(() => supabase().from("release_gates").select("sha,recorded_at"), "sha");
        return rows.map((row) => ({ sha: row.sha, recordedAt: row.recorded_at }));
      } catch (error) {
        // Staging has no release gate (production only): a missing table is "no gates", never a failure.
        const code = (error as { code?: string } | null)?.code;
        if (code === "PGRST205" || code === "42P01") return null;
        throw readFailure("release_gates", error as { message?: string; code?: string });
      }
    },
    async markPreFixBuild(occurrenceIds) {
      for (const batch of chunks(occurrenceIds, IN_CHUNK)) {
        const { error } = await supabase()
          .from("system_audit_occurrences")
          .update({ pre_fix_build: true, updated_at: new Date().toISOString() })
          .in("id", batch);
        if (error) throw readFailure("the older-build marker (write)", error);
      }
    },
    async affectedPeople(issueId, beforeIso) {
      const { data, error } = await supabase()
        .from("system_audit_occurrences")
        .select("hr_key")
        .eq("issue_id", issueId)
        .eq("is_test", false)
        .not("hr_key", "is", null)
        .lt("occurred_at", beforeIso)
        .order("occurred_at", { ascending: false })
        .limit(500);
      if (error) throw readFailure("the people the issue reached", error);
      const keys = new Set(((data ?? []) as Array<{ hr_key: string | null }>).map((row) => row.hr_key).filter((key): key is string => Boolean(key)));
      return [...keys].slice(0, 50);
    },
    async pageRoutes(issueId) {
      const { data, error } = await supabase()
        .from("system_audit_occurrences")
        .select("route")
        .eq("issue_id", issueId)
        .not("route", "is", null)
        .order("occurred_at", { ascending: false })
        .limit(500);
      if (error) throw readFailure("the issue's pages", error);
      const routes = new Set(
        ((data ?? []) as Array<{ route: string | null }>)
          .map((row) => String(row.route ?? "").split("?")[0].trim())
          .filter((route) => route.startsWith("/") && !route.startsWith("/api/")),
      );
      return [...routes].slice(0, 20);
    },
    async pageViews({ routes, hrKeys, sinceIso, atLeast }) {
      let query = supabase().from("activity_events").select("id").in("path", routes).gt("created_at", sinceIso);
      // Stored HR ids drift between spellings (B-10 / b-10), so every spelling of every person is asked.
      if (hrKeys) query = query.in("hr_id", [...new Set(hrKeys.flatMap((key) => hrIdLookupKeys(key)))]);
      const { data, error } = await query.limit(atLeast);
      if (error) throw readFailure("page views", error);
      return (data ?? []).length;
    },
    async cleanNights({ detector, sinceIso, checkId }) {
      const { data, error } = await supabase()
        .from("system_audit_detector_runs")
        .select(checkId ? "started_at,status,checks:report->ledger->checks" : "started_at,status")
        .eq("detector", detector)
        .gt("started_at", sinceIso)
        .in("status", checkId ? ["ok", "partial"] : ["ok"])
        .order("started_at", { ascending: true })
        .limit(60);
      if (error) throw readFailure("the detector's runs", error);
      const nights = new Set<string>();
      for (const row of (data ?? []) as Array<{ started_at: string; checks?: Record<string, string> | null }>) {
        if (checkId && row.checks?.[checkId] !== "holds") continue;
        nights.add(cairoNight(row.started_at));
      }
      return [...nights];
    },
    transition: (input) => transitionIssueStatus(input, override),
  };
}
