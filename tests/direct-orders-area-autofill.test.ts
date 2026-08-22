import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Spec B3 — the area comes from the CHOSEN customer, by AREA (owner's rule, not brick), and the
// submitter cannot overrule it.
//
// "Auto-fills" undersells what this rule is for. If the client could send an area alongside its
// pharmacy choice, a rep could pick any pharmacy in the country and file it under their own area —
// and every downstream number (per-rep counters, geography attribution, the approval chain built
// from the requester's line) would agree with them. The stored area must therefore be copied from
// the catalogue row server-side, and the request body must carry POINTERS ONLY.
//
// That is why this test spends most of its assertions on what the payload may NOT contain.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slice a top-level declaration out of a source file by its REAL end — the next top-level
 * declaration — instead of a fixed byte count. A magic window measures source LENGTH, not the
 * invariant it claims to guard: it false-FAILS the moment the pinned function grows past the
 * window (the regression fixed in PR #2288), and it false-PASSES when a function that genuinely
 * lost its marker spills into the next function's copy of it.
 */
function topLevelBlock(source: string, start: number): string {
  if (start < 0) return "";
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
  return source.slice(start, next >= 0 ? start + 1 + next : source.length);
}

export function runDirectOrdersAreaAutofillTests() {
  const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const routeSource = readFileSync(
    new URL("../app/api/direct-orders/pharmacies/from-directory/route.ts", import.meta.url),
    "utf8",
  );
  const formSource = readFileSync(
    new URL("../src/components/direct-orders/direct-order-submit-form.tsx", import.meta.url),
    "utf8",
  );

  // ── The route accepts pointers, and only pointers ──────────────────────────
  {
    const bodyType = /body = \(await request\.json\(\)[\s\S]*?\}\);/.exec(routeSource);
    assert.ok(bodyType, "the from-directory route must still parse a typed body");
    const declared = bodyType[0];
    for (const pointer of ["phoenixPharmacyCode", "distributorCode", "customerCode"]) {
      assert.ok(declared.includes(pointer), `the body must still accept the ${pointer} pointer`);
    }
    for (const owned of ["areaCode", "regionCode", "brickId", "pharmacyName", "pharmacyAddress"]) {
      assert.ok(
        !declared.includes(owned),
        `the body must NOT accept ${owned}: a client-supplied area lets a rep file any pharmacy in the country under their own geography, and every downstream number would agree with them`,
      );
    }
  }

  // ── The server copies from the catalogue row, and fails closed ─────────────
  {
    const fnIdx = serviceSource.indexOf("export async function ensureDirectOrderPharmacyFromDirectory(");
    assert.ok(fnIdx > -1, "ensureDirectOrderPharmacyFromDirectory must still be the materialization entrypoint");
    const fn = topLevelBlock(serviceSource, fnIdx);

    assert.match(
      fn,
      /from\("source_of_sales_customer_map"\)[\s\S]{0,240}\.select\([^)]*area_code[^)]*\)/,
      "the area must be SELECTed from the customer map — that row is the source of truth, not the request",
    );
    assert.match(
      fn,
      /if \(!mapRow\) badRequest\(/,
      "a missing catalogue row must fail closed: the UI only offers rows the search returned, so a miss means a stale or forged request",
    );
    assert.match(
      fn,
      /assertPermission\(access, "direct_orders", "create"\)/,
      "materializing a pharmacy is a create, and must be permission-gated before anything is written",
    );
    assert.ok(
      !/input\.areaCode|input\.regionCode|input\.brickId/.test(fn),
      "the function must never read an area, region or brick off its input — the whole point is that the caller does not get to say",
    );
  }

  // ── By AREA, not by brick (the owner said so explicitly) ───────────────────
  // The distinction matters because a brick can be reassigned between areas. Deriving the area
  // from the brick at read time would silently move historical orders when a brick moves; reading
  // the area column keeps the order where it was filed.
  {
    const fnIdx = serviceSource.indexOf("export async function ensureDirectOrderPharmacyFromDirectory(");
    const fn = topLevelBlock(serviceSource, fnIdx);
    assert.match(fn, /area_code/, "the area code must be carried explicitly");
    assert.ok(
      !/areaCode:\s*(?:await\s*)?(?:resolve|lookup|derive)\w*[Bb]rick/.test(fn),
      "the area must not be re-derived from the brick — a brick that moves between areas would silently relocate orders already filed",
    );
  }

  // ── The form sends the pointer, not its own copy of the row ────────────────
  {
    const callIdx = formSource.indexOf('"/api/direct-orders/pharmacies/from-directory"');
    assert.ok(callIdx > -1, "the submit form must still resolve a picked pharmacy through the from-directory route");
    // The picked PATH is the region, bounded by the close of its own `if` branch. The 700-byte
    // window was 300 bytes short of reading into the hand-created path below, which legitimately
    // does send an areaCode — a byte count away from failing on entirely correct code.
    const callEnd = formSource.slice(callIdx).search(/^ {4}\}$/m);
    const call = formSource.slice(callIdx, callEnd >= 0 ? callIdx + callEnd : formSource.length);
    assert.match(call, /phoenixPharmacyCode: pickedHit\.phoenixPharmacyCode/, "the form must send the picked row's Phoenix code");
    assert.ok(
      !/areaCode|regionCode|brickId/.test(call),
      "the form must not send geography with a picked pharmacy — the server owns those fields",
    );
  }

  // ── A picked pharmacy and a hand-created one are different paths ───────────
  // The hand-created path DOES send a brick (the submitter genuinely is telling us where it is,
  // because no catalogue row exists yet) — and that is exactly why it is flagged for review and
  // takes an extra rung. Collapsing the two paths would let the trusted one inherit the untrusted
  // one's freedoms.
  {
    assert.match(
      formSource,
      /if \(pharmacyMode === "picked"\)/,
      "the picked and hand-created paths must stay distinct — one copies from the catalogue, the other is flagged for review",
    );
    const handIdx = formSource.indexOf('"/api/direct-orders/pharmacies"');
    assert.ok(handIdx > -1, "the hand-created path must still exist — refusing it only ever produced an invented code");
    // Bounded by the fetch call's own closing `});` — the body is a list of fields that grows,
    // and a byte count would quietly stop checking below the cut.
    const handEnd = formSource.slice(handIdx).search(/^ {4}\}\);$/m);
    const hand = formSource.slice(handIdx, handEnd >= 0 ? handIdx + handEnd : formSource.length);
    assert.match(
      hand,
      /areaCode: selectedBrick\?\.areaCode/,
      "the hand-created path derives its area from the chosen brick, and is flagged for review precisely because nobody has checked it",
    );
  }
}
