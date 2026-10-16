// Pure decisions for scripts/sentry-setup.mjs — what the Sentry account should look like, and how to read
// the account's answers. No network, no environment, no imports: scripts/lib is imported by entry points,
// and tests/sentry-account-setup.test.ts calls these directly.
//
// The account is configured over Sentry's REST API, not by `sentry-cli`: the CLI covers releases, sourcemaps
// and issue triage, but has no command that changes an organisation's data-scrubbing settings. It is installed
// beside this for triage (`sentry-cli issues list`), not for this.
//
// Alerts are NOT created here. The account runs Sentry's new alert system, where the old project `rules` endpoint
// answers 404 and the replacement's create shape could not be verified; and the account already ships an alert that
// emails on every new high-priority issue. This file only decides whether that is so.

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

// The triggers that mean "email me when a NEW issue appears". An account on Sentry's alert system (workflows) gets one of
// these by default ("Send a notification for high priority issues"), and a hand-made rule uses the other.
export const NEW_ISSUE_TRIGGERS = ["new_high_priority_issue", "first_seen_event"];

/** Does this workflow (alert) email people when a new issue appears? */
export function emailsOnNewIssues(workflow) {
  if (!workflow || workflow.enabled === false) return false;
  const triggers = workflow.triggers?.conditions;
  const fires = Array.isArray(triggers) && triggers.some((c) => NEW_ISSUE_TRIGGERS.includes(c?.type));
  const emails =
    Array.isArray(workflow.actionFilters) &&
    workflow.actionFilters.some((f) => Array.isArray(f?.actions) && f.actions.some((a) => a?.type === "email" && a?.status !== "disabled"));
  return fires && emails;
}

/** The enabled alert that already covers new issues, or null. A production-only one is still production-only coverage. */
export function workflowCoveringNewIssues(workflows) {
  if (!Array.isArray(workflows)) return null;
  const covering = workflows.filter(emailsOnNewIssues);
  return covering.find((w) => w.environment === "production") ?? covering.find((w) => !w.environment) ?? null;
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

/** The token is never printed: this is the only form of it that may appear in output. */
export function describeToken(token) {
  const value = String(token ?? "");
  return value ? `a token of ${value.length} characters` : "no token";
}
