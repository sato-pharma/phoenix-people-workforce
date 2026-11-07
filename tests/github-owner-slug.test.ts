import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expectedOwnerOf, GITHUB_OWNER, ORG_REPOSITORIES, PERSONAL_OWNER } from "../scripts/required-check-names.mjs";
import { cachedIsDirectory, cachedReaddir, cachedReadFile } from "./support/source-corpus.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ONE GITHUB ACCOUNT OWNS EVERY REPOSITORY (owner, 26 Oct 2026: "completely move to a new GitHub account
// without leaving anything here"). The repositories were transferred to a new account; the old one is kept
// EMPTY and never deleted, so its links keep redirecting. A redirect is not a home: a push, a release
// download or an API call that still names the old account works only until someone creates a repository
// of the same name there, and GHCR images and the Railway, Sentry and Claude apps do not redirect at all.
//
// So the code, CI, scripts, hooks and tests must name the CURRENT owner, `GITHUB_OWNER` in
// scripts/required-check-names.mjs, which the scripts import. Docs and memory may tell the history.
//
// Since 6 Nov 2026 the repositories sit on TWO owners: this one moved to the organization `sato-pharma`
// (his "migrate the project to the trail enterprise"), the others stayed on his personal account,
// `PERSONAL_OWNER`. Each repository below names the owner it lives on, and a reference must match it.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF = "tests/github-owner-slug.test.ts";

/** Accounts that owned these repositories before. Assembled, so this file never names one itself. */
const RETIRED_OWNERS = [["Gawish", "1997"].join("-"), ["it", "gawish", "hr"].join("-"), ["gawish", "theit"].join("")];

/** Every repository the personal account holds. A reference to one of these must name `PERSONAL_OWNER`. */
const PERSONAL_REPOSITORIES = [
  "hmdm-android",
  "sato-anti-infective-releases",
  "sato-anti-infective-app",
  "FTP-Portal",
  "Sato-Pharma-Website",
  "jessy-the-people-partner",
  "tigogrow-website",
  "phoenix-next",
  "Satopharma-Prototype",
];

/** `<word>/<repository>` spellings that are not an owner: the upstream fork, and Railway's `<environment>/<service>` labels. */
const NOT_THE_OWNER = new Set(["h-mdm", "production", "staging"]);

const SWEPT_DIRS =["src", "app", "scripts", "tests", "infra", "supabase", ".github", ".railway", ".claude/hooks", ".claude/skills"];
const SWEPT_FILE = /(?:\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|sh|ps1|py|toml|sql)|^Dockerfile[^/]*)$/i;

// GitHub's login rule: letters, digits and single inner hyphens, at most 39 characters.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function sweptFiles(relativeDir: string, out: string[] = []): string[] {
  const absolute = path.join(ROOT, relativeDir);
  if (!cachedIsDirectory(absolute)) return out;
  for (const name of cachedReaddir(absolute)) {
    if (name === "node_modules" || name === ".next") continue;
    const relative = `${relativeDir}/${name}`;
    if (cachedIsDirectory(path.join(absolute, name))) sweptFiles(relative, out);
    else if (SWEPT_FILE.test(name)) out.push(relative);
  }
  return out;
}

function rootFiles(): string[] {
  return cachedReaddir(ROOT).filter((name) => SWEPT_FILE.test(name) && !cachedIsDirectory(path.join(ROOT, name)));
}

// The repositories on the organization, and which owner each belongs on, are kept in scripts/required-check-names.mjs
// (ORG_REPOSITORIES, expectedOwnerOf) — the one list the Railway trigger check reads too.
const OWN_REPOSITORIES = [...ORG_REPOSITORIES, ...PERSONAL_REPOSITORIES];

/** Each written `<owner>/<one of our repositories>` that the code points at, with the owner it names. */
export function ownerReferences(files: { code: string; file: string }[]): { file: string; owner: string; repo: string; ghcr: boolean }[] {
  const repos = OWN_REPOSITORIES.map((repo) => repo.replace(/[-.]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(github\\.com[/:]|ghcr\\.io/|\\brepos/|["'\`(])([A-Za-z0-9_-]+)/(${repos})\\b`, "gi");
  const found: { file: string; owner: string; repo: string; ghcr: boolean }[] = [];
  for (const { code, file } of files) {
    for (const match of code.matchAll(pattern)) {
      if (NOT_THE_OWNER.has(match[2].toLowerCase())) continue;
      found.push({ file, owner: match[2], repo: match[3], ghcr: match[1].toLowerCase() === "ghcr.io/" });
    }
  }
  return found;
}

export function findOwnerSlugBreaches(files: { code: string; file: string }[], org: string, personal = PERSONAL_OWNER): string[] {
  const breaches: string[] = [];
  for (const { code, file } of files) {
    for (const retired of RETIRED_OWNERS) {
      if (code.toLowerCase().includes(retired.toLowerCase())) breaches.push(`${file}: names the old account ${retired}`);
    }
  }
  for (const ref of ownerReferences(files)) {
    const owner = expectedOwnerOf(ref.repo, org, personal);
    if (ref.owner.toLowerCase() !== owner.toLowerCase()) breaches.push(`${ref.file}: points at ${ref.owner}/${ref.repo}, not ${owner}`);
    else if (ref.ghcr && ref.owner !== owner.toLowerCase()) breaches.push(`${ref.file}: a GHCR path must be lowercase (${ref.owner})`);
  }
  return breaches;
}

export async function runGithubOwnerSlugTests() {
  assert.match(GITHUB_OWNER, GITHUB_LOGIN, `GITHUB_OWNER (${GITHUB_OWNER}) is not a GitHub login: it still holds a placeholder, or a typo`);
  assert.ok(!RETIRED_OWNERS.some((old) => old.toLowerCase() === GITHUB_OWNER.toLowerCase()), "GITHUB_OWNER names a retired account");

  const files = [...SWEPT_DIRS.flatMap((dir) => sweptFiles(dir)), ...rootFiles()]
    .filter((file) => file !== SELF)
    .map((file) => ({ code: cachedReadFile(path.join(ROOT, file)), file }));
  assert.ok(files.length > 1000, `the sweep read only ${files.length} files: a sweep that reads less reports a clean tree`);

  // The sweep must actually see the places that name the owner, or a broken pattern would pass on nothing.
  const refs = ownerReferences(files);
  for (const mustSee of ["next.config.ts", ".railway/railway.ts", "infra/headwind-phoenix-actions/phoenix-entrypoint.sh", ".github/workflows/emergency-host.yml"]) {
    assert.ok(refs.some((ref) => ref.file === mustSee), `the sweep found no owner reference in ${mustSee}`);
  }

  const breaches = findOwnerSlugBreaches(files, GITHUB_OWNER);
  assert.deepEqual(breaches, [], `every reference must name its repository's owner (${GITHUB_OWNER} or ${PERSONAL_OWNER}):\n  ${breaches.join("\n  ")}`);

  // The checker itself: an old name, a third name and an upper-case GHCR path are each refused.
  const old = RETIRED_OWNERS[0];
  assert.equal(findOwnerSlugBreaches([{ file: "a.ts", code: `const REPO = "${old.toLowerCase()}/x";` }], GITHUB_OWNER).length, 1);
  assert.equal(findOwnerSlugBreaches([{ file: "b.yml", code: "url: https://github.com/someone-else/hmdm-android/releases" }], GITHUB_OWNER).length, 1);
  assert.equal(findOwnerSlugBreaches([{ file: "c.yml", code: `IMAGE: ghcr.io/${GITHUB_OWNER.toUpperCase()}X/phoenix-people-workforce` }], GITHUB_OWNER).length, 1);
  assert.deepEqual(findOwnerSlugBreaches([{ file: "d.ts", code: `repos/${GITHUB_OWNER}/phoenix-people-workforce` }], GITHUB_OWNER), []);
  // Each repository is held to its own owner: this one to the organization, the launcher to the personal account.
  assert.equal(findOwnerSlugBreaches([{ file: "e.ts", code: `repos/${PERSONAL_OWNER}/phoenix-people-workforce` }], GITHUB_OWNER).length, 1, "this repository named on the personal account is refused");
  assert.deepEqual(findOwnerSlugBreaches([{ file: "f.sh", code: `https://github.com/${PERSONAL_OWNER}/hmdm-android/releases` }], GITHUB_OWNER), [], "the launcher stays on the personal account");
  assert.equal(findOwnerSlugBreaches([{ file: "g.sh", code: `https://github.com/${GITHUB_OWNER}/hmdm-android/releases` }], GITHUB_OWNER).length, 1, "the launcher named on the organization is refused");
}
