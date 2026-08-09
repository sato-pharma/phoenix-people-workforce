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

    // Order matters, and it REVERSED on 2026-08-01.
    //
    // This assertion used to require the opposite — supersede AFTER the upsert, so the alias was
    // never momentarily unresolvable. That was correct only while two active rows could coexist.
    // Migration 20260801112000_territory_alias_single_active_target added
    // UNIQUE (normalized_alias, target_type) WHERE active, and from that moment the upsert that was
    // supposed to run first is the very statement the index rejects:
    //   "duplicate key value violates unique constraint ... (beiala elhamol, brick) already exists"
    // The supersede could then never run, because the statement it followed had already thrown.
    // Re-pointing any alias with an existing active target became impossible from the UI.
    assert.ok(
      fn.indexOf('.neq("target_code", code)') < fn.indexOf(".upsert("),
      "supersede must run BEFORE the upsert — the partial unique index rejects a second active row, " +
        "so an upsert-first order can never reach the supersede at all",
    );
  }

  // ── 1b. The BULK save path supersedes too ──────────────────────────────────
  // saveMappings writes the same table from the import mapping screen, and had no supersede at all.
  // That is the path the owner actually hit: every attempt to save a territory whose alias already
  // pointed somewhere failed outright, so the screen could not be cleared and the import was stuck.
  {
    const mapping = read("src/lib/sales/normalizer/mapping.ts");
    const start = mapping.indexOf("if (territoryRows.length)");
    assert.ok(start >= 0, "saveMappings must still write territory aliases");
    const block = mapping.slice(start, start + 1600);

    assert.match(
      block,
      /\.update\(\{ active: false \}\)/,
      "the bulk save must deactivate the previous active target, or re-pointing an alias throws",
    );
    assert.match(
      block,
      /\.in\("normalized_alias", territoryKeys\)/,
      "supersede the whole batch in one statement — one round trip per alias crosses the Atlantic each time",
    );
    assert.ok(
      block.indexOf(".update({ active: false })") < block.indexOf(".upsert("),
      "the bulk supersede must run BEFORE the upsert, same as the single-alias path",
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
