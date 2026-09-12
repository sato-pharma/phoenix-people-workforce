import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * YOU CANNOT ACKNOWLEDGE A WARNING YOU WERE NEVER SHOWN (audit finding 53).
 *
 * Part 1 and Part 2 confirm behind three acknowledgeable gates — missing pay-determining data, a
 * Part 1 overpayment, and someone paid last month who has vanished with no resignation on file.
 * None of them is a hard block, by the owner's rule: flag loudly, let HR accept it on the record,
 * never stop the month.
 *
 * The acknowledgement used to be A BOOLEAN IN THE REQUEST BODY. So the gate only ever fired for a
 * caller that had not already said yes: sending `{ acknowledgeDataIssues: true }` on the FIRST
 * request confirmed the run without the warning being computed for a human at all. Nothing failed,
 * nothing looked wrong — and the audit log recorded `payroll_data_issues_acknowledged`, which reads
 * as *HR was shown this and accepted it*, over a warning that was never rendered to anybody. That is
 * the worst shape a gate can fail in: it leaves a record saying the opposite of what happened.
 *
 * So the acknowledgement is now a token the SERVER mints, and only when a gate actually fires. The
 * token carries:
 *
 *   - the RUN, so an acknowledgement from one month cannot answer another;
 *   - the GATE, so accepting an overpayment does not also wave through vanished people;
 *   - the ACTOR, so one person's decision is not another person's permission;
 *   - a DIGEST of the exact warning that was shown, so the token answers THAT warning;
 *   - an EXPIRY, because a decision about live payroll data goes stale.
 *
 * The digest is what makes this more than a nonce. If the underlying data moves between the warning
 * and the retry — a salary filled in, a resignation filed, another person dropping out — the
 * sentence changes, the digest no longer matches, and the token is refused. The gate then asks
 * again, with the new text. That is the same promise the client-side reset makes (an acknowledgement
 * dies with its attempt, #3731), enforced where it cannot be skipped.
 *
 * Stateless on purpose: an HMAC over the payload, no table, no migration, nothing to clean up. The
 * signing secret is `PHOENIX_AUTH_SECRET`, the primitive the session and unsubscribe signers already
 * use. With no secret nothing mints and nothing verifies — the gate simply cannot be passed, which
 * is the correct direction to fail, and is moot in practice: sessions are signed with the same
 * secret, so without it nobody is logged in to confirm anything either.
 */

export type AcknowledgmentGate = "data-quality" | "overpaid" | "population-diff";

type AcknowledgmentPayload = {
  run: string;
  gate: AcknowledgmentGate;
  actor: string;
  digest: string;
  exp: number;
};

/**
 * Fifteen minutes. Long enough to read a list of names and decide, short enough that a token left in
 * a tab overnight cannot answer tomorrow's run. The digest is the real guard; this only bounds how
 * long a still-accurate warning stays answerable.
 */
const TOKEN_TTL_SECONDS = 15 * 60;

function signingSecret(): string {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("PHOENIX_AUTH_SECRET is required to issue a payroll acknowledgment.");
  }
  return secret;
}

function sign(encoded: string): string {
  return createHmac("sha256", signingSecret()).update(encoded).digest("base64url");
}

/**
 * The warning reduced to a fingerprint. Whitespace is collapsed so a purely cosmetic re-wrap does
 * not invalidate a decision somebody has already made, while any change to WHO or HOW MUCH does.
 */
function warningDigest(gate: AcknowledgmentGate, runId: string, warning: string): string {
  const normalized = warning.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${gate}\n${runId}\n${normalized}`).digest("base64url");
}

/** The actor in the lowercase comparison form — HR ids are stored mixed-case. */
function actorKey(actorHrId: string): string {
  return canonicalHrIdKey(actorHrId) ?? "";
}

/** Mint a token for a gate that has just fired. Only ever called from the throw site. */
export function issueAcknowledgmentToken(input: {
  runId: string;
  gate: AcknowledgmentGate;
  actorHrId: string;
  warning: string;
  nowSeconds?: number;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: AcknowledgmentPayload = {
    run: input.runId,
    gate: input.gate,
    actor: actorKey(input.actorHrId),
    digest: warningDigest(input.gate, input.runId, input.warning),
    exp: now + TOKEN_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Does this token answer THIS warning, for THIS run and gate, from THIS person, right now?
 *
 * Every no is the same no. A forged signature, a token for another gate, another month or another
 * person, an expired one, and one answering a warning whose text has since changed all return
 * false — and the caller re-throws the gate with a fresh token. There is deliberately no way to tell
 * those apart from outside: the answer to all of them is "look at it again".
 */
export function acknowledgmentTokenAnswers(input: {
  token: string | null | undefined;
  runId: string;
  gate: AcknowledgmentGate;
  actorHrId: string;
  warning: string;
  nowSeconds?: number;
}): boolean {
  if (!input.token) return false;
  const [encoded, signature] = input.token.split(".");
  if (!encoded || !signature) return false;

  let expected: string;
  try {
    expected = sign(encoded);
  } catch {
    // No signing secret: nothing verifies, so nothing is acknowledged.
    return false;
  }
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (received.length !== expectedBuffer.length || !timingSafeEqual(received, expectedBuffer)) {
    return false;
  }

  let payload: AcknowledgmentPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AcknowledgmentPayload;
  } catch {
    return false;
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return false;
  if (payload.run !== input.runId) return false;
  if (payload.gate !== input.gate) return false;
  if (payload.actor !== actorKey(input.actorHrId)) return false;
  // The heart of it: the token answers the warning it was ISSUED for, not whatever this attempt
  // happens to be showing now.
  return payload.digest === warningDigest(input.gate, input.runId, input.warning);
}

/**
 * The error a fired gate throws. It keeps the exact `Conflict: [marker] sentence` message the API
 * routes already recognise, and carries the freshly minted token beside it so the route can hand it
 * to the client. A plain `Error` from anywhere else therefore behaves exactly as before.
 */
export class PayrollAcknowledgmentRequiredError extends Error {
  readonly gate: AcknowledgmentGate;
  readonly acknowledgmentToken: string;

  constructor(input: { marker: string; gate: AcknowledgmentGate; warning: string; token: string }) {
    super(`Conflict: ${input.marker} ${input.warning}`);
    this.name = "PayrollAcknowledgmentRequiredError";
    this.gate = input.gate;
    this.acknowledgmentToken = input.token;
  }
}

/** The token a caught error carries, if it is an acknowledgement gate. Never throws. */
export function acknowledgmentTokenFromError(error: unknown): string | null {
  if (error instanceof PayrollAcknowledgmentRequiredError) return error.acknowledgmentToken;
  const candidate = (error as { acknowledgmentToken?: unknown } | null)?.acknowledgmentToken;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
