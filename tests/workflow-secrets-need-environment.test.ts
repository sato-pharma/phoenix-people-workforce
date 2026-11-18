// A JOB THAT READS A PRODUCTION SECRET STANDS IN THE MAIN-ONLY ENVIRONMENT — credentials audit of 18 Nov 2026,
// finding 1, fixed on the owner's word ("Fix 1, 3, 4 in one PR").
//
// WHY. Every Actions secret was repository-wide, so any branch whose workflow was edited could read the production
// service key, the database password, the session-signing secret and the Railway key — and the owner, the Claude
// GitHub app and the Railway GitHub app can all push a branch. The secrets now live in two GitHub environments that
// only named branches may use: `main-secrets` (only `main`) and `urgent-deploy` (only the two urgent-deploy/*
// branches, the Railway tokens alone). move-secrets-to-environments.yml copies them in; the repository-wide copies are
// then removed on the owner's word.
//
// What breaks it quietly, and what this file pins:
//   1. A new job reads a production secret with no `environment:`. Before the repository copies are deleted it works
//      and re-opens the hole; after, the secret reads as EMPTY and the job fails in a way that looks like a bad value.
//   2. The list of what stays repository-wide drifts between this test and the mover's `keep` pattern, so the mover
//      leaves behind a secret a job outside the environment still needs, or copies one this test thinks is public.
//   3. A pull request's run is handed a production secret again: ci.yml's `validate` signs with production's
//      session secret, or fallback-image's pull-request build reads the Railway token.
//   4. `secrets: inherit` spreads to a new caller, carrying every repository secret into a workflow nobody reviewed.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const WORKFLOW_DIR = ".github/workflows";
const MOVER = "move-secrets-to-environments.yml";

// Stays repository-wide: browser-visible values and Expo's token, nothing else. The STAGING service key and the
// Telegram alarm pair joined main-secrets on 19 Nov 2026 (the owner's "fix those"): ci.yml's `validate` stands in it
// only on main, and deploy-failure-alert.yml hands its message to a `send` job on main.
export const REPOSITORY_WIDE = [
  "GITHUB_TOKEN",
  "EXPO_TOKEN",
  "SYNTHETIC_BASE_URL",
  "APP_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
];
const REPOSITORY_WIDE_PREFIXES = ["NEXT_PUBLIC_"];

/** ci.yml's `validate` stands in main-secrets on main and in nothing on a pull request or another branch's dispatch. */
const VALIDATE_ENVIRONMENT =
  "${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && 'main-secrets' || '' }}";
/** The only secrets `validate` may read: the staging login smoke's key and the red-main Telegram alert. */
const VALIDATE_SECRETS = ["STAGING_SUPABASE_SERVICE_ROLE_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALERT_CHAT_ID"];

export function isRepositoryWide(name: string): boolean {
  return REPOSITORY_WIDE.includes(name) || REPOSITORY_WIDE_PREFIXES.some((p) => name.startsWith(p));
}

// Mobile workflows are frozen (AGENTS.md §4) and read only EXPO_TOKEN; they are still parsed like every other file.
type Job = { file: string; id: string; environment: string | null; secrets: string[]; body: string };

/** Each top-level job: its `environment:` value (null when absent) and every `secrets.NAME` it references. */
export function workflowJobs(file: string, source: string): Job[] {
  const lines = source.split("\n");
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) return [];
  const jobs: Job[] = [];
  let current: { id: string; body: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = current.body.join("\n");
    const env = /^ {4}environment:\s*(.+?)\s*(?:#.*)?$/m.exec(body);
    const secrets = [...new Set([...body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
    jobs.push({ file, id: current.id, environment: env ? env[1] : null, secrets, body });
  };
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/.test(line)) break;
    const id = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (id) {
      close();
      current = { id: id[1], body: [] };
      continue;
    }
    current?.body.push(line);
  }
  close();
  return jobs;
}

export function runWorkflowSecretsNeedEnvironmentTests() {
  const files = readdirSync(WORKFLOW_DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort();
  const jobs = files.flatMap((file) => workflowJobs(file, readFileSync(path.join(WORKFLOW_DIR, file), "utf8")));
  assert.ok(jobs.length > 30, `expected to parse more than 30 jobs across the workflows, found ${jobs.length} — the parser has stopped matching`);

  // ── 1. a production secret is read only inside an environment that only named branches may use ──
  const guarded: string[] = [];
  for (const job of jobs) {
    const production = job.secrets.filter((n) => !isRepositoryWide(n));
    if (production.length === 0) continue;
    guarded.push(`${job.file}:${job.id}`);
    const allowed =
      job.file === "urgent-deploy.yml"
        ? job.environment === "urgent-deploy"
        : job.environment === "main-secrets" ||
          (job.file === "fallback-image.yml" && job.id === "image" && /'main-secrets'/.test(job.environment ?? "")) ||
          (job.file === "ci.yml" && job.id === "validate" && job.environment === VALIDATE_ENVIRONMENT);
    assert.ok(
      allowed,
      `${job.file} job \`${job.id}\` reads ${production.join(", ")} but declares environment ${JSON.stringify(job.environment)}. ` +
        "A production secret lives only in the main-only `main-secrets` environment (urgent-deploy.yml: `urgent-deploy`). " +
        "Add `environment: main-secrets` beside its runs-on, or — if the value is genuinely public — add it to REPOSITORY_WIDE " +
        `here AND to the keep pattern in ${MOVER} (credentials audit, finding 1).`,
    );
  }
  // An anti-vacuous floor: the 22 jobs that read production secrets on 18 Nov 2026, the mover among them.
  assert.ok(guarded.length >= 20, `expected at least 20 jobs reading a production secret, found ${guarded.length}: ${guarded.join(", ")}`);

  // ── 2. the mover keeps exactly what this file calls repository-wide ──
  const mover = readFileSync(path.join(WORKFLOW_DIR, MOVER), "utf8");
  const keep = /keep='\^\(([^)]+)\)\$'/.exec(mover);
  assert.ok(keep, `${MOVER} no longer has its keep='^(…)$' pattern`);
  const keepNames = keep[1].split("|");
  for (const name of REPOSITORY_WIDE) {
    assert.ok(keepNames.includes(name), `${MOVER}'s keep pattern must name ${name}, which stays repository-wide`);
  }
  for (const prefix of REPOSITORY_WIDE_PREFIXES) {
    assert.ok(keepNames.includes(`${prefix}.*`), `${MOVER}'s keep pattern must keep ${prefix}* repository-wide`);
  }
  for (const name of keepNames) {
    if (["github_token", "SECRETS_MOVER_TOKEN"].includes(name)) continue;
    const plain = name.replace(/\.\*$/, "");
    assert.ok(
      REPOSITORY_WIDE.includes(plain) || REPOSITORY_WIDE_PREFIXES.includes(plain),
      `${MOVER} keeps ${name} repository-wide, but this test does not — add it to REPOSITORY_WIDE or take it out of the pattern`,
    );
  }
  assert.match(mover, /github\.ref == 'refs\/heads\/main'/, `${MOVER} must run only from main`);
  assert.doesNotMatch(mover, /gh secret delete(?! SECRETS_MOVER_TOKEN)/, `${MOVER} must COPY only — the repository copies are deleted on the owner's word`);

  // ── 3. no pull-request run is handed a production secret ──
  const ci = readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");
  const validate = jobs.find((j) => j.file === "ci.yml" && j.id === "validate");
  assert.ok(validate, "ci.yml no longer has a validate job");
  assert.deepEqual(
    validate.secrets.filter((n) => !isRepositoryWide(n) && !VALIDATE_SECRETS.includes(n)),
    [],
    "ci.yml's validate runs on every branch, so it may read no production secret — only the staging key and the Telegram pair, inside main-secrets on main",
  );
  assert.equal(
    validate.environment,
    VALIDATE_ENVIRONMENT,
    "ci.yml's validate must stand in main-secrets on main ONLY — never on a pull request, never on another branch's dispatch",
  );
  assert.match(
    ci,
    /- name: Run Playwright login smoke test\n(?: +#.*\n)* +if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'\n/,
    "the login smoke reads the staging key, which only main's run holds, so it must run on main only",
  );
  assert.match(
    ci,
    /\n\s+PHOENIX_AUTH_SECRET: ci-only-phoenix-auth-secret-for-playwright-session-signing\n/,
    "the CI login smoke signs with the CI-only literal, never production's session secret",
  );
  const image = jobs.find((j) => j.file === "fallback-image.yml" && j.id === "image");
  assert.ok(image, "fallback-image.yml no longer has an image job");
  for (const token of ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]) {
    const line = new RegExp(`\\n\\s+${token}: (.+)\\n`).exec(image.body);
    assert.ok(line, `fallback-image's image job no longer sets ${token}`);
    assert.match(line[1], /github\.event_name != 'pull_request' &&/, `fallback-image's pull-request build must get no ${token}`);
  }

  // ── 4. `secrets: inherit` only where it was reviewed ──
  const inherits = jobs.filter((j) => /^ {4}secrets:\s*inherit\b/m.test(j.body)).map((j) => `${j.file}:${j.id}`);
  assert.deepEqual(inherits, ["emergency-host.yml:image"], "only emergency-host's call into fallback-image may pass `secrets: inherit`");
}
