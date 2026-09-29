// A pnpm override that names a package this repo ALSO declares directly must be SCOPED to the
// parent that needs it (`parent>child`), never written bare.
//
// WHY THIS EXISTS. A bare `overrides:` entry applies to the WHOLE dependency graph — including this
// repo's own `dependencies` entry for the same package — and it OUTRANKS package.json. So the
// manifest can say one thing while the lockfile resolves another, with nothing red to show it.
//
// Measured 2026-09-29, and it cost a Dependabot PR, a fake "upgrade" and most of a working day:
// `pnpm-workspace.yaml` carried a bare `nodemailer: ^9.1.1` (added 2026-09-09 for the addressparser
// DoS advisory, `<9.1.0`). Dependabot #4698 then set package.json to `^10.0.2` — and the lockfile
// kept resolving 9.1.1, because the override outranked it. CI went GREEN: both CI and the
// production Dockerfile install with `pnpm install --frozen-lockfile`, i.e. from the lockfile, so
// the checks proved the OLD version installed cleanly. The PR upgraded nothing while making
// package.json claim otherwise, and ANY manifest-only PR would have reproduced it. #4717 fixed it by
// scoping the override to the two parents that actually pin below the floor
// (`imapflow>nodemailer`, `mailparser>nodemailer`), leaving the direct dependency free.
//
// 🔴 THE DANGEROUS PART IS NOT THE NO-OP, IT IS THE DELAY. A bare override does not fail — it waits.
// The bump sits in package.json looking applied until somebody regenerates the lockfile for an
// unrelated reason, and then the real version change lands inside whatever PR happened to touch
// pnpm-lock.yaml, detached from any review of it.
//
// A comment cannot hold this: the mistake is made while EDITING this exact file, by someone closing
// an advisory in a hurry, and a bare entry looks identical to a correct one. So it is asserted.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * Known, deliberate violations — each one a package that is still bare AND still a direct
 * dependency. This is a RATCHET, not an amnesty: the assertion is a SUBSET check, so fixing an
 * entry keeps the suite green and its name can simply be dropped from here, while adding any NEW
 * bare override over a direct dependency goes red.
 *
 * EMPTY, and it should stay that way. `sharp` was the one entry and was removed the same day the
 * guard landed: its bare `^0.35.3` (65c6e30a2, the libvips CVEs) protected nothing that
 * package.json's own `^0.35.4` and `next@16.3.3`'s own `sharp: ^0.35.3` did not already protect, so
 * it was deleted rather than scoped. An empty set is the strongest form of this guard — every bare
 * override over a direct dependency now fails. Add a name here only with the reason and a way out,
 * never to quiet a red run.
 */
const KNOWN_BARE_OVERRIDES_OVER_A_DIRECT_DEPENDENCY = new Set<string>([]);

/** The `overrides:` block of pnpm-workspace.yaml, as [key, value] pairs, comments and blanks dropped. */
function readOverrides(raw = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8")): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let inside = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^overrides:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    // Any new key at column zero ends the block.
    if (/^\S/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = line.match(/^\s+(?:"([^"]+)"|'([^']+)'|([^"'#:][^:]*?))\s*:\s*(\S.*?)\s*$/);
    if (match) pairs.push([(match[1] ?? match[2] ?? match[3] ?? "").trim(), match[4]]);
  }
  return pairs;
}

function readDirectDependencies(): Set<string> {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
}

export function runPnpmOverrideScopeTests() {
  const overrides = readOverrides();

  // The parser is load-bearing: if it silently read nothing, every assertion below would pass
  // vacuously and the guard would be switched off without anyone noticing.
  assert.ok(
    overrides.length >= 10,
    `parsed only ${overrides.length} entries from pnpm-workspace.yaml's overrides block — the parser is broken, ` +
      "so this guard would pass vacuously. Fix the parser before trusting a green run.",
  );
  // The parser must still handle a scoped (`parent>child`) key even though the LIVE file no longer
  // carries one: the two nodemailer floors (`imapflow>nodemailer`, `mailparser>nodemailer`) were
  // removed 2026-09-29 once imapflow ^2.1.2 dropped the nodemailer dependency and mailparser ^3.9.26
  // moved to nodemailer 10.x. Asserting scoped-key parsing against a FIXTURE keeps that coverage
  // without depending on the repo happening to carry a scoped override — a real parser regression on
  // `>` keys would otherwise go unnoticed the moment the overrides block has none.
  assert.deepEqual(
    readOverrides('overrides:\n  "imapflow>nodemailer": ^9.1.1\n'),
    [["imapflow>nodemailer", "^9.1.1"]],
    "the overrides parser dropped or mangled a scoped (`parent>child`) key — it is broken.",
  );

  const direct = readDirectDependencies();
  assert.ok(direct.has("next"), "package.json parsed without its dependencies — the guard would pass vacuously.");

  const offenders = overrides
    .map(([key]) => key)
    .filter((key) => !key.includes(">"))
    .filter((key) => direct.has(key))
    .filter((key) => !KNOWN_BARE_OVERRIDES_OVER_A_DIRECT_DEPENDENCY.has(key));

  assert.deepEqual(
    offenders,
    [],
    `pnpm-workspace.yaml declares a BARE override for ${offenders.join(", ")}, which package.json also lists as a ` +
      "direct dependency. A bare override applies to the whole graph and OUTRANKS package.json, so the manifest " +
      "can be bumped while the lockfile keeps resolving the old version — and CI stays green, because it installs " +
      "--frozen-lockfile, i.e. from the lockfile. That is exactly how nodemailer's bump silently did nothing " +
      "(Dependabot #4698, fixed in #4717). Scope it to the parent that actually needs the floor, e.g. " +
      '"imapflow>nodemailer": ^9.1.1 — or delete it if the direct range already clears the advisory.',
  );
}
