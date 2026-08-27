import { strict as assert } from "node:assert";

import {
  OFFER_PLACEHOLDERS,
  OFFER_PLACEHOLDER_GROUPS,
  OFFER_PLACEHOLDER_KEYS,
  unknownOfferPlaceholders,
} from "../src/lib/offers/placeholders.ts";
import { OFFER_BUILTIN_TEMPLATES } from "../src/lib/offers/builtin-templates.ts";
import { buildOfferTokens } from "../src/lib/offers/render.ts";
import type { OfferFields } from "../src/lib/offers/types.ts";

/**
 * The placeholder catalogue and the token builder must not drift apart.
 *
 * They are two lists of the same thing maintained in two files, which is exactly the shape that
 * rots. Each direction fails differently and both are silent:
 *
 *   - a token the BUILDER produces but the catalogue omits is undiscoverable. It works perfectly
 *     for anyone who already knows its name and does not exist for anyone else, which in practice
 *     means it does not exist.
 *   - a catalogue entry with NO matching token is worse than useless: `fillOfferTokens` leaves an
 *     unknown token standing, so the designer's picker would hand somebody a placeholder that
 *     prints as the literal characters `{{companyPhone}}` on a legally binding letter.
 *
 * Neither shows up in a rendered preview built from the SHIPPED templates, because the shipped
 * templates only use tokens that already work. So it gets asserted here instead.
 */
export function runOfferPlaceholderTests() {
  const SAMPLE: OfferFields = {
    candidateEmail: "samaa.shalaby@example.com",
    candidateName: "SAMAA SHALABY",
    contractTerm: "One year, renewable",
    costOfLiving: 3500,
    dateOfIssue: "27-Aug-26",
    reference: "SP-HR-DSM-2026-019",
    reportsTo: "National Sales Manager",
    salutationName: "Dr SAMAA SHALABY",
    startDate: "1 September 2026",
    territory: "Delta (3)",
    title: "District Sales Manager",
    totalMonthly: 30000,
    validUntil: "1 September 2026",
  };

  // ── The headline: the two lists are the same set ───────────────────────────────────────────
  const produced = Object.keys(buildOfferTokens(SAMPLE)).sort();
  const catalogued = OFFER_PLACEHOLDERS.map((placeholder) => placeholder.key).sort();

  assert.deepEqual(
    catalogued,
    produced,
    "the placeholder catalogue and buildOfferTokens must list exactly the same tokens — " +
      "an extra catalogue entry prints literally on the letter, a missing one is undiscoverable",
  );

  // ── Nothing in the catalogue may be empty or duplicated ────────────────────────────────────
  assert.equal(
    new Set(catalogued).size,
    catalogued.length,
    "a duplicated placeholder key would list the same token twice in the picker",
  );
  for (const placeholder of OFFER_PLACEHOLDERS) {
    assert.ok(placeholder.label.trim() !== "", `${placeholder.key} needs a label — the picker shows it`);
    assert.ok(placeholder.note.trim() !== "", `${placeholder.key} needs a note saying where the value comes from`);
    assert.ok(
      OFFER_PLACEHOLDER_GROUPS.includes(placeholder.group),
      `${placeholder.key} is in group "${placeholder.group}", which the picker does not render`,
    );
  }
  // Every group must actually hold something, or the picker draws an empty heading.
  for (const group of OFFER_PLACEHOLDER_GROUPS) {
    assert.ok(
      OFFER_PLACEHOLDERS.some((placeholder) => placeholder.group === group),
      `group "${group}" is listed but empty — the picker would draw a heading over nothing`,
    );
  }

  // ── Both shipped letters must use only real placeholders ───────────────────────────────────
  // This is the check that would have caught a typo in either built-in design before it shipped.
  for (const builtin of OFFER_BUILTIN_TEMPLATES) {
    assert.deepEqual(
      unknownOfferPlaceholders(builtin.blocks()),
      [],
      `${builtin.key} uses a placeholder that does not exist — it would print as literal braces`,
    );
  }

  // ── The recursive walk must reach text inside repeatable lists ─────────────────────────────
  // Most of the letter's words live one level down, in clause/benefit/step rows. A check that only
  // looked at top-level props would report a clean bill of health for a broken letter.
  assert.deepEqual(
    unknownOfferPlaceholders({
      props: { items: [{ h: "Probation", t: "Reports to the {{reprotsTo}} from {{startDate}}." }] },
    }),
    ["reprotsTo"],
    "the walk must reach inside list rows and flag the misspelling while leaving the real token alone",
  );
  assert.deepEqual(
    unknownOfferPlaceholders({ html: "<p>Dear {{salutationName}}, welcome to {{companyName}}.</p>" }),
    [],
    "known placeholders must never be reported, including the company ones",
  );

  // ── The four tokens this catalogue added ───────────────────────────────────────────────────
  // `candidateEmail` was a field on every offer that no template could reach; the company trio was
  // hard-coded as type in the letterhead. Pin them so a refactor cannot quietly drop them again.
  const tokens = buildOfferTokens(SAMPLE);
  assert.equal(tokens.candidateEmail, "samaa.shalaby@example.com", "the candidate's email must be reachable");
  assert.ok(OFFER_PLACEHOLDER_KEYS.has("companyName"), "the company name must be a placeholder, not retyped prose");
  assert.equal(tokens.companyName, "Sato Pharma", "the company name comes from the shared legal entity");
  assert.ok(
    (tokens.companyNameAr ?? "").trim() !== "" && (tokens.companyAddress ?? "").trim() !== "",
    "the Arabic name and head office must resolve, or the placeholder is a trap",
  );

  // ── Every catalogued placeholder must actually print something ─────────────────────────────
  // The designer's picker shows the real value beside each entry, produced by this same builder, so
  // an entry that resolves to "" lists as a placeholder with nothing next to it — indistinguishable
  // on screen from one that is broken — and prints as a hole in the letter. `initials` is the one
  // worth naming: it is derived from the name rather than typed, so a change to how it is built is
  // exactly the kind of edit that quietly starts returning an empty string.
  for (const placeholder of OFFER_PLACEHOLDERS) {
    const value = tokens[placeholder.key];
    assert.ok(
      typeof value === "string" && value.trim() !== "",
      `{{${placeholder.key}}} resolves to nothing on a fully filled offer — it would print as a hole ` +
        "in the letter, and list in the designer's picker with no example beside it",
    );
  }
}
