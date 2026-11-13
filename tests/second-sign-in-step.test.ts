import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";
import { stripComments } from "./support/comment-strip.ts";
import {
  RECOVERY_CODE_COUNT,
  SECOND_STEP_ROLES,
  TOTP_PERIOD_SECONDS,
  TRUSTED_DEVICE_MAX_AGE_SECONDS,
  base32Decode,
  base32Encode,
  decideSecondStep,
  generateRecoveryCodes,
  generateTotpSecret,
  looksLikeTrustedDeviceToken,
  matchTotp,
  otpauthUri,
  readSecondStepCode,
  recoveryCodeHash,
  secondStepRequiredForRole,
  totpCode,
  totpStepAt,
  trustedDeviceCookieName,
} from "../src/lib/auth/second-step.ts";
import {
  type SecondStepDb,
  checkSecondStepCode,
  forgetTrustedDevices,
  issueTrustedDevice,
  readSecondStepStatus,
  renewRecoveryCodes,
  resetSecondStep,
  secondStepAtSignIn,
} from "../src/lib/auth/second-step-store.ts";
import { sealSecret } from "../src/lib/security/secret-box.ts";

/**
 * THE SECOND SIGN-IN STEP (integration audit INT-005; owner, 13 Nov 2026).
 *
 * His four choices: "Super Admin accounts only", "Authenticator app, passkey counts", "Once per device,
 * 30 days", "Recovery codes plus your reset". What is pinned:
 *
 *   1. The arithmetic is the standard's own: RFC 6238's published codes come out of totpCode.
 *   2. A code is good ONCE, and only within one step either side of now.
 *   3. A remembered browser is honoured only for an account that is set up, only for its own account,
 *      and only inside its 30 days.
 *   4. The whole step, on an in-memory database: set-up, sign-in by code, by recovery code (spent once),
 *      by remembered browser, reset, and a read that fails refusing the sign-in.
 *   5. Nothing readable is stored: the key is sealed, the codes and the cookie token are fingerprints.
 *   6. The sign-in route asks the step after the password and before any session, for every caller; the
 *      account's own screen is a Super Admin's, acting as themselves; the tables are server-only.
 *
 * The flows never touch a real database: every store function is handed the fake one.
 */

const LOGIN_ROUTE = "app/api/auth/login/route.ts";
const PASSKEY_ROUTE = "app/api/auth/biometric/login/verify/route.ts";
const MANAGE_ROUTE = "app/api/auth/second-step/route.ts";
const PROFILE_PAGE = "app/(admin)/admin/profile/page.tsx";
const MIGRATION = "supabase/migrations/20261113213439_second_sign_in_step.sql";

// RFC 6238, appendix B: the SHA-1 key is the ASCII text below, and these are the published codes
// (the RFC prints eight digits; an authenticator app shows the last six).
const RFC_KEY = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const RFC_VECTORS: Array<[seconds: number, code: string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

function db(seed: Record<string, Array<Record<string, unknown>>> = {}, failOn?: Record<string, string>) {
  const client = fakeSupabaseClient(seed, failOn ? { failOn } : {});
  return { client, db: client as unknown as SecondStepDb };
}

// The store throws the database's own error object, as PostgREST hands it over (not an Error).
const refusedRead = (error: unknown) => /connection refused/.test(String((error as { message?: unknown } | null)?.message ?? ""));

/** The same database, with every READ of one table failing while its writes still succeed. */
function readsFail(client: ReturnType<typeof fakeSupabaseClient>, table: string): SecondStepDb {
  const failing = fakeSupabaseClient({}, { failOn: { [table]: "connection refused" } });
  return {
    from(name: string) {
      const builder = client.from(name);
      if (name !== table) return builder;
      const select = builder.select.bind(builder);
      let wrote = false;
      for (const verb of ["update", "insert", "upsert", "delete"] as const) {
        const real = (builder[verb] as (...args: unknown[]) => unknown).bind(builder);
        (builder as unknown as Record<string, unknown>)[verb] = (...args: unknown[]) => {
          wrote = true;
          return real(...args);
        };
      }
      (builder as unknown as Record<string, unknown>).select = (columns?: string) => (wrote ? select(columns) : failing.from(name).select(columns));
      return builder;
    },
  } as unknown as SecondStepDb;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STEP_MS = TOTP_PERIOD_SECONDS * 1000;

export async function runSecondSignInStepTests() {
  const priorSecret = process.env.PHOENIX_AUTH_SECRET;
  process.env.PHOENIX_AUTH_SECRET = "test-secret-for-the-second-sign-in-step";
  try {
    // ── 1. The arithmetic is the standard's own ──────────────────────────────────────────────────
    assert.equal(RFC_KEY, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "base32 writes the RFC's key as every authenticator app reads it"); // gitleaks:allow — RFC 6238's published sample key, not a credential
    for (const [seconds, code] of RFC_VECTORS) {
      assert.equal(totpCode(RFC_KEY, totpStepAt(seconds * 1000)), code, `RFC 6238's code at ${seconds}s`);
    }
    assert.deepEqual([...(base32Decode(RFC_KEY) ?? [])], [...Buffer.from("12345678901234567890", "ascii")], "base32 reads back what it wrote");
    assert.equal(base32Decode("not base32 !"), null, "a key that is not base32 is never guessed at");
    assert.equal(base32Decode(""), null);
    assert.equal(totpCode("ABC", 1), null, "a key too short to be a key gives no code");
    const fresh = generateTotpSecret();
    assert.match(fresh, /^[A-Z2-7]{32}$/, "a new key is 160 random bits in base32");
    assert.notEqual(fresh, generateTotpSecret(), "two new keys differ");

    const uri = otpauthUri({ account: "omar@example.com", secret: RFC_KEY });
    assert.ok(uri.startsWith("otpauth://totp/Phoenix%20Workforce:omar%40example.com?"), "the link names the system and the account");
    assert.ok(uri.includes(`secret=${RFC_KEY}`) && uri.includes("digits=6") && uri.includes("period=30") && uri.includes("algorithm=SHA1"));
    assert.ok(!uri.includes("+"), "a space is written %20: some authenticator apps show a plus sign as a plus sign");

    // ── 2. A code is good once, and only near now ────────────────────────────────────────────────
    const now = 1_800_000_000_000;
    const step = totpStepAt(now);
    const codeAt = (offset: number) => totpCode(RFC_KEY, step + offset) as string;
    const match = (code: string, lastUsedStep: number | null) => matchTotp({ code, lastUsedStep, nowMs: now, secret: RFC_KEY });
    assert.equal(match(codeAt(0), null), step, "the code of this step is accepted");
    assert.equal(match(codeAt(-1), null), step - 1, "one step back is accepted: the code was typed as it rolled over");
    assert.equal(match(codeAt(1), null), step + 1, "one step ahead is accepted: the phone's clock is a little fast");
    assert.equal(match(codeAt(-2), null), null, "two steps back is refused");
    assert.equal(match(codeAt(2), null), null, "two steps ahead is refused");
    assert.equal(match(codeAt(0), step), null, "🔴 a code already used is refused: it is good ONCE");
    assert.equal(match(codeAt(-1), step), null, "an older code than the one already used is refused");
    assert.equal(match(codeAt(1), step), step + 1, "only a newer step is accepted after a used one");
    assert.equal(match("12345", null), null);
    assert.equal(match("1234567", null), null);
    assert.equal(match("abcdef", null), null);

    // ── 3. Who is asked, and when a remembered browser counts ────────────────────────────────────
    assert.deepEqual([...SECOND_STEP_ROLES], ["Super Admin"], 'his choice: "Super Admin accounts only"');
    assert.equal(secondStepRequiredForRole("Super Admin"), true);
    for (const role of ["CEO", "HR Operations", "Medical Rep", "National Sales Manager", "", null, undefined]) {
      assert.equal(secondStepRequiredForRole(role), false, `${String(role)} is not asked`);
    }
    const decide = (setUp: boolean, trustedDevice: boolean, codeSent: boolean) =>
      decideSecondStep({ codeSent, required: true, setUp, trustedDevice });
    assert.equal(decideSecondStep({ codeSent: false, required: false, setUp: false, trustedDevice: false }), "pass");
    assert.equal(decide(false, false, false), "offer_setup");
    assert.equal(decide(false, false, true), "finish_setup");
    assert.equal(decide(false, true, false), "offer_setup", "🔴 a remembered browser never carries an account past its own set-up");
    assert.equal(decide(false, true, true), "finish_setup");
    assert.equal(decide(true, true, false), "pass");
    assert.equal(decide(true, false, false), "ask_code");
    assert.equal(decide(true, false, true), "check_code");

    assert.deepEqual(readSecondStepCode(" 123 456 "), { code: "123456", kind: "totp" });
    assert.deepEqual(readSecondStepCode("abcde-fghjk"), { code: "ABCDEFGHJK", kind: "recovery" });
    assert.equal(readSecondStepCode("ABCDE-FGHI0"), null, "a recovery code holds no 0, O, 1, I or L");
    assert.equal(readSecondStepCode("12345"), null);
    assert.equal(readSecondStepCode(123456), null, "only text is read");
    assert.equal(readSecondStepCode("1".repeat(41)), null);

    const codes = generateRecoveryCodes();
    assert.equal(codes.length, RECOVERY_CODE_COUNT);
    assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT, "the ten codes differ");
    for (const code of codes) assert.match(code, /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/, `${code} is written XXXXX-XXXXX in the paper-safe alphabet`);
    assert.notEqual(recoveryCodeHash("a.one", "ABCDEFGHJK"), recoveryCodeHash("a.two", "ABCDEFGHJK"), "a fingerprint belongs to one account");
    assert.equal(recoveryCodeHash("A.One", "ABCDEFGHJK"), recoveryCodeHash("a.one", "ABCDEFGHJK"));
    assert.match(recoveryCodeHash("a.one", "ABCDEFGHJK"), /^[0-9a-f]{64}$/);
    process.env.PHOENIX_AUTH_SECRET = "another-secret-for-the-same-code";
    const underAnotherSecret = recoveryCodeHash("a.one", "ABCDEFGHJK");
    process.env.PHOENIX_AUTH_SECRET = "test-secret-for-the-second-sign-in-step";
    assert.notEqual(recoveryCodeHash("a.one", "ABCDEFGHJK"), underAnotherSecret, "the fingerprint is keyed with the server's secret");

    assert.equal(looksLikeTrustedDeviceToken("x".repeat(43)), true);
    assert.equal(looksLikeTrustedDeviceToken("x".repeat(42)), false);
    assert.equal(looksLikeTrustedDeviceToken(null), false);
    assert.equal(TRUSTED_DEVICE_MAX_AGE_SECONDS, 30 * 24 * 60 * 60, 'his choice: "Once per device, 30 days"');

    // ── 4. The whole step, on an in-memory database ──────────────────────────────────────────────
    const LOGIN = "omar.gawish";
    const { client, db: store } = db();
    const signIn = (over: { canFinishSetup?: boolean; code?: unknown; loginId?: string; nowMs: number; role?: string; token?: unknown }) =>
      secondStepAtSignIn({
        account: over.loginId ?? LOGIN,
        canFinishSetup: over.canFinishSetup ?? true,
        code: over.code,
        db: store,
        loginId: over.loginId ?? LOGIN,
        nowMs: over.nowMs,
        role: over.role ?? "Super Admin",
        trustedDeviceToken: over.token ?? null,
      });

    // An account the step is not asked of passes, and nothing is read or written for it.
    assert.deepEqual(await signIn({ loginId: "a.rep", nowMs: now, role: "Medical Rep" }), { by: "not_required", kind: "pass" });
    assert.equal(client.rows("app_auth_second_step").length, 0, "no row is made for an account that is not asked");

    // A Super Admin with nothing set up is handed a key, and no session.
    const offered = await signIn({ nowMs: now });
    assert.equal(offered.kind, "offer_setup");
    const offeredSecret = offered.kind === "offer_setup" ? offered.setup.secret : "";
    assert.match(offeredSecret, /^[A-Z2-7]{32}$/);
    assert.equal(offered.kind === "offer_setup" && offered.setup.otpauthUri, otpauthUri({ account: LOGIN, secret: offeredSecret }));
    const pendingRow = client.rows("app_auth_second_step")[0];
    assert.ok(pendingRow && !pendingRow.secret_sealed, "the account is not set up until a code proves the app has the key");
    assert.ok(!JSON.stringify(client.rows("app_auth_second_step")).includes(offeredSecret), "🔴 the key is stored sealed, never as it is typed");

    // 🔴 A KEY IS HANDED OUT ONCE (risk review, 13 Nov 2026). Whoever asks next (the owner reloading, or
    // somebody who only knows the password) gets a NEW key, never the one already on another screen: a
    // waiting key handed back would let a password thief hold the key the owner then puts in their phone.
    const again = await signIn({ nowMs: now + 60_000 });
    const againSecret = again.kind === "offer_setup" ? again.setup.secret : "";
    assert.match(againSecret, /^[A-Z2-7]{32}$/);
    assert.notEqual(againSecret, offeredSecret, "🔴 asking again makes a NEW key: a waiting key is never handed to a second caller");
    assert.deepEqual(
      await signIn({ code: totpCode(offeredSecret, totpStepAt(now + 60_500)), nowMs: now + 60_500 }),
      { duringSetup: true, kind: "wrong_code" },
      "and the key before it finishes nothing",
    );
    assert.ok(!client.rows("app_auth_second_step")[0].secret_sealed);

    // The wrong code during set-up: refused, the key NOT sent again, the waiting key left as it was.
    const waitingKey = client.rows("app_auth_second_step")[0].pending_secret_sealed;
    const wrongAtSetup = await signIn({ code: "000000", nowMs: now + 61_000 });
    assert.deepEqual(wrongAtSetup, { duringSetup: true, kind: "wrong_code" }, "🔴 a refusal during a set-up carries no key");
    assert.equal(client.rows("app_auth_second_step")[0].pending_secret_sealed, waitingKey, "a wrong code leaves the waiting key where it was");

    // A sign-in that cannot show the recovery codes may not finish a set-up, even with the right code.
    const setupStep = totpStepAt(now + 62_000);
    const noScript = await signIn({ canFinishSetup: false, code: totpCode(againSecret, setupStep), nowMs: now + 62_000 });
    assert.equal(noScript.kind, "offer_setup", "a form posted with no script is offered the set-up again, never finished");
    assert.ok(!client.rows("app_auth_second_step")[0].secret_sealed);
    // That offer made a new key in its turn; it is the one the set-up below finishes with.
    const secret = noScript.kind === "offer_setup" ? noScript.setup.secret : "";
    assert.notEqual(secret, againSecret);

    // The right code finishes the set-up and hands over the ten recovery codes, once.
    const finished = await signIn({ code: totpCode(secret, setupStep), nowMs: now + 62_000 });
    assert.equal(finished.kind === "pass" && finished.by, "set_up");
    const recoveryCodes = finished.kind === "pass" && finished.by === "set_up" ? finished.recoveryCodes : [];
    assert.equal(recoveryCodes.length, RECOVERY_CODE_COUNT);
    const enrolled = client.rows("app_auth_second_step")[0];
    assert.ok(enrolled.secret_sealed && !enrolled.pending_secret_sealed && enrolled.enrolled_at, "the key handed over became the account's key");
    assert.equal(enrolled.last_used_step, setupStep, "the set-up's own code is spent by the set-up");

    // ── 5. Nothing readable is stored ────────────────────────────────────────────────────────────
    const everything = () =>
      JSON.stringify([
        client.rows("app_auth_second_step"),
        client.rows("app_auth_second_step_recovery_codes"),
        client.rows("app_auth_trusted_devices"),
      ]);
    assert.ok(!everything().includes(secret), "the key is nowhere in the tables in plain text");
    for (const code of recoveryCodes) {
      assert.ok(!everything().includes(code) && !everything().includes(code.replace("-", "")), "a recovery code is stored as a fingerprint, never the code");
    }
    assert.equal(client.rows("app_auth_second_step_recovery_codes").length, RECOVERY_CODE_COUNT);

    // Signing in again: asked for a code; the set-up's code does not work twice.
    assert.deepEqual(await signIn({ nowMs: now + 63_000 }), { kind: "ask_code" });
    assert.deepEqual(
      await signIn({ code: totpCode(secret, setupStep), nowMs: now + 63_000 }),
      { duringSetup: false, kind: "wrong_code" },
      "🔴 the code that finished the set-up cannot sign in a second time",
    );
    assert.deepEqual(await signIn({ code: "000000", nowMs: now + 63_000 }), { duringSetup: false, kind: "wrong_code" });

    // The next step's code signs in, once.
    const later = now + 62_000 + 2 * STEP_MS;
    const laterCode = totpCode(secret, totpStepAt(later));
    assert.deepEqual(await signIn({ code: laterCode, nowMs: later }), { by: "totp", kind: "pass" });
    assert.deepEqual(await signIn({ code: laterCode, nowMs: later }), { duringSetup: false, kind: "wrong_code" }, "🔴 a code is good ONCE");
    assert.equal(client.rows("app_auth_second_step")[0].last_used_step, totpStepAt(later));

    // A recovery code signs in, and is spent by doing so.
    assert.deepEqual(await signIn({ code: recoveryCodes[0].toLowerCase(), nowMs: later }), { by: "recovery", kind: "pass" });
    assert.deepEqual(await signIn({ code: recoveryCodes[0], nowMs: later }), { duringSetup: false, kind: "wrong_code" }, "🔴 a recovery code is good ONCE");
    assert.equal(client.rows("app_auth_second_step_recovery_codes").filter((row) => row.used_at).length, 1);
    assert.deepEqual(await readSecondStepStatus(LOGIN, later, store), {
      recoveryCodesLeft: RECOVERY_CODE_COUNT - 1,
      setUp: true,
      setUpAt: enrolled.enrolled_at,
      trustedDevices: 0,
    });
    // Another account's recovery code is not this account's.
    assert.deepEqual(await signIn({ code: "ABCDE-FGHJK", nowMs: later }), { duringSetup: false, kind: "wrong_code" });

    // A remembered browser: honoured for its own account, inside its 30 days, and nowhere else.
    const trusted = await issueTrustedDevice({ db: store, loginId: LOGIN, nowMs: later, userAgent: "a browser" });
    assert.equal(trusted.maxAgeSeconds, TRUSTED_DEVICE_MAX_AGE_SECONDS);
    assert.ok(looksLikeTrustedDeviceToken(trusted.token));
    assert.ok(!everything().includes(trusted.token), "the cookie's token is stored as a fingerprint, never the token");
    assert.deepEqual(await signIn({ nowMs: later + DAY_MS, token: trusted.token }), { by: "trusted_device", kind: "pass" });
    assert.deepEqual(await signIn({ nowMs: later + 29 * DAY_MS, token: trusted.token }), { by: "trusted_device", kind: "pass" });
    assert.deepEqual(await signIn({ nowMs: later + 30 * DAY_MS, token: trusted.token }), { kind: "ask_code" }, "🔴 after 30 days the browser is asked again");
    assert.deepEqual(await signIn({ nowMs: later + DAY_MS, token: "x".repeat(43) }), { kind: "ask_code" }, "a token nobody was given is nothing");
    assert.deepEqual(await signIn({ nowMs: later + DAY_MS, token: "not-a-token" }), { kind: "ask_code" });
    assert.equal((await readSecondStepStatus(LOGIN, later + DAY_MS, store)).trustedDevices, 1);

    // The other Super Admin account cannot ride on this account's browser.
    const other = await signIn({ loginId: "system.admin", nowMs: later + DAY_MS, token: trusted.token });
    assert.equal(other.kind, "offer_setup", "another account with this browser's cookie is still made to set up");
    const otherSecret = other.kind === "offer_setup" ? other.setup.secret : "";
    const otherSetUp = await signIn({ code: totpCode(otherSecret, totpStepAt(later + DAY_MS)), loginId: "system.admin", nowMs: later + DAY_MS });
    assert.equal(otherSetUp.kind === "pass" && otherSetUp.by, "set_up");
    assert.deepEqual(
      await signIn({ loginId: "system.admin", nowMs: later + DAY_MS + 1000, token: trusted.token }),
      { kind: "ask_code" },
      "🔴 another account with this browser's cookie is asked for its own code: a remembered browser belongs to one account",
    );
    assert.deepEqual(await signIn({ nowMs: later + DAY_MS + 1000, token: trusted.token }), { by: "trusted_device", kind: "pass" });

    // "Forget remembered browsers": the cookie stops counting at once.
    await forgetTrustedDevices(LOGIN, store);
    assert.deepEqual(await signIn({ nowMs: later + DAY_MS, token: trusted.token }), { kind: "ask_code" });

    // New recovery codes: the old ones stop working.
    const renewed = await renewRecoveryCodes(LOGIN, store);
    assert.equal(renewed.length, RECOVERY_CODE_COUNT);
    assert.deepEqual(await signIn({ code: recoveryCodes[1], nowMs: later }), { duringSetup: false, kind: "wrong_code" }, "an old recovery code is dead once new ones are made");
    assert.deepEqual(await signIn({ code: renewed[0], nowMs: later }), { by: "recovery", kind: "pass" });

    // A reset returns the account to "not set up": key, codes and browsers all go.
    const beforeReset = await issueTrustedDevice({ db: store, loginId: LOGIN, nowMs: later, userAgent: null });
    assert.equal(await resetSecondStep(LOGIN, store), true);
    assert.equal(client.rows("app_auth_second_step").filter((row) => row.login_id === LOGIN).length, 0);
    assert.equal(client.rows("app_auth_second_step_recovery_codes").filter((row) => row.login_id === LOGIN).length, 0);
    assert.equal(client.rows("app_auth_trusted_devices").filter((row) => row.login_id === LOGIN).length, 0);
    const afterReset = await signIn({ nowMs: later + DAY_MS, token: beforeReset.token });
    assert.equal(afterReset.kind, "offer_setup", "after a reset the next password sign-in is offered a new set-up");
    assert.notEqual(afterReset.kind === "offer_setup" && afterReset.setup.secret, secret, "and with a new key");
    assert.equal(await resetSecondStep("nobody.at.all", store), false);
    assert.deepEqual(await readSecondStepStatus("nobody.at.all", later, store), { recoveryCodesLeft: 0, setUp: false, setUpAt: null, trustedDevices: 0 });

    // 🔴 A browser row that outlived its account's set-up (the cascade is the database's, not this
    // file's) still carries nobody past a new set-up.
    const stale = db({
      app_auth_trusted_devices: [
        { expires_at: new Date(now + DAY_MS).toISOString(), id: "t1", login_id: LOGIN, token_hash: "will-not-be-read" },
      ],
    });
    const staleOutcome = await secondStepAtSignIn({
      account: LOGIN, canFinishSetup: true, code: undefined, db: stale.db, loginId: LOGIN, nowMs: now, role: "Super Admin", trustedDeviceToken: "x".repeat(43),
    });
    assert.equal(staleOutcome.kind, "offer_setup");

    // A key older than 15 minutes is replaced, and its code no longer finishes anything.
    const expiring = db();
    const first = await secondStepAtSignIn({ account: LOGIN, canFinishSetup: true, code: undefined, db: expiring.db, loginId: LOGIN, nowMs: now, role: "Super Admin", trustedDeviceToken: null });
    const firstSecret = first.kind === "offer_setup" ? first.setup.secret : "";
    const lateNow = now + 16 * 60_000;
    const lateFinish = await secondStepAtSignIn({
      account: LOGIN, canFinishSetup: true, code: totpCode(firstSecret, totpStepAt(lateNow)), db: expiring.db, loginId: LOGIN, nowMs: lateNow, role: "Super Admin", trustedDeviceToken: null,
    });
    assert.equal(lateFinish.kind, "offer_setup", "a key left for more than 15 minutes cannot be finished with: the set-up is offered again");
    assert.notEqual(lateFinish.kind === "offer_setup" && lateFinish.setup.secret, firstSecret, "with a new key");
    assert.ok(!expiring.client.rows("app_auth_second_step")[0].secret_sealed, "and the account is still not set up");

    // 🔴 A SET-UP THAT CANNOT MAKE ITS RECOVERY CODES IS UNDONE. The key was promoted, then the codes table
    // refused: left so, the account would be set up with no recovery code and nobody told.
    const halfDone = db({}, { app_auth_second_step_recovery_codes: "connection refused" });
    const halfOffer = await secondStepAtSignIn({ account: LOGIN, canFinishSetup: true, code: undefined, db: halfDone.db, loginId: LOGIN, nowMs: now, role: "Super Admin", trustedDeviceToken: null });
    const halfSecret = halfOffer.kind === "offer_setup" ? halfOffer.setup.secret : "";
    await assert.rejects(
      secondStepAtSignIn({ account: LOGIN, canFinishSetup: true, code: totpCode(halfSecret, totpStepAt(now)), db: halfDone.db, loginId: LOGIN, nowMs: now, role: "Super Admin", trustedDeviceToken: null }),
      refusedRead,
      "the failure reaches the caller",
    );
    assert.ok(
      !halfDone.client.rows("app_auth_second_step").some((row) => row.secret_sealed),
      "🔴 a set-up whose recovery codes could not be made leaves the account NOT set up, never set up with no codes",
    );

    // 🔴 EVERY READ FAILS CLOSED: a table that cannot be read refuses the sign-in, it never passes it.
    // Only the READ fails here and every write would succeed, so a read turned into "not set up" would
    // be seen handing over a key instead of throwing.
    const unreadable = db();
    await assert.rejects(
      secondStepAtSignIn({
        account: LOGIN, canFinishSetup: true, code: undefined, db: readsFail(unreadable.client, "app_auth_second_step"), loginId: LOGIN, nowMs: now, role: "Super Admin", trustedDeviceToken: null,
      }),
      refusedRead,
      'a failed read of the account\'s second step throws: "could not read" is never "not set up"',
    );
    assert.equal(unreadable.client.rows("app_auth_second_step").length, 0, "and nothing was written on the way");

    // 🔴 THE DATABASE DECIDES A RACE, NOT THE READ. Two requests carry the same code and both read the row
    // before either wrote: this one's read is stale, the row already holds the step, and its claim finds nothing.
    const raceStep = totpStepAt(now);
    const raceCode = totpCode(RFC_KEY, raceStep);
    for (const staleStep of [null, raceStep - 5]) {
      const sealed = sealSecret(RFC_KEY, { context: "second-sign-in-step", keyEnv: "PHOENIX_AUTH_SECRET" });
      const row = { enrolled_at: new Date(now).toISOString(), login_id: LOGIN, pending_created_at: null, pending_secret_sealed: null, secret_sealed: sealed };
      const live = fakeSupabaseClient({ app_auth_second_step: [{ ...row, last_used_step: raceStep }] });
      const staleRead = fakeSupabaseClient({ app_auth_second_step: [{ ...row, last_used_step: staleStep }] });
      const racing = {
        from(name: string) {
          const writes = live.from(name);
          const select = writes.select.bind(writes);
          let wrote = false;
          for (const verb of ["update", "insert", "upsert", "delete"] as const) {
            const real = (writes[verb] as (...args: unknown[]) => unknown).bind(writes);
            (writes as unknown as Record<string, unknown>)[verb] = (...args: unknown[]) => {
              wrote = true;
              return real(...args);
            };
          }
          (writes as unknown as Record<string, unknown>).select = (columns?: string) => (wrote ? select(columns) : staleRead.from(name).select(columns));
          return writes;
        },
      } as unknown as SecondStepDb;
      assert.equal(
        await checkSecondStepCode({ code: raceCode, db: racing, loginId: LOGIN, nowMs: now }),
        null,
        `🔴 a code another request already used is refused by the write itself (this request read last step ${String(staleStep)})`,
      );
      assert.equal(live.rows("app_auth_second_step")[0].last_used_step, raceStep);
    }
    // The remembered-browser read as well: an account that is set up, whose browser table cannot be read.
    const setUpAgain = db();
    const seedOffer = await secondStepAtSignIn({ account: LOGIN, canFinishSetup: true, code: undefined, db: setUpAgain.db, loginId: LOGIN, nowMs: now, role: "Super Admin", trustedDeviceToken: null });
    const seedSecret = seedOffer.kind === "offer_setup" ? seedOffer.setup.secret : "";
    await secondStepAtSignIn({ account: LOGIN, canFinishSetup: true, code: totpCode(seedSecret, totpStepAt(now)), db: setUpAgain.db, loginId: LOGIN, nowMs: now, role: "Super Admin", trustedDeviceToken: null });
    const brokenDevices = db(
      { app_auth_second_step: setUpAgain.client.rows("app_auth_second_step").map((row) => ({ ...row })) },
      { app_auth_trusted_devices: "connection refused" },
    );
    await assert.rejects(
      secondStepAtSignIn({ account: LOGIN, canFinishSetup: true, code: undefined, db: brokenDevices.db, loginId: LOGIN, nowMs: now, role: "Super Admin", trustedDeviceToken: "x".repeat(43) }),
      refusedRead,
      "a failed read of the remembered browsers throws: it is never read as trusted",
    );

    // ── 6. The sign-in route, the account's screen and the tables ────────────────────────────────
    const route = stripComments(readFileSync(LOGIN_ROUTE, "utf8"));
    const passwordChecked = route.indexOf("temporaryPasswordSignInGate(user)");
    const gate = route.indexOf("await secondStepAtSignIn({");
    const session = route.indexOf("appSession = await createAppSession(");
    const bridge = route.indexOf("const supabaseSessionRequired = isSupabaseBridgeRequiredForRole(user.role);");
    assert.ok(passwordChecked !== -1 && gate !== -1 && session !== -1 && bridge !== -1, `${LOGIN_ROUTE} still has its password gate, the second step, the bridge and the session`);
    assert.ok(passwordChecked < gate, "the step is asked only after the password was verified");
    assert.ok(gate < bridge && gate < session, "🔴 the step is asked BEFORE the bridge and before any session is opened");
    assert.equal(route.split("createAppSession(").length - 1, 1, "the route opens a session in one place");
    const gateCall = route.slice(route.lastIndexOf("const secondStep =", gate), route.indexOf("});", gate));
    assert.match(gateCall, /const secondStep = ciSmokeMode\s*\?/, "CI smoke mode is the only sign-in left out");
    assert.ok(!/native|isNative|x-phoenix/i.test(gateCall), '🔴 nothing the request says about itself excuses the step: "I am the native app" is a header anyone can send');
    assert.ok(gateCall.includes("loginId: user.loginId") && gateCall.includes("role: user.role"), "the step is asked of the STORED account and role, never of what was typed");
    assert.ok(gateCall.includes('canFinishSetup: payload.responseMode === "json"'), "a form posted with no script may not finish a set-up");

    const between = route.slice(gate, bridge);
    for (const kind of ["ask_code", "offer_setup", "wrong_code"]) {
      const at = between.indexOf(`secondStep.kind === "${kind}"`);
      assert.notEqual(at, -1, `the route answers ${kind}`);
      const block = between.slice(at, between.indexOf("\n    }\n", at));
      assert.ok(/return (loginFailureResponse|NextResponse\.json)\(/.test(block), `${kind} returns: nothing below it runs`);
      assert.ok(!block.includes("status: 200"), `${kind} is never a 200`);
    }
    assert.ok(/second_step_required[\s\S]{0,200}status: 403/.test(between), "asked for a code answers 403: a client that does not know the answer reads it as not signed in");
    assert.ok(/second_step_setup_required[\s\S]{0,300}status: 403/.test(between));
    assert.ok(/second_step_invalid[\s\S]{0,400}status: 401/.test(between));
    const wrong = between.slice(between.indexOf('secondStep.kind === "wrong_code"'));
    assert.ok(
      wrong.indexOf("await registerFailedLoginAttempt({ ip, loginId: user.loginId })") !== -1 &&
        wrong.indexOf("await registerFailedLoginAttempt({ ip, loginId: user.loginId })") < wrong.indexOf("return "),
      "🔴 a wrong code is counted with the wrong passwords, so guessing a code locks the account",
    );
    assert.ok(!/catch\s*\([^)]*\)\s*{[^}]*kind: "pass"/.test(route), "no catch turns a failed read into a pass");
    // The key of a set-up travels only in a JSON body marked no-store, never in a redirect.
    assert.ok(/loginFailureResponse\(request, payload, "second_step_setup_required", "", 403\)/.test(between), "a form post is told to set up, and is not handed the key in an address");

    // A set-up finished by a request whose sign-in then failed is undone, so the codes nobody saw are not left behind.
    assert.ok(route.includes("undoSecondStepSetupFor = user.loginId;"));
    assert.ok(route.split("await resetSecondStep(undoSecondStepSetupFor)").length - 1 >= 2, "both failure paths after the step undo an unfinished set-up");
    assert.ok(route.indexOf("undoSecondStepSetupFor = null;", session) !== -1, "and nothing is undone once the session exists");
    assert.ok(/secondStep: secondStep\.by/.test(route), "the success audit row says what carried the second step");

    // The remembered-browser cookie.
    const cookieAt = route.indexOf("name: trustedDeviceCookieName");
    const cookie = route.slice(route.lastIndexOf("response.cookies.set({", cookieAt), route.indexOf("});", cookieAt));
    assert.ok(cookie.includes("httpOnly: true"), "the page's script cannot read the remembered-browser cookie");
    assert.ok(cookie.includes('path: "/api/auth"'), "it is sent to the sign-in routes and nowhere else");
    assert.ok(cookie.includes('sameSite: "lax"') && cookie.includes('secure: process.env.NODE_ENV === "production"'));
    assert.equal(trustedDeviceCookieName, "phoenix_trusted_device");
    assert.ok(/const rememberThisBrowser =\s*\(secondStep\.by === "totp" \|\| secondStep\.by === "recovery" \|\| secondStep\.by === "set_up"\)/.test(route), "a browser is remembered only when a code was just given on it");

    // "Passkey counts": the passkey sign-in demands user verification and is not asked for a code.
    const passkey = stripComments(readFileSync(PASSKEY_ROUTE, "utf8"));
    assert.ok(!passkey.includes("second-step"), 'his choice: "passkey counts" — the passkey sign-in is both steps at once');
    const webauthn = stripComments(readFileSync("src/lib/auth/webauthn.ts", "utf8"));
    assert.ok(webauthn.split("requireUserVerification: true").length - 1 >= 2, "which holds only while a passkey demands the fingerprint, face or PIN");
    assert.ok(!webauthn.includes("requireUserVerification: false"));

    // The account's own screen.
    const manage = stripComments(readFileSync(MANAGE_ROUTE, "utf8"));
    assert.ok(manage.includes("if (access.seatView || !secondStepRequiredForRole(access.role)) return { failure: \"forbidden\" as const };"), "a Super Admin, acting as themselves: a seat view is refused");
    assert.ok(manage.includes("resolveSessionState(sessionToken, { allowRecentCopy: false })"), "the session is read fresh from its cookie");
    for (const handler of ["export async function GET", "export async function POST"]) {
      const at = manage.indexOf(handler);
      const guard = manage.indexOf("await requireSuperAdminSession(request)", at);
      const firstStore = Math.min(
        ...["readSecondStepStatus(", "beginSecondStepSetup(", "resetSecondStep(", "forgetTrustedDevices(", "renewRecoveryCodes(", "finishSecondStepSetup(", "request.json()"]
          .map((call) => manage.indexOf(call, at))
          .filter((index) => index !== -1),
      );
      assert.ok(at !== -1 && guard !== -1 && guard < firstStore, `${handler}: the session is checked before anything is read or changed`);
    }
    assert.ok(
      manage.includes('new Set<Action>(["begin_setup", "new_recovery_codes", "reset", "reset_other"])'),
      "🔴 being handed a set-up key, making new codes and both resets ask for the password again: a session somebody else is using cannot put their phone on the account",
    );
    const card = stripComments(readFileSync("src/components/auth/second-step-card.tsx", "utf8"));
    assert.ok(card.includes('post({ action: "begin_setup", password: currentPassword })') && !card.includes('post({ action: "begin_setup" })'), "the card sends the password with the set-up");

    // 🔴 A waiting key is never read back out for a later caller, and never sent with a refusal.
    const storeSource = stripComments(readFileSync("src/lib/auth/second-step-store.ts", "utf8"));
    const beginBody = storeSource.slice(storeSource.indexOf("export async function beginSecondStepSetup"), storeSource.indexOf("async function replaceRecoveryCodes"));
    assert.ok(beginBody.includes("generateTotpSecret()") && !beginBody.includes("openSecret("), "beginSecondStepSetup only ever makes a key; it opens none");
    const wrongBlock = wrong.slice(0, wrong.indexOf("\n    }\n"));
    assert.ok(wrongBlock.includes("status: 401") && !/\bsetup\b/.test(wrongBlock), "🔴 the wrong-code answer carries no set-up key");

    // The list of accounts another Super Admin may reset reads the role the way sign-in does.
    const management = stripComments(readFileSync("src/lib/auth/second-step-management.ts", "utf8"));
    assert.ok(
      management.includes("secondStepRequiredForRole(normalizeRole(user.role))") && !management.includes('.in("role"'),
      'an account stored as "super admin" or "admin" is asked at sign-in, so it is on the reset list too',
    );
    const passwordGate = manage.indexOf("if (PASSWORD_ACTIONS.has(action))");
    assert.ok(passwordGate !== -1 && passwordGate < manage.indexOf('if (action === "begin_setup")'), "the password is asked before any action runs");
    const resetOther = manage.slice(manage.indexOf("const target ="));
    assert.ok(resetOther.indexOf("listOtherSecondStepAccounts(loginId)") < resetOther.indexOf("await resetSecondStep(other.loginId)"), "another account is reset only if it is on the list of accounts the step is asked of");
    assert.ok(resetOther.includes("resetBy: loginId"), "and the audit row names both accounts");
    assert.ok(manage.indexOf("rejectUntrustedForwardedOrigin(request)") < manage.indexOf("await requireSuperAdminSession(request)", manage.indexOf("export async function POST")));
    assert.ok(manage.includes('scope: "auth:second-step"') && manage.includes("limit: 10"), "ten changes in 15 minutes");

    const page = stripComments(readFileSync(PROFILE_PAGE, "utf8"));
    assert.ok(page.includes("{secondStepRequiredForRole(access.role) && !access.seatView ? <SecondStepCard /> : null}"), "the card is on a Super Admin's own profile only");

    const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
    assert.ok(registry.includes('pattern: "/api/auth/second-step"'), "the route is in the access registry");

    // The tables: server only.
    const sql = readFileSync(MIGRATION, "utf8").replace(/--.*$/gm, "");
    for (const table of ["app_auth_second_step", "app_auth_second_step_recovery_codes", "app_auth_trusted_devices"]) {
      assert.ok(sql.includes(`alter table public.${table} enable row level security;`), `${table}: row level security is on`);
      for (const role of ["public", "anon", "authenticated"]) {
        assert.ok(sql.includes(`revoke all on table public.${table} from ${role};`), `${table}: ${role} holds nothing`);
      }
      assert.ok(sql.includes(`grant select, insert, update, delete on table public.${table} to service_role;`));
    }
    assert.ok(!/create policy/i.test(sql), "no policy: the browser key can neither read nor write the three tables");
    assert.ok(!/grant[^;]*\b(anon|authenticated)\b/i.test(sql));
    assert.ok(/login_id\s+text primary key references public\.app_auth_users\(login_id\) on update cascade on delete cascade/.test(sql), "a removed account takes its second step with it");

    // A new password ends every remembered browser.
    for (const file of ["src/lib/auth/change-password.ts", "src/lib/auth/password-setup.ts"]) {
      const code = stripComments(readFileSync(file, "utf8"));
      assert.ok(/const trustedDevicesForgotten = await forgetTrustedDevices\(/.test(code), `${file}: a new password forgets the remembered browsers`);
      assert.ok(code.indexOf("trustedDevicesForgotten,") > code.indexOf("const trustedDevicesForgotten"), `${file}: and the audit row says whether it did`);
    }
  } finally {
    if (priorSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = priorSecret;
  }
}
