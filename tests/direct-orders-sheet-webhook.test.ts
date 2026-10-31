import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pingDirectOrderSheet } from "../src/lib/direct-orders/sheet-webhook.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The live-sheet push (spec D5e).
//
// The whole point of this module is that it CANNOT hurt anything. It sits at the end of six
// money-critical mutations — submit, decide, reverse, expire, verify, set-sales-month — and a
// spreadsheet refresh must never be able to fail one of them. The sheet already re-pulls the feed
// every 60 seconds on its own, so a ping that fails costs at most a minute of freshness and never
// costs correctness.
//
// These tests pin that property, plus the two things that would silently break the design: a caller
// awaiting it into the critical path, and the Apps Script accepting an unauthenticated caller.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrderSheetWebhookTests() {
  const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const moduleSource = readFileSync(new URL("../src/lib/direct-orders/sheet-webhook.ts", import.meta.url), "utf8");
  const scriptSource = readFileSync(new URL("../docs/direct-orders-live-sheet.gs", import.meta.url), "utf8");

  // ── THE HEADLINE: it must be un-awaitable and un-throwable ──────────────────────────────
  // Returning void (not a Promise) is what stops a future caller writing `await ping(...)` and
  // making an order's success depend on Google being reachable.
  assert.match(
    moduleSource,
    /export function pingDirectOrderSheet\(reason: string\): void \{/,
    "pingDirectOrderSheet must return void, not a Promise — a Promise invites `await`, which would put a spreadsheet on the critical path of a payroll-adjacent mutation",
  );
  assert.doesNotMatch(
    serviceSource,
    /await pingDirectOrderSheet\(/,
    "AWAITED SHEET PING: an order must never wait on, or fail because of, a spreadsheet refresh",
  );

  // Unconfigured is a normal state, not an error. This must not throw with no env set.
  delete process.env.SHEET_REFRESH_WEBHOOK_URL;
  delete process.env.SHEET_REFRESH_WEBHOOK_SECRET;
  assert.doesNotThrow(
    () => pingDirectOrderSheet("unit-test"),
    "an unconfigured webhook must be a silent no-op — the sheet still refreshes on its own timer",
  );
  // A URL without a secret must also no-op rather than POST unauthenticated.
  process.env.SHEET_REFRESH_WEBHOOK_URL = "https://example.invalid/hook";
  assert.doesNotThrow(() => pingDirectOrderSheet("unit-test"), "a URL with no secret must no-op, never POST bare");
  delete process.env.SHEET_REFRESH_WEBHOOK_URL;

  // ── The secret must travel in the body, never the query string ───────────────────────────
  // In a URL it would be written to browser history, referrer headers and proxy logs while looking
  // protected — the same mistake D5b exists to avoid on the human surface.
  assert.match(
    moduleSource,
    /body: JSON\.stringify\(\{ secret, reason \}\)/,
    "the shared secret must be sent in the POST body",
  );
  assert.doesNotMatch(
    moduleSource,
    /searchParams\.set\(\s*["']secret|\?secret=/,
    "SECRET IN THE QUERY STRING: it would be logged by every proxy on the path",
  );

  // ── All six mutations must ping ──────────────────────────────────────────────────────────
  // Miss one and that transition silently stops reaching the sheet — invisible, because the 60s
  // timer papers over it and everything still looks live.
  for (const reason of [
    "order_submitted",
    "order_decided",
    "order_reversed",
    "held_expired",
    "pharmacy_verified",
    "sales_month_set",
  ]) {
    assert.match(
      serviceSource,
      new RegExp(`pingDirectOrderSheet\\("${reason}"\\)`),
      `the "${reason}" transition must notify the live sheet`,
    );
  }

  // ── The Apps Script side must fail CLOSED ────────────────────────────────────────────────
  // The Web App is deployed to "Anyone" because Phoenix calls it unauthenticated, so the secret is
  // the only gate. A deployment with no secret configured must refuse everything, not accept it.
  assert.match(scriptSource, /function doPost\(e\)/, "the script must expose a doPost for the push endpoint");
  assert.match(
    scriptSource,
    /if \(!expected\) \{[\s\S]{0,400}?return ContentService/,
    "AN UNSET SECRET MUST FAIL CLOSED: otherwise a fresh deployment accepts any caller on the internet",
  );
  assert.match(
    scriptSource,
    /if \(String\(payload\.secret \|\| ""\) !== expected\) \{/,
    "the script must compare the supplied secret against the configured one before refreshing",
  );
  // The comparison must come BEFORE anything that acts — rotation included. A rotation branch
  // placed above the check would let an unauthenticated caller replace the sheet's feed token.
  const doPostBody = scriptSource.slice(
    scriptSource.indexOf("function doPost(e)"),
    scriptSource.indexOf("function resolveWebhookSecret()"),
  );
  assert.ok(
    doPostBody.indexOf('!== expected') < doPostBody.indexOf("rotateToken"),
    "SECRET CHECK MUST PRECEDE THE ROTATION BRANCH: otherwise an unauthenticated caller could replace the sheet's feed token",
  );
  assert.match(
    doPostBody,
    /if \(!props\.getProperty\("WEBHOOK_SECRET"\)\) props\.setProperty\("WEBHOOK_SECRET", expected\);\s*\n\s*props\.setProperty\("FEED_TOKEN", rotate\);/,
    "the webhook secret must be PINNED before FEED_TOKEN is rotated — otherwise the default secret moves with the token while Phoenix still sends the old one, and every later push is denied silently",
  );
  assert.match(
    doPostBody,
    /if \(!\/\^\[A-Za-z0-9_-\]\{20,\}\$\/\.test\(rotate\)\)/,
    "a rotation token must be validated before it is stored — storing rubbish would break every refresh from then on",
  );
  // The secret belongs in Script Properties, never in the file that gets shared and committed.
  assert.doesNotMatch(
    scriptSource,
    /WEBHOOK_SECRET\s*=\s*["'][^"']+["']/,
    "HARDCODED SECRET IN THE SCRIPT: it must come from Script Properties",
  );

  // ── The zero-configuration fallback ──────────────────────────────────────────────────────
  // A Script Property still wins, but with none set the script authorises against the feed token it
  // already holds — so the push endpoint works the moment the script is pasted, with nothing else to
  // configure. That grants nothing extra: doPost can only make the sheet re-read the feed, and
  // anyone holding the feed token can already read that feed directly and in full.
  assert.match(
    scriptSource,
    /function resolveWebhookSecret\(\)/,
    "the script must resolve its secret through resolveWebhookSecret, not read the property inline",
  );
  assert.match(
    scriptSource,
    /var explicit = PropertiesService\.getScriptProperties\(\)\.getProperty\("WEBHOOK_SECRET"\);[\s\S]{0,120}?if \(explicit\) return explicit;/,
    "an explicitly configured WEBHOOK_SECRET must take precedence over the fallback",
  );
  assert.match(
    scriptSource,
    /if \(explicit\) return explicit;\s*\n\s*return feedToken\(\);/,
    "with no explicit property the fallback must be the feed token currently in force",
  );

  // ── No feed token may live in this file, ever ────────────────────────────────────────────
  // It shipped once as a "bootstrap" constant, on the reasoning that rotating would revoke it and
  // make the committed copy worthless. It did — and a dead credential in a file is still a
  // credential in a file: it reads as live to the next person, and it invites the next setup to
  // paste a live one beside it. git keeps whatever is written there for good, so the slot is gone.
  assert.ok(
    !/BOOTSTRAP_FEED_TOKEN/.test(scriptSource),
    "the committed bootstrap token slot must stay deleted — an emptied one invites a live token back into git",
  );
  // Any long base64url run outside a comment is the shape a real token has. This is the check that
  // fires if someone pastes their live token in "just to test it".
  const codeOnly = stripComments(scriptSource);
  assert.ok(
    !/["'][A-Za-z0-9_-]{30,}["']/.test(codeOnly),
    "no token-shaped literal may appear in the script — the feed token belongs in a Script Property",
  );
  assert.match(
    scriptSource,
    /function feedToken\(\) \{\s*\n\s*return String\(PropertiesService\.getScriptProperties\(\)\.getProperty\("FEED_TOKEN"\)/,
    "the token must come only from the Script Property, which is committed nowhere",
  );
  // A missing token must be distinguishable from a refused feed, and must not fetch a URL with an
  // empty token in it — that 404s and reads as a revoked link, sending the debugger somewhere else.
  assert.match(
    scriptSource,
    /return token \? FEED_BASE \+ token \+ "\/feed\?bundle=1" : "";/,
    "an unconfigured token must yield no URL at all rather than a URL with a hole in it",
  );
  assert.match(
    scriptSource,
    /function feedUrl\(\) \{\s*\n\s*var token = feedToken\(\);/,
    "the feed URL must be built per call from the CURRENT token — a cached URL would keep using a rotated-away token",
  );
  // The refresh must resolve the URL on every run rather than fetch a module-level constant, or a
  // rotation never takes effect. It now reads feedUrl() into a local first so it can tell "no token
  // configured" apart from "the feed refused us" — both of which look identical from the sheet.
  assert.match(
    scriptSource,
    /function refreshDirectOrders\(e\) \{\s*\n\s*var url = feedUrl\(\);/,
    "the refresh must resolve the feed URL per run, or rotation never takes effect",
  );
  assert.match(
    scriptSource,
    /UrlFetchApp\.fetch\(url,/,
    "the refresh must fetch the freshly resolved URL, not a constant",
  );
}
