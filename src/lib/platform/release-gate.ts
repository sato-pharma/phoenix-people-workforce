// The production release gate: may THIS container take traffic yet? (docs/deployment.md, "The release gate".)
//
// WHY THIS EXISTS. Railway's "Wait for CI" held a merge's build until every check finished, so the build
// (4 to 10 minutes, at the mercy of Railway's shared builder) started only after CI. On 2026-10-19 a merge
// took 16 minutes to go live: about 5 for the checks, then 10.5 for the build. With Wait for CI switched
// off, Railway builds the moment a commit lands, side by side with the checks, and the only thing left to
// stop an unchecked build is the healthcheck Railway asks of a NEW container before it moves traffic: the
// old version keeps serving until that answers 2xx, and a deploy whose probe never does is marked failed.
// /api/readyz therefore answers 503 until a row for this container's own commit exists in release_gates,
// and the last job of ci.yml writes that row only after `validate` and `checks` (the two required checks)
// both passed. Nothing is skipped: the checks still run on every merge, the deploy still cannot go live
// without them, and a red check leaves the old version serving.
//
// FAIL CLOSED. A production container whose row cannot be read is NOT ready, and neither is one that names
// no commit at all (a hand `railway up` with no urgent marker, an image deploy that lost its ENV layer): there
// is nothing CI could ever have recorded for it, so it is held, never waved through (audit P6-03 / D-03,
// 2026-10-23). A container that is not production Railway (a laptop, CI, any other host) is never held,
// because no row could ever arrive for it.
//
// Import-free on purpose, like deploy-identity.ts: the decision is plain data in, plain data out, so the
// tests cover every branch with no database. The one read lives in release-gate-store.ts.

/**
 * The environment this decision reads — RAILWAY_ENVIRONMENT_NAME, RAILWAY_GIT_COMMIT_SHA and
 * PHOENIX_RELEASE_GATE. Passed in, never read from process.env here. It is the plain record shape, not a
 * type with those three optional keys, because `process.env` (Next declares NODE_ENV required on it) does not
 * type-check against a weak all-optional object, and a test can hand a record of its own.
 */
export type ReleaseGateEnv = Readonly<Record<string, string | undefined>>;

export type ReleaseGateReason =
  /** Not production on Railway — a laptop, CI, staging. Nothing writes a row for these, so none is asked for. */
  | "not_production_railway"
  /** An upload with no git commit: the urgent route's `railway up`, which skips the checks by the owner's own words. */
  | "urgent_upload"
  /**
   * Production on Railway, but the platform gave no commit at all and there is no urgent marker. Nothing CI
   * records can ever match it, so it is HELD (fail closed, since 2026-10-23) — never a reason to pass.
   */
  | "no_commit"
  /** PHOENIX_RELEASE_GATE=off — the emergency switch. */
  | "switched_off"
  /** The commit has a row: every required check passed on it. */
  | "recorded"
  /** The commit has no row yet (CI still running, or a check failed). The old version keeps serving. */
  | "not_recorded"
  /** The platform gave a commit that is not 40 hex characters, so it can never match a row. */
  | "malformed_commit"
  /** The row could not be read at all. Fail closed. */
  | "unreadable";

export type ReleaseGateDecision = {
  /** Does this container have to be released by CI before it may take traffic? */
  required: boolean;
  /** May it take traffic now? Always true when it is not required. */
  passed: boolean;
  reason: ReleaseGateReason;
  /** The commit asked about, when there is one. */
  sha: string | null;
};

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The commits already seen released. A row is never deleted, so a positive answer holds for the process. */
const releasedInThisProcess = new Set<string>();

/** Tests only: forget every released commit so the next call asks again. */
export function clearReleaseGateCache(): void {
  releasedInThisProcess.clear();
}

/**
 * Is this container one the gate applies to, and which commit does it stand for?
 *
 * Applies to every production container on Railway that is neither an urgent upload nor switched off. A
 * container with NO commit is required and can never pass (`sha: null`, reason `no_commit`). Every other
 * state is `required: false`, and the reason says which, so /api/readyz can show why a probe passed.
 */
export function resolveReleaseGateScope(
  env: ReleaseGateEnv,
  urgentRevision: string | null,
):
  | { required: false; reason: "not_production_railway" | "urgent_upload" | "switched_off" }
  | { required: true; sha: null; reason: "no_commit" }
  | { required: true; sha: string; malformed: boolean } {
  if (String(env.RAILWAY_ENVIRONMENT_NAME ?? "").trim().toLowerCase() !== "production") {
    return { required: false, reason: "not_production_railway" };
  }
  if (String(env.PHOENIX_RELEASE_GATE ?? "").trim().toLowerCase() === "off") {
    return { required: false, reason: "switched_off" };
  }
  if (urgentRevision) return { required: false, reason: "urgent_upload" };
  const sha = String(env.RAILWAY_GIT_COMMIT_SHA ?? "").trim().toLowerCase();
  if (sha === "") return { required: true, sha: null, reason: "no_commit" };
  return { required: true, sha, malformed: !FULL_SHA.test(sha) };
}

/**
 * The gate's answer for this container. `hasRecord` is the one database read; it may throw, and a throw
 * is an unreadable gate, never a pass.
 */
export async function evaluateReleaseGate(input: {
  env: ReleaseGateEnv;
  urgentRevision: string | null;
  hasRecord: (sha: string) => Promise<boolean>;
}): Promise<ReleaseGateDecision> {
  const scope = resolveReleaseGateScope(input.env, input.urgentRevision);
  if (!scope.required) return { required: false, passed: true, reason: scope.reason, sha: null };
  if (scope.sha === null) return { required: true, passed: false, reason: "no_commit", sha: null };
  if (scope.malformed) return { required: true, passed: false, reason: "malformed_commit", sha: scope.sha };
  if (releasedInThisProcess.has(scope.sha)) {
    return { required: true, passed: true, reason: "recorded", sha: scope.sha };
  }
  try {
    if (await input.hasRecord(scope.sha)) {
      releasedInThisProcess.add(scope.sha);
      return { required: true, passed: true, reason: "recorded", sha: scope.sha };
    }
    return { required: true, passed: false, reason: "not_recorded", sha: scope.sha };
  } catch {
    return { required: true, passed: false, reason: "unreadable", sha: scope.sha };
  }
}
