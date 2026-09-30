#!/usr/bin/env node
/**
 * The whole-graph vulnerability scan, over every resolved package, at every severity.
 *
 * WHY THIS EXISTS. `validate` already runs `pnpm audit --audit-level=high --prod`
 * (scripts/ci-dependency-audit.mjs), and that gate is blind in three separate ways that each hid a
 * real advisory on 2026-09-30:
 *
 *   1. THE npm FEED LAGS. `@grpc/grpc-js@1.14.4` carried GHSA-m9gg-hp2v-232j — HIGH, `getAuthContext`
 *      returning unauthorized certificates as though they were authorized — and `pnpm audit` reported
 *      `{"info":0,"low":0,"moderate":0,"high":0,"critical":0}` at the same moment OSV reported the
 *      HIGH. "Audit green" is not evidence; it is one feed's opinion, hours to days behind.
 *   2. `--prod` HIDES THE DEV GRAPH and `--audit-level=high` hides everything below high.
 *      pnpm-workspace.yaml records three separate advisories that slipped through for exactly this
 *      reason, each noting "Dependabot alone saw it."
 *   3. DEPENDABOT CANNOT COVER THE GAP. Its job definition is
 *      `"allowed-updates":[{"dependency-type":"direct"}]` with `"update-subdependencies": false`, so a
 *      security advisory on a TRANSITIVE package makes it fail `update_not_possible` every time —
 *      which is also why a failing Dependabot run withholds a production deploy (AGENTS.md §2.3).
 *      That is why this script reports DIRECT vs TRANSITIVE: for a transitive package the fix is an
 *      override in pnpm-workspace.yaml, never a manifest bump, and nothing else will ever do it.
 *
 * 🔴 WHY THE COVERAGE ASSERTION IS THE POINT OF THIS FILE, NOT A NICETY. This scan was first written
 * by hand, inside a session, with a regex that required the package key to start immediately after
 * two spaces:
 *
 *     /^  ((?:@[^/@\s]+\/)?[^@\s(][^@\s(]*)@([0-9][^():\s]*)[():]/
 *
 * pnpm writes a scoped key QUOTED — `  '@grpc/grpc-js@1.14.4':` — so that regex silently skipped
 * every quoted key, and then reported "no advisories matched any resolved version" while a HIGH sat
 * in the graph. A positive control passed throughout, because a control proves the scan WORKED, never
 * that it COVERED.
 *
 * Reintroducing that defect against this repo's real lockfile measures it exactly: `total: 800,
 * scoped: 0` against a true `total: 1171, scoped: 371`. Note what that means — it loses a THIRD of the
 * graph and every single scoped package, while leaving a total that still looks entirely plausible.
 * So `scanGraph` refuses to report a clean graph it cannot prove it read: the caller passes a coverage
 * floor, and a parse below it throws instead of returning an empty result. A scanner that finds
 * nothing must be unable to pass.
 *
 * WHAT IT IS NOT. It does not replace `pnpm audit` and does not gate the build — it prints, and the
 * CI step is deliberately non-blocking, so a disagreement between two advisory feeds cannot freeze
 * `main` (which is production's own branch). Promote it to blocking only after watching it agree.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** OSV's batch endpoint. Public, unauthenticated, no key to leak. */
const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
const OSV_VULN = "https://api.osv.dev/v1/vulns/";

/** OSV accepts up to 1000 queries per batch; 500 keeps a failure cheap to retry. */
const CHUNK = 500;

/**
 * Severity order for reporting. OSV's `database_specific.severity` is the GitHub Advisory rating,
 * which is the one a human recognises.
 */
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MODERATE: 2, MEDIUM: 2, LOW: 3, UNSPECIFIED: 4 };

/**
 * Every resolved `name@version` in a pnpm lockfile, from BOTH the `packages:` and `snapshots:`
 * sections (a package can appear in one and not the other).
 *
 * 🔴 The optional `'` is the whole reason this function exists as a named, tested unit rather than an
 * inline regex. pnpm quotes any key it must — every `@scope/name`, and anything with a peer suffix —
 * so a pattern anchored on two spaces followed by the name misses most scoped packages and reports a
 * clean graph. See the header.
 */
export function parseLockfilePackages(text) {
  const found = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^ {2}'?((?:@[^/@\s']+\/)?[^@\s'(]+)@([0-9][^'():\s]*)'?\s*[(:]/);
    if (!match) continue;
    const name = match[1];
    const version = match[2];
    // A version must look like one. Guards against a stray key whose value starts with a digit.
    if (!/^\d+\.\d+/.test(version)) continue;
    found.set(`${name}@${version}`, { name, version });
  }
  return found;
}

/** True for an `@scope/name` package. Used by the coverage floor, which is what catches the bug above. */
export function isScoped(name) {
  return String(name).startsWith("@");
}

/**
 * How many of the parsed packages are scoped. If the quoted-key defect ever returns this collapses
 * toward zero while the total stays plausible, which is precisely the shape that fooled a reader
 * once already.
 */
export function coverageOf(packages) {
  const all = [...packages.values()];
  return { total: all.length, scoped: all.filter((pkg) => isScoped(pkg.name)).length };
}

/**
 * The direct dependencies, from package.json. A finding on one of these is fixed by bumping the
 * manifest; a finding on anything else needs an override, because Dependabot structurally cannot
 * reach it (header, reason 3).
 */
export function directDependencyNames(manifestText) {
  const manifest = JSON.parse(String(manifestText));
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

/**
 * Scan a parsed graph.
 *
 * `query` is injected so the whole decision path is testable with no network: it takes an array of
 * `{name, version}` and returns an array of `{ vulns: [{id}] }` positionally aligned with it, which
 * is OSV's own `querybatch` contract.
 *
 * `minScoped`/`minTotal` are the coverage floor. Passing a graph that falls under it THROWS — a
 * clean result from an under-read lockfile is the one outcome this file exists to make impossible.
 */
export async function scanGraph({
  packages,
  query,
  direct = new Set(),
  minTotal = 0,
  minScoped = 0,
  chunkSize = CHUNK,
}) {
  const coverage = coverageOf(packages);
  if (coverage.total < minTotal || coverage.scoped < minScoped) {
    throw new Error(
      `vuln-scan: refusing to report on an under-read lockfile — parsed ${coverage.total} packages ` +
        `(${coverage.scoped} scoped), floor is ${minTotal}/${minScoped}. A scoped count near zero ` +
        `means the quoted-key defect is back; see this file's header.`,
    );
  }

  const all = [...packages.values()];
  const findings = [];
  for (let i = 0; i < all.length; i += chunkSize) {
    const batch = all.slice(i, i + chunkSize);
    const results = await query(batch);
    (results ?? []).forEach((result, index) => {
      const ids = (result?.vulns ?? []).map((vuln) => vuln.id).filter(Boolean);
      if (ids.length === 0) return;
      const pkg = batch[index];
      findings.push({
        name: pkg.name,
        version: pkg.version,
        ids,
        directness: direct.has(pkg.name) ? "direct" : "transitive",
      });
    });
  }
  return { coverage, findings };
}

/** Sort findings most-severe first, then name. `severityOf` is injected so sorting stays pure. */
export function sortFindings(findings, severityOf) {
  return [...findings].sort((a, b) => {
    const rankA = SEVERITY_RANK[severityOf(a)] ?? 4;
    const rankB = SEVERITY_RANK[severityOf(b)] ?? 4;
    return rankA === rankB ? a.name.localeCompare(b.name) : rankA - rankB;
  });
}

/**
 * What to DO about a finding, in one line. The distinction is load-bearing rather than cosmetic:
 * a transitive finding will never be fixed by Dependabot or by editing package.json.
 */
export function remedyFor(finding) {
  return finding.directness === "direct"
    ? `bump "${finding.name}" in package.json`
    : `add an override for "${finding.name}" in pnpm-workspace.yaml (Dependabot cannot fix a transitive advisory)`;
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

/** The real OSV batch query. Kept separate from `scanGraph` so tests never touch the network. */
async function osvQuery(batch) {
  const body = {
    queries: batch.map((pkg) => ({
      package: { name: pkg.name, ecosystem: "npm" },
      version: pkg.version,
    })),
  };
  const json = await fetchJson(OSV_BATCH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return json.results ?? [];
}

async function hydrate(ids) {
  const meta = new Map();
  for (const id of ids) {
    try {
      const vuln = await fetchJson(`${OSV_VULN}${id}`);
      meta.set(id, {
        severity: vuln?.database_specific?.severity ?? "UNSPECIFIED",
        summary: String(vuln?.summary ?? "").slice(0, 120),
        withdrawn: Boolean(vuln?.withdrawn),
      });
    } catch {
      meta.set(id, { severity: "UNSPECIFIED", summary: "(advisory detail unavailable)", withdrawn: false });
    }
  }
  return meta;
}

async function main() {
  const lockText = readFileSync("pnpm-lock.yaml", "utf8");
  const packages = parseLockfilePackages(lockText);
  const direct = directDependencyNames(readFileSync("package.json", "utf8"));

  // 🔴 THE SCOPED FLOOR IS THE ONE THAT WORKS, AND THAT IS MEASURED, NOT ASSUMED. Reintroducing the
  // quoted-key defect against this repo's real lockfile on 2026-09-30 produced `total: 800, scoped: 0`
  // against a true `total: 1171, scoped: 371`. A total-only floor of 800 would have passed that
  // EXACTLY — the defect drops ~32% of the graph and still leaves a plausible-looking count. So the
  // total floor carries real headroom and the scoped floor is the load-bearing one; keep both.
  const { coverage, findings } = await scanGraph({
    packages,
    query: osvQuery,
    direct,
    minTotal: 1000,
    minScoped: 250,
  });

  console.log(`vuln-scan: read ${coverage.total} resolved packages (${coverage.scoped} scoped)`);

  if (findings.length === 0) {
    console.log("vuln-scan: no OSV advisory matches any resolved version.");
    return 0;
  }

  const meta = await hydrate([...new Set(findings.flatMap((finding) => finding.ids))]);
  const severityOf = (finding) =>
    finding.ids.map((id) => meta.get(id)?.severity ?? "UNSPECIFIED").sort(
      (a, b) => (SEVERITY_RANK[a] ?? 4) - (SEVERITY_RANK[b] ?? 4),
    )[0];

  console.log(`vuln-scan: ${findings.length} package(s) with at least one advisory\n`);
  for (const finding of sortFindings(findings, severityOf)) {
    for (const id of finding.ids) {
      const detail = meta.get(id);
      if (!detail || detail.withdrawn) continue;
      console.log(
        `[${String(detail.severity).padEnd(11)}] ${finding.name}@${finding.version}  ${id}` +
          `  (${finding.directness})\n    ${detail.summary}\n    -> ${remedyFor(finding)}`,
      );
    }
  }

  // Deliberately 0: this step reports, `pnpm audit` gates. See the header.
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`vuln-scan: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
