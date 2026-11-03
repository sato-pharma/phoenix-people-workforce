// THE WATCH ON THE CHECKS THAT RUN ON GITHUB (owner, 2026-11-03).
//
// Eight production checks live on GitHub Actions: seven on GitHub's own schedule and the synthetic
// journeys through a dispatch from Phoenix. Nothing in the job register saw any of them, so a check
// GitHub stopped firing, or one failing every night, read exactly like a quiet night. This asks GitHub
// when each one last SUCCEEDED and compares that with how old it may be.
//
// BEING BLIND IS A FAILURE, NEVER A CLEAN READ. Three shapes:
//   * no token: the route pings fail;
//   * 401, 403 or 404: a dead token, a suspended account or a renamed workflow. Fails at once. On
//     2026-11-02 GitHub suspended the account and every call answered 403, which is the case this names;
//   * a timeout or a 5xx: GitHub having a bad hour. The route still pings success, so a blip reaches
//     nobody, and carries the last complete read in its own heartbeat detail. Past three hours of that
//     it fails. Not pinging at all would strand the job in about 40 minutes, because the grace is 30.
//
// The route pings directly rather than through withDeadMansSwitch: that wrapper reports success on any
// run that returns, and "I could not see" returns. Same reasoning as run-synthetic-journeys.
//
// Pure apart from `readGithubWorkflowRuns`, so every verdict is testable without GitHub.
//
// THE GAP, stated plainly: if production itself is down this stays silent. `deploy-drift-check` covers
// that from the other side, which is why it holds the shortest limit here.

const OWNER = "gawishtheit";
const REPO = "phoenix-people-workforce";
const READ_TIMEOUT_MS = 15_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long GitHub may answer badly before the watch calls itself blind. */
export const GITHUB_WATCH_TRANSIENT_LIMIT_MS = 3 * HOUR_MS;
/** A fine-grained token warns from this many days out. */
export const GITHUB_TOKEN_WARN_DAYS = 21;

export type GithubWorkflowWatch = {
  file: string;
  label: string;
  maxAgeHours: number;
};

/**
 * Every workflow with a `schedule:` block, plus the synthetic journeys, which cron-job.org dispatches
 * through Phoenix. tests/github-workflow-watch.test.ts refuses a scheduled workflow missing from here.
 * The limits are generous because GitHub's scheduler runs hours late here (measured 2026-08-05): 4.5 to 9
 * hours on a daily workflow.
 */
export const GITHUB_WORKFLOW_WATCHES: readonly GithubWorkflowWatch[] = [
  { file: "deploy-drift-check.yml", label: "Deploy drift check", maxAgeHours: 6 },
  { file: "synthetic-journeys.yml", label: "Synthetic journeys", maxAgeHours: 8 },
  { file: "attendance-weekly-digest.yml", label: "Attendance digest", maxAgeHours: 18 },
  { file: "migration-drift-check.yml", label: "Migration drift check", maxAgeHours: 36 },
  { file: "origin-certificate-check.yml", label: "Origin certificate check", maxAgeHours: 36 },
  { file: "secret-drift-check.yml", label: "Secret drift check", maxAgeHours: 36 },
  { file: "security-scan.yml", label: "Security scan", maxAgeHours: 36 },
  { file: "staging-hr-drift-check.yml", label: "Staging HR drift check", maxAgeHours: 36 },
];

export type GithubWorkflowRead =
  | { file: string; kind: "answered"; lastSuccessAt: string | null; tokenExpiresAt: string | null }
  | { file: string; kind: "refused"; status: number }
  | { file: string; kind: "transient"; reason: string };

export type GithubWorkflowOverdue = {
  file: string;
  label: string;
  lastSuccessAt: string | null;
  maxAgeHours: number;
};

export type GithubWorkflowVerdict = {
  /** What the job's own heartbeat says. `fail` is the sweep's to carry to a phone. */
  outcome: "success" | "fail";
  /** The heartbeat detail. Always ends in the `lastGoodRead=` marker the next run reads back. */
  detail: string;
  overdue: GithubWorkflowOverdue[];
  /** Whole days until the token dies, when a warning is due today. Null otherwise. */
  tokenWarningDays: number | null;
};

const MARKER = /lastGoodRead=(\S+)/;

/** The last complete read a previous run recorded in its own heartbeat detail, if it did. */
export function parseLastGoodRead(detail: string | null | undefined): string | null {
  const iso = MARKER.exec(detail ?? "")?.[1] ?? null;
  return iso && Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** GitHub's header reads `2026-12-31 10:00:00 UTC`, or a zoned variant. Null when it cannot be read. */
export function parseTokenExpiry(header: string | null | undefined): string | null {
  const raw = header?.trim();
  if (!raw) return null;
  const normalised = raw.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T").replace(/ UTC$/, "Z").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalised);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Weekly from three weeks out, daily in the last week. The header is null on a classic token. */
export function tokenWarningDaysDue(tokenExpiresAt: string | null, nowMs: number): number | null {
  if (!tokenExpiresAt) return null;
  const expires = Date.parse(tokenExpiresAt);
  if (!Number.isFinite(expires)) return null;
  const days = Math.max(0, Math.floor((expires - nowMs) / DAY_MS));
  if (days > GITHUB_TOKEN_WARN_DAYS) return null;
  return days <= 7 || days % 7 === 0 ? days : null;
}

export function assessGithubWorkflows(input: {
  tokenSet: boolean;
  reads: readonly GithubWorkflowRead[];
  nowMs: number;
  /** The previous run's heartbeat detail. */
  previousDetail: string | null;
  /** Where the three-hour clock starts when no run has recorded a complete read yet. */
  firstSeenAt: string | null;
}): GithubWorkflowVerdict {
  const nowIso = new Date(input.nowMs).toISOString();
  const lastGood = parseLastGoodRead(input.previousDetail) ?? input.firstSeenAt ?? nowIso;
  const marker = (iso: string) => `lastGoodRead=${iso}`;

  if (!input.tokenSet) {
    return {
      detail: `GITHUB_ACTIONS_DISPATCH_TOKEN is not set, so nothing watches the checks on GitHub. ${marker(lastGood)}`,
      outcome: "fail",
      overdue: [],
      tokenWarningDays: null,
    };
  }

  const overdue: GithubWorkflowOverdue[] = [];
  for (const watch of GITHUB_WORKFLOW_WATCHES) {
    const read = input.reads.find((candidate) => candidate.file === watch.file);
    if (read?.kind !== "answered") continue;
    const at = read.lastSuccessAt ? Date.parse(read.lastSuccessAt) : Number.NaN;
    if (Number.isFinite(at) && input.nowMs - at <= watch.maxAgeHours * HOUR_MS) continue;
    overdue.push({ file: watch.file, label: watch.label, lastSuccessAt: read.lastSuccessAt, maxAgeHours: watch.maxAgeHours });
  }

  const expiries = input.reads.flatMap((read) => (read.kind === "answered" && read.tokenExpiresAt ? [read.tokenExpiresAt] : []));
  const tokenWarningDays = tokenWarningDaysDue(expiries[0] ?? null, input.nowMs);

  const refused = input.reads.filter((read): read is Extract<GithubWorkflowRead, { kind: "refused" }> => read.kind === "refused");
  if (refused.length > 0) {
    const named = refused.map((read) => `${read.file} (${read.status})`).join(", ");
    return {
      detail: `GitHub refused the read of ${named}. The token may be dead, the account suspended or a workflow renamed. ${marker(lastGood)}`,
      outcome: "fail",
      overdue,
      tokenWarningDays,
    };
  }

  const missing = GITHUB_WORKFLOW_WATCHES.filter((watch) => !input.reads.some((read) => read.file === watch.file)).map((watch) => watch.file);
  const transient = input.reads.filter((read) => read.kind === "transient").map((read) => read.file);
  const unread = [...transient, ...missing];
  if (unread.length > 0) {
    const blindMs = input.nowMs - Date.parse(lastGood);
    const tooLong = !Number.isFinite(blindMs) || blindMs > GITHUB_WATCH_TRANSIENT_LIMIT_MS;
    return {
      detail: tooLong
        ? `GitHub has not answered for over three hours: ${unread.join(", ")}. ${marker(lastGood)}`
        : `GitHub did not answer for ${unread.join(", ")} on this run. ${marker(lastGood)}`,
      outcome: tooLong ? "fail" : "success",
      overdue,
      tokenWarningDays,
    };
  }

  return {
    detail:
      overdue.length > 0
        ? `Overdue: ${overdue.map((item) => item.file).join(", ")}. ${marker(nowIso)}`
        : `All ${GITHUB_WORKFLOW_WATCHES.length} checks within their limits. ${marker(nowIso)}`,
    outcome: "success",
    overdue,
    tokenWarningDays,
  };
}

function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date(iso));
}

/** Pure: the message a person reads. Says "has not succeeded", because a red run lands here too. */
export function buildGithubWorkflowMessage(verdict: GithubWorkflowVerdict): string {
  const lines: string[] = [];
  if (verdict.overdue.length > 0) {
    lines.push("🛑 A check on GitHub has not succeeded within its limit.", "");
    for (const item of verdict.overdue) {
      const last = item.lastSuccessAt ? `last success ${cairoStamp(item.lastSuccessAt)} Cairo` : "no success on record";
      lines.push(`• ${item.label}: ${last}, limit ${item.maxAgeHours} hours.`);
    }
    lines.push("", `Runs: https://github.com/${OWNER}/${REPO}/actions`);
  }
  if (verdict.tokenWarningDays !== null) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `⚠️ The GitHub token Phoenix uses expires in ${verdict.tokenWarningDays} day(s). It also starts the synthetic journeys, so both stop when it dies.`,
    );
  }
  return lines.join("\n");
}

/** One workflow's newest successful run on main. Never throws: a bad answer is a verdict input. */
async function readOneWorkflow(file: string, token: string): Promise<GithubWorkflowRead> {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${file}/runs?branch=main&status=success&per_page=1`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return { file, kind: "transient", reason: "could not reach GitHub" };
  }
  // A rate limit also answers 403, and that one passes on its own.
  const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  if (rateLimited) return { file, kind: "transient", reason: "rate limited" };
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { file, kind: "refused", status: response.status };
  }
  if (!response.ok) return { file, kind: "transient", reason: `GitHub answered ${response.status}` };
  const body = (await response.json().catch(() => null)) as { workflow_runs?: Array<{ updated_at?: string }> } | null;
  if (!body || !Array.isArray(body.workflow_runs)) return { file, kind: "transient", reason: "unreadable answer" };
  return {
    file,
    kind: "answered",
    lastSuccessAt: body.workflow_runs[0]?.updated_at ?? null,
    tokenExpiresAt: parseTokenExpiry(response.headers.get("github-authentication-token-expiration")),
  };
}

export async function readGithubWorkflowRuns(token: string): Promise<GithubWorkflowRead[]> {
  return Promise.all(GITHUB_WORKFLOW_WATCHES.map((watch) => readOneWorkflow(watch.file, token)));
}
