// The Railway CLI credential attempts shared by validate-railway-production-secrets.mjs and
// sync-railway-production-secrets.mjs — the two scripts that shell out to the Railway CLI.
//
// 🔴 EACH SECRET IS TRIED UNDER ITS OWN NAME FIRST, AND THE TWO ARE NEVER MERGED INTO ONE VALUE.
// Until 2026-10-27 both scripts read `RAILWAY_API_TOKEN || RAILWAY_TOKEN` into ONE value and tried
// that one value under both names, and the workflows fed them the same `||` merge. So whenever the
// repository held BOTH secrets, the `RAILWAY_TOKEN` value was never tried at all. The two keys then
// broke each other for a week, every swap fixing one job and breaking another:
//
//   * 21–23 Oct: a workspace key in RAILWAY_API_TOKEN. The CLI (railway 5.63.1) refused it on
//     `variable list`, so the production-secrets check failed "Unauthorized".
//   * 23 Oct 22:44 Cairo: swapped for a production-only PROJECT key. The check passed ("credential
//     accepted as RAILWAY_TOKEN") and the fallback rehearsal, which creates a STAGING service and so
//     needs the workspace key, broke.
//   * 27 Oct 14:27 Cairo: swapped back to a workspace key. The rehearsal passed again (run
//     40496315134) and the secrets check failed again (runs 40496318818 and 40505513309) — while the
//     project key from 9 Aug sat in RAILWAY_TOKEN, never once handed to the CLI.
//
// The order below is the fix: the PROJECT key is tried as a project key, the WORKSPACE key as a
// workspace key, and only then each value under the other name, for an owner who pasted a key into
// the wrong secret. The GraphQL scripts (deploy settings, triggers, the fallback image) accept a
// workspace key, so they keep reading one value; this file is only for the CLI.

/**
 * The first line of a CLI failure, for the log. Never a token: the CLI does not echo one. npx's own
 * "npm warn exec … will be installed" lines are skipped, or every attempt would report the download.
 */
export function firstErrorLine(result) {
  const text = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^npm (warn|notice)\b/i.test(l));
  return (line || `exit ${result?.status ?? "unknown"}, no output`).slice(0, 200);
}

/** Only an auth rejection is worth another attempt; a bad project id fails the same every way. */
export function isAuthRejection(result) {
  return /Unauthorized|Invalid RAILWAY|Not Authorized/i.test(`${result?.stderr || ""}${result?.stdout || ""}`);
}

/**
 * The ordered, de-duplicated attempts: `{ varName, value, from }`. `from` is the SECRET the value
 * came from, so the log can say "RAILWAY_TOKEN's value as RAILWAY_TOKEN" without printing it.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function railwayCliAttempts(env = process.env) {
  const project = env.RAILWAY_TOKEN?.trim() || "";
  const workspace = env.RAILWAY_API_TOKEN?.trim() || "";
  const ordered = [
    { varName: "RAILWAY_TOKEN", value: project, from: "RAILWAY_TOKEN" },
    { varName: "RAILWAY_API_TOKEN", value: workspace, from: "RAILWAY_API_TOKEN" },
    { varName: "RAILWAY_TOKEN", value: workspace, from: "RAILWAY_API_TOKEN" },
    { varName: "RAILWAY_API_TOKEN", value: project, from: "RAILWAY_TOKEN" },
  ];
  const seen = new Set();
  return ordered.filter((attempt) => {
    if (!attempt.value) return false;
    const key = `${attempt.varName}\u0000${attempt.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The child environment for one attempt: the value under ONE name, the other blanked.
 *
 * @param {{ varName: string, value: string }} attempt
 * @param {Record<string, string | undefined>} [extra]
 * @param {Record<string, string | undefined>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function railwayCliEnv(attempt, extra = {}, base = process.env) {
  return {
    ...base,
    RAILWAY_API_TOKEN: attempt.varName === "RAILWAY_API_TOKEN" ? attempt.value : "",
    RAILWAY_TOKEN: attempt.varName === "RAILWAY_TOKEN" ? attempt.value : "",
    ...extra,
  };
}

/** How an attempt is named in the log: the secret and the name, never the value. */
export function describeAttempt(attempt) {
  return attempt.from === attempt.varName
    ? `${attempt.from} as ${attempt.varName}`
    : `${attempt.from}'s value as ${attempt.varName}`;
}
