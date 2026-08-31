import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// DESIGN LOCK (owner) — the employee-portal identity banner MUST always render via
// PhoenixSignatureCard and must never be swapped for another component. This is one of the
// permanently-locked protected files, but until now the lock was PURELY behavioural: nothing
// turned a PR red if a session quietly swapped the render, so CI would stay green through the swap.
//
// This is that missing mechanical lock. It is a source pin (the component is a client-only
// dynamic import, so there is nothing to render in a plain node test) that fails the moment the
// banner stops rendering PhoenixSignatureCard, the import is removed, or the DESIGN LOCK notice is
// deleted.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const IDENTITY_CARD = read("../src/components/employee-portal/identity-card.tsx");
const SIGNATURE_CARD = read("../src/components/phoenix-signature-card/PhoenixSignatureCard.tsx");

export function runIdentityCardSignatureLockTests() {
  // ── The lock notice itself must survive ─────────────────────────────────────
  // The banner is a box-drawing comment, so "MUST use" and "PhoenixSignatureCard" sit on adjacent
  // lines separated by frame characters — assert presence, not adjacency.
  assert.ok(
    IDENTITY_CARD.includes("DESIGN LOCK")
      && IDENTITY_CARD.includes("MUST use")
      && IDENTITY_CARD.includes("PhoenixSignatureCard"),
    "identity-card.tsx must keep its DESIGN LOCK banner naming PhoenixSignatureCard as required",
  );

  // ── The component must be imported from the one canonical module ────────────
  assert.match(
    IDENTITY_CARD,
    /import\(["']@\/components\/phoenix-signature-card\/PhoenixSignatureCard["']\)/,
    "identity-card.tsx must import PhoenixSignatureCard from @/components/phoenix-signature-card/PhoenixSignatureCard",
  );

  // ── The banner must RENDER PhoenixSignatureCard as its root element ──────────
  // This is the assertion a component swap trips: change <PhoenixSignatureCard to any other
  // component in the return and this fails.
  assert.match(
    IDENTITY_CARD,
    /return\s*\(\s*<PhoenixSignatureCard[\s/>]/,
    "IdentityCard must render <PhoenixSignatureCard …/> as its root element — never another component",
  );

  // ── And PhoenixSignatureCard must still exist and export that name ───────────
  // Guards the other half of a swap: renaming or deleting the component would break the import
  // above at build time, but pinning the export keeps the failure legible here.
  assert.match(
    SIGNATURE_CARD,
    /export\s+function\s+PhoenixSignatureCard\b/,
    "PhoenixSignatureCard.tsx must still export a component named PhoenixSignatureCard",
  );

  // ── Discrimination: the render assertion must actually catch a swap ──────────
  // Simulated in a string copy so the protected file on disk is never touched. If the banner
  // rendered another component, the root-render regex must stop matching — otherwise the assertion
  // above is vacuous.
  const swapped = IDENTITY_CARD.replace(/<PhoenixSignatureCard/g, "<SomeOtherCard");
  assert.ok(
    !/return\s*\(\s*<PhoenixSignatureCard[\s/>]/.test(swapped),
    "detector sanity: a swapped render must fail the root-render check — the assertion is not vacuous",
  );
}
