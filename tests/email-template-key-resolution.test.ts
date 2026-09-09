import assert from "node:assert/strict";

import {
  emailTemplateKeys,
  findRowForKey,
  normalizeTemplateKey,
  templateKeyText,
} from "@/lib/email-templates/key-resolution.ts";

type Row = { template_key: string; body_html: string };

/**
 * The retired-alias shadowing regression.
 *
 * `email_templates` carried rows under retired names (`probation`, `resignation`) alongside their
 * modern keys. Both normalize to the same key, so the old `.find()` returned whichever the
 * unordered PostgREST select yielded first — the retired row, which sat earlier in the heap. The
 * admin module always SAVES the modern key, so edits landed on a row nothing read: resignation
 * notices sent on 2026-09-07 still carried the retired row's 2026-05-18 wording. The rows were
 * deleted from production on 2026-09-09; this pins the resolver so a retired name re-entering the
 * table cannot silently win again.
 */
export function runEmailTemplateKeyResolutionTests() {
  // --- The headline: an exact key beats a retired alias, in EITHER row order ----------
  const retired: Row = { template_key: "resignation", body_html: "<p>RETIRED 2026-05-18</p>" };
  const modern: Row = { template_key: "resignation_workflow", body_html: "<p>{{summary}}</p>{{detailsTable}}" };

  assert.equal(
    findRowForKey([retired, modern], "resignation_workflow")?.body_html,
    modern.body_html,
    "a retired alias row listed FIRST must not shadow the exact key — this is the production bug",
  );
  assert.equal(
    findRowForKey([modern, retired], "resignation_workflow")?.body_html,
    modern.body_html,
    "row order must not change which template fires",
  );

  // Same shape for probation, the other row that was live in production.
  const probationRetired: Row = { template_key: "probation", body_html: "<p>RETIRED</p>" };
  const probationModern: Row = { template_key: "probation_workflow", body_html: "<p>MODERN</p>" };
  assert.equal(
    findRowForKey([probationRetired, probationModern], "probation_workflow")?.body_html,
    "<p>MODERN</p>",
    "probation_workflow must resolve to its own row, not the retired `probation` row",
  );

  // --- The alias must still work when it is the ONLY row -----------------------------
  // Deleting the fallback would strand `job_offer`, the one retired name still stored in
  // production, on the built-in default instead of its saved wording.
  assert.equal(
    findRowForKey([{ template_key: "job_offer", body_html: "<p>OFFER</p>" }], "offer")?.body_html,
    "<p>OFFER</p>",
    "a retired alias must still resolve when no exact row exists",
  );
  assert.equal(
    findRowForKey([{ template_key: "probation_tracker", body_html: "<p>T</p>" }], "probation_workflow")?.body_html,
    "<p>T</p>",
    "every alias in the map must still resolve on its own",
  );

  // --- Misses stay misses -------------------------------------------------------------
  assert.equal(findRowForKey([], "general"), null, "an empty table resolves to null, not undefined");
  assert.equal(
    findRowForKey([{ template_key: "leave_request", body_html: "x" }], "general"),
    null,
    "an unrelated row must never stand in for a missing key",
  );

  // --- Text folding: case, spaces and hyphens still count as the exact key -------------
  for (const stored of ["Resignation_Workflow", "resignation-workflow", "  resignation workflow  "]) {
    assert.equal(
      findRowForKey([retired, { template_key: stored, body_html: "<p>FOLDED</p>" }], "resignation_workflow")?.body_html,
      "<p>FOLDED</p>",
      `a stored key written as "${stored}" must count as the exact key, not lose to the alias`,
    );
  }
  assert.equal(templateKeyText("  Leave-Request "), "leave_request", "text folding trims, lowercases and folds separators");
  assert.equal(templateKeyText(null), "", "a null key folds to the empty string, never the word null");

  // --- The alias map may never collide with a real key --------------------------------
  // An alias that IS a live key would make its own template unreachable behind itself.
  for (const key of emailTemplateKeys) {
    assert.equal(
      normalizeTemplateKey(key),
      key,
      `the live key ${key} must normalize to itself — an alias entry has shadowed it`,
    );
  }
  assert.equal(normalizeTemplateKey("nonsense_key"), null, "an unknown key resolves to null");
}
