// Which packages a pnpm-lock.yaml moved BACKWARD, between a base lockfile and a head lockfile.
//
// WHY (owner, 2026-10-27). Dependabot regenerates pnpm-lock.yaml for its own PR, and pnpm re-resolves EVERY
// entry younger than the seven-day cooldown to an older version: PRs 6486-6488 (26 Oct) and 6580-6582 (27 Oct)
// each carried ~40 silent downgrades — puppeteer-core 25.16.0 -> 25.14.0, imapflow 2.9.1 -> 2.5.8, openai,
// supabase, 17 @sentry/* packages. Only the puppeteer pin's two tests went red; the rest would have merged.
// tests/lockfile-downgrade-gate.test.ts uses this to fail ANY pull request that does that, whoever opened it.
// Account: docs/dependency-refresh.md.
//
// A DOWNGRADE is a version the base resolved that the head no longer holds, where the head holds a LOWER
// version of the same major and nothing higher or equal. So these are not downgrades: an upgrade; a package
// added or removed; a major change either way; and an OLDER copy added beside the one that stays (a package
// with two ranges in the graph legitimately holds two versions — @babel/parser does).

import { resolvedVersions } from "./refresh.mjs";

/**
 * @param {string} version
 * @returns {{ core: number[], pre: (string | number)[] } | null} null when it is not a plain semver (a git, tarball
 * or alias spec) — those are never compared, so they can never be called a downgrade.
 */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  const pre = match[4] ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [];
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

/**
 * Semver precedence: negative when a < b, 0 when equal, positive when a > b. A prerelease is lower than its release.
 * @param {string} a
 * @param {string} b
 * @returns {number | null} null when either side is not a plain semver
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * @param {string} before the base lockfile
 * @param {string} after the head lockfile
 * @returns {{ name: string, from: string, to: string }[]} one entry per version that went backward, sorted
 */
export function lockDowngrades(before, after) {
  const was = resolvedVersions(before);
  const now = resolvedVersions(after);
  const found = [];
  for (const [name, wasSet] of was) {
    const nowSet = now.get(name);
    if (!nowSet) continue;
    for (const from of wasSet) {
      if (nowSet.has(from)) continue;
      const major = parseVersion(from)?.core[0];
      if (major === undefined) continue;
      let lowest = null;
      let higherOrEqual = false;
      for (const candidate of nowSet) {
        const parsed = parseVersion(candidate);
        if (!parsed || parsed.core[0] !== major) continue;
        const order = compareVersions(candidate, from);
        if (order === null) continue;
        if (order >= 0) higherOrEqual = true;
        else if (lowest === null || compareVersions(candidate, lowest) > 0) lowest = candidate;
      }
      if (lowest !== null && !higherOrEqual) found.push({ name, from, to: lowest });
    }
  }
  return found.sort((a, b) => (a.name === b.name ? (compareVersions(a.from, b.from) ?? 0) : a.name < b.name ? -1 : 1));
}

/** Every refresh branch starts with this (refresh.mjs's BRANCH_PREFIX; tests/lockfile-downgrade-gate.test.ts holds them equal). */
const REFRESH_PREFIX = "codex/weekly-deps-refresh-";

/**
 * The verdict on one pull request's lockfile. The weekly refresh is exempt: with the seven-day window it deliberately
 * rolls back an entry main took younger than that (a manual bump, a security fix), and its PR body lists every one.
 * @param {{ before: string, after: string, headRef: string, allowedText: string }} input
 * @returns {{ exempt: boolean, downgrades: { name: string, from: string, to: string }[], message: string }}
 */
export function lockfileVerdict({ before, after, headRef, allowedText }) {
  if (headRef.startsWith(REFRESH_PREFIX)) return { exempt: true, downgrades: [], message: "" };
  const allowed = parseAllowedDowngrades(allowedText);
  const downgrades = lockDowngrades(before, after).filter((moved) => !allowed.has(downgradeKey(moved)));
  if (downgrades.length === 0) return { exempt: false, downgrades, message: "" };
  const fromDependabot = headRef.startsWith("dependabot/");
  const message = [
    `pnpm-lock.yaml moves ${downgrades.length} package version${downgrades.length === 1 ? "" : "s"} BACKWARD against its base:`,
    ...downgrades.map((moved) => `  ${downgradeKey(moved)}`),
    "",
    fromDependabot
      ? "This is a Dependabot pull request, and this is what its lockfile always does: Dependabot hands its 7-day cooldown to pnpm, and pnpm re-resolves EVERY entry younger than that to an older version, so the bump arrives with a silent rollback of everything the weekly refresh or a security fix had just moved. Do not merge it."
      : "A lockfile that goes backward silently rolls production back. Dependabot's lockfile does exactly this (its 7-day cooldown makes pnpm re-resolve every entry younger than that to an older version), and so can a hand-run install under a stricter policy.",
    "REPLACE the pull request, never repair it:",
    "  1. close it;",
    "  2. make the same manifest change (package.json) on a codex/ branch cut from main;",
    "  3. run `node scripts/remote-check.mjs lockfile` in the background — it regenerates the lockfile on GitHub and moves nothing but what the manifests changed — and commit the files it writes;",
    "  4. push and open the pull request. PR 6493 and PR 6595 are the worked examples.",
    "A rollback you MEANT (a bad release being backed out): add each line above, exactly, to scripts/deps-refresh/allowed-downgrades.txt in this pull request.",
    "Account: docs/dependency-refresh.md, \"Why a Dependabot PR is replaced, never merged\".",
  ].join("\n");
  return { exempt: false, downgrades, message };
}

/** The exact line a deliberate rollback is listed under in allowed-downgrades.txt. */
export const downgradeKey = ({ name, from, to }) => `${name} ${from} -> ${to}`;

/**
 * allowed-downgrades.txt: one `name from -> to` per line; blank lines and `#` comments are ignored.
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseAllowedDowngrades(text) {
  const keys = new Set();
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line && !line.startsWith("#")) keys.add(line.replace(/\s+/g, " "));
  }
  return keys;
}
