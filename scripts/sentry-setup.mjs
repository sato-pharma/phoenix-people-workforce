// Configures the Sentry account for Phoenix over Sentry's REST API: the "Production: new error" email alert,
// the organisation's IP and data scrubbing, and resolving the deliberate test issue. Safe to run again —
// every step reads first and only writes what is missing.
//
// Usage:
//   node scripts/sentry-setup.mjs            read the account and print what it WOULD change (writes nothing)
//   node scripts/sentry-setup.mjs --apply    make those changes
//   --url <base>                             API host; default https://de.sentry.io (the EU region)
//
// Needs SENTRY_AUTH_TOKEN in the environment: a personal token from sentry.io -> User settings -> Personal
// Tokens, with the scopes org:read, org:write, project:read, project:write, alerts:write, event:admin. The
// token is read from the environment only and is never printed, logged or written to a file.
// docs/observability.md, "Operating Sentry from a terminal".

import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";
import {
  SENTRY_ALERT_NAME,
  buildAlertRulePayload,
  describeToken,
  findRuleByName,
  orgPrivacyPatch,
  otherEmailRules,
  pickOrg,
  pickProject,
  testIssues,
} from "./lib/sentry-account-plan.mjs";

refuseUnknownFlags({
  name: "sentry-setup",
  entry: import.meta.url,
  known: ["--apply", "--url"],
  hints: ["dry run (default): node scripts/sentry-setup.mjs", "make the changes:   node scripts/sentry-setup.mjs --apply"],
});

const TOKEN_HELP = [
  "SENTRY_AUTH_TOKEN is not set. Create one, then run this again:",
  "  1. sentry.io -> your name (bottom left) -> User settings -> Personal Tokens -> Create New Token",
  "  2. scopes: org:read org:write project:read project:write alerts:write event:admin",
  "  3. PowerShell:  $env:SENTRY_AUTH_TOKEN = '<paste the token>' ; node scripts/sentry-setup.mjs",
  "     (the token lives only in that window; closing it forgets it)",
];

function flagValue(argv, flag) {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const base = String(flagValue(argv, "--url") ?? "https://de.sentry.io").replace(/\/+$/, "");
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) {
    for (const line of TOKEN_HELP) console.error(line);
    process.exit(1);
  }
  console.log(`sentry-setup: ${apply ? "APPLY" : "DRY RUN (writes nothing; add --apply to change the account)"} · ${base} · ${describeToken(token)}`);

  async function api(method, path, body) {
    const response = await fetch(`${base}/api/0${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data);
      const err = new Error(`${method} ${path} -> HTTP ${response.status} ${detail.slice(0, 400)}`);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  const orgs = await api("GET", "/organizations/");
  const org = pickOrg(orgs);
  if (!org) {
    console.error(`sentry-setup: cannot decide the organisation — the token sees ${orgs.length}: ${orgs.map((o) => o.slug).join(", ") || "none"}`);
    process.exit(1);
  }
  const projects = await api("GET", `/organizations/${org.slug}/projects/`);
  const project = pickProject(projects);
  if (!project) {
    console.error(`sentry-setup: cannot decide the project in ${org.slug}: ${projects.map((p) => p.slug).join(", ") || "none"}`);
    process.exit(1);
  }
  console.log(`  organisation  ${org.slug}\n  project       ${project.slug}`);

  // 1 · organisation-wide scrubbing
  const orgDetail = await api("GET", `/organizations/${org.slug}/`);
  const patch = orgPrivacyPatch(orgDetail);
  if (Object.keys(patch).length === 0) {
    console.log("  scrubbing     already on (IP addresses, data scrubber, default scrubbers)");
  } else if (apply) {
    await api("PUT", `/organizations/${org.slug}/`, patch);
    console.log(`  scrubbing     SET ${Object.keys(patch).join(", ")}`);
  } else {
    console.log(`  scrubbing     WOULD SET ${Object.keys(patch).join(", ")}`);
  }

  // 2 · the email alert
  const rulesPath = `/projects/${org.slug}/${project.slug}/rules/`;
  const rules = await api("GET", rulesPath);
  if (findRuleByName(rules, SENTRY_ALERT_NAME)) {
    console.log(`  alert         "${SENTRY_ALERT_NAME}" already exists`);
  } else if (apply) {
    const created = await api("POST", rulesPath, buildAlertRulePayload());
    console.log(`  alert         CREATED "${created?.name ?? SENTRY_ALERT_NAME}" (email on every new production issue, at most once per 30 minutes)`);
  } else {
    console.log(`  alert         WOULD CREATE "${SENTRY_ALERT_NAME}"`);
  }
  for (const rule of otherEmailRules(rules)) {
    console.log(`  note          another rule already emails: "${rule.name}" — keep it or delete it in Sentry; this script never deletes a rule`);
  }

  // 3 · the deliberate test issue
  const issues = await api("GET", `/projects/${org.slug}/${project.slug}/issues/?statsPeriod=14d&query=${encodeURIComponent("is:unresolved")}`);
  const stale = testIssues(issues);
  if (stale.length === 0) {
    console.log("  test issue    none open");
  } else if (apply) {
    const ids = stale.map((issue) => `id=${encodeURIComponent(issue.id)}`).join("&");
    await api("PUT", `/projects/${org.slug}/${project.slug}/issues/?${ids}`, { status: "resolved" });
    console.log(`  test issue    RESOLVED ${stale.length}`);
  } else {
    console.log(`  test issue    WOULD RESOLVE ${stale.length}`);
  }

  // 4 · read it back, so "created" is never taken on the response's word
  if (apply) {
    const after = await api("GET", rulesPath);
    if (!findRuleByName(after, SENTRY_ALERT_NAME)) {
      console.error(`sentry-setup: the alert "${SENTRY_ALERT_NAME}" is NOT in the project after creating it`);
      process.exit(1);
    }
    console.log(`  verified      "${SENTRY_ALERT_NAME}" is present on ${project.slug}`);
  }
  console.log("sentry-setup: finished");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`sentry-setup: FAILED — ${error.message}`);
    if (error.status === 401 || error.status === 403) {
      console.error("  the token was rejected or is missing a scope (org:read org:write project:read project:write alerts:write event:admin)");
    }
    process.exit(1);
  });
}
