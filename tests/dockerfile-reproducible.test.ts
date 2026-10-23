import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RUNTIME_EXTRAS,
  RUNTIME_EXTRAS_DIR,
  lockedImporterVersion,
  runtimeExtrasDrift,
} from "../scripts/sync-runtime-extras.mjs";
import { stripHashComments } from "./support/comment-strip.ts";

/**
 * THE PRODUCTION IMAGE IS BUILT FROM PINNED INPUTS (audit F-22 / S-INT-16, 2026-10-23).
 *
 * Three things used to float, and each one changed what production ran with nothing in the repository saying so:
 *
 *   1. The base image was `node:24-alpine` by tag only — a tag that moves with every Node or Alpine patch.
 *   2. The runtime image deleted the traced sharp and ran `npm install sharp@0.35.3` and
 *      `npm install puppeteer-core@25.13.0` with no lockfile, so every transitive package resolved on the day of
 *      the build, and the comment claimed "in sync with pnpm-lock.yaml" while the lockfile had moved to sharp 0.35.5
 *      (the version past the GHSA-2464 threshold) and puppeteer-core 25.15.0.
 *   3. Nothing compared the image's versions with the lockfile, so the drift was silent.
 *
 * Now the FROM carries a digest, the two packages come from `npm ci` against a committed lockfile, and this test
 * fails the moment either direct version differs from what pnpm-lock.yaml resolves.
 * `node scripts/sync-runtime-extras.mjs` brings them back in step.
 */
export function runDockerfileReproducibleTests(): void {
  const dockerfileRaw = readFileSync("Dockerfile", "utf8");
  const dockerfile = stripHashComments(dockerfileRaw);
  const pnpmLock = readFileSync("pnpm-lock.yaml", "utf8");
  const manifest = JSON.parse(readFileSync(`${RUNTIME_EXTRAS_DIR}/package.json`, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const npmLock = JSON.parse(readFileSync(`${RUNTIME_EXTRAS_DIR}/package-lock.json`, "utf8")) as {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string; integrity?: string; resolved?: string; link?: boolean }>;
  };

  // ── 1. The base image is pinned by digest ──────────────────────────────────────────────────────────
  const stages = new Set([...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map(([, name]) => name.toLowerCase()));
  const external = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)]
    .map(([, image]) => image)
    .filter((image) => !stages.has(image.toLowerCase()));
  assert.ok(external.length > 0, "the Dockerfile pulls no external base image, so this rule asserts nothing — re-point it");
  for (const image of external) {
    assert.match(
      image,
      /^[^@\s]+:[^@\s/]+@sha256:[0-9a-f]{64}$/,
      `🔴 the production base image \`${image}\` is not pinned by digest. A tag alone moves with every upstream patch, so two ` +
        "builds of one commit can run different bases. Keep the tag for the reader and add `@sha256:<digest>` " +
        "(`docker buildx imagetools inspect <image:tag>`).",
    );
  }

  // ── 2. The runtime extras come from the committed lockfile, never a floating install ──────────────────
  assert.match(
    dockerfile,
    /^COPY infra\/runtime-extras\/package\.json infra\/runtime-extras\/package-lock\.json \/tmp\/runtime-extras\/$/m,
    "the runtime image no longer copies the runtime extras' manifest and lockfile",
  );
  assert.match(dockerfile, /\bnpm ci\b[^\n]*--omit=dev/, "🔴 the runtime extras must be installed with `npm ci` (the lockfile, exactly), not `npm install`");
  assert.doesNotMatch(
    dockerfile,
    /\bnpm (install|i|add)\b/,
    "🔴 the Dockerfile runs `npm install` again — that resolves versions on the day of the build. Add the package to " +
      `${RUNTIME_EXTRAS_DIR} and install it with \`npm ci\`.`,
  );
  for (const name of RUNTIME_EXTRAS) {
    assert.doesNotMatch(
      dockerfileRaw,
      new RegExp(`${name.replace(/[-/]/g, "\\$&")}@\\d`),
      `the Dockerfile names a ${name} version again (comments included) — the version lives in ${RUNTIME_EXTRAS_DIR} only, ` +
        "so a second copy can only drift",
    );
  }
  // The traced sharp is still removed before the copy (a pnpm symlink is written THROUGH otherwise), and the build
  // still proves sharp loads.
  const install = /RUN cd \/tmp\/runtime-extras[^]*?(?=\n\S)/.exec(dockerfile)?.[0] ?? "";
  assert.ok(install.length > 0, "the runtime-extras install step is gone");
  assert.ok(
    install.indexOf("rm -rf /app/node_modules/sharp /app/node_modules/@img") > install.indexOf("npm ci") &&
      install.indexOf("rm -rf /app/node_modules/sharp /app/node_modules/@img") < install.indexOf("cp -R /tmp/runtime-extras/node_modules/."),
    "the traced sharp must be removed after the install and before the copy",
  );
  assert.match(dockerfile, /require\('sharp'\)[^\n]*toBuffer/, "the build no longer proves sharp loads and encodes");

  // ── 3. The lockfile is complete and reproducible ─────────────────────────────────────────────────────
  assert.ok((npmLock.lockfileVersion ?? 0) >= 2, "the runtime extras' lockfile must be npm lockfile v2 or later");
  const entries = Object.entries(npmLock.packages ?? {}).filter(([path]) => path !== "");
  assert.ok(entries.length > RUNTIME_EXTRAS.length, "the runtime extras' lockfile records no transitive packages");
  for (const [path, entry] of entries) {
    assert.ok(entry.version, `${path} has no pinned version in the runtime extras' lockfile`);
    assert.match(entry.integrity ?? "", /^sha512-/, `${path} has no integrity hash, so npm ci could install different bytes`);
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${path} resolves outside the public npm registry`);
  }

  // ── 4. The versions equal pnpm-lock.yaml's — what every test and the dev server run against ─────────
  for (const name of RUNTIME_EXTRAS) {
    assert.ok(lockedImporterVersion(pnpmLock, name), `pnpm-lock.yaml's root importer no longer resolves ${name}`);
  }
  assert.deepEqual(
    runtimeExtrasDrift({ pnpmLock, manifest, npmLock }),
    [],
    `🔴 the production image's runtime extras have drifted from pnpm-lock.yaml. Run \`node scripts/sync-runtime-extras.mjs\` ` +
      `and commit ${RUNTIME_EXTRAS_DIR}/package.json and package-lock.json.`,
  );

  // The parser itself: a peer suffix is stripped, a scoped name is found, and a dev or nested importer is not the root.
  const sample = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      '@img/colour':",
    "        specifier: ^1.0.0",
    "        version: 1.1.0",
    "      puppeteer-core:",
    "        specifier: ^25.13.0",
    "        version: 25.15.0(yauzl@2.10.0)",
    "",
    "  other:",
    "    dependencies:",
    "      sharp:",
    "        specifier: ^0.30.0",
    "        version: 0.30.0",
    "",
    "packages:",
    "",
    "  sharp@0.35.5:",
    "    resolution: {integrity: sha512-x}",
  ].join("\n");
  assert.equal(lockedImporterVersion(sample, "puppeteer-core"), "25.15.0", "the peer suffix is stripped");
  assert.equal(lockedImporterVersion(sample, "@img/colour"), "1.1.0", "a scoped name is found by its quoted key");
  assert.equal(lockedImporterVersion(sample, "sharp"), null, "another importer's sharp is not the root's");
  const drift = runtimeExtrasDrift({
    pnpmLock: sample.replace("      puppeteer-core:", "      sharp:\n        specifier: ^0.35.5\n        version: 0.35.5\n      puppeteer-core:"),
    manifest: { dependencies: { "puppeteer-core": "25.13.0", sharp: "0.35.5" } },
    npmLock: { packages: { "node_modules/puppeteer-core": { version: "25.13.0" }, "node_modules/sharp": { version: "0.35.3" } } },
  });
  assert.deepEqual(
    drift,
    [
      `${RUNTIME_EXTRAS_DIR}/package.json pins puppeteer-core 25.13.0 but pnpm-lock.yaml resolves 25.15.0`,
      `${RUNTIME_EXTRAS_DIR}/package-lock.json installs puppeteer-core 25.13.0 but pnpm-lock.yaml resolves 25.15.0`,
      `${RUNTIME_EXTRAS_DIR}/package-lock.json installs sharp 0.35.3 but pnpm-lock.yaml resolves 0.35.5`,
    ],
    "a drifted pin and a drifted lockfile are each named",
  );

  // ── 5. The fallback route can still build a digest-pinned base from a mirror ─────────────────────────
  // Docker refuses to tag a reference that carries a digest, so the mirror's copy reaches the build as a named
  // context instead; the plain tag path stays for an older commit whose FROM has no digest.
  const fallback = stripHashComments(readFileSync(".github/workflows/fallback-image.yml", "utf8"));
  assert.match(fallback, /\*@sha256:\*\) echo "BASE_CONTEXT=\$\{BASE\}=docker-image:\/\/\$\{pulled\}" >> "\$GITHUB_ENV"/, "a mirror's copy of a pinned base is handed to the build as a named context");
  assert.match(fallback, /build_args\+=\(--build-context "\$\{BASE_CONTEXT\}"\)/, "the build passes that named context");
  assert.match(fallback, /- infra\/runtime-extras\/\*\*/, "a change to the runtime extras builds the image on its pull request");
}
