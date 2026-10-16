// Pure decisions for scripts/sentry-setup.mjs — what the Sentry account should look like, and how to read
// the account's answers. No network, no environment, no imports: scripts/lib is imported by entry points,
// and tests/sentry-account-setup.test.ts calls these directly.
//
// The account is configured over Sentry's REST API, not by `sentry-cli`: the CLI covers releases, sourcemaps
// and issue triage, but has no command that creates an alert rule or changes an organisation's data-scrubbing
// settings. The CLI is installed beside this for triage (`sentry-cli issues list`), not for this.

export const SENTRY_ALERT_NAME = "Production: new error";
export const SENTRY_PROJECT_SLUG = "phoenix-workforce";

// The deliberate test error fired on 2026-10-16 after PR 5985; its text starts with this.
export const TEST_ISSUE_TEXT = "SENTRY PRODUCTION TEST";

// The organisation-wide scrubbing the owner asked for ("Prevent Storing of IP Addresses"), plus Sentry's own
// default scrubbers. These keys are the REST API's names for those toggles.
export const ORG_PRIVACY = { dataScrubber: true, dataScrubberDefaults: true, scrubIPAddresses: true };

/** The regional API host for a DSN's ingest host: `o1.ingest.de.sentry.io` -> https://de.sentry.io. */
export function apiBaseFromDsn(dsn) {
  try {
    const host = new URL(String(dsn).trim()).hostname;
    const region = /\.ingest\.([a-z]{2})\.sentry\.io$/.exec(host);
    return region ? `https://${region[1]}.sentry.io` : "https://sentry.io";
  } catch {
    return null;
  }
}

/**
 * The issue alert: email on every NEW issue, production only, at most once per 30 minutes per issue.
 * `IssueOwners` with `AllMembers` as the fallthrough needs no member id, so the rule is the same on any
 * account and a personal token is not required to look one up.
 */
export function buildAlertRulePayload() {
  return {
    name: SENTRY_ALERT_NAME,
    actionMatch: "all",
    filterMatch: "all",
    frequency: 30,
    environment: "production",
    conditions: [{ id: "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition" }],
    filters: [],
    actions: [
      {
        id: "sentry.mail.actions.NotifyEmailAction",
        targetType: "IssueOwners",
        targetIdentifier: "",
        fallthroughType: "AllMembers",
      },
    ],
  };
}

/** The rules already on the project, by name. */
export function findRuleByName(rules, name) {
  return Array.isArray(rules) ? (rules.find((rule) => rule && rule.name === name) ?? null) : null;
}

/** The keys of ORG_PRIVACY the organisation does not have yet, as a patch body — empty when nothing differs. */
export function orgPrivacyPatch(org) {
  const patch = {};
  for (const [key, want] of Object.entries(ORG_PRIVACY)) {
    if (!org || org[key] !== want) patch[key] = want;
  }
  return patch;
}

/** One organisation: the only one, else the one the caller named. Null when it cannot be decided. */
export function pickOrg(orgs, hint) {
  if (!Array.isArray(orgs) || orgs.length === 0) return null;
  if (hint) return orgs.find((o) => o.slug === hint || String(o.id) === String(hint)) ?? null;
  return orgs.length === 1 ? orgs[0] : null;
}

/** The Phoenix project: by slug, else the only project there is. Null when it cannot be decided. */
export function pickProject(projects) {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  return projects.find((p) => p.slug === SENTRY_PROJECT_SLUG) ?? (projects.length === 1 ? projects[0] : null);
}

/** The unresolved issues whose title is the deliberate test error. */
export function testIssues(issues) {
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue) => issue && issue.status !== "resolved" && String(issue.title ?? issue.metadata?.value ?? "").includes(TEST_ISSUE_TEXT),
  );
}

/** Other rules that already email on a new or high-priority issue — reported, never deleted. */
export function otherEmailRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.filter(
    (rule) =>
      rule &&
      rule.name !== SENTRY_ALERT_NAME &&
      Array.isArray(rule.actions) &&
      rule.actions.some((action) => String(action?.id ?? "").includes("NotifyEmailAction")),
  );
}

/** The token is never printed: this is the only form of it that may appear in output. */
export function describeToken(token) {
  const value = String(token ?? "");
  return value ? `a token of ${value.length} characters` : "no token";
}
