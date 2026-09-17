// Sign-in throttling limits. Kept free of imports so the rules are testable without a database;
// src/lib/auth/audit.ts reads the attempt history and applies them.
//
// Two gates refuse a sign-in inside the rolling window:
//   - one ACCOUNT that fails too often is locked (a password being guessed), and
//   - one NETWORK ADDRESS that fails too often is refused for everyone behind it (one machine
//     spraying guesses across many accounts).
//
// The network gate cannot tell an attacker from an office: a whole office reaches us through one
// public address. On 2026-09-16 fifteen typos from five colleagues in seven minutes ("AL-0018" for
// "AI-0018", a bare "0012") refused sign-in to the WHOLE office, including a new hire who had not
// made a single failed attempt. What separates the two is that an office has already let colleagues
// in. So the address limit grows by one account's allowance for every DIFFERENT account that signed
// in successfully from it in the lookback — never below the strict limit, never above the ceiling.
// An address nobody has signed in from keeps the strict limit, and the account lock is unchanged.

export const loginThrottleWindowMinutes = 15;
export const loginThrottleMaxFailures = 10;
export const loginIpThrottleMaxFailures = 15;
export const loginLockoutMinutes = 30;
export const loginSharedNetworkLookbackHours = 24;
export const loginSharedNetworkMaxFailures = 150;

/** Failed sign-ins one network address may make inside the window before it is refused. */
export function loginIpFailureLimit(accountsSignedInFromIp: number) {
  const accounts = Number.isFinite(accountsSignedInFromIp) ? Math.max(0, Math.floor(accountsSignedInFromIp)) : 0;
  return Math.min(
    loginSharedNetworkMaxFailures,
    Math.max(loginIpThrottleMaxFailures, accounts * loginThrottleMaxFailures),
  );
}
