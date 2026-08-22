import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extraDirectOrderAreaCodes } from "@/lib/direct-orders/extra-area-grants";

// ─────────────────────────────────────────────────────────────────────────────
// Extra Direct Orders areas — the grant must WIDEN one module and nothing else.
//
// The owner's instruction (2026-08-19) was explicit: let Salim Gomaa raise a direct order in
// Alex-BHR, and change nothing else. The tempting fix — re-pointing AB1-AB5 at his seat in
// `au.line_area_map` — is exactly what "nothing else" rules out: that unique index allows one
// district manager per area, so it would have taken Alex-BHR off Sara Samir's seat and moved her
// sales attribution, targets, incentive scope and approval chain with it.
//
// So the grant lives outside the seat map, and these assertions are what keep it there. The blast
// radius is the point of this file, not the five area codes.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrdersExtraAreaGrantTests() {
  const grantSource = readFileSync(new URL("../src/lib/direct-orders/extra-area-grants.ts", import.meta.url), "utf8");
  const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");

  // ── The grant itself ───────────────────────────────────────────────────────
  {
    assert.deepEqual(
      [...extraDirectOrderAreaCodes("B-76")].sort(),
      ["AB1", "AB2", "AB3", "AB4", "AB5"],
      "Salim Gomaa (B-76) must hold the five Alex-BHR areas the owner asked for",
    );
    assert.deepEqual([...extraDirectOrderAreaCodes("b-76")].sort(), ["AB1", "AB2", "AB3", "AB4", "AB5"]);
    assert.deepEqual([...extraDirectOrderAreaCodes("  B-76  ")].sort(), ["AB1", "AB2", "AB3", "AB4", "AB5"]);
  }

  // ── Everyone else is untouched ─────────────────────────────────────────────
  // A grant that leaked to another id would hand someone a district they were never given, and
  // Direct Orders' pharmacy and customer search both bound on this same set.
  {
    for (const other of ["B-156", "B-12", "AI-0001", "AI-0007", "B-1", "", "   ", null, undefined]) {
      assert.equal(
        extraDirectOrderAreaCodes(other).size,
        0,
        `${JSON.stringify(other)} must get no extra areas — only ids listed by hand are granted`,
      );
    }
  }

  // ── A caller cannot mutate the grant through the returned set ──────────────
  {
    const first = extraDirectOrderAreaCodes("B-76");
    first.add("CA1");
    assert.ok(
      !extraDirectOrderAreaCodes("B-76").has("CA1"),
      "each call must return a fresh set — a shared one would let any caller widen the grant for the whole process",
    );
  }

  // ── It widens, never replaces ──────────────────────────────────────────────
  // If the extra codes were assigned INTO areaCodesInScopeOverride instead of unioned in the
  // filter, a granted person would see the extra areas and lose their own seat's areas.
  {
    const fnIdx = serviceSource.indexOf("export async function listDirectOrderAreaAndBrickOptions(");
    assert.ok(fnIdx > -1, "listDirectOrderAreaAndBrickOptions must still be the single scope point");
    // Slice to the END of the function, not a fixed byte count. A magic window measures source
    // LENGTH rather than the invariant: it false-FAILS once the function grows past it, and
    // false-PASSES by spilling into the next declaration's copy of the marker.
    const rest = serviceSource.slice(fnIdx + 1);
    const nextDecl = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
    const fn = serviceSource.slice(fnIdx, nextDecl >= 0 ? fnIdx + 1 + nextDecl : serviceSource.length);

    assert.match(
      fn,
      /if \(extraAreaCodes\.has\(areaCode\)\) return true;/,
      "the extra codes must be an early-return union inside the area filter",
    );
    assert.match(
      fn,
      /areaCodesInScopeOverride\s*\n?\s*\?\s*areaCodesInScopeOverride\.has\(areaCode\)/,
      "the seat bound must still be evaluated for every area the grant does not cover",
    );
    assert.ok(
      !/areaCodesInScopeOverride\s*=\s*extraAreaCodes/.test(fn),
      "the grant must never be assigned into the seat bound — that would replace the person's own areas instead of adding to them",
    );
  }

  // ── Bricks follow the areas, so a new brick needs no edit here ─────────────
  {
    assert.ok(
      !/brick/i.test(grantSource.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
      "the grant must list AREA codes only — bricks are derived from the granted areas, so listing them would go stale the first time a brick is added",
    );
  }

  // ── Direct Orders ONLY — this is the owner's 'change nothing else' rule ────
  // Made mechanical: exactly one module may import the grant. Sales, targets, incentives, the
  // organogram and the approval chain must keep reading the seat map alone.
  {
    const importers = [
      "src/lib/direct-orders/service.ts",
      "src/lib/sales/access-scope.ts",
      "src/lib/sales/seat-area-scope.ts",
      "src/lib/sales/portal-targets.ts",
      "src/lib/incentives/scheme-2026.ts",
      "src/lib/marketing-requests/service.ts",
    ].map((path) => {
      let source = "";
      try {
        source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      } catch {
        source = "";
      }
      return { path, imports: source.includes("direct-orders/extra-area-grants") };
    });

    const actual = importers.filter((entry) => entry.imports).map((entry) => entry.path);
    assert.deepEqual(
      actual,
      ["src/lib/direct-orders/service.ts"],
      "only the Direct Orders service may read the grant — anywhere else and it stops being a Direct Orders exception and starts moving sales, targets or incentives",
    );
  }
}
