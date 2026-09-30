import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  coverageOf,
  directDependencyNames,
  isScoped,
  parseLockfilePackages,
  remedyFor,
  scanGraph,
  sortFindings,
} from "../scripts/vuln-scan.mjs";

/**
 * The whole-graph vulnerability scan.
 *
 * THE INTERESTING FAILURE HERE IS A SCAN THAT PASSES WHILE READING ALMOST NOTHING. On 2026-09-30 a
 * hand-rolled version of this scan reported "no advisories matched any resolved version" over a graph
 * that contained a HIGH (`@grpc/grpc-js@1.14.4`, GHSA-m9gg-hp2v-232j). Its regex required the package
 * key to start immediately after two spaces, and pnpm writes every scoped key QUOTED —
 * `  '@grpc/grpc-js@1.14.4':` — so it silently skipped ~370 of 1167 packages. A positive control
 * passed throughout, because a control proves the scan WORKS, never that it COVERED.
 *
 * So the load-bearing assertions below are the COVERAGE ones, not the detection ones: the real
 * lockfile must parse with a plausible scoped count, the specific packages that the old defect lost
 * must be present by name, and `scanGraph` must THROW rather than report a clean graph it cannot
 * prove it read.
 */
export async function runVulnScanTests() {
  // ── The regression: pnpm quotes scoped keys, and both forms must parse ────────────────────────
  // Every line below is the real shape pnpm emits, including the peer-suffixed form.
  const fixture = [
    "packages:",
    "",
    "  '@grpc/grpc-js@1.14.4':",
    "    resolution: {integrity: sha512-deadbeef}",
    "",
    "  lodash@4.17.20:",
    "    resolution: {integrity: sha512-cafebabe}",
    "",
    "  '@babel/core@7.29.7':",
    "    resolution: {integrity: sha512-f00d}",
    "",
    "  next@16.3.8(@babel/core@7.29.7)(react@19.3.0):",
    "    dependencies:",
    "      react: 19.3.0",
  ].join("\n");

  const parsed = parseLockfilePackages(fixture);
  assert.equal(
    parsed.has("@grpc/grpc-js@1.14.4"),
    true,
    "a QUOTED scoped key must parse — this exact line is what the 2026-09-30 defect skipped, and skipping it "
      + "is how a HIGH advisory was reported as a clean graph",
  );
  assert.equal(parsed.has("@babel/core@7.29.7"), true, "every quoted scoped key must parse, not just the first");
  assert.equal(parsed.has("lodash@4.17.20"), true, "an unquoted key must still parse");
  assert.equal(
    parsed.has("next@16.3.8"),
    true,
    "a key with a peer-dependency suffix must parse to the bare version, not be skipped",
  );

  // The defect's signature, stated as an assertion rather than prose: if quoted keys are ever skipped
  // again the scoped count collapses while the total stays plausible.
  const fixtureCoverage = coverageOf(parsed);
  assert.equal(fixtureCoverage.total, 4, "the fixture holds exactly four resolved packages");
  assert.equal(
    fixtureCoverage.scoped,
    2,
    "both scoped packages must be counted — a scoped count of 0 beside a non-zero total IS the defect",
  );

  assert.equal(isScoped("@grpc/grpc-js"), true);
  assert.equal(isScoped("lodash"), false);

  // ── Nothing that is not a resolved package may be parsed as one ───────────────────────────────
  const notPackages = parseLockfilePackages(
    ["settings:", "  autoInstallPeers: true", "overrides:", "  '@grpc/grpc-js': ^1.14.5", "  postcss: ^8.5.23"].join("\n"),
  );
  assert.equal(
    notPackages.size,
    0,
    "an override entry is a RANGE, not a resolved version — parsing `^1.14.5` as a version would query OSV for a "
      + "version that does not exist and report a clean graph",
  );

  // ── scanGraph must refuse an under-read graph rather than report it clean ─────────────────────
  // This is the assertion that would have caught the original defect. Break the parser and it fires.
  await assert.rejects(
    () => scanGraph({ packages: parsed, query: async () => [], minTotal: 800, minScoped: 200 }),
    /under-read lockfile/,
    "a graph below the coverage floor must THROW — reporting it clean is the one outcome this file exists to prevent",
  );

  // ── Detection, with no network: the query is injected ─────────────────────────────────────────
  const direct = directDependencyNames(
    JSON.stringify({ dependencies: { next: "16.3.8" }, devDependencies: { eslint: "^9" } }),
  );

  const { coverage, findings } = await scanGraph({
    packages: parsed,
    query: async (batch: { name: string }[]) =>
      batch.map((pkg) =>
        pkg.name === "@grpc/grpc-js" ? { vulns: [{ id: "GHSA-m9gg-hp2v-232j" }] } : { vulns: [] },
      ),
    direct,
    minTotal: 0,
    minScoped: 0,
  });

  assert.equal(coverage.total, 4, "coverage must be reported alongside the findings, so a clean result is auditable");
  assert.equal(findings.length, 1, "exactly the one vulnerable package must be reported");
  assert.equal(findings[0].name, "@grpc/grpc-js");
  assert.deepEqual(findings[0].ids, ["GHSA-m9gg-hp2v-232j"]);
  assert.equal(
    findings[0].directness,
    "transitive",
    "@grpc/grpc-js is not in package.json, and that distinction decides the fix",
  );

  // The positional contract with OSV's querybatch: result[i] describes batch[i]. An off-by-one here
  // would attribute a real advisory to the wrong package, which is worse than missing it.
  const { findings: chunked } = await scanGraph({
    packages: parsed,
    query: async (batch: { name: string }[]) =>
      batch.map((pkg) => (pkg.name === "lodash" ? { vulns: [{ id: "GHSA-lodash" }] } : { vulns: [] })),
    direct,
    minTotal: 0,
    minScoped: 0,
    chunkSize: 1,
  });
  assert.equal(chunked.length, 1, "chunking must not lose a finding");
  assert.equal(chunked[0].name, "lodash", "chunking must not misattribute a finding to another package");

  // ── The remedy names the only thing that can actually fix it ──────────────────────────────────
  assert.match(
    remedyFor({ name: "@grpc/grpc-js", directness: "transitive" }),
    /override .* pnpm-workspace\.yaml/,
    "a transitive finding must point at an override — Dependabot's job definition is direct-only "
      + "(`update-subdependencies: false`), so it can NEVER fix one and its failing run withholds a deploy",
  );
  assert.match(
    remedyFor({ name: "next", directness: "direct" }),
    /package\.json/,
    "a direct finding is a manifest bump",
  );

  assert.deepEqual(
    sortFindings(
      [
        { name: "b", ids: ["low"] },
        { name: "a", ids: ["crit"] },
      ],
      (finding: { ids: string[] }) => (finding.ids[0] === "crit" ? "CRITICAL" : "LOW"),
    ).map((finding: { name: string }) => finding.name),
    ["a", "b"],
    "the most severe finding must be reported first",
  );

  // ── THE LIVE COVERAGE ASSERTION, against this repo's real lockfile ────────────────────────────
  // 🔴 Measured by reintroducing the defect on 2026-09-30: the broken parser returned
  // `total: 800, scoped: 0` where the true figures were `total: 1171, scoped: 371`. A total-only floor
  // of 800 would have passed that EXACTLY, which is why the scoped floor exists and why the total floor
  // carries headroom. (The graph legitimately shrank to 1126 / 351 hours later when #4966 removed the
  // dead `@google-cloud/logging`, which is why these are floors with slack and not equalities.)
  // Do not lower either to quiet a red run — a drop means the parser regressed or the graph lost a
  // third of itself, and both deserve a human.
  const realLock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  const realPackages = parseLockfilePackages(realLock);
  const realCoverage = coverageOf(realPackages);

  assert.ok(
    realCoverage.total >= 1000,
    `the real lockfile parsed only ${realCoverage.total} packages — the parser is under-reading it, so a clean `
      + "scan would prove nothing",
  );
  assert.ok(
    realCoverage.scoped >= 250,
    `only ${realCoverage.scoped} scoped packages parsed out of ${realCoverage.total}. A collapsed scoped count IS `
      + "the 2026-09-30 defect: pnpm quotes every @scope/name key, so a pattern anchored on two spaces loses them "
      + "all while the total still looks plausible",
  );

  // 🔴 SELF-CALIBRATING, BECAUSE HARD-CODED PACKAGE NAMES ROT — AND MINE ROTTED WITHIN THE HOUR.
  // The first version of this block asserted four names by hand, `@grpc/grpc-js` among them. #4966
  // then removed the dead `@google-cloud/logging` dependency, which took `@grpc/grpc-js` out of the
  // graph entirely, and the assertion failed in CI on a repo that was perfectly healthy — a test
  // asserting a fact about the dependency tree that the dependency tree is free to change.
  //
  // So the check derives its own expectation instead: pull every QUOTED scoped key out of the raw
  // lockfile with a deliberately DIFFERENT and simpler pattern than the parser's, and require the
  // parser to have found all of them. It names no package, so it cannot rot, and it still fails hard
  // the moment quoted keys stop parsing — which is the entire defect it exists for.
  const quotedScopedNames = new Set<string>();
  for (const line of realLock.split(/\r?\n/)) {
    const match = line.match(/^ {2}'(@[^'/]+\/[^'@]+)@/);
    if (match) quotedScopedNames.add(match[1]);
  }

  // The extractor needs its own floor or it could pass by finding nothing, which is the same vacuous
  // green this whole file is built to refuse. Measured 2026-09-30: 310 distinct quoted scoped names.
  assert.ok(
    quotedScopedNames.size >= 200,
    `the independent extractor found only ${quotedScopedNames.size} quoted scoped keys in the lockfile — it is `
      + "broken, so comparing the parser against it would prove nothing",
  );

  const parsedNames = new Set([...realPackages.values()].map((pkg) => pkg.name));
  const missed = [...quotedScopedNames].filter((name) => !parsedNames.has(name));
  assert.deepEqual(
    missed.slice(0, 10),
    [],
    `${missed.length} scoped package(s) are written QUOTED in pnpm-lock.yaml but did not parse, e.g. `
      + `${missed.slice(0, 5).join(", ")}. That is the 2026-09-30 defect exactly: pnpm quotes every `
      + "@scope/name key, so a pattern anchored on two spaces skips them all while the total still looks "
      + "plausible, and the scan then reports a clean graph over a real HIGH.",
  );
}
