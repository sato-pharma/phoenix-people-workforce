import { strict as assert } from "node:assert";

import {
  defaultOfferTemplateId,
  findOfferJobTitle,
  offerTemplateIdForTitle,
} from "../src/lib/offers/template-choice.ts";
import type { OfferJobTitle, OfferTemplate } from "../src/lib/offers/types.ts";

/**
 * Binding a letter design to a job title.
 *
 * The owner asked for templates "savable per role". Everything else that varies by role already
 * lived on the job title — cost of living, reporting line, contract term — and choosing the title
 * on the offer form filled all three. The design did not follow, so every offer opened on whichever
 * template happened to hold `is_default` and whoever was writing it had to remember to switch.
 *
 * These are the four ways that binding can go wrong, each of which produces a plausible-looking
 * letter rather than an error:
 *
 *   1. the lookup disagreeing with the database's own unique index, so a title that certainly
 *      exists resolves to nothing and the binding silently never applies;
 *   2. an unbound title RESETTING a design somebody deliberately chose;
 *   3. a binding to a deleted template selecting a dead id, which renders a `<select>` blank — it
 *      reads as "no design" while meaning "a design you cannot see";
 *   4. a workspace with no `is_default` row rendering nothing at all.
 */
export function runOfferTitleTemplateTests() {
  const template = (id: string, name: string, isDefault: boolean): OfferTemplate =>
    ({ id, isDefault, name }) as unknown as OfferTemplate;

  const jobTitle = (title: string, templateId: string | null): OfferJobTitle => ({
    active: true,
    contractTerm: null,
    costOfLiving: 0,
    id: `jt-${title}`,
    reportsTo: null,
    templateId,
    title,
  });

  const TEMPLATES = [
    template("tpl-classic", "SATO Offer", true),
    template("tpl-exec", "SATO Executive Offer", false),
  ];

  const CATALOGUE = [
    jobTitle("District Sales Manager", "tpl-exec"),
    jobTitle("Medical Representative", null),
    jobTitle("Product Manager", "tpl-deleted"),
  ];

  // ── 1. The lookup must agree with the catalogue's unique index ─────────────────────────────
  // The database stores titles under `lower(btrim(title))` and REFUSES to hold two rows that differ
  // only by case or padding. A lookup stricter than that constraint would find nothing for a title
  // the database is certain exists, and the binding would appear to be ignored.
  assert.equal(
    findOfferJobTitle("  district sales manager ", CATALOGUE)?.title,
    "District Sales Manager",
    "the title lookup must normalise case and padding the same way the unique index does",
  );
  assert.equal(findOfferJobTitle("Regional Manager", CATALOGUE), null, "an unlisted title has no row");
  assert.equal(findOfferJobTitle("   ", CATALOGUE), null, "a blank title must not match the first row");

  // ── 2. A bound title resolves to its design ────────────────────────────────────────────────
  assert.equal(
    offerTemplateIdForTitle("District Sales Manager", CATALOGUE, TEMPLATES),
    "tpl-exec",
    "a title bound to a live template must resolve to it",
  );
  assert.equal(
    offerTemplateIdForTitle("  DISTRICT SALES MANAGER", CATALOGUE, TEMPLATES),
    "tpl-exec",
    "the binding must survive the same normalisation as the lookup",
  );

  // ── 3. "No answer" is null, and null must never mean "the default" here ────────────────────
  // This is the distinction the composer depends on. It reads null as LEAVE IT ALONE, so returning
  // the default's id for an unbound title would silently overwrite a design somebody chose on
  // purpose — every time they corrected a typo in the title field.
  assert.equal(
    offerTemplateIdForTitle("Medical Representative", CATALOGUE, TEMPLATES),
    null,
    "an unbound title must answer null, not the default's id — the caller decides what null means",
  );
  assert.equal(
    offerTemplateIdForTitle("Regional Manager", CATALOGUE, TEMPLATES),
    null,
    "a title outside the catalogue must answer null",
  );

  // ── 4. A binding to a template that no longer exists ───────────────────────────────────────
  // The database clears these itself with ON DELETE SET NULL, but a screen holding a list loaded
  // before the deletion would put the dead id into the picker, and a select whose value matches no
  // option renders EMPTY — indistinguishable on screen from "no design chosen".
  assert.equal(
    offerTemplateIdForTitle("Product Manager", CATALOGUE, TEMPLATES),
    null,
    "a binding to a template that is gone must resolve to null, never to the dead id",
  );

  // ── 5. The default ─────────────────────────────────────────────────────────────────────────
  assert.equal(defaultOfferTemplateId(TEMPLATES), "tpl-classic", "the flagged template is the default");
  assert.equal(
    defaultOfferTemplateId([template("tpl-a", "A", false), template("tpl-b", "B", false)]),
    "tpl-a",
    "with templates but no flag — possible while the flag is being moved — the first must still render",
  );
  assert.equal(defaultOfferTemplateId([]), "", "no templates at all is the composer's own empty state");
}
