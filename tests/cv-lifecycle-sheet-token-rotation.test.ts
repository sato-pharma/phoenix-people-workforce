import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// ─────────────────────────────────────────────────────────────────────────────
// THE CV-LIFECYCLE SHEET'S doPost, AND THE ROTATION THAT DRIVES IT.
//
// This handler is the one place in the system where an unauthenticated caller on the open internet
// can change which credential a sheet full of candidate names and phone numbers is using. It lives
// in docs/, which is not built, linted, imported or type-checked by anything — so without this file
// nothing in CI looks at it at all.
//
// So it is EXECUTED here, not pattern-matched. Every branch below runs the real
// docs/cv-lifecycle-live-sheet.gs source inside a sandbox with a fake PropertiesService, which is
// the only way to prove that "fails closed" and "cannot be repointed at another server" are true
// of the code rather than of its comments. The precedent is tests/live-sheet-stale-banner.test.ts,
// which exists because a sheet showed eighteen-day-old figures while looking perfectly normal.
// ─────────────────────────────────────────────────────────────────────────────

const GS = "../docs/cv-lifecycle-live-sheet.gs";
const ROTATION = "../src/lib/recruitment/cv-lifecycle-sheet-token-rotation.ts";
const ROUTE = "../app/api/cron/cv-lifecycle-rotate-sheet-token/route.ts";

const ORIGIN = "https://phoenix-hr.satopharma.com";

/**
 * FIXTURES ONLY, AND THEY MUST STAY OBVIOUSLY FAKE.
 *
 * These were briefly a real production token, copied out of a mint. `secret-scan` — a required
 * check — caught it on the first push, correctly: a live bearer credential that reads every
 * candidate's name and phone number had been committed and pushed, and anything pushed to the
 * remote has to be treated as compromised no matter how fast the commit is rewritten.
 *
 * So they are deliberately low-entropy and self-describing. The handler only requires
 * `^[A-Za-z0-9_-]{20,}$`, which these satisfy, so nothing is lost by making them unmistakable —
 * and a future reader tempted to "use a realistic one" has this paragraph to read first.
 * Never paste a value out of the database, a mint, or a log into this file.
 */
const OLD_TOKEN = "EXAMPLE-OLD-TOKEN-0000000000000000";
const NEW_TOKEN = "EXAMPLE-NEW-TOKEN-1111111111111111";
const feedUrlFor = (token: string) => `${ORIGIN}/api/share/cv-lifecycle/${token}/feed`;

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

type Loaded = {
  doPost: (event: unknown) => { text: string };
  props: Record<string, string>;
  refreshes: number;
};

/**
 * Run the real .gs in a sandbox.
 *
 * `refreshCvLifecycle` is replaced AFTER the source is evaluated rather than stubbed before it —
 * the file defines it, so a pre-seeded stub would simply be overwritten and every "did it refresh"
 * assertion below would be measuring the sandbox instead of the handler.
 */
function loadSheet(props: Record<string, string>): Loaded {
  const state = { refreshes: 0 };
  const sandbox: Record<string, unknown> = {
    Array,
    ContentService: {
      MimeType: { TEXT: "TEXT" },
      createTextOutput: (text: string) => ({ setMimeType: () => ({ text }) }),
    },
    Date,
    JSON,
    Math,
    Number,
    Object,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => (key in props ? props[key] : null),
        setProperty: (key: string, value: string) => {
          props[key] = value;
        },
      }),
    },
    RegExp,
    ScriptApp: {},
    SpreadsheetApp: {},
    String,
    UrlFetchApp: {},
    Utilities: {},
    console: { error: () => {}, log: () => {} },
    isNaN,
  };
  vm.createContext(sandbox);
  vm.runInContext(read(GS), sandbox);
  sandbox.refreshCvLifecycle = () => {
    state.refreshes += 1;
  };
  return {
    doPost: sandbox.doPost as Loaded["doPost"],
    props,
    get refreshes() {
      return state.refreshes;
    },
  };
}

const post = (body: unknown) => ({ postData: { contents: JSON.stringify(body) } });

export function runCvLifecycleSheetTokenRotationTests() {
  // ── 1. FAILS CLOSED with no secret configured ──────────────────────────────
  //
  // The Web App must be deployed as "Anyone", so the URL is not a credential. A handler that
  // accepted everything until somebody remembered to set a property would be an open endpoint onto
  // the candidate pool's feed token, and it would look exactly like a working one.
  {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN) });
    const answer = sheet.doPost(post({ rotateToken: NEW_TOKEN, secret: "anything" }));
    assert.equal(answer.text, "not configured", "with WEBHOOK_SECRET unset every caller must be refused");
    assert.equal(sheet.props.FEED_URL, feedUrlFor(OLD_TOKEN), "and nothing may be written");
    assert.equal(sheet.refreshes, 0);
  }

  // ── 2. A wrong secret is refused, and learns nothing ───────────────────────
  {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN), WEBHOOK_SECRET: "the-real-secret" });
    const answer = sheet.doPost(post({ rotateToken: NEW_TOKEN, secret: "guess" }));
    assert.equal(answer.text, "denied");
    assert.equal(sheet.props.FEED_URL, feedUrlFor(OLD_TOKEN), "a denied push must not rotate anything");
    assert.equal(sheet.refreshes, 0, "…and must not even trigger a refresh");
  }

  // Malformed JSON is the same answer, not a crash: an exception here would surface as a 500 and
  // tell a prober that their body reached real code.
  {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN), WEBHOOK_SECRET: "s3cret" });
    const answer = sheet.doPost({ postData: { contents: "{not json" } });
    assert.equal(answer.text, "denied");
  }

  // ── 3. A rotation swaps the TOKEN and nothing else ─────────────────────────
  {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN), WEBHOOK_SECRET: "s3cret" });
    const answer = sheet.doPost(post({ rotateToken: NEW_TOKEN, secret: "s3cret" }));
    assert.equal(answer.text, "rotated");
    assert.equal(sheet.props.FEED_URL, feedUrlFor(NEW_TOKEN), "the token is replaced in place");
    assert.ok(sheet.props.FEED_URL.startsWith(`${ORIGIN}/api/share/cv-lifecycle/`), "origin and path survive");
    // The refresh is the CONFIRMATION channel, not a courtesy. Phoenix watches its own access_count
    // for the new token and revokes the old one only once that read lands; a handler that stored
    // the token without spending it would be rolled back as a failure, leaving the sheet on a token
    // Phoenix believes it abandoned.
    assert.equal(sheet.refreshes, 1, "a stored token must be USED immediately");
  }

  // ── 4. THE ORIGIN CAN NEVER COME FROM THE PAYLOAD ──────────────────────────
  //
  // The reason storeRotatedToken_ rewrites one path segment instead of accepting a whole URL. If a
  // caller could name the address, one leaked WEBHOOK_SECRET would let them point the sheet at a
  // server they control — and it would go on filling, with plausible rows, showing data nobody at
  // Phoenix ever wrote. That is a far worse outcome than a leaked read-only token.
  {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN), WEBHOOK_SECRET: "s3cret" });
    sheet.doPost(
      post({
        feedUrl: "https://evil.example.com/api/share/cv-lifecycle/whatever/feed",
        rotateToken: NEW_TOKEN,
        secret: "s3cret",
        url: "https://evil.example.com/feed",
      }),
    );
    assert.equal(
      sheet.props.FEED_URL,
      feedUrlFor(NEW_TOKEN),
      "a caller-supplied URL must be ignored entirely — only the token segment may move",
    );
    assert.ok(!sheet.props.FEED_URL.includes("evil.example.com"));
  }

  // A token carrying URL syntax cannot break out of its segment either.
  {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN), WEBHOOK_SECRET: "s3cret" });
    const answer = sheet.doPost(post({ rotateToken: "evil.example.com/x/feed?a=b", secret: "s3cret" }));
    assert.equal(answer.text, "bad token", "anything outside [A-Za-z0-9_-]{20,} is refused");
    assert.equal(sheet.props.FEED_URL, feedUrlFor(OLD_TOKEN), "and the old URL stands");
  }

  // ── 5. Rubbish is refused rather than stored ───────────────────────────────
  //
  // Storing junk would break every subsequent refresh and the sheet would report it as a Phoenix
  // failure — a confusing lie about whose fault it is.
  for (const bad of ["short", "has spaces in it here", "!!!!!!!!!!!!!!!!!!!!!!"]) {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN), WEBHOOK_SECRET: "s3cret" });
    const answer = sheet.doPost(post({ rotateToken: bad, secret: "s3cret" }));
    assert.equal(answer.text, "bad token", `"${bad}" must be refused`);
    assert.equal(sheet.props.FEED_URL, feedUrlFor(OLD_TOKEN));
    assert.equal(sheet.refreshes, 0);
  }

  // With FEED_URL unset there is nothing to rewrite — say so rather than inventing an address.
  {
    const sheet = loadSheet({ WEBHOOK_SECRET: "s3cret" });
    assert.equal(sheet.doPost(post({ rotateToken: NEW_TOKEN, secret: "s3cret" })).text, "bad url");
  }

  // ── 6. A RETRY IS A SUCCESS, not a failure ─────────────────────────────────
  //
  // Phoenix cannot trust the reply (Apps Script answers a POST with a 302, followed as a GET), so
  // it may well push again. The second push carries the token already stored; answering "bad url"
  // to that would read as a broken sheet at exactly the moment everything worked.
  {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN), WEBHOOK_SECRET: "s3cret" });
    sheet.doPost(post({ rotateToken: NEW_TOKEN, secret: "s3cret" }));
    const again = sheet.doPost(post({ rotateToken: NEW_TOKEN, secret: "s3cret" }));
    assert.equal(again.text, "rotated", "re-pushing the stored token is idempotent");
    assert.equal(sheet.props.FEED_URL, feedUrlFor(NEW_TOKEN));
    assert.equal(sheet.refreshes, 2, "and it re-reads, which is what re-confirms the rotation");
  }

  // ── 7. A plain push with no token is still just a refresh ──────────────────
  {
    const sheet = loadSheet({ FEED_URL: feedUrlFor(OLD_TOKEN), WEBHOOK_SECRET: "s3cret" });
    const answer = sheet.doPost(post({ secret: "s3cret" }));
    assert.equal(answer.text, "ok");
    assert.equal(sheet.props.FEED_URL, feedUrlFor(OLD_TOKEN), "no token, no rotation");
    assert.equal(sheet.refreshes, 1);
  }

  // ── 8. NO FALLBACK to the feed token, and this is the one real divergence ──
  //
  // docs/direct-orders-live-sheet.gs falls back to its feed token when WEBHOOK_SECRET is unset, and
  // its comment argues that is safe THERE: anyone holding that feed token can already read that
  // feed, so authorising a refresh with it grants nothing new. The argument does not survive the
  // move to this sheet, because here doPost can also REPLACE the token — so the fallback would let
  // one leaked PII-reading token keep its holder in control of where the sheet points.
  const gs = read(GS);
  assert.ok(
    !/resolveWebhookSecret/.test(gs),
    "this sheet must not grow the direct-orders secret-fallback helper",
  );
  assert.ok(
    !/FEED_TOKEN/.test(gs),
    "this sheet keys on FEED_URL; a FEED_TOKEN property would mean the fallback came with it",
  );

  // ── 9. The Phoenix side: order is the whole design ─────────────────────────
  const rotation = read(ROTATION);
  const revokeAt = rotation.indexOf("revoked_at: new Date().toISOString()");
  const confirmAt = rotation.indexOf("if (!confirmed)");
  assert.ok(revokeAt > 0 && confirmAt > 0, "both the confirmation gate and the revoke must exist");
  assert.ok(
    confirmAt < revokeAt,
    "the old token may be revoked only AFTER the confirmation gate — reversing these strands the owner with a sheet that cannot read anything",
  );
  assert.ok(
    rotation.includes('.delete().eq("token_hash", hashShareToken(newToken))'),
    "an unconfirmed rotation must delete the link it minted, or the next run refuses on 'more than one live link'",
  );

  // The expiry is INHERITED, never reset. Owner decision 2026-09-05. Resetting it on every weekly
  // rotation would turn a mandatory 365-day cap into a perpetual credential — the precise thing
  // createCvLifecycleShareLink's cap exists to prevent.
  assert.ok(
    rotation.includes("expires_at: expiresAt"),
    "the replacement must inherit the old expiry",
  );
  assert.ok(
    !/expiresInDays|MAX_EXPIRY_DAYS|365 \* 24/.test(rotation),
    "rotation must never compute a NEW expiry — that would make the link perpetual",
  );
  assert.ok(
    rotation.includes("EXPIRY_FLOOR_MS"),
    "…and must refuse when the inherited expiry is so close that the replacement is born dying",
  );

  // ── 10. The route reports honestly ─────────────────────────────────────────
  const route = read(ROUTE);
  assert.ok(
    route.includes('"phoenix-cv-lifecycle-rotate-sheet-token"'),
    "the dead-man's-switch slug must match the one documented for the cron job",
  );
  assert.ok(
    route.includes("assertCronAuthorized"),
    "the route is CRON_SECRET-guarded like every other cron route",
  );
  // "Not configured" is the CORRECT steady state until the owner deploys the Apps Script web app.
  // Pinging /fail for it would make the switch red for a job behaving exactly as intended, and a
  // switch that is red for a non-problem is one nobody looks at.
  assert.ok(
    route.includes("unconfigured"),
    "an unconfigured sheet must ping success, not fail",
  );
}
