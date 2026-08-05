import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Invoice-photo prefill (spec B5).
//
// Two rules carry the whole feature, and both are the kind that fail silently:
//
//   1. What the reader returns is a CLAIM. Every code is re-resolved against master data, and
//      anything that does not resolve is NAMED, never quietly dropped and never replaced with the
//      nearest plausible match. This module exists because codes that did not exist were accepted
//      once — 12 phantom pharmacies, 509,736 EGP. A reader that invents a code industrialises that.
//
//   2. It is never announced (spec D4). No "AI", no model name, no provider, no confidence score,
//      no sparkle — anywhere a user can see. A leak here is invisible to typecheck and to every
//      other test in the suite.
//
// The extraction path is OpenAI- and Supabase-bound end to end, so the resolution rules are pinned
// by source; the D4 sweep and the both-forms check execute for real.
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACTOR = "../src/lib/direct-orders/invoice-extraction.ts";
const CAPTURE = "../src/components/direct-orders/invoice-capture.tsx";
const ROUTE = "../app/api/direct-orders/invoice-extract/route.ts";
const ADMIN_FORM = "../src/components/direct-orders/direct-order-submit-form.tsx";
const PORTAL_FORM = "../src/components/employee-portal/direct-order-portal-submit.tsx";

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runDirectOrderInvoicePrefillTests() {
  const extractor = read(EXTRACTOR);
  const capture = read(CAPTURE);
  const route = read(ROUTE);

  // ── Rule 1: an unresolved code prefills NOTHING ──────────────────────────────────────────
  assert.match(
    extractor,
    /const exact = hits\.find\(\(hit\) => codeKey\(hit\.customerCode\) === codeKey\(read\.customerCode\)\)/,
    "THE CUSTOMER CODE MUST BE CONFIRMED BY AN EXACT DIRECTORY MATCH: a fuzzy or first-hit match would prefill the nearest-looking pharmacy, which is worse than no prefill because it looks deliberate",
  );
  assert.match(
    extractor,
    /if \(!exact\) \{[\s\S]{0,600}?return null;/,
    "AN UNRECOGNISED CUSTOMER CODE MUST RESOLVE TO NULL: prefilling a pharmacy the master database has never heard of is exactly how the 12 phantom pharmacies were created, only faster",
  );
  // The dangerous "helpful" behaviour is falling back to a name match when the code misses.
  assert.doesNotMatch(
    extractor,
    /if \(!exact\)[\s\S]{0,400}?hits\[0\]/,
    "THE RESOLVER MUST NOT FALL BACK TO THE FIRST/NEAREST HIT when the code does not match — that silently lands the order on a different pharmacy",
  );

  // ── Rule 1b: an unmatched line keeps its place ───────────────────────────────────────────
  assert.match(
    extractor,
    /return \{ read, product: null, problem \};/,
    "AN UNMATCHED LINE MUST BE RETURNED, NOT FILTERED: dropping it turns a five-line invoice into four with nobody able to notice — the same silent-discard bug the half-filled distributor row already caused",
  );
  assert.doesNotMatch(
    extractor,
    /\.filter\(\(line\) => line\.product\)/,
    "unmatched lines must never be filtered out of the result",
  );

  // ── Rule 1c: quantities are read, never invented ─────────────────────────────────────────
  assert.match(
    extractor,
    /NEVER guess, complete, correct or infer a code/,
    "the instructions must forbid guessing a code outright — a wrong code is treated as a real pharmacy",
  );
  assert.match(
    extractor,
    /if \(read\.qty == null \|\| read\.qty <= 0\)/,
    "a line with no readable quantity must be flagged rather than defaulted to some number",
  );
  // A quantity is a whole number of boxes; a fractional or negative read is a misread.
  assert.match(extractor, /function count\(value: unknown\)/, "quantities must go through a single normaliser");
  assert.match(extractor, /!Number\.isFinite\(n\) \|\| n < 0/, "a negative or non-finite quantity must not survive");

  // ── Rule 2: D4 — the reader is never announced ───────────────────────────────────────────
  // Only user-visible strings matter: code comments explain WHY and must stay. Extract the string
  // literals and JSX text, then sweep those.
  const bannedWord = /\b(AI|A\.I\.|GPT|OpenAI|LLM|model|artificial intelligence|machine learning|confidence score)\b/i;

  /**
   * Split a source file into its string literals and its remaining code, in ONE string-aware pass.
   *
   * This is deliberately a scanner and not a set of regexes, and the history is worth keeping
   * because both regex attempts failed SILENTLY — the suite stayed green while the check had
   * stopped looking:
   *
   *   1. `/"([^"\\]{4,})"/g` desynchronised on an empty string: `""` cannot match a 4-plus
   *      character body, so the engine paired ITS closing quote with the next opening quote and
   *      every literal after that point was mis-paired.
   *
   *   2. Stripping comments with `/\/\*[\s\S]*?\*\//g` ate 2,698 characters of this component,
   *      because `accept="image/*"` contains `/*`. The regex read that as a comment opening and
   *      deleted everything up to the next `*​/` — a JSX comment far below — taking the button
   *      label with it. A planted "AI is reading the invoice…" was therefore invisible.
   *
   * A scanner cannot make either mistake: it consumes a string literal whole, so `/*` inside one is
   * never treated as a comment, and it never has to guess which quote pairs with which.
   *
   * Known limit: a regex literal containing a quote would confuse it. Neither file has one, and a
   * wrong answer here fails loudly rather than quietly, which is the right direction to be wrong in.
   */
  const scan = (source: string): { strings: string[]; code: string } => {
    const strings: string[] = [];
    let code = "";
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
        continue;
      }
      if (c === "/" && next === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        let value = "";
        while (j < source.length && source[j] !== c) {
          if (source[j] === "\\") {
            value += source[j + 1] ?? "";
            j += 2;
            continue;
          }
          value += source[j];
          j += 1;
        }
        strings.push(value);
        // A space, so removing the literal cannot weld two identifiers into one word.
        code += " ";
        i = j + 1;
        continue;
      }
      code += c;
      i += 1;
    }
    return { strings, code };
  };

  for (const [label, source] of [
    ["the capture component", capture],
    ["the API route", route],
  ] as const) {
    const { strings: allStrings, code } = scan(source);
    // Import specifiers are machinery: "@/lib/ai/openai-client" is never shown to anyone, and
    // flagging it would train the next person to weaken the banned-word list rather than trust it.
    const importSpecifiers = new Set(
      [...source.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]),
    );
    const strings = allStrings.filter((s) => !importSpecifiers.has(s));
    // JSX text lives between tags, not in a literal, so it comes from the comment-free code.
    const jsxText = [...code.matchAll(/>\s*([A-Za-z][^<>{}]{8,})\s*</g)].map((m) => m[1]);
    for (const text of [...strings, ...jsxText]) {
      // className strings are not prose and legitimately contain no banned words anyway; skip the
      // Tailwind soup so a class like "text-slate-900" cannot trip a substring rule later.
      if (/^[a-z0-9:\-\[\]#/. ]+$/.test(text)) continue;
      // A module path or URL is never shown to a user. Narrow and explicit, so real prose that
      // merely starts with a symbol is still swept.
      if (/^[@.]{1,2}\//.test(text) || /^https?:\/\//.test(text)) continue;
      assert.doesNotMatch(
        text,
        bannedWord,
        `D4 VIOLATION — ${label} shows the user "${text}". The reader must present as Phoenix itself: no AI label, no model name, no confidence score, anywhere a user can see (standing owner rule, 2026-08-04)`,
      );
    }
  }
  // Comments are excluded on purpose: the comment in invoice-capture.tsx that STATES this rule
  // ("no sparkle icon") would otherwise trip it. A check that fires on its own documentation
  // teaches the next person to delete the documentation.
  const captureScan = scan(capture);
  assert.doesNotMatch(
    [...captureScan.strings, captureScan.code].join("\n"),
    /✨|🤖|sparkle/i,
    "NO SPARKLE OR ROBOT ICONOGRAPHY — spec D4. The feature presents as Phoenix being smart, never as a machine being consulted.",
  );

  // ── The reader runs server-side only ─────────────────────────────────────────────────────
  assert.doesNotMatch(
    capture,
    /openai|api\.openai\.com|OPENAI_API_KEY/i,
    "THE MODEL MUST NEVER BE CALLED FROM THE BROWSER: spec D4 requires that nothing client-side betrays one, and a browser call would also expose the key",
  );
  assert.match(
    capture,
    /fetch\("\/api\/direct-orders\/invoice-extract"/,
    "the component must go through our own route, which is where the permission check lives",
  );

  // ── An outage must not read as a bad photo ───────────────────────────────────────────────
  assert.match(
    route,
    /error instanceof PhoenixOpenAiError[\s\S]{0,400}?status: 503/,
    "AN UPSTREAM FAILURE MUST NOT BE DRESSED UP AS A BAD INVOICE: otherwise the rep retakes a perfectly good photo five times to fix an outage on our side",
  );
  assert.match(route, /assertSameOriginMutation/, "the route must carry CSRF like every other POST here");

  // ── Reachability: BOTH forms, or the people holding invoices cannot use it ────────────────
  for (const [label, rel] of [
    ["the admin submit form", ADMIN_FORM],
    ["the PORTAL submit form", PORTAL_FORM],
  ] as const) {
    const form = read(rel);
    assert.match(
      form,
      /<InvoiceCapture/,
      `INVOICE PREFILL IS UNREACHABLE FROM ${label}: every medical rep and district manager is redirected into the portal, so a capture mounted on only one form is a feature the people holding the invoices cannot use — exactly what happened to the pharmacy-validation capture (11 held orders, 509,736 EGP, zero validation requests)`,
    );
    assert.match(
      form,
      /onApply=\{\(payload\) => \{[\s\S]{0,400}?setProductCode\(payload\.productCode\)/,
      `${label} must actually apply what was read, not just render the control`,
    );
  }

  // ── The route is declared, or the access-registry gate fails CI ──────────────────────────
  assert.match(
    read("../src/lib/security/access-registry.ts"),
    /pattern: "\/api\/direct-orders\/invoice-extract"/,
    "every app/api route must be declared in the access registry",
  );
}
