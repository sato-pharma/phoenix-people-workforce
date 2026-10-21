import { strict as assert } from "node:assert";

import {
  PREVIOUS_SECRET_ACCEPTED_UNTIL,
  previousAuthSecret,
  previousCronSecret,
} from "../src/lib/auth/previous-secret.ts";
import { createSessionToken, verifySessionToken } from "../src/lib/auth/session-token.ts";
import {
  acknowledgmentTokenAnswers,
  issueAcknowledgmentToken,
} from "../src/lib/automated-payroll/acknowledgment-token.ts";
import { openSignatureToken, sealSignatureToken } from "../src/lib/email-signature/signature-token.ts";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "../src/lib/email/unsubscribe-token.ts";
import { issueOfferAcceptToken, readOfferAcceptToken } from "../src/lib/offers/accept-token.ts";
import {
  openClosingSelectionSeal,
  sealClosingSelection,
  type SealedClosingSelection,
} from "../src/lib/sales/closing-pdf-link-seal.ts";
import { assertCronAuthorized, previousCronSecretAuthorized } from "../src/lib/security/cron-auth.ts";
import { issueShareCardToken, readShareCardToken } from "../src/lib/share/share-card-token.ts";

/**
 * THE OCTOBER 2026 SECRET ROTATION — old LINKS keep opening for a limited time, LOGINS never fall back.
 *
 * Railway reported a security incident on 21 October 2026, so PHOENIX_AUTH_SECRET and CRON_SECRET are
 * being replaced. The old values arrive as PHOENIX_AUTH_SECRET_PREVIOUS and CRON_SECRET_PREVIOUS
 * (src/lib/auth/previous-secret.ts). These tests prove three things:
 *
 *  1. a link sealed under the OLD secret still opens after the switch, while the window is open;
 *  2. it stops opening when the previous value is unset, equal to the current one, or past the end date;
 *  3. a login session (and a payroll acknowledgment) signed under the OLD secret never verifies at all.
 *
 * Every test sets the four variables it needs and restores them exactly, including having been unset.
 */

const OLD = "old-auth-secret-for-the-rotation-test";
const NEW = "new-auth-secret-for-the-rotation-test";
const OLD_CRON = "old-cron-secret-for-the-rotation-test";
const NEW_CRON = "new-cron-secret-for-the-rotation-test";

const END_MS = Date.parse(PREVIOUS_SECRET_ACCEPTED_UNTIL);
/** One day inside the window, and one minute past it — explicit, so the test never rots with the clock. */
const BEFORE = new Date(END_MS - 24 * 60 * 60 * 1000);
const AFTER = new Date(END_MS + 60 * 1000);
const BEFORE_SECONDS = Math.floor(BEFORE.getTime() / 1000);
const AFTER_SECONDS = Math.floor(AFTER.getTime() / 1000);

const ROTATION_KEYS = [
  "PHOENIX_AUTH_SECRET",
  "PHOENIX_AUTH_SECRET_PREVIOUS",
  "CRON_SECRET",
  "CRON_SECRET_PREVIOUS",
] as const;
type RotationKey = (typeof ROTATION_KEYS)[number];

const mutableEnv = process.env as Record<string, string | undefined>;

/** Run `fn` with exactly these four variables, then put back whatever was there before. */
function withRotationEnv(values: Partial<Record<RotationKey, string>>, fn: () => void) {
  const saved = ROTATION_KEYS.map((key) => [key, key in process.env, process.env[key]] as const);
  try {
    for (const key of ROTATION_KEYS) {
      const value = values[key];
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
    fn();
  } finally {
    for (const [key, had, value] of saved) {
      if (had) mutableEnv[key] = value;
      else delete mutableEnv[key];
    }
  }
}

/** Mint something under the OLD auth secret, the way it was minted before the rotation. */
function underOldSecret<T>(mint: () => T): T {
  let minted: T | undefined;
  withRotationEnv({ PHOENIX_AUTH_SECRET: OLD }, () => {
    minted = mint();
  });
  return minted as T;
}

/** Swallow the structured logger while `fn` runs, and hand back its value and what it printed. */
function captureLogs<T>(fn: () => T): { value: T; logs: string } {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const collect = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.log = collect;
  console.warn = collect;
  console.error = collect;
  console.info = collect;
  try {
    const value = fn();
    return { value, logs: lines.join("\n") };
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    console.info = originals.info;
  }
}

function cronRequest(secret: string) {
  return new Request("https://phoenix-hr.satopharma.com/api/cron/probe", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

const ROTATED = { PHOENIX_AUTH_SECRET: NEW, PHOENIX_AUTH_SECRET_PREVIOUS: OLD };

function helperTests() {
  assert.equal(PREVIOUS_SECRET_ACCEPTED_UNTIL, "2026-11-22T00:00:00+02:00", "the end date is midnight Cairo, 22 November 2026");
  assert.ok(Number.isFinite(END_MS), "the end date must parse, or every previous value would be refused");

  withRotationEnv(ROTATED, () => {
    assert.equal(previousAuthSecret(BEFORE), OLD, "inside the window the previous auth secret is offered");
    assert.equal(previousAuthSecret(AFTER), null, "HEADLINE: past the end date the previous auth secret is ignored even though it is still set");
    assert.equal(previousAuthSecret(new Date(END_MS)), null, "the end date itself is already closed");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: NEW }, () => {
    assert.equal(previousAuthSecret(BEFORE), null, "an unset previous secret offers nothing");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: NEW, PHOENIX_AUTH_SECRET_PREVIOUS: "   " }, () => {
    assert.equal(previousAuthSecret(BEFORE), null, "a blank previous secret offers nothing");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: NEW, PHOENIX_AUTH_SECRET_PREVIOUS: "too-short" }, () => {
    assert.equal(previousAuthSecret(BEFORE), null, "a previous secret under 16 characters is a typo, never a key");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: OLD, PHOENIX_AUTH_SECRET_PREVIOUS: OLD }, () => {
    assert.equal(previousAuthSecret(BEFORE), null, "HEADLINE: a previous secret equal to the current one is ignored");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: OLD, PHOENIX_AUTH_SECRET_PREVIOUS: `  ${OLD}  ` }, () => {
    assert.equal(previousAuthSecret(BEFORE), null, "equal after trimming is still equal");
  });

  withRotationEnv({ CRON_SECRET: NEW_CRON, CRON_SECRET_PREVIOUS: OLD_CRON }, () => {
    assert.equal(previousCronSecret(BEFORE), OLD_CRON, "inside the window the previous cron secret is offered");
    assert.equal(previousCronSecret(AFTER), null, "past the end date the previous cron secret is ignored");
  });
  withRotationEnv({ CRON_SECRET: OLD_CRON, CRON_SECRET_PREVIOUS: OLD_CRON }, () => {
    assert.equal(previousCronSecret(BEFORE), null, "a previous cron secret equal to the current one is ignored");
  });
  withRotationEnv({ CRON_SECRET: NEW_CRON }, () => {
    assert.equal(previousCronSecret(BEFORE), null, "an unset previous cron secret offers nothing");
  });
  withRotationEnv({ CRON_SECRET: NEW_CRON, PHOENIX_AUTH_SECRET_PREVIOUS: OLD_CRON }, () => {
    assert.equal(previousCronSecret(BEFORE), null, "the cron fallback reads only CRON_SECRET_PREVIOUS, never the auth one");
  });
}

function signatureTokenTests() {
  const token = underOldSecret(() => sealSignatureToken("B-10"));
  const expected = underOldSecret(() => openSignatureToken(token));
  assert.ok(expected, "control: the old address opens under the secret that sealed it");

  withRotationEnv(ROTATED, () => {
    assert.equal(openSignatureToken(token, BEFORE), expected, "HEADLINE: a signature address sealed under OLD opens when current=NEW and PREVIOUS=OLD");
    assert.equal(openSignatureToken(token, AFTER), null, "past the end date the old signature address no longer opens");
    const fresh = sealSignatureToken("B-10");
    assert.notEqual(fresh, token, "a new address is sealed with the NEW secret, never the previous one");
    assert.equal(openSignatureToken(fresh, AFTER), expected, "control: a NEW address still opens past the end date");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: NEW }, () => {
    assert.equal(openSignatureToken(token, BEFORE), null, "with PREVIOUS unset the old signature address does not open");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: NEW, PHOENIX_AUTH_SECRET_PREVIOUS: NEW }, () => {
    assert.equal(openSignatureToken(token, BEFORE), null, "a PREVIOUS equal to the current secret opens nothing old");
  });
}

function unsubscribeTokenTests() {
  const token = underOldSecret(() => createUnsubscribeToken("someone@satopharma.com", "marketing"));

  withRotationEnv(ROTATED, () => {
    const opened = verifyUnsubscribeToken(token, BEFORE);
    assert.ok(opened, "HEADLINE: an unsubscribe link signed under OLD opens when current=NEW and PREVIOUS=OLD");
    assert.equal(opened.addr, "someone@satopharma.com");
    assert.equal(opened.type, "marketing");
    assert.equal(verifyUnsubscribeToken(token, AFTER), null, "past the end date the old unsubscribe link no longer opens");
    const fresh = createUnsubscribeToken("someone@satopharma.com", "marketing");
    assert.ok(verifyUnsubscribeToken(fresh, AFTER), "control: a NEW link still opens past the end date, so the refusal above is the window");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: NEW }, () => {
    assert.equal(verifyUnsubscribeToken(token, BEFORE), null, "with PREVIOUS unset the old unsubscribe link does not open");
  });
}

function shareCardTokenTests() {
  const issuedBefore = underOldSecret(() =>
    issueShareCardToken({ kind: "performance", hrId: "B-10", nowSeconds: BEFORE_SECONDS - 24 * 60 * 60 }),
  );
  const issuedLate = underOldSecret(() =>
    issueShareCardToken({ kind: "performance", hrId: "B-10", nowSeconds: AFTER_SECONDS - 24 * 60 * 60 }),
  );

  withRotationEnv(ROTATED, () => {
    const opened = readShareCardToken(issuedBefore, BEFORE_SECONDS);
    assert.ok(opened, "HEADLINE: a share card signed under OLD opens when current=NEW and PREVIOUS=OLD");
    assert.equal(opened.k, "performance");
    assert.equal(
      readShareCardToken(issuedLate, AFTER_SECONDS),
      null,
      "past the end date an old share card no longer opens, even inside its own 30 days",
    );
    const fresh = issueShareCardToken({ kind: "performance", hrId: "B-10", nowSeconds: AFTER_SECONDS - 24 * 60 * 60 });
    assert.ok(readShareCardToken(fresh, AFTER_SECONDS), "control: a NEW card still opens past the end date");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: NEW }, () => {
    assert.equal(readShareCardToken(issuedBefore, BEFORE_SECONDS), null, "with PREVIOUS unset the old share card does not open");
  });
}

function offerAndClosingLinkTests() {
  const offer = underOldSecret(() =>
    issueOfferAcceptToken({ offerId: "OFFER-1", nowSeconds: BEFORE_SECONDS - 24 * 60 * 60 }),
  );
  const offerLate = underOldSecret(() =>
    issueOfferAcceptToken({ offerId: "OFFER-1", nowSeconds: AFTER_SECONDS - 24 * 60 * 60 }),
  );
  const selection: SealedClosingSelection = {
    filter: { areaCodes: [], productCodes: [], regionCodes: ["GZ"], search: "" },
    headOffice: false,
    line: "Pedia",
    period: "2026-08",
  };
  const seal = underOldSecret(() => sealClosingSelection(selection));
  assert.ok(seal, "control: a closing seal is minted under the old secret");

  withRotationEnv(ROTATED, () => {
    assert.equal(readOfferAcceptToken(offer, BEFORE_SECONDS), "OFFER-1", "an offer link signed under OLD opens inside the window");
    assert.equal(readOfferAcceptToken(offerLate, AFTER_SECONDS), null, "an old offer link stops opening past the end date");
    assert.equal(openClosingSelectionSeal(seal, BEFORE)?.line, "Pedia", "a closing PDF seal signed under OLD opens inside the window");
    assert.equal(openClosingSelectionSeal(seal, AFTER), null, "an old closing PDF seal stops opening past the end date");
  });
  withRotationEnv({ PHOENIX_AUTH_SECRET: NEW }, () => {
    assert.equal(readOfferAcceptToken(offer, BEFORE_SECONDS), null, "with PREVIOUS unset the old offer link does not open");
    assert.equal(openClosingSelectionSeal(seal, BEFORE), null, "with PREVIOUS unset the old closing seal does not open");
  });
}

function loginsNeverFallBackTests() {
  const session = underOldSecret(() =>
    createSessionToken({
      hrId: "B-10",
      loginId: "B-10",
      maxAgeSeconds: 3600,
      role: "Super Admin",
      sessionId: "SID-ROTATION",
      sessionVersion: 1,
    }),
  );
  assert.ok(underOldSecret(() => verifySessionToken(session)), "control: the old session verifies under the secret that signed it");

  withRotationEnv(ROTATED, () => {
    assert.equal(
      verifySessionToken(session),
      null,
      "HEADLINE: a SESSION signed under OLD must NOT verify, even with PREVIOUS=OLD inside the window — a leaked old secret never signs anybody in",
    );
    const fresh = createSessionToken({
      hrId: "B-10",
      loginId: "B-10",
      maxAgeSeconds: 3600,
      role: "Super Admin",
      sessionId: "SID-ROTATION",
      sessionVersion: 1,
    });
    assert.ok(verifySessionToken(fresh), "control: a session signed under NEW verifies");
  });

  const acknowledgment = {
    runId: "RUN-2026-10",
    gate: "overpaid" as const,
    actorHrId: "B-10",
    warning: "Three rows are paid more than last month.",
  };
  const ackToken = underOldSecret(() => issueAcknowledgmentToken(acknowledgment));
  assert.ok(
    underOldSecret(() => acknowledgmentTokenAnswers({ ...acknowledgment, token: ackToken })),
    "control: the old payroll acknowledgment answers under the secret that signed it",
  );
  withRotationEnv(ROTATED, () => {
    assert.equal(
      acknowledgmentTokenAnswers({ ...acknowledgment, token: ackToken }),
      false,
      "a payroll acknowledgment signed under OLD must NOT answer after the switch — it simply stops working",
    );
  });
}

function cronTests() {
  const cronRotated = { CRON_SECRET: NEW_CRON, CRON_SECRET_PREVIOUS: OLD_CRON };

  withRotationEnv(cronRotated, () => {
    assert.equal(previousCronSecretAuthorized(cronRequest(OLD_CRON), BEFORE), true, "HEADLINE: cron accepts the previous secret before the end date");
    assert.equal(previousCronSecretAuthorized(cronRequest(OLD_CRON), AFTER), false, "HEADLINE: cron refuses the previous secret after the end date");
    assert.equal(previousCronSecretAuthorized(cronRequest("some-other-bearer-value"), BEFORE), false, "a wrong bearer is never the previous secret");

    const windowOpen = Date.now() < END_MS;
    const previousRun = captureLogs(() => assertCronAuthorized(cronRequest(OLD_CRON), "cron/rotation-probe"));
    assert.equal(previousRun.value === null, windowOpen, "the shared cron guard accepts the previous secret exactly while the window is open");
    if (windowOpen) {
      assert.match(previousRun.logs, /cron_previous_secret/, "a run on the previous secret is logged, so the jobs still to move can be listed");
    }

    const current = captureLogs(() => assertCronAuthorized(cronRequest(NEW_CRON), "cron/rotation-probe")).value;
    assert.equal(current, null, "control: the new cron secret is accepted");

    const ownToken = captureLogs(() =>
      assertCronAuthorized(cronRequest(OLD_CRON), "cron/own-token-probe", { secret: "own-route-token-for-the-test" }),
    ).value;
    assert.ok(ownToken, "a route on its own token never accepts the previous CRON_SECRET");
  });

  withRotationEnv({ CRON_SECRET: NEW_CRON }, () => {
    assert.equal(previousCronSecretAuthorized(cronRequest(OLD_CRON), BEFORE), false, "with CRON_SECRET_PREVIOUS unset the old bearer is refused");
    const denied = captureLogs(() => assertCronAuthorized(cronRequest(OLD_CRON), "cron/rotation-probe")).value;
    assert.ok(denied, "with CRON_SECRET_PREVIOUS unset the shared guard refuses the old bearer");
  });

  withRotationEnv({ CRON_SECRET: OLD_CRON, CRON_SECRET_PREVIOUS: OLD_CRON }, () => {
    assert.equal(previousCronSecretAuthorized(cronRequest(OLD_CRON), BEFORE), false, "a previous cron secret equal to the current one is ignored");
  });

  withRotationEnv({ CRON_SECRET_PREVIOUS: OLD_CRON }, () => {
    const denied = captureLogs(() => assertCronAuthorized(cronRequest(OLD_CRON), "cron/rotation-probe")).value;
    // Outside a real dev machine an unset CRON_SECRET fails closed; the previous value never opens it.
    if (process.env.NODE_ENV !== "development") {
      assert.ok(denied, "an unset CRON_SECRET still fails closed — the previous value alone never authorizes");
    }
  });
}

export async function runAuthSecretPreviousTests() {
  helperTests();
  signatureTokenTests();
  unsubscribeTokenTests();
  shareCardTokenTests();
  offerAndClosingLinkTests();
  loginsNeverFallBackTests();
  cronTests();
}
