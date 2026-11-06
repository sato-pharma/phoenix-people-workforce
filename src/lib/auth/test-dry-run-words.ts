/**
 * The test-account dry run's names and words, with no import at all, so the browser can load them
 * (the notice component) as well as the proxy and the server (src/lib/auth/test-dry-run-rules.ts).
 */

/** The request header proxy.ts sets on a test account's write that runs as a dry run. */
export const TEST_DRY_RUN_HEADER = "x-phoenix-test-dry-run";

/** The response header that tells the page "this ran every check and saved nothing". */
export const TEST_DRY_RUN_RESPONSE_HEADER = "x-phoenix-test-dry-run";

/** What a test account reads beside a save that ran as a dry run. */
export const TEST_DRY_RUN_NOTICE = "Test account — every check ran on the real data. Nothing was saved and nobody was told.";
