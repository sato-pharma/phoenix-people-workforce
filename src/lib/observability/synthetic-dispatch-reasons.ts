/**
 * The sentences a failed hourly GitHub dispatch files on its heartbeat, and what each one means.
 *
 * WHY THEY HAVE THEIR OWN FILE. The Needs You board reads this row to learn whether GitHub is refusing the
 * account (owner, 3 Nov 2026), and the heartbeat carries only a sentence. So the words and the reading of them
 * live side by side, and `tests/needs-you-vendor-accounts.test.ts` proves each sentence reads back as what it
 * said. On 2 Nov 2026 the suspended account answered 403, and this row knew hours before anybody else did.
 *
 * No imports, so a pure test and the Needs You rules can load it with no logging behind them.
 */

/** What `app/api/cron/run-synthetic-journeys/route.ts` puts in front of the reason on the heartbeat. */
export const SYNTHETIC_DISPATCH_FAILURE_PREFIX = "the run was not dispatched: ";

export const SYNTHETIC_DISPATCH_TOKEN_UNSET =
  "GITHUB_ACTIONS_DISPATCH_TOKEN is not set; nothing to dispatch. Create a fine-grained PAT " +
  "scoped to this repository with Actions: read and write, and set it in Railway.";

export const SYNTHETIC_DISPATCH_UNREACHABLE = "could not reach the GitHub API";

export function syntheticDispatchRefused(status: number): string {
  return `GitHub refused the dispatch (${status})`;
}

export function syntheticDispatchOtherStatus(status: number): string {
  return `GitHub returned ${status}`;
}

export type SyntheticDispatchFailure =
  /** The key is not there at all. */
  | "token-unset"
  /** GitHub answered and said no. The account or the key needs a person. */
  | "refused"
  /** GitHub did not answer, or answered that it is the one in trouble. Nothing is known about the account. */
  | "not-answered"
  /** A crash, or a sentence this file did not write. Nothing is known about the account. */
  | "unknown";

export function classifySyntheticDispatchFailure(detail: string | null | undefined): SyntheticDispatchFailure {
  const text = String(detail ?? "");
  if (text.includes(SYNTHETIC_DISPATCH_TOKEN_UNSET)) return "token-unset";
  if (text.includes(SYNTHETIC_DISPATCH_UNREACHABLE)) return "not-answered";
  const status = /GitHub (?:refused the dispatch \(|returned )(\d{3})/.exec(text)?.[1];
  if (!status) return "unknown";
  const code = Number(status);
  // A rate limit says nothing about the account, and a 5xx is GitHub's own trouble.
  if (code === 429 || code >= 500) return "not-answered";
  return code >= 400 ? "refused" : "unknown";
}
