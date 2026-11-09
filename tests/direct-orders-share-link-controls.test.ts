import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Spec D5b / D5c / D5d — the controls on the live report links.
//
// Until this file existed, the word "passcode" appeared NOWHERE in the test suite, and nothing
// asserted expiry, revocation, or the frozen scope. These links are bearer credentials: whoever
// holds the URL is the reader. They serve every direct order the creator can see — pharmacy names,
// doctors, quantities, prices and sales values — to someone with no Phoenix account, and they are
// pasted into WhatsApp and email by design.
//
// Two of the surfaces are deliberately different and must not be made consistent:
//   'live' — a human page. Passcode REQUIRED, so a forwarded URL alone is useless.
//   'feed' — CSV for a Google Sheet's IMPORTDATA. Token-only, because a formula cannot type a
//            passcode; the sheet's own Google sharing is the access control.
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

export function runDirectOrdersShareLinkControlsTests() {
  const source = readFileSync(new URL("../src/lib/direct-orders/report-share-links.ts", import.meta.url), "utf8");
  const liveRoute = readFileSync(
    new URL("../app/api/share/direct-orders/[token]/live/route.ts", import.meta.url),
    "utf8",
  );
  const feedRoute = readFileSync(
    new URL("../app/api/share/direct-orders/[token]/feed/route.ts", import.meta.url),
    "utf8",
  );
  const sharePage = readFileSync(
    new URL("../app/share/direct-orders/[token]/page.tsx", import.meta.url),
    "utf8",
  );
  const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", import.meta.url), "utf8");

  // ── D5d: publishing is gated on EXPORT, not on read ────────────────────────
  // Publishing the report outside the login wall is the strongest form of export. Gating on read
  // would mean anyone who can OPEN the report can publish it to the world — a reader who may not
  // download the file must not be able to hand out a link to it instead.
  {
    for (const fn of [
      "createDirectOrderReportShareLink",
      "listDirectOrderReportShareLinks",
      "revokeDirectOrderReportShareLink",
    ]) {
      const idx = source.indexOf(`export async function ${fn}(`);
      assert.ok(idx > -1, `${fn} must still exist`);
      const body = topLevelBlock(source, idx);
      assert.match(
        body,
        /assertPermission\(access, "direct_orders", "export"\)/,
        `${fn} must be gated on EXPORT, never on read: publishing past the login wall is the strongest export there is`,
      );
      const gateAt = body.indexOf('assertPermission(access, "direct_orders", "export")');
      const writeAt = body.search(/getSupabaseAdmin\(\)/);
      assert.ok(
        writeAt === -1 || gateAt < writeAt,
        `${fn} must check the permission BEFORE it touches the database`,
      );
    }
  }

  // ── D5b: the human link must carry a passcode, and the feed must not ───────
  {
    const createIdx = source.indexOf("export async function createDirectOrderReportShareLink(");
    const create = topLevelBlock(source, createIdx);
    assert.match(
      create,
      /if \(surface === "live" && passcode\.length < 4\)/,
      "a live link must REQUIRE a passcode: optional would make the safe choice the one needing extra effort, which is how a link ends up naked in a group chat",
    );
    assert.match(
      create,
      /passcode_hash: surface === "live" \? hashPasscode\(passcode, token\) : null/,
      "the passcode must be stored as a hash, and only for the human surface",
    );
  }

  // ── D5b: the passcode travels in the BODY, never the URL ───────────────────
  // A passcode in a query string lands in browser history, the Referer header, and every proxy log
  // between here and the reader. It would look protected while leaking — worse than no passcode,
  // because it invites trust.
  {
    assert.match(liveRoute, /export async function POST\(/, "the live link must be served over POST");
    assert.ok(
      !/export async function GET\(/.test(liveRoute),
      "the live link must not expose a GET: a passcode in the query string leaks to history, referrers and proxy logs",
    );
    assert.match(
      liveRoute,
      /body\.passcode/,
      "the passcode must be read from the request BODY",
    );
    assert.ok(
      !/searchParams\.get\(['"]passcode['"]\)/.test(liveRoute),
      "the passcode must never be read from the query string",
    );
  }

  // ── D5b: the compare is constant-time, salted per link, and slow ───────────
  {
    const passcodeHash = readFileSync(new URL("../src/lib/share-links/passcode-hash.ts", import.meta.url), "utf8");
    assert.match(
      source,
      /import \{ hashPasscode, passcodeMatches \} from "@\/lib\/share-links\/passcode-hash";/,
      "the link reads its passcode hash from the one shared module",
    );
    assert.match(
      passcodeHash,
      /timingSafeEqual/,
      "the passcode compare must be constant-time — a length-varying compare leaks the prefix to a patient caller",
    );
    assert.match(
      passcodeHash,
      /scryptSync\(`\$\{token\}:\$\{passcode\.trim\(\)\}`, salt, SCRYPT_KEY_LENGTH\)/,
      "a new passcode is a slow scrypt hash, still salted with the token so two links sharing a passcode do not share a hash",
    );
  }

  // ── D5c: mandatory expiry, defaulted and capped ────────────────────────────
  // Not "expiry is offered" — expiry is unavoidable. There is no branch that mints a link without
  // one, so a forgotten link stops working on its own.
  {
    assert.match(source, /const MAX_EXPIRY_DAYS = 180;/, "the expiry cap must stay 180 days");
    assert.match(source, /const DEFAULT_EXPIRY_DAYS = 30;/, "the expiry default must stay 30 days");
    assert.match(
      source,
      /Math\.min\(Math\.max\(Math\.floor\(Number\(input\.expiresInDays\) \|\| DEFAULT_EXPIRY_DAYS\), 1\), MAX_EXPIRY_DAYS\)/,
      "expiry must be clamped to [1, MAX] with the default applied first — a caller must not be able to mint a link that never expires",
    );
    assert.match(source, /expires_at: expiresAt/, "every created link must be written with an expiry");
    assert.ok(
      !/expires_at:\s*null/.test(source),
      "no branch may write a null expiry — mandatory means there is no way to opt out",
    );
  }

  // ── D5c: revoked and expired links are refused, and absent ones are silent ─
  {
    const assertIdx = source.indexOf("export async function assertDirectOrderShareToken(");
    assert.ok(assertIdx > -1, "assertDirectOrderShareToken must remain the single liveness check");
    const gate = topLevelBlock(source, assertIdx);
    // These two were pinned to the ONE-LINE form (`if (…) throw forbiddenError(`) until 2026-10-03,
    // when both branches gained a `noteDeadShareTokenRead` call so a dead token being polled leaves
    // a trace Phoenix can see (`src/lib/share-links/dead-token-polling.ts`). The spelling changed;
    // the control did not. `[^}]*` is the deliberate limit — it cannot cross the branch's own
    // closing brace, so the throw it finds is still inside the `if`, and the counting line between
    // them cannot grow into a nested condition that skips the refusal.
    assert.match(
      gate,
      /if \(link\.revoked_at\)\s*\{?[^}]*throw forbiddenError\(/,
      "a revoked link must be refused — whatever else that branch does first",
    );
    assert.match(
      gate,
      /if \(new Date\(String\(link\.expires_at\)\)\.getTime\(\) < Date\.now\(\)\)\s*\{?[^}]*throw forbiddenError\(/,
      "an expired link must be refused — whatever else that branch does first",
    );
    assert.ok(
      !/if \(link\.revoked_at\)\s*\{[^}]*\breturn\b/.test(gate)
        && !/getTime\(\) < Date\.now\(\)\)\s*\{[^}]*\breturn\b/.test(gate),
      "neither dead branch may RETURN the link: counting the read must not become a way past the gate",
    );
    assert.match(
      gate,
      /if \(String\(link\.surface\) !== input\.surface\) throw notFoundError\("Link not found\."\)/,
      "a wrong-surface token must answer 'not found', identically to a missing one — a probing caller must learn nothing about which tokens exist",
    );
    assert.match(
      gate,
      /if \(input\.requireFiles && !link\.allow_files\) throw forbiddenError\(/,
      "file access must be a SEPARATE grant: a token minted to feed a spreadsheet must not also unlock photographs of real shop fronts",
    );
  }

  // ── D5c: the scope is frozen at creation and never re-resolved ─────────────
  // If the scope were resolved at read time, a District Manager's link would silently widen the
  // day they were promoted, and break the day they were not. Neither is something the person who
  // pasted the link into an email agreed to.
  {
    const createIdx = source.indexOf("export async function createDirectOrderReportShareLink(");
    const create = topLevelBlock(source, createIdx);
    assert.match(create, /const scope = resolveDirectOrderReportScope\(access\);/, "the creator's scope must be captured at creation");
    assert.match(create, /scope_hr_id: hrId/, "the creator's identity must be frozen onto the link");

    const resolveIdx = source.indexOf("export async function resolveDirectOrderReportShareLink(");
    const resolve = topLevelBlock(source, resolveIdx);
    assert.match(
      resolve,
      /const creatorHrId = String\(link\.scope_hr_id \?\? ""\);/,
      "the read path must load as the CREATOR, from the frozen columns",
    );
    assert.ok(
      !/resolveDirectOrderReportScope\(/.test(resolve),
      "the read path must NEVER re-resolve the scope: the link would then widen on promotion and break on demotion, neither of which the sharer agreed to",
    );
    assert.match(
      resolve,
      /const link = await assertDirectOrderShareToken\(/,
      "the read path must reuse the same liveness gate as the file route, so the two cannot drift on what counts as a live link",
    );
  }

  // ── D5c: nothing is cached, nothing is indexed ─────────────────────────────
  // A cached or crawled copy outlives the expiry and the revoke button — the two controls this
  // whole design rests on.
  {
    for (const [name, route] of [["live", liveRoute], ["feed", feedRoute]] as const) {
      // Counted against the number of responses, not matched once anywhere in the file. A single
      // `assert.match` is satisfied by the FIRST response that carries the header while a second
      // one leaks — verified by deleting no-store from the live route's JSON response, which a
      // bare match did not notice.
      const responses = route.match(/return new NextResponse\(|return NextResponse\.json\(/g) ?? [];
      const noStore = route.match(/"Cache-Control": "no-store, max-age=0"/g) ?? [];
      assert.ok(
        noStore.length >= responses.length - 1,
        `the ${name} route must send no-store on every data response: a cached copy outlives both ` +
          `the expiry and the revoke button (${responses.length} responses, ${noStore.length} no-store)`,
      );

      // The ERROR path is asserted on its OWN body. A whole-file match for the success header
      // ("noindex, nofollow, noarchive") stays green after the error path's header is deleted,
      // because the error path sends the shorter "noindex, nofollow" — so the one response most
      // likely to be reached by a crawler probing tokens was the one nothing checked.
      const catchStart = route.indexOf("} catch (error) {");
      assert.notEqual(catchStart, -1, `the ${name} route must still handle its errors`);
      assert.match(
        route.slice(catchStart),
        /"X-Robots-Tag": "noindex/,
        `the ${name} route must send noindex on its ERROR response too: a crawled copy is a ` +
          "permanent public copy, and a 404 still tells a crawler the URL exists",
      );
      assert.match(
        route,
        /"X-Robots-Tag": "noindex, nofollow, noarchive"/,
        `the ${name} route must send noindex on its data response: a crawled copy is a permanent public copy`,
      );
    }
  }

  // ── D5c: the token is long enough that guessing is not the threat ──────────
  {
    assert.match(
      source,
      /randomBytes\(32\)\.toString\("base64url"\)/,
      "the token must stay 32 random bytes — it is the entire credential",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Merged in from #1831, which locked the same spec items independently. These five rules were
  // in that version and not in this one, and they are kept because each covers something the
  // rest of this file does not reach. The two efforts were written in parallel by different
  // sessions; the union is what ships.
  // ─────────────────────────────────────────────────────────────────────────

  // ── D5c: every open is stamped and counted ─────────────────────────────────
  // The controls above decide who MAY read. This is the record of who DID. Without it, the
  // honest answer to "who else has published our numbers" is that nobody knows.
  {
    const resolveIdx = source.indexOf("export async function resolveDirectOrderReportShareLink(");
    assert.ok(resolveIdx > -1, "resolveDirectOrderReportShareLink must still exist");
    const resolveBody = topLevelBlock(source, resolveIdx);
    assert.match(resolveBody, /last_accessed_at:/, "every open must be stamped");
    assert.match(
      resolveBody,
      /access_count: Number\(link\.access_count \?\? 0\) \+ 1/,
      "every open must be counted",
    );
  }

  // ── D5c: the management table answers "who else has published our numbers" ─
  // A creator sees their own links so they can revoke them; a Super Admin sees every one, because
  // the question the table exists to answer is company-wide and cannot be asked one account at a
  // time.
  {
    // Two substrings rather than one regex over the whole statement: the filter grew a guard
    // on 2026-09-05 (an empty key list builds `created_by_hr_id=in.()`, which PostgREST
    // rejects as a syntax error, so a permissioned viewer with no linked HR id 500d the
    // screen instead of seeing no links). Pinning the one-line form again would false-fail
    // the next time it grows, while these two say the thing that actually matters.
    assert.ok(
      source.includes("const ownKeys = hrIdLookupKeys(access.hrId);"),
      "the owner filter must be built from the viewer's OWN key list, in every casing",
    );
    assert.ok(
      source.includes('query = query.in("created_by_hr_id", ownKeys);'),
      "a non-admin sees only their own links; a Super Admin sees every one",
    );
    // `.in(hrIdLookupKeys(...))` and not `.eq(access.hrId)`: access.hrId is lower-cased by
    // canonicalHrIdKey, while created_by_hr_id keeps whatever case the creating session had —
    // 40 of 41 rows lower-case in production, 1 upper. An exact match hid a creator's own links
    // from them. The widening is case-only and cannot reach another person's links, because
    // hrIdLookupKeys never produces a different HR_ID. See tests/direct-orders-hr-id-case.test.ts.
    assert.ok(
      !/query\.eq\("created_by_hr_id"/.test(source),
      "the owner filter must not be case-sensitive — an exact match hides links stored in the other case",
    );
  }

  // ── D5d: the route registry must agree with the domain ─────────────────────
  // The domain function asserting `export` is only half the gate. If the registry declared the
  // management route at a lower bar, the two would disagree and the weaker one would be the one
  // an access sweep reported as correct.
  {
    assert.match(
      registry,
      /pattern: "\/api\/direct-orders\/report\/share-links", permission: \{ resource: "direct_orders", action: "export" \}/,
      "the registry must gate the management route on export too, so the route and the domain agree",
    );
  }

  // ── The public surfaces are unauthenticated BY DESIGN, and must say so ─────
  // An undeclared public route is indistinguishable from a forgotten one. Declaring them means a
  // future access sweep reads them as a decision rather than as an oversight to be "fixed" by
  // putting them behind the login wall the whole feature exists to bypass.
  {
    assert.match(
      registry,
      /authMode: "public-token", methods: \["POST"\], pattern: "\/api\/share\/direct-orders\/:token\/live"/,
      "the live surface must be registered as a declared public-token route",
    );
    assert.match(
      registry,
      /authMode: "public-token"[^\n]*pattern: "\/api\/share\/direct-orders\/:token\/feed"/,
      "the feed surface must be registered as a declared public-token route",
    );
  }

  // ── The PAGE, not only the API, must refuse indexing ───────────────────────
  // The routes above send the header. The page is a separate surface with its own metadata, and
  // it is the one a crawler actually follows a pasted link to.
  {
    assert.match(
      sharePage,
      /robots:\s*\{\s*index:\s*false/,
      "the public page itself must declare noindex — a crawled copy would outlive the revoke switch",
    );
  }
}
