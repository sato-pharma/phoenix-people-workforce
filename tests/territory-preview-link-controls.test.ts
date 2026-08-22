import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Territory Management preview links (owner request, 2026-08-14).
//
// These links are BEARER credentials with NO SECOND FACTOR. The Direct Orders live link demands a
// passcode; the owner asked for this one to be open — "no password or username, normal access". So
// every control that remains is load-bearing, and this file is what stops a later session from
// quietly relaxing one of them because "it's only a map".
//
// Four things must stay true:
//   1. Only a Super Admin who may EXPORT can publish one, checked before the database is touched.
//   2. Expiry is unavoidable, defaults to the owner's 14 days, and is capped SHORTER than the
//      passcode-protected report link's window.
//   3. The area list is frozen at creation and every read is intersected against it, so a forged
//      area code reaches nothing and a promotion cannot widen a link already sent.
//   4. The internal analysis is projected OUT IN THE DOMAIN, not hidden in the UI — and the line
//      the link is pinned to is never disclosed, which is what the owner explicitly asked for.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Comments describe the controls in prose, so a naive whole-file search for "residence" would match
 * the paragraph explaining why residence data is excluded and pass while the code leaked it. Every
 * leak assertion below runs against CODE ONLY.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}

/** Handles both the multi-line types and the single-line ones — `\n};` would miss the latter. */
function typeBlock(source: string, name: string): string {
  const start = source.indexOf(`export type ${name} = {`);
  assert.ok(start > -1, `the ${name} type must still exist`);
  const end = source.indexOf("};", start);
  assert.ok(end > start, `the ${name} type must be a closed block`);
  return source.slice(start, end + 2);
}

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

export function runTerritoryPreviewLinkControlsTests() {
  const here = import.meta.url;
  const domain = readFileSync(new URL("../src/lib/territory-management/preview-links.ts", here), "utf8");
  const filtersRoute = readFileSync(new URL("../app/api/share/territory/[token]/filters/route.ts", here), "utf8");
  const mapRoute = readFileSync(new URL("../app/api/share/territory/[token]/map/route.ts", here), "utf8");
  const sharePage = readFileSync(new URL("../app/share/territory/[token]/page.tsx", here), "utf8");
  const shareView = readFileSync(new URL("../src/components/territory-management/shared-territory-view.tsx", here), "utf8");
  const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", here), "utf8");
  const reportLinks = readFileSync(new URL("../src/lib/direct-orders/report-share-links.ts", here), "utf8");

  const flat = domain.replace(/\s+/g, " ");
  const code = stripComments(domain);

  // ── 1. Publishing is gated on EXPORT + Super Admin, before any read ─────────
  // Gating on read would mean anyone who can OPEN the map can publish it to the internet. The
  // Super Admin check on top mirrors this module's only other privileged act (moving a brick pin).
  {
    assert.match(
      flat,
      /async function assertMayPublish\(access: AccessContext\): Promise<void> \{ await assertPermission\(access, "sales", "export"\); if \(access\.role !== "Super Admin"\)/,
      "publishing must assert sales:export AND Super Admin — a public link is the strongest export there is",
    );

    for (const fn of [
      "createTerritoryPreviewLink",
      "listTerritoryPreviewLinks",
      "revokeTerritoryPreviewLink",
    ]) {
      const idx = domain.indexOf(`export async function ${fn}(`);
      assert.ok(idx > -1, `${fn} must still exist`);
      const body = topLevelBlock(domain, idx);
      const gateAt = body.indexOf("await assertMayPublish(access);");
      assert.ok(gateAt > -1, `${fn} must call assertMayPublish`);
      const dbAt = body.search(/getSupabaseAdmin\(\)|loadTerritoryFilters\(/);
      assert.ok(
        dbAt === -1 || gateAt < dbAt,
        `${fn} must check the permission BEFORE it touches the database`,
      );
    }
  }

  // ── 1b. There is NO passcode, and that is the owner's decision ─────────────
  // The mirror image of the Direct Orders rule that its live link MUST carry one. He asked for
  // "no password or username, normal access", so a future session tightening this back into a
  // passcode gate would be undoing the feature, not hardening it — and would silently break every
  // link already sent. If the decision is ever reversed, it gets reversed here first, deliberately.
  {
    assert.ok(
      !/passcode_hash/.test(code),
      "a preview link must store no passcode hash — open access is what the owner asked for",
    );
    assert.ok(
      !/timingSafeEqual/.test(code),
      "there is no secret to compare on a preview link; a constant-time compare here means a gate was reintroduced",
    );
    assert.match(
      code,
      /hasPasscode: false/,
      "the audit record must state plainly that this link carries no passcode, so the trail shows what was published",
    );
  }

  // ── 2. Expiry is mandatory, defaulted to 14, and capped shorter than 180 ────
  {
    assert.match(flat, /const DEFAULT_EXPIRY_DAYS = 14;/, "the owner set the default at 14 days (two weeks)");
    assert.match(flat, /const MAX_EXPIRY_DAYS = 90;/, "the cap must stay 90 days");
    assert.match(
      flat,
      /Math\.min\( Math\.max\(Math\.floor\(Number\(input\.expiresInDays\) \|\| DEFAULT_EXPIRY_DAYS\), 1\), MAX_EXPIRY_DAYS, \)/,
      "expiry must be clamped to [1, MAX] with the default applied first — no caller may mint a link that never expires",
    );
    assert.match(flat, /expires_at: expiresAt,/, "every created link must be written with an expiry");
    assert.ok(
      !/expires_at:\s*null/.test(domain),
      "no branch may write a null expiry — mandatory means there is no way to opt out",
    );

    // The cross-file invariant that encodes WHY this window is shorter: that link has a passcode,
    // this one does not. If someone raises this cap to match, the reasoning has been lost.
    const reportCap = Number(/const MAX_EXPIRY_DAYS = (\d+);/.exec(reportLinks)?.[1] ?? 0);
    assert.ok(reportCap > 0, "the Direct Orders report link must still declare a cap to compare against");
    assert.ok(
      90 < reportCap,
      `a passwordless link must expire sooner than the passcode-protected report link (90 vs ${reportCap})`,
    );
  }

  // ── 3. Revoked and expired links are refused in ONE liveness gate ───────────
  {
    const idx = domain.indexOf("export async function assertTerritoryPreviewToken(");
    assert.ok(idx > -1, "assertTerritoryPreviewToken must remain the single liveness check");
    const gate = topLevelBlock(domain, idx);
    assert.match(gate, /if \(link\.revoked_at\) throw forbiddenError\(/, "a revoked link must be refused");
    assert.match(
      gate,
      /if \(new Date\(str\(link\.expires_at\)\)\.getTime\(\) < Date\.now\(\)\) throw forbiddenError\(/,
      "an expired link must be refused",
    );
    assert.match(
      gate,
      /if \(!row\) throw notFoundError\("Link not found\."\)/,
      "an unknown token must answer 'not found' — a probing caller must learn nothing about which tokens exist",
    );

    // Both public entry points must go through it, so they cannot drift on what counts as live.
    for (const fn of ["loadTerritoryPreviewFilters", "loadTerritoryPreviewArea"]) {
      const body = domain.slice(domain.indexOf(`export async function ${fn}(`), domain.indexOf(`export async function ${fn}(`) + 700);
      assert.match(
        body,
        /const link = await assertTerritoryPreviewToken\(token\);/,
        `${fn} must resolve the token through the shared liveness gate`,
      );
    }

    assert.match(
      flat,
      /randomBytes\(32\)\.toString\("base64url"\)/,
      "the token must stay 32 random bytes — with no passcode it is the entire credential",
    );
  }

  // ── 4. The frozen area list is the containment ──────────────────────────────
  {
    const createIdx = domain.indexOf("export async function createTerritoryPreviewLink(");
    const create = topLevelBlock(domain, createIdx);
    assert.match(
      create,
      /const filters = await loadTerritoryFilters\(lineCode, access\);/,
      "the creator's own scope must be resolved at creation — this is what bounds the link forever",
    );
    assert.match(create, /area_codes: areaCodes,/, "the literal area codes must be frozen onto the row");
    assert.match(
      create,
      /if \(areaCodes\.length === 0\)/,
      "a creator with no territory must not be able to mint a link that would show nothing",
    );

    // The read path must never re-derive the scope: the link would then widen on promotion and
    // break on demotion, neither of which the person who sent it agreed to.
    assert.ok(
      !/resolveTerritoryScope/.test(code),
      "the read path must NEVER re-resolve the creator's scope — the frozen area_codes list is the only boundary",
    );

    const areaIdx = domain.indexOf("export async function loadTerritoryPreviewArea(");
    const areaFn = topLevelBlock(domain, areaIdx);
    const guardAt = areaFn.indexOf("link.areaCodes.has(requested.toUpperCase())");
    const loadAt = areaFn.indexOf("loadTerritoryMap(");
    assert.ok(guardAt > -1, "the requested area must be intersected against the link's frozen list");
    assert.ok(
      loadAt > guardAt,
      "the intersection must happen BEFORE any geography is read — otherwise a forged area code is loaded and then merely not returned",
    );
    assert.match(
      areaFn,
      /throw notFoundError\("Not found: that area is not part of this link\."\)/,
      "an area outside the link must answer 'not found', not silently return empty",
    );

    assert.match(
      domain.slice(domain.indexOf("export async function loadTerritoryPreviewFilters(")),
      /link\.areaCodes\.has\(area\.areaCode\.trim\(\)\.toUpperCase\(\)\)/,
      "the filter list must be narrowed to the frozen areas, so a later-granted area never appears in an already-sent link",
    );
  }

  // ── 5. The internal analysis never enters the payload ───────────────────────
  // The admin module's findings — where a rep should live, which bricks look mis-assigned, the
  // route/span/gap kilometres, the coverage tiles — are management analysis, not something to hand
  // an anonymous reader. Hiding them in the UI would still ship them in the JSON, so they are
  // stripped in the DOMAIN. These assertions run against code with comments removed.
  {
    for (const leaked of ["residence", "orphans", "overlaps", "mstKm", "spreadKm", "meanPairKm", "hull", "coverage", "confidence"]) {
      assert.ok(
        !new RegExp(leaked).test(code),
        `the preview domain must not reference '${leaked}': the public payload is brick pins only, ` +
          "and a field referenced here is a field an anonymous caller can read",
      );
    }
    assert.ok(
      !/return \{\s*\.\.\.map/.test(code),
      "the map result must be projected field by field, never spread wholesale — a spread republishes every future field the analysis gains",
    );

    const brick = typeBlock(domain, "PreviewBrick");
    assert.deepEqual(
      [...brick.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((match) => match[1]).sort(),
      ["blockCode", "brickId", "brickName", "lat", "lng"],
      "a published brick is a name, a block and a position — nothing else",
    );

    // Unlocated bricks are still LISTED. On a map an unplotted brick is indistinguishable from one
    // nobody covers, so dropping them would invent gaps that are not real and hide ones that are.
    const areaType = typeBlock(domain, "PreviewAreaBricks");
    assert.match(areaType, /unlocated:/, "bricks with no pin must still be returned, never silently dropped");
    assert.match(shareView, /area\.unlocated\.map/, "the page must render the unplaced bricks rather than hide them");
    assert.ok(
      !/reason/.test(stripComments(areaType)),
      "the internal geocoding reason must stay internal — 'no confirmed location' is the honest part, the rest is our own data-quality bookkeeping",
    );
  }

  // ── 6. The line is pinned server-side and NEVER disclosed ───────────────────
  // The owner's instruction: default it to Pedia, and do not show that the preview is Pedia.
  {
    assert.match(
      flat,
      /export const TERRITORY_PREVIEW_DEFAULT_LINE_CODE = "pedia";/,
      "preview links must stay pinned to Pedia by default",
    );
    for (const name of ["PreviewFilters", "PreviewArea", "PreviewAreaBricks", "PreviewBrick"]) {
      assert.ok(
        !/line/i.test(stripComments(typeBlock(domain, name))),
        `${name} must carry no line field — the viewer is deliberately not told which line this is`,
      );
    }
    for (const [name, source] of [["page", sharePage], ["view", shareView]] as const) {
      for (const disclosure of ["Pedia", "pedia", "CNS", "Anti Infective", "anti_infective", "lineCode", "lineName"]) {
        assert.ok(
          !source.includes(disclosure),
          `the public ${name} must not mention '${disclosure}' — the owner asked that the preview not disclose its line`,
        );
      }
    }
    // No line filter either: the viewer picks a region, then an area, and that is the whole flow.
    assert.match(shareView, /Region/, "the viewer must filter by region");
    assert.match(shareView, /Area/, "the viewer must then filter by area");
  }

  // ── 7. Nothing is cached, nothing is indexed — on EVERY response ────────────
  // A cached or crawled copy outlives the expiry and the switch-off button, and with no passcode
  // those two are the whole of the control.
  {
    for (const [name, route] of [["filters", filtersRoute], ["map", mapRoute]] as const) {
      const responses = route.match(/return NextResponse\.json\(/g) ?? [];
      const noStore = route.match(/"Cache-Control": "no-store, max-age=0"/g) ?? [];
      assert.equal(
        noStore.length,
        responses.length,
        `the ${name} route must send no-store on EVERY response (${responses.length} responses, ${noStore.length} no-store)`,
      );
      const noIndex = route.match(/"X-Robots-Tag": "noindex, nofollow, noarchive"/g) ?? [];
      assert.equal(
        noIndex.length,
        responses.length,
        `the ${name} route must send noindex on every response including the error one — a 404 still tells a crawler the URL exists`,
      );
      assert.ok(
        !/export async function POST\(/.test(route),
        `the ${name} route is a read surface; a public write endpoint here would be a different feature entirely`,
      );
    }

    assert.match(
      sharePage,
      /robots:\s*\{\s*index:\s*false/,
      "the public page itself must declare noindex — a crawled copy would outlive the switch-off button",
    );
  }

  // ── 8. The registry must agree with the code ────────────────────────────────
  // An undeclared public route is indistinguishable from a forgotten one. Declared, it reads as a
  // decision rather than an oversight for a future access sweep to "fix" by putting it behind the
  // login wall this feature exists to bypass.
  {
    assert.match(
      registry,
      /authMode: "public-token", methods: \["GET"\], pattern: "\/api\/share\/territory\/:token\/filters"/,
      "the filters surface must be registered as a declared public-token route",
    );
    assert.match(
      registry,
      /authMode: "public-token", methods: \["GET"\], pattern: "\/api\/share\/territory\/:token\/map"/,
      "the map surface must be registered as a declared public-token route",
    );
    assert.match(
      registry,
      /pattern: "\/api\/territory-management\/preview-links", permission: \{ resource: "sales", action: "export" \}/,
      "the registry must gate the management route on export too, so the route and the domain agree",
    );
  }

  // ── 9. Counting an open must never deny one ────────────────────────────────
  // The WHOLE function is guarded, not just the final write: the read-then-increment lookup is a
  // round trip too, and guarding only the write would let it throw straight out of a legitimate
  // open. This is bookkeeping — a broken counter must not turn a live link into a dead one.
  {
    assert.match(
      code.replace(/\s+/g, " "),
      /async function stampAccess\(linkId: string, countIt: boolean\): Promise<void> \{ try \{/,
      "stampAccess must wrap its entire body in try/catch, so no counter failure can deny a read",
    );
  }
}
