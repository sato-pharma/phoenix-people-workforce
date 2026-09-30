import assert from "node:assert/strict";

import {
  ALLOW_MARKERS,
  EXTRA_FILES,
  EXTS,
  FORBIDDEN,
  ROOTS,
  findViolations,
  hasScannedExtension,
} from "../scripts/stale-domain-rules.mjs";

// The stale-platform gate had NO unit test for its entire life, and that is how it came to pass the
// thing it exists to catch.
//
// WHAT HAPPENED. scripts/check-no-stale-domains.mjs runs as a step in the required `validate` job
// and in `pnpm run ci`. It read next.config.ts on every single run — that file is one of its
// explicit EXTRA_FILES — and reported OK while `experimental.serverActions.allowedOrigins` still
// listed two deleted Google Cloud Run hosts. Next matches a Server Action's Origin/Host against
// that list, so a live payroll app was accepting mutations from a hostname built on a GCP project
// number the company no longer pays for: whoever claims that number next inherits the trust. The
// gate was not broken and was not skipped. It simply had four Vercel patterns and no pattern for
// the platform that had actually been retired (AGENTS.md §3 — GCP is dead, billing closed, every
// API answers BILLING_DISABLED), so the file it read most often was the one it could not judge.
//
// The second of the two hosts carried a comment describing a "post-cutover rollback window" to a
// platform that had been deleted for weeks. A gate cannot catch a stale comment; it can catch the
// hostname the comment was justifying, which is the point of the pattern added here.
//
// WHY THESE THREE THINGS. Each is a way the gate can report a clean tree it did not actually judge:
//   1. a missing pattern          — the next.config.ts failure above
//   2. an over-broad escape hatch — one marker silencing every pattern on a line, not just its own
//   3. the extension matcher      — keyed on the last dot in the WHOLE path, so a dotted parent
//                                   directory skipped every file beneath it, silently
// The gate itself cannot be imported: it walks the tree and calls process.exit at import time. So
// the rules live in scripts/stale-domain-rules.mjs and this test drives those, exactly as
// tests/railway-secret-shape.test.ts drives the extracted scripts/secret-shape-rules.mjs.

/** The two origins that really sat in next.config.ts, as they were written there. */
const SHIPPED_CLOUD_RUN_ORIGINS = [
  '        "phoenix-hr-897559113412.europe-west3.run.app",',
  '        "phoenix-hr-897559113412.us-central1.run.app",',
];

export function runStaleDomainGateTests() {
  // --- 1. the Cloud Run pattern exists, and is the thing that catches what shipped -------------

  const cloudRun = FORBIDDEN.filter(([re]) => re.test("foo.run.app"));
  assert.ok(
    cloudRun.length > 0,
    "FORBIDDEN must carry a Cloud Run host pattern — without one the gate reads next.config.ts " +
      "on every required `validate` run and cannot judge it",
  );
  for (const [, message] of cloudRun) {
    assert.match(
      message,
      /run\.app/,
      "the Cloud Run message must name the pattern so a failure is actionable without reading the script",
    );
  }

  // The real pre-fix content of next.config.ts. This is the regression: before the pattern was
  // added, findViolations on these two lines returned nothing at all.
  const shipped = findViolations(
    "next.config.ts",
    ["    serverActions: {", "      allowedOrigins: [", ...SHIPPED_CLOUD_RUN_ORIGINS, '        "phoenix-hr.satopharma.com",', "      ],"].join("\n"),
  );
  assert.equal(
    shipped.length,
    2,
    `both deleted Cloud Run origins must be flagged, got ${shipped.length}: ${JSON.stringify(shipped)}`,
  );
  assert.deepEqual(
    shipped.map((v) => v.line),
    [3, 4],
    "each finding must carry the real line number, so the failure names a location a human can open",
  );

  // The canonical custom domain is the host that must survive — a pattern that also matched it
  // would make the gate unusable and get it deleted.
  assert.equal(
    findViolations("next.config.ts", '        "phoenix-hr.satopharma.com",').length,
    0,
    "the canonical production domain must never be flagged",
  );

  // Neighbouring words that merely contain the letters. A gate that fires on prose gets switched off.
  for (const benign of [
    "  const next = await run.apply(null, args);",
    "  // the migration will run.applyTo(target) next",
    "  logger.info('overrun.appended');",
  ]) {
    assert.equal(
      findViolations("src/x.ts", benign).length,
      0,
      `must not fire on a word that merely contains the letters: ${benign}`,
    );
  }

  // The four Vercel patterns the gate started with must still be live.
  assert.equal(
    findViolations("src/x.ts", '  const url = "https://phoenix-workforce-team.vercel.app";').length,
    1,
    "the original stale-Vercel-domain pattern must still fire",
  );
  assert.equal(
    findViolations("src/x.ts", "  if (process.env.VERCEL_URL) return process.env.VERCEL_URL;").length,
    1,
    "the Vercel runtime-var pattern must still fire",
  );
  // Worth stating, because it explains why the documented escape hatch has never been needed:
  // `/process\.env\.VERCEL\b/` does NOT match `process.env.VERCEL_ENV`, since `_` is a word
  // character. So src/config/system-settings.ts's tolerated VERCEL_ENV fallback passes the gate on
  // its own merits, and the platform-neutral-vercel-fallback marker appears nowhere in the tree.
  assert.equal(
    findViolations(
      "src/config/system-settings.ts",
      '  const env = String(process.env.APP_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV || "");',
    ).length,
    0,
    "process.env.VERCEL_ENV must not trip the VERCEL flag pattern — that is why the marker is unused",
  );

  // --- 2. the escape hatch works, and is scoped to its own platform ---------------------------

  const excusedVercel = `  const env = process.env.VERCEL_URL; // ${ALLOW_MARKERS.vercel}`;
  assert.equal(
    findViolations("src/config/system-settings.ts", excusedVercel).length,
    0,
    "the documented platform-neutral-vercel-fallback marker must still excuse a Vercel finding",
  );

  const excusedGcp = `  const host = "x.run.app"; // ${ALLOW_MARKERS.gcp}`;
  assert.equal(
    findViolations("src/x.ts", excusedGcp).length,
    0,
    "the Cloud Run marker must excuse a deliberate Cloud Run reference",
  );

  // 🔴 The scoping, which is the half that matters. The single catch-all ALLOW_LINE regex this
  // replaced would have let a Vercel-fallback comment silence a Cloud Run host sitting on the same
  // line — an escape hatch that excuses patterns it was never written for is a hole, not a hatch.
  const wrongMarker = `  const host = "x.run.app"; // ${ALLOW_MARKERS.vercel}`;
  assert.equal(
    findViolations("src/x.ts", wrongMarker).length,
    1,
    "the Vercel marker must NOT excuse a Cloud Run finding — each marker covers only its own platform",
  );
  const wrongMarkerOther = `  const env = process.env.VERCEL_URL; // ${ALLOW_MARKERS.gcp}`;
  assert.equal(
    findViolations("src/config/x.ts", wrongMarkerOther).length,
    1,
    "the Cloud Run marker must NOT excuse a Vercel finding",
  );

  assert.notEqual(
    ALLOW_MARKERS.vercel,
    ALLOW_MARKERS.gcp,
    "the two markers must be distinguishable, or scoping them means nothing",
  );

  // --- 3. the extension matcher, keyed on the BASENAME ----------------------------------------

  // 🔴 The bug. `EXTS.has(full.slice(full.lastIndexOf(".")))` tested the last dot in the WHOLE
  // path, so a dotted parent directory displaced the check entirely: "src/v1.2/route.ts" yields
  // ".2/route.ts", which is in no extension set, and every file beneath such a directory was
  // skipped while the gate went on reporting a clean scan of the files it did read. Latent only
  // because nothing under src/ or app/ carries a dot in a directory name today — the failure mode
  // was a gate that quietly stops looking, which is worse than one that is red.
  for (const dotted of [
    "src/v1.2/route.ts",
    "app/(admin)/v2.0/page.tsx",
    "src/lib/next.13/shim.mjs",
    "src/a.b/c.d/deep.tsx",
  ]) {
    assert.equal(
      hasScannedExtension(dotted),
      true,
      `a dotted parent directory must not displace the extension test: ${dotted}`,
    );
  }

  // The ordinary cases still behave.
  for (const yes of ["src/x.ts", "app/page.tsx", "scripts/y.mjs", "lib/utils.ts", "a/b/c.jsx", "d.js"]) {
    assert.equal(hasScannedExtension(yes), true, `must be scanned: ${yes}`);
  }
  for (const no of ["src/x.md", "app/styles.css", "docs/a.json", "src/q.sql", "x.snap.map"]) {
    assert.equal(hasScannedExtension(no), false, `must not be scanned: ${no}`);
  }

  // A basename with no dot at all. The old `slice(lastIndexOf("."))` with -1 handed back the final
  // CHARACTER of the path instead of an extension, so the answer was accidental either way.
  for (const noDot of ["Makefile", "src/Dockerfile", "src/lib/README", "s"]) {
    assert.equal(
      hasScannedExtension(noDot),
      false,
      `a basename with no extension must not be scanned: ${noDot}`,
    );
  }
  // A dotfile is a name, not an extension: ".ts" as a whole filename has nothing before the dot.
  assert.equal(hasScannedExtension(".ts"), false, "a dotfile named like an extension is not a source file");
  assert.equal(hasScannedExtension("src/.eslintrc.js"), true, "a dotfile with a real extension is scanned");

  // --- 4. the scan surface -------------------------------------------------------------------

  // Widened 2026-09-30. instrumentation.ts is a real runtime file (Next loads it on every server
  // boot) and the top-level lib/ ships too; both were unscanned purely because they do not live
  // under src/.
  for (const root of ["src", "app", "lib"]) {
    assert.ok(ROOTS.includes(root), `ROOTS must include ${root}`);
  }
  for (const file of ["next.config.ts", "proxy.ts", "instrumentation.ts"]) {
    assert.ok(EXTRA_FILES.includes(file), `EXTRA_FILES must include ${file}`);
  }

  // 🔴 scripts/ is deliberately OUT, and this assertion is the reminder rather than a preference.
  // Four files there legitimately hold the exact strings this gate hunts, because REJECTING a dead
  // platform is what that tooling is for: validate-env.mjs (:33-34) and
  // validate-railway-production-secrets.mjs (:127) refuse such a value, audit-page-transitions.mjs
  // (:118-119) recognises the old Vercel preview host, and check-no-stale-domains.mjs plus
  // stale-domain-rules.mjs define the patterns themselves. Adding scripts/ reds the required
  // `validate` job on eight lines that are all correct, and scripts/ does not ship in the runtime
  // image, so it cannot regress a production trust decision.
  assert.ok(
    !ROOTS.includes("scripts"),
    "scripts/ must stay out of ROOTS — a rejection pattern is the opposite of a stale reference, " +
      "and four files there would fail the gate for being right",
  );

  assert.ok(EXTS.has(".ts") && EXTS.has(".tsx"), "the gate must read TypeScript");
}
