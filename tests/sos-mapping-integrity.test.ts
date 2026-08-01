import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Two ways a mapping edit could quietly make things worse.
//
// 1. RE-POINTING AN ALIAS BROKE IT. upsertTerritoryAlias upserts with
//    onConflict "normalized_alias,target_type,target_code" — the conflict key includes the TARGET,
//    so pointing an existing alias at a different brick does not conflict, it INSERTS. The alias
//    then has two active rows, and buildAliasIndex deliberately drops an ambiguous alias, so the
//    edit silently makes the alias resolve to NOTHING. Worse than before it was edited, no error.
//
// 2. LAST-WRITE-WINS ON THE EXACT CUSTOMER KEY. customerBrickByKey was the only crosswalk index
//    built without conflict detection, while its canonical-key sibling three lines below has it.
//
// Both are latent in production today (0 duplicate active aliases of 913; 0 exact-key collisions),
// so these are guards rather than repairs — which is exactly when they are cheapest to add.

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const read = (p: string) => code(readFileSync(join(process.cwd(), p), "utf8"));

export function runSosMappingIntegrityTests() {
  // ── 1. Editing an alias supersedes the old target ───────────────────────────
  {
    const mapping = read("src/lib/sales/normalizer/mapping.ts");
    const start = mapping.indexOf("export async function upsertTerritoryAlias");
    assert.ok(start >= 0, "upsertTerritoryAlias must exist");
    const fn = mapping.slice(start, mapping.indexOf("export async function deleteTerritoryAlias"));

    assert.match(
      fn,
      /\.neq\("target_code", code\)/,
      "the upsert must deactivate every OTHER active target for this alias, or the edit adds a second one",
    );
    assert.match(fn, /\.eq\("active", true\)/, "only active rows need superseding");
    assert.match(
      fn,
      /supersedeError/,
      "a failed supersede must surface — leaving two active rows is what breaks the alias",
    );

    // Order matters: upsert first, then deactivate the others. Deactivating first would leave the
    // alias with zero active rows if the upsert then failed.
    assert.ok(
      fn.indexOf(".upsert(") < fn.indexOf('.neq("target_code", code)'),
      "supersede must run AFTER the upsert so the alias is never momentarily unresolvable",
    );
  }

  // ── 2. The exact customer key detects conflicts like its sibling ────────────
  {
    const crosswalks = read("src/lib/sales/normalizer/crosswalks.ts");
    assert.ok(
      !/\n\s*customerBrickByKey\.set\(exactKey, brick\);\n\s*if \(ownerVerified\)/.test(crosswalks),
      "customerBrickByKey must not be a bare last-write-wins set()",
    );
    assert.match(crosswalks, /customerExactConflict/, "exact-key conflicts must be tracked");
    assert.match(
      crosswalks,
      /customerBrickByKey\.delete\(exactKey\)/,
      "an ambiguous exact key must resolve to NOTHING, per the owner's standing rule",
    );
    // The canonical-key sibling must keep its own conflict handling.
    assert.match(crosswalks, /customerCanonConflict/, "the canonical-key conflict guard must remain");
  }
}
