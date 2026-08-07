import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Spec B2 — Arabic-safe search over the customer directory.
//
// Egyptian pharmacy names are written with inconsistent orthography, so the form a rep TYPES
// rarely matches the form a distributor STORED. Before this was fixed, reps hand-typed pharmacy
// names because searching genuinely did not find them — which is the root cause of the phantom
// pharmacies the whole module exists to stop.
//
// The rule lives in SQL, not TypeScript: `phx_normalize_arabic` and `phx_search_direct_order_customers`.
// The harness cannot execute Postgres, so this locks the migration's TEXT. That is a weaker
// instrument than running the function, and it is chosen deliberately — the alternative is
// re-implementing the folds in TypeScript and asserting against the copy, which would pass
// happily while production searched with different rules.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION = "../supabase/migrations/20260804183000_direct_order_customer_directory_search.sql";
const SPACE_FOLD_MIGRATION = "../supabase/migrations/20260807120000_direct_order_search_arabic_space_fold.sql";
const TRIGRAM_REINDEX_MIGRATION =
  "../supabase/migrations/20260807120100_direct_order_search_arabic_trigram_reindex.sql";

export function runDirectOrdersArabicSearchTests() {
  const sql = readFileSync(new URL(MIGRATION, import.meta.url), "utf8");
  const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");

  // ── The normalizer exists, and is IMMUTABLE ────────────────────────────────
  // Not a style preference: the index at the bottom of the migration is built on a call to this
  // function, and Postgres refuses to index a non-IMMUTABLE expression. Losing the marker turns a
  // 51k-row type-ahead into a sequential scan on every keystroke.
  {
    assert.match(
      sql,
      /create or replace function public\.phx_normalize_arabic\(p_text text\)/,
      "the Arabic normalizer must exist — a raw ILIKE missed 64% of real matches",
    );
    const fnStart = sql.indexOf("create or replace function public.phx_normalize_arabic");
    const fnBody = sql.slice(fnStart, sql.indexOf("$$;", fnStart));
    assert.match(fnBody, /\bimmutable\b/, "the normalizer must be IMMUTABLE or the search index cannot be built on it");
  }

  // ── Every fold the owner's data actually needs ─────────────────────────────
  // One assertion per letter family, so a failure names the family that broke rather than
  // reporting "the regex changed".
  {
    const folds: Array<{ family: string; chars: string[]; to: string }> = [
      { family: "alef (hamza-above, hamza-below, madda, wasla)", chars: ["أ", "إ", "آ", "ٱ"], to: "\\0627" },
      { family: "ta-marbuta → ha", chars: ["ة"], to: "\\0647" },
      { family: "alef-maqsura and ya-hamza → ya", chars: ["ى", "ئ"], to: "\\064A" },
    ];
    for (const fold of folds) {
      for (const char of fold.chars) {
        assert.ok(
          sql.includes(char),
          `the ${fold.family} fold must still cover U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
        );
      }
      assert.ok(
        sql.includes(`U&'${fold.to}'`),
        `the ${fold.family} fold must still write its replacement as a codepoint escape, never a literal glyph`,
      );
    }
  }

  // ── The bug that made a broken search look like a working one ──────────────
  // A wider harakat class such as [ؐ-ً] swallows the Arabic LETTERS at 0621..063A. The
  // probe then normalized to the EMPTY string, `ilike '%%'` matched all 51,192 rows, and the
  // search returned a full page of results for any input — indistinguishable, on screen, from
  // working. This is the module's recurring failure shape: succeeding loudly while doing nothing.
  {
    const strip = /'\[([^']*)\]\+', '', 'g'/.exec(sql);
    assert.ok(strip, "the harakat/tatweel strip must still be a single explicit character class");
    const cls = strip[1];
    for (const letter of ["ء", "ا", "ب", "غ"]) {
      const cp = `U+${letter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
      assert.ok(
        !cls.includes(letter),
        `the strip class must NOT contain the Arabic letter ${cp}: swallowing letters empties the probe, and an empty probe matches EVERY row while looking like a working search`,
      );
    }
    for (const mark of ["ً", "ْ", "ٰ", "ـ"]) {
      assert.ok(
        cls.includes(mark),
        `the strip class must still drop U+${mark.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} — a stray haraka or tatweel otherwise defeats the whole comparison`,
      );
    }
  }

  // ── A customer with no name must be reachable, not hidden ──────────────────
  // 6,089 of 51,192 directory rows have no name at all. Matching on the name alone made them
  // unreachable by ANY query — including by the distributor's own code, which is the one thing the
  // rep is holding when they call.
  {
    assert.match(sql, /m\.customer_code ilike p\.raw \|\| '%'/, "the search must match the customer CODE, not the name alone");
    assert.match(
      sql,
      /\(h\.customer_name is not null\) desc/,
      "an unnamed customer must be RANKED DOWN, never filtered out — it is still the right pharmacy",
    );
    assert.doesNotMatch(
      sql,
      /where[\s\S]{0,400}customer_name is not null/,
      "no WHERE clause may drop unnamed customers again — that is what made 6,089 rows unreachable",
    );
  }

  // ── Both birth paths, or the drop list lies ────────────────────────────────
  // Owner rule, 2026-08-04: "when any new pharmacy is added any way into Phoenix, the drop list is
  // updated." A pharmacy can be born in the SoS directory OR in direct_order_pharmacies, and
  // neither table writes the other. Searching one means a pharmacy someone just registered is
  // missing from the list that exists to stop people typing it by hand.
  {
    assert.match(sql, /from public\.source_of_sales_customer_map m/, "the SoS customer directory must be searched");
    assert.match(sql, /from public\.direct_order_pharmacies ph/, "pharmacies registered in Phoenix must be searched too");
    assert.match(sql, /union all/, "both sources must be UNIONed, not chosen between");
    assert.match(
      sql,
      /left join public\.direct_order_pharmacy_distributor_codes/,
      "the distributor-code join must be a LEFT JOIN: a pharmacy registered with no code must still be findable by name",
    );
  }

  // ── The catalogue must not be enumerable from a browser ────────────────────
  // SECURITY INVOKER on purpose — DEFINER would hand a company-wide customer list to anyone who
  // could reach the function, since the area scope is applied by the service on the way out, not
  // by the function. And REVOKE FROM PUBLIC strips service_role when it holds only the default
  // ACL, so the explicit GRANTs are load-bearing rather than decorative.
  {
    assert.match(sql, /security invoker/, "the search must stay SECURITY INVOKER — DEFINER exposes the whole catalogue");
    assert.doesNotMatch(sql, /security definer/, "the search must never become SECURITY DEFINER");
    assert.match(sql, /revoke all on function public\.phx_search_direct_order_customers/, "the function must be revoked from PUBLIC");
    assert.match(
      sql,
      /grant execute on function public\.phx_search_direct_order_customers\(text, text, int\) to service_role/,
      "service_role must be re-granted explicitly — REVOKE FROM PUBLIC strips it when it held only the default ACL",
    );
    assert.match(
      sql,
      /grant execute on function public\.phx_normalize_arabic\(text\) to service_role/,
      "the normalizer needs its own grant — the search calls it, and a missing grant fails at query time, not at deploy",
    );
  }

  // ── The service must go THROUGH the normalizing function ───────────────────
  // A raw ILIKE anywhere in the reader would silently bypass every fold above: the tests would
  // still pass, and the search would be back to missing 64% of matches.
  {
    const readerIdx = serviceSource.indexOf("export async function searchDirectOrderPharmacyDirectory(");
    assert.ok(readerIdx > -1, "searchDirectOrderPharmacyDirectory must still be the search entrypoint");
    // Wide enough to reach the scope filter, which is the LAST statement in the function.
    const reader = serviceSource.slice(readerIdx, serviceSource.indexOf("\nexport ", readerIdx + 1));
    assert.match(
      reader,
      /\.rpc\("phx_search_direct_order_customers"/,
      "the search must call the normalizing RPC — a raw ILIKE here silently undoes every fold in the migration",
    );
    assert.match(
      reader,
      /allowedAreaCodes\.has\(hit\.areaCode\.toUpperCase\(\)\)/,
      "the caller's AREA scope must be re-applied to the returned rows — the SQL function deliberately does not apply it",
    );
  }

  // ── Whitespace must be folded, not just letter forms (2026-08-07) ─────────
  // A real, active, 42-invoice customer (PS/0001556836) was unreachable through this exact search
  // because the stored name is one word ("ابوالفتوح") and a rep typed it as two ("ابو الفتوح").
  // Proven live against production before this migration: the OLD normalizer left both sides with a
  // surviving space mismatch, so the ILIKE substring check returned false — a real customer,
  // findable by nothing, is indistinguishable on screen from a customer that was never in the
  // directory.
  {
    const spaceFoldSql = readFileSync(new URL(SPACE_FOLD_MIGRATION, import.meta.url), "utf8");
    assert.match(
      spaceFoldSql,
      /create or replace function public\.phx_normalize_arabic\(p_text text\)/,
      "the space-fold migration must replace the same function, not fork a second normalizer",
    );
    const fnStart = spaceFoldSql.indexOf("create or replace function public.phx_normalize_arabic");
    const fnBody = spaceFoldSql.slice(fnStart, spaceFoldSql.indexOf("$$;", fnStart));
    assert.match(fnBody, /\bimmutable\b/, "the normalizer must stay IMMUTABLE or the search index cannot be built on it");
    assert.match(
      fnBody,
      /'\\s\+', '', 'g'/,
      "whitespace must be stripped ENTIRELY (not collapsed) — a stored one-word name and a typed two-word name must normalize identically",
    );
    assert.match(
      spaceFoldSql,
      /reindex index public\.source_of_sales_customer_map_norm_name_idx/,
      "the expression index built on this function must be reindexed — CREATE OR REPLACE FUNCTION does not recompute it",
    );
    const trigramReindexSql = readFileSync(new URL(TRIGRAM_REINDEX_MIGRATION, import.meta.url), "utf8");
    assert.match(
      trigramReindexSql,
      /reindex index public\.source_of_sales_customer_map_name_trgm_idx\s*;/,
      "the trigram expression index must also be rebuilt — stale normalized keys can return results using the old spacing rules",
    );
  }
}
