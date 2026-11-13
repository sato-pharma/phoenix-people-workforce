/**
 * The rows behind the second sign-in step (rules and arithmetic: second-step.ts; migration
 * 20261113213439_second_sign_in_step.sql).
 *
 * Three tables, all server-only (RLS on, no policy):
 *   app_auth_second_step                 the account's authenticator key, SEALED, and its last used step
 *   app_auth_second_step_recovery_codes  ten one-time codes, as keyed fingerprints
 *   app_auth_trusted_devices             browsers that passed the step, by the fingerprint of their cookie
 *
 * 🔴 EVERY READ HERE FAILS CLOSED. A read that errors throws; the sign-in route answers 500 and opens no
 * session. Nothing in this file turns "could not read" into "not set up" or "trusted".
 * 🔴 `loginId` is always the account's own stored login id (the row the password was checked against), never
 * what the person typed.
 */

import {
  PENDING_SETUP_MINUTES,
  TRUSTED_DEVICE_MAX_AGE_SECONDS,
  decideSecondStep,
  generateRecoveryCodes,
  generateTotpSecret,
  looksLikeTrustedDeviceToken,
  matchTotp,
  newTrustedDeviceToken,
  otpauthUri,
  readSecondStepCode,
  recoveryCodeHash,
  secondStepRequiredForRole,
  secretForTyping,
  trustedDeviceTokenHash,
} from "@/lib/auth/second-step";
import { openSecret, sealSecret } from "@/lib/security/secret-box";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const SEAL = { context: "second-sign-in-step", keyEnv: "PHOENIX_AUTH_SECRET" } as const;

/**
 * The database these functions write to. Always the server's own client in the app; the tests hand in an
 * in-memory one (tests/fixtures/fake-supabase-table.ts), because the suite runs with production's keys and
 * must never write a row there.
 */
export type SecondStepDb = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

function dbOf(db?: SecondStepDb): SecondStepDb {
  return db ?? getSupabaseAdmin();
}

type SecondStepRow = {
  enrolled_at: string | null;
  last_used_step: number | string | null;
  login_id: string;
  pending_created_at: string | null;
  pending_secret_sealed: string | null;
  secret_sealed: string | null;
};

const ROW_COLUMNS = "login_id, secret_sealed, pending_secret_sealed, pending_created_at, enrolled_at, last_used_step";

async function readRow(loginId: string, db?: SecondStepDb): Promise<SecondStepRow | null> {
  const { data, error } = await dbOf(db)
    .from("app_auth_second_step")
    .select(ROW_COLUMNS)
    .eq("login_id", loginId)
    .maybeSingle();
  if (error) throw error;
  return (data as SecondStepRow | null) ?? null;
}

function lastUsedStepOf(row: SecondStepRow): number | null {
  if (row.last_used_step === null || row.last_used_step === undefined) return null;
  const step = Number(row.last_used_step);
  return Number.isSafeInteger(step) ? step : null;
}

/** True when the account has finished setting up its authenticator app. */
export async function secondStepIsSetUp(loginId: string, db?: SecondStepDb): Promise<boolean> {
  const row = await readRow(loginId, db);
  return Boolean(row?.secret_sealed);
}

/** True while a set-up key is waiting for its first code: handed over under 15 minutes ago, not finished. */
function setupIsWaiting(row: SecondStepRow | null, nowMs: number): boolean {
  if (!row || row.secret_sealed || !row.pending_secret_sealed || !row.pending_created_at) return false;
  const age = nowMs - new Date(row.pending_created_at).getTime();
  return age >= 0 && age < PENDING_SETUP_MINUTES * 60 * 1000;
}

/**
 * The key to set up with.
 *
 * 🔴 EVERY CALL MAKES A NEW KEY, AND THE ONE BEFORE IT STOPS WORKING. A key is shown to one screen, once,
 * and is never read back out of the table for a later caller. Handing a waiting key to the next caller
 * (as this did until the risk review of 13 Nov 2026) let anyone who knew the password collect the very key
 * the owner was about to put in their phone, and then make the owner's codes for good with nothing to
 * show for it. The price: reloading the set-up screen shows a new key, and the old one must be removed
 * from the app.
 * Never called for an account that is already set up.
 */
export async function beginSecondStepSetup(loginId: string, nowMs = Date.now(), db?: SecondStepDb): Promise<{ secret: string }> {
  const row = await readRow(loginId, db);
  if (row?.secret_sealed) throw new Error("This account's second sign-in step is already set up.");

  const secret = generateTotpSecret();
  const now = new Date(nowMs).toISOString();
  const { error } = await dbOf(db)
    .from("app_auth_second_step")
    .upsert(
      { login_id: loginId, pending_created_at: now, pending_secret_sealed: sealSecret(secret, SEAL), updated_at: now },
      { onConflict: "login_id" },
    );
  if (error) throw error;
  return { secret };
}

async function replaceRecoveryCodes(loginId: string, db?: SecondStepDb): Promise<string[]> {
  const supabase = dbOf(db);
  const { error: deleteError } = await supabase.from("app_auth_second_step_recovery_codes").delete().eq("login_id", loginId);
  if (deleteError) throw deleteError;
  const codes = generateRecoveryCodes();
  const { error: insertError } = await supabase.from("app_auth_second_step_recovery_codes").insert(
    codes.map((code) => ({ code_hash: recoveryCodeHash(loginId, code.replace("-", "")), login_id: loginId, used_at: null })),
  );
  if (insertError) throw insertError;
  return codes;
}

/**
 * Finishes a set-up: the code must be the authenticator's own, computed from the key handed over. On
 * success the key becomes the account's key, ten recovery codes are made (returned ONCE, never readable
 * again) and every earlier trusted browser is forgotten. Null when the code is wrong or the key expired.
 */
export async function finishSecondStepSetup(input: {
  code: unknown;
  db?: SecondStepDb;
  loginId: string;
  nowMs?: number;
}): Promise<{ recoveryCodes: string[] } | null> {
  const nowMs = input.nowMs ?? Date.now();
  const typed = readSecondStepCode(input.code);
  if (typed?.kind !== "totp") return null;

  const row = await readRow(input.loginId, input.db);
  if (!row || !setupIsWaiting(row, nowMs) || !row.pending_secret_sealed) return null;

  const secret = openSecret(row.pending_secret_sealed, SEAL);
  const step = matchTotp({ code: typed.code, lastUsedStep: null, nowMs, secret });
  if (step === null) return null;

  const now = new Date(nowMs).toISOString();
  const supabase = dbOf(input.db);
  // Only a row still waiting on THIS key is promoted: two finishes at once cannot both win.
  const { data, error } = await supabase
    .from("app_auth_second_step")
    .update({
      enrolled_at: now,
      last_used_step: step,
      pending_created_at: null,
      pending_secret_sealed: null,
      secret_sealed: row.pending_secret_sealed,
      updated_at: now,
    })
    .eq("login_id", input.loginId)
    .is("secret_sealed", null)
    .eq("pending_secret_sealed", row.pending_secret_sealed)
    .select("login_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  try {
    await forgetTrustedDevices(input.loginId, input.db);
    return { recoveryCodes: await replaceRecoveryCodes(input.loginId, input.db) };
  } catch (afterPromotion) {
    // The key became the account's key and then the codes could not be made. Left so, the account would
    // be set up with no recovery code and nobody told. The row goes (its children with it), the account
    // is "not set up" again, and the caller hears the failure.
    await supabase.from("app_auth_second_step").delete().eq("login_id", input.loginId).then(
      () => undefined,
      () => undefined,
    );
    throw afterPromotion;
  }
}

/**
 * Checks a typed code for an account that is set up. An authenticator code is accepted once (the step it
 * belongs to is recorded, and only a newer step is accepted next); a recovery code is spent by the same
 * statement that finds it. Null when the code is wrong, already used, or the account is not set up.
 */
export async function checkSecondStepCode(input: {
  code: unknown;
  db?: SecondStepDb;
  loginId: string;
  nowMs?: number;
}): Promise<"totp" | "recovery" | null> {
  const nowMs = input.nowMs ?? Date.now();
  const typed = readSecondStepCode(input.code);
  if (!typed) return null;

  const row = await readRow(input.loginId, input.db);
  if (!row?.secret_sealed) return null;
  const supabase = dbOf(input.db);
  const now = new Date(nowMs).toISOString();

  if (typed.kind === "totp") {
    const lastUsedStep = lastUsedStepOf(row);
    const step = matchTotp({ code: typed.code, lastUsedStep, nowMs, secret: openSecret(row.secret_sealed, SEAL) });
    if (step === null) return null;
    // The database decides the race, never the read above: the step is taken only by a statement that
    // still finds the row as it was read (no step used yet, or an older one). Two requests carrying the
    // same code cannot both find it so.
    const claim = supabase
      .from("app_auth_second_step")
      .update({ last_used_step: step, updated_at: now })
      .eq("login_id", input.loginId);
    const { data, error } = await (lastUsedStep === null ? claim.is("last_used_step", null) : claim.lt("last_used_step", step))
      .select("login_id")
      .maybeSingle();
    if (error) throw error;
    return data ? "totp" : null;
  }

  const { data, error } = await supabase
    .from("app_auth_second_step_recovery_codes")
    .update({ used_at: now })
    .eq("login_id", input.loginId)
    .eq("code_hash", recoveryCodeHash(input.loginId, typed.code))
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data ? "recovery" : null;
}

/** A new trusted browser: the token goes into its cookie, only the fingerprint is stored. */
export async function issueTrustedDevice(input: {
  db?: SecondStepDb;
  loginId: string;
  nowMs?: number;
  userAgent: string | null;
}): Promise<{ maxAgeSeconds: number; token: string }> {
  const nowMs = input.nowMs ?? Date.now();
  const token = newTrustedDeviceToken();
  const { error } = await dbOf(input.db).from("app_auth_trusted_devices").insert({
    expires_at: new Date(nowMs + TRUSTED_DEVICE_MAX_AGE_SECONDS * 1000).toISOString(),
    login_id: input.loginId,
    token_hash: trustedDeviceTokenHash(token),
    user_agent: input.userAgent ? input.userAgent.slice(0, 300) : null,
  });
  if (error) throw error;
  return { maxAgeSeconds: TRUSTED_DEVICE_MAX_AGE_SECONDS, token };
}

/** True only for a token this account was given, inside its 30 days. */
export async function trustedDeviceIsValid(input: {
  db?: SecondStepDb;
  loginId: string;
  nowMs?: number;
  token: unknown;
}): Promise<boolean> {
  if (!looksLikeTrustedDeviceToken(input.token)) return false;
  const nowMs = input.nowMs ?? Date.now();
  const supabase = dbOf(input.db);
  const { data, error } = await supabase
    .from("app_auth_trusted_devices")
    .select("id, expires_at")
    .eq("login_id", input.loginId)
    .eq("token_hash", trustedDeviceTokenHash(input.token))
    .maybeSingle();
  if (error) throw error;
  const row = data as { expires_at: string; id: string } | null;
  if (!row || new Date(row.expires_at).getTime() <= nowMs) return false;
  // When it was last used is a courtesy for the account's own screen; a failed write changes nothing.
  await supabase.from("app_auth_trusted_devices").update({ last_used_at: new Date(nowMs).toISOString() }).eq("id", row.id).then(
    () => undefined,
    () => undefined,
  );
  return true;
}

/** Every browser of this account is asked for a code again. Called on a password change and a reset. */
export async function forgetTrustedDevices(loginId: string, db?: SecondStepDb): Promise<void> {
  const { error } = await dbOf(db).from("app_auth_trusted_devices").delete().eq("login_id", loginId);
  if (error) throw error;
}

/**
 * Returns an account to "not set up": its trusted browsers, its recovery codes and its key all go, in that
 * order and each by name (the foreign keys' cascade would take the first two as well; nothing here leans
 * on it). Its next password sign-in is offered a new set-up. True when there was a row to remove.
 */
export async function resetSecondStep(loginId: string, db?: SecondStepDb): Promise<boolean> {
  const supabase = dbOf(db);
  await forgetTrustedDevices(loginId, db);
  const { error: codesError } = await supabase.from("app_auth_second_step_recovery_codes").delete().eq("login_id", loginId);
  if (codesError) throw codesError;
  const { data, error } = await supabase
    .from("app_auth_second_step")
    .delete()
    .eq("login_id", loginId)
    .select("login_id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/** Ten new recovery codes; the old ones stop working. Returned once. */
export async function renewRecoveryCodes(loginId: string, db?: SecondStepDb): Promise<string[]> {
  if (!(await secondStepIsSetUp(loginId, db))) throw new Error("This account's second sign-in step is not set up.");
  return replaceRecoveryCodes(loginId, db);
}

export type SecondStepStatus = {
  recoveryCodesLeft: number;
  setUp: boolean;
  setUpAt: string | null;
  trustedDevices: number;
};

/** What an account's own screen shows. Counts only: never a key, a code or a token. */
export async function readSecondStepStatus(loginId: string, nowMs = Date.now(), db?: SecondStepDb): Promise<SecondStepStatus> {
  const row = await readRow(loginId, db);
  if (!row?.secret_sealed) return { recoveryCodesLeft: 0, setUp: false, setUpAt: null, trustedDevices: 0 };
  const supabase = dbOf(db);
  // Ten codes and a handful of browsers at most, so the rows are counted here.
  const [codes, devices] = await Promise.all([
    supabase.from("app_auth_second_step_recovery_codes").select("id").eq("login_id", loginId).is("used_at", null),
    supabase.from("app_auth_trusted_devices").select("id, expires_at").eq("login_id", loginId),
  ]);
  if (codes.error) throw codes.error;
  if (devices.error) throw devices.error;
  const liveDevices = ((devices.data ?? []) as Array<{ expires_at: string }>).filter(
    (device) => new Date(device.expires_at).getTime() > nowMs,
  );
  return {
    recoveryCodesLeft: (codes.data ?? []).length,
    setUp: true,
    setUpAt: row.enrolled_at,
    trustedDevices: liveDevices.length,
  };
}

// ── The whole step, as the sign-in route asks it ────────────────────────────────────────────────

/** What the sign-in page needs to set an authenticator app up: the key, typed or opened by link. */
export type SecondStepSetupOffer = {
  account: string;
  otpauthUri: string;
  secret: string;
  secretForTyping: string;
};

export type SecondStepSignInOutcome =
  /** Go on and open the session. `by` says what carried it, for the audit row. */
  | { by: "not_required" | "trusted_device" | "totp" | "recovery"; kind: "pass" }
  /** The set-up was finished by this request: the ten recovery codes are shown now and never again. */
  | { by: "set_up"; kind: "pass"; recoveryCodes: string[] }
  | { kind: "ask_code" }
  | { kind: "offer_setup"; setup: SecondStepSetupOffer }
  /**
   * `duringSetup` says the code was typed against a key still waiting on the person's screen. The key is
   * NOT sent again with the refusal: the screen that was given it still has it, and nobody else gets it.
   */
  | { duringSetup: boolean; kind: "wrong_code" };

async function setupOffer(input: { account: string; db?: SecondStepDb; loginId: string; nowMs: number }): Promise<SecondStepSetupOffer> {
  const { secret } = await beginSecondStepSetup(input.loginId, input.nowMs, input.db);
  return {
    account: input.account,
    otpauthUri: otpauthUri({ account: input.account, secret }),
    secret,
    secretForTyping: secretForTyping(secret),
  };
}

/**
 * The second step of ONE password sign-in whose password was already verified.
 *
 * 🔴 Call it only after the password check passed, with the account's stored login id and role. It never
 * opens a session itself; "pass" only says the route may.
 * `canFinishSetup` is false for a sign-in that cannot show the recovery codes (a form posted with no
 * script): such a request is never allowed to finish a set-up, because the codes would be made and lost.
 */
export async function secondStepAtSignIn(input: {
  account: string;
  canFinishSetup: boolean;
  code: unknown;
  db?: SecondStepDb;
  loginId: string;
  nowMs?: number;
  role: string | null | undefined;
  trustedDeviceToken: unknown;
}): Promise<SecondStepSignInOutcome> {
  if (!secondStepRequiredForRole(input.role)) return { by: "not_required", kind: "pass" };

  const nowMs = input.nowMs ?? Date.now();
  const { db, loginId } = input;
  const setUp = await secondStepIsSetUp(loginId, db);
  const codeTyped = typeof input.code === "string" && input.code.trim() !== "";
  // A trusted browser is looked up only for an account that is set up (decideSecondStep says why).
  const trustedDevice = setUp && (await trustedDeviceIsValid({ db, loginId, nowMs, token: input.trustedDeviceToken }));
  const decision = decideSecondStep({
    codeSent: codeTyped && (setUp || input.canFinishSetup),
    required: true,
    setUp,
    trustedDevice,
  });

  if (decision === "pass") return { by: "trusted_device", kind: "pass" };
  if (decision === "ask_code") return { kind: "ask_code" };
  if (decision === "offer_setup") {
    return { kind: "offer_setup", setup: await setupOffer({ account: input.account, db, loginId, nowMs }) };
  }
  if (decision === "check_code") {
    const by = await checkSecondStepCode({ code: input.code, db, loginId, nowMs });
    return by ? { by, kind: "pass" } : { duringSetup: false, kind: "wrong_code" };
  }
  const finished = await finishSecondStepSetup({ code: input.code, db, loginId, nowMs });
  if (finished) return { by: "set_up", kind: "pass", recoveryCodes: finished.recoveryCodes };

  const row = await readRow(loginId, db);
  // Another request finished the set-up while this one was checking its code.
  if (row?.secret_sealed) return { duringSetup: false, kind: "wrong_code" };
  // A key is still waiting: the code was wrong, or it belongs to a key that was replaced. Refused, and the
  // waiting key stays where it is, unread.
  if (setupIsWaiting(row, nowMs)) return { duringSetup: true, kind: "wrong_code" };
  // No key is waiting any more (15 minutes passed): a new one.
  return { kind: "offer_setup", setup: await setupOffer({ account: input.account, db, loginId, nowMs }) };
}
