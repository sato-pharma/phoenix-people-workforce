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
      const body = source.slice(idx, idx + 900);
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
    const create = source.slice(createIdx, createIdx + 2600);
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

  // ── D5b: the compare is constant-time and salted per link ──────────────────
  {
    assert.match(
      source,
      /timingSafeEqual/,
      "the passcode compare must be constant-time — a length-varying compare leaks the prefix to a patient caller",
    );
    assert.match(
      source,
      /createHash\("sha256"\)\.update\(`\$\{token\}:\$\{passcode\.trim\(\)\}`\)/,
      "the hash must be salted with the token so two links sharing a passcode do not share a hash",
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
    const gate = source.slice(assertIdx, assertIdx + 1800);
    assert.match(gate, /if \(link\.revoked_at\) throw forbiddenError\(/, "a revoked link must be refused");
    assert.match(
      gate,
      /if \(new Date\(String\(link\.expires_at\)\)\.getTime\(\) < Date\.now\(\)\) throw forbiddenError\(/,
      "an expired link must be refused",
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
    const create = source.slice(createIdx, createIdx + 2600);
    assert.match(create, /const scope = resolveDirectOrderReportScope\(access\);/, "the creator's scope must be captured at creation");
    assert.match(create, /scope_hr_id: hrId/, "the creator's identity must be frozen onto the link");

    const resolveIdx = source.indexOf("export async function resolveDirectOrderReportShareLink(");
    const resolve = source.slice(resolveIdx, resolveIdx + 2400);
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
      assert.match(
        route,
        /"Cache-Control": "no-store, max-age=0"/,
        `the ${name} route must send no-store: a cached copy outlives both the expiry and the revoke button`,
      );
      assert.match(
        route,
        /"X-Robots-Tag": "noindex, nofollow, noarchive"/,
        `the ${name} route must send noindex: a crawled copy is a permanent public copy`,
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
}
