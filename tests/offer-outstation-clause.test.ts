import assert from "node:assert/strict";

import { escapeRegExp, placeAliases } from "@/lib/geo/egypt-locations";
import { defaultOfferBlocks } from "@/lib/offers/default-template";
import { executiveOfferBlocks } from "@/lib/offers/executive-template";
import {
  OFFER_OUTSTATION_CLAUSE_HEADING,
  OFFER_OUTSTATION_CLAUSE_TEXT,
} from "@/lib/offers/outstation-clause";
import type { OfferBlock } from "@/lib/offers/types";
import { CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE } from "@/lib/outstation/cairo-allowance-rule";
import { OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM } from "@/lib/outstation/classification";

/** Pull the outstation clause text out of a template's `clauses` block. */
function outstationClauseOf(blocks: OfferBlock[], where: string): string {
  for (const block of blocks) {
    if (block.type !== "clauses") continue;
    const items = (block.props as { items?: Array<{ h?: string; t?: string }> }).items ?? [];
    const found = items.find((item) => item.h === OFFER_OUTSTATION_CLAUSE_HEADING);
    if (found?.t) return found.t;
  }
  assert.fail(`${where} has no "${OFFER_OUTSTATION_CLAUSE_HEADING}" clause at all`);
}

/**
 * Every Egyptian governorate this text names, resolved through the repo's ONE place vocabulary
 * (`@/lib/geo/egypt-locations`) rather than a second copy of it.
 *
 * Aliases, not just the canonical labels — the whole point. The clause this test exists to prevent
 * said "Sharkia", while the canonical label is "Sharqia", so a label-only check would have sailed
 * straight past the exact bug. Latin aliases of four characters or more, on a word boundary, so a
 * short fragment cannot match inside an ordinary English word.
 */
function governoratesNamedIn(text: string): string[] {
  const found = new Set<string>();
  for (const { aliases, label } of placeAliases) {
    for (const alias of aliases) {
      const term = alias.trim();
      if (term.length < 4 || /[\u0600-\u06FF]/.test(term)) continue;
      if (new RegExp(String.raw`\b${escapeRegExp(term)}\b`, "i").test(text)) {
        found.add(label);
        break;
      }
    }
  }
  return [...found].sort();
}

export function runOfferOutstationClauseTests() {
  const shipped: Array<[string, string]> = [
    ["the classic template", outstationClauseOf(defaultOfferBlocks(), "the classic template")],
    ["the executive template", outstationClauseOf(executiveOfferBlocks(), "the executive template")],
  ];

  // ── Both shipped letters make the SAME promise ───────────────────────────────────────────────
  {
    for (const [where, clause] of shipped) {
      assert.equal(
        clause,
        OFFER_OUTSTATION_CLAUSE_TEXT,
        `${where} must use the shared clause, or the two letters can promise different pay terms`,
      );
    }
  }

  // ── The letter cannot claim a distance the engine does not enforce ───────────────────────────
  {
    const numbers = [...OFFER_OUTSTATION_CLAUSE_TEXT.matchAll(/(\d+)\s*km/gi)].map((m) => Number(m[1]));
    assert.deepEqual(
      numbers,
      [OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM],
      "the clause must state exactly the policy minimum the engine applies, and no other distance",
    );
  }

  // ── THE HEADLINE. The letter may only name a place the engine actually rules on ──────────────
  {
    // The engine's one governorate-specific rule is Cairo (cairo-allowance-rule.ts). Nothing in
    // src/lib/outstation/ has ever excluded any other governorate — so any other name here is a
    // term no system enforces, printed on a letter somebody signs. That is precisely how
    // "excluding Sharkia Governorate" reached every role in every territory: it was true of one
    // signed offer (Dr Samaa Shalaby, DSM Delta 3) and was never true of the software.
    assert.deepEqual(
      governoratesNamedIn(OFFER_OUTSTATION_CLAUSE_TEXT),
      [CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE],
      "the outstation clause names a governorate the outstation engine has no rule for — "
        + "the letter would promise or deny money the system does not act on",
    );
  }

  // ── The Cairo rule the engine DOES apply must be stated, not silently omitted ────────────────
  {
    // The dangerous direction. A regional employee travelling to Cairo is paid transport but earns
    // no per-diem (owner rule, 2026-08-15). A letter silent on that reads as an unconditional
    // promise, and the refusal arrives after the candidate has signed.
    assert.match(
      OFFER_OUTSTATION_CLAUSE_TEXT,
      new RegExp(String.raw`\b${escapeRegExp(CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE)}\b`, "i"),
      "the clause must state the Cairo per-diem rule the engine enforces",
    );
    assert.match(
      OFFER_OUTSTATION_CLAUSE_TEXT,
      /daily allowance/i,
      "the Cairo sentence must say what is actually withheld — the daily allowance, not the whole "
        + "claim — and must say it in plain words: the owner asked what 'per diem' meant, so a "
        + "candidate signing the letter would have to look it up too",
    );
  }

  // ── And the residence-governorate rule, which rejects outright ───────────────────────────────
  {
    assert.match(
      OFFER_OUTSTATION_CLAUSE_TEXT,
      /governorate of residence/i,
      "the clause must state that a trip inside your own governorate is not eligible",
    );
  }
}
