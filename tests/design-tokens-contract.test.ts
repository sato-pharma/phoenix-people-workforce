import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The design-token contract.
//
// src/styles/tokens.css is imported by app/globals.css BEFORE globals.css declares its own
// :root block. Equal specificity, later wins — so any name both files declare takes the
// globals.css value and the one in tokens.css never renders at all. No error, no warning; the
// token is simply dead.
//
// That is not hypothetical. --border and --card were declared in both files for months. The
// compiled stylesheet emitted each of them FOUR times, and the two hex values in tokens.css were
// discarded by the cascade every single build. Removing them (#2527) changed no pixel, which is
// exactly what made it invisible for so long.
//
// Two rules keep it from happening again, and a third keeps the dark theme honest:
//
//   1. Every token tokens.css declares is either a known legacy name or carries the --phx-
//      prefix. The prefix is what makes a collision impossible.
//   2. No name tokens.css declares is one that globals.css's own :root already owns.
//   3. Every --phx- token whose value is a COLOUR is redefined in .dark. A colour defined only
//      in :root renders the light value on the dark ground — the classic unreadable-theme bug.

const TOKENS_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)),
  "utf8",
);

const GLOBALS_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);

// The pre-existing tokens that are wired into tailwind.config.ts and globals.css's @theme inline
// block. They predate the --phx- system and are allowed to stay bare. Phase 3 re-points them at
// --phx- values; this list should SHRINK over time and must never grow.
const LEGACY_BARE_NAMES = new Set([
  "--phoenix-primary",
  "--phoenix-primary-hover",
  "--bg",
  "--bg-soft",
  "--bg-muted",
  "--text",
  "--text-secondary",
  "--success",
  "--warning",
  "--danger",
]);

// --phx- tokens whose value is derived from another --phx- token rather than being a literal
// colour. They follow whatever their input resolves to, so they need no .dark counterpart.
const DERIVED_COLOUR_TOKENS = new Set(["--phx-focus-ring"]);

function declaredNames(css: string): string[] {
  return [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]);
}

/** The names globals.css declares in its OWN :root block, i.e. the ones that win the cascade. */
function globalsOwnRootNames(): Set<string> {
  const start = GLOBALS_SOURCE.indexOf(":root {");
  const end = GLOBALS_SOURCE.indexOf("@theme inline");
  assert.ok(start >= 0, "app/globals.css no longer has a :root block — this test needs updating");
  assert.ok(
    end > start,
    "app/globals.css no longer has an @theme inline block after :root — this test needs updating",
  );
  return new Set(declaredNames(GLOBALS_SOURCE.slice(start, end)));
}

function looksLikeColour(value: string): boolean {
  return /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\blab\(|color-mix\(/i.test(value);
}

export function runDesignTokensContractTests() {
  const rootStart = TOKENS_SOURCE.indexOf(":root {");
  const darkStart = TOKENS_SOURCE.indexOf(".dark {");
  assert.ok(rootStart >= 0, "tokens.css has no :root block");
  assert.ok(darkStart > rootStart, "tokens.css has no .dark block after :root");

  const rootBlock = TOKENS_SOURCE.slice(rootStart, darkStart);
  const darkBlock = TOKENS_SOURCE.slice(darkStart);

  // --- 1. every declared name is legacy or --phx- prefixed -------------------
  const unprefixed = declaredNames(TOKENS_SOURCE).filter(
    (name) => !name.startsWith("--phx-") && !LEGACY_BARE_NAMES.has(name),
  );
  assert.deepEqual(
    unprefixed,
    [],
    `tokens.css declares bare token name(s) that are neither legacy nor --phx- prefixed: ` +
      `${unprefixed.join(", ")}. Use the --phx- prefix — a bare name can collide with ` +
      `app/globals.css, and the loser of that collision is silently dead.`,
  );

  // --- 2. no collision with the names globals.css :root owns -----------------
  const owned = globalsOwnRootNames();
  assert.ok(owned.size > 0, "could not read any token names from globals.css :root");

  const collisions = [...new Set(declaredNames(TOKENS_SOURCE))].filter((name) => owned.has(name));
  assert.deepEqual(
    collisions,
    [],
    `tokens.css declares name(s) that app/globals.css :root also declares: ${collisions.join(", ")}. ` +
      `globals.css imports tokens.css first, so globals.css wins and the value here never ` +
      `renders. Rename with the --phx- prefix, or set the value in globals.css instead.`,
  );

  // --- 3. every --phx- colour token has a .dark counterpart ------------------
  const rootColourTokens = [...rootBlock.matchAll(/^\s*(--phx-[a-z0-9-]+)\s*:\s*([^;]+);/gm)]
    .filter(([, , value]) => looksLikeColour(value))
    .map(([, name]) => name);

  assert.ok(
    rootColourTokens.length >= 20,
    `expected the --phx- system to define many colour tokens, found ${rootColourTokens.length} — ` +
      `the matcher is probably broken rather than the file`,
  );

  const redefinedInDark = new Set(declaredNames(darkBlock));
  const missingFromDark = rootColourTokens.filter(
    (name) => !redefinedInDark.has(name) && !DERIVED_COLOUR_TOKENS.has(name),
  );
  assert.deepEqual(
    missingFromDark,
    [],
    `--phx- colour token(s) defined in :root but not in .dark: ${missingFromDark.join(", ")}. ` +
      `A colour defined only in :root renders its light value on the dark ground.`,
  );
}
