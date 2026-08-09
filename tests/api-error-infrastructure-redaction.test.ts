import assert from "node:assert/strict";
import {
  ApiError,
  clientSafeErrorMessage,
  isInfrastructureError,
  toApiError,
} from "../src/lib/http/api-errors.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Postgres must never write the sentence the user reads.
//
// toApiError classifies a bare Error by matching its MESSAGE against a fixed pattern list. That
// list cannot tell our own prose apart from Postgres's, and supabase-js >= 2 makes PostgrestError a
// real Error subclass, so `instanceof Error` is not a filter either. The result was that
// `relation "public.salary_records" does not exist` matched the "does not exist" branch and left as
// a 404 naming a live table, and `invalid input syntax for type uuid` matched "invalid " and left
// as a 400 naming a column type.
//
// The fix classifies by ORIGIN before message text. These tests pin that ordering: the check that
// matters is not merely "the status changed" but that the raw text is ABSENT from what ships.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors supabase-js v2's real PostgrestError: an Error subclass carrying code/details/hint. */
function postgrestError(message: string, code: string, details = "", hint = "") {
  const error = new Error(message);
  error.name = "PostgrestError";
  return Object.assign(error, { code, details, hint });
}

export function runApiErrorInfrastructureRedactionTests() {
  const FALLBACK = "Could not load the payroll batch.";

  // ── the two message patterns that used to smuggle schema out ──────────────
  const missingRelation = postgrestError('relation "public.salary_records" does not exist', "42P01");
  const relationResult = toApiError(missingRelation, FALLBACK);
  assert.equal(
    relationResult.message,
    FALLBACK,
    "a missing-relation error must read as the caller's fallback, never Postgres's own sentence",
  );
  assert.ok(
    !relationResult.message.includes("salary_records"),
    "the table name must not survive into the client response — that is the whole leak",
  );
  assert.equal(
    relationResult.status,
    500,
    "origin is classified before message text, so 'does not exist' no longer downgrades this to a 404",
  );

  const badUuid = postgrestError('invalid input syntax for type uuid: "abc"', "22P02");
  const uuidResult = toApiError(badUuid, FALLBACK);
  assert.equal(uuidResult.message, FALLBACK, "a type-syntax error must not reach the caller verbatim");
  assert.ok(
    !uuidResult.message.includes("uuid"),
    "the column type must not survive — 'invalid ' used to route this to a 400 echoing the message",
  );

  // ── a PostgREST error that arrives as a PLAIN object, not an Error ─────────
  const plainPostgrest = { message: 'permission denied for table "employees"', code: "42501", details: null, hint: null };
  assert.equal(
    toApiError(plainPostgrest, FALLBACK).message,
    FALLBACK,
    "PostgREST errors thrown without .throwOnError() are plain objects and must redact identically",
  );

  // ── statement timeout keeps its own actionable 503, not a raw DB sentence ──
  const timeout = postgrestError("canceling statement due to statement timeout", "57014");
  const timeoutResult = toApiError(timeout, FALLBACK);
  assert.equal(timeoutResult.status, 503, "a statement timeout is transient and user-actionable, never an opaque 500");
  assert.ok(
    !timeoutResult.message.includes("canceling statement"),
    "the 503 must carry the written 'narrow your filters' guidance, not Postgres's cancellation text",
  );

  // ── our own prose still reaches the user unchanged (the fix must not overreach) ──
  const domainForbidden = new Error("Forbidden: Medical Rep cannot read payroll.");
  assert.equal(
    toApiError(domainForbidden, FALLBACK).status,
    403,
    "hand-authored domain errors carry no code/details/hint, so they keep their existing classification",
  );
  const domainNotFound = new Error("That vacation request was not found.");
  const notFoundResult = toApiError(domainNotFound, FALLBACK);
  assert.equal(notFoundResult.status, 404, "a domain 'was not found' is still a 404");
  assert.equal(
    notFoundResult.message,
    "That vacation request was not found.",
    "the user still gets the sentence we wrote for them",
  );

  // ── an already-built ApiError is deliberate output and passes through ──────
  const deliberate = new ApiError(409, "conflict", "This batch is already locked.");
  assert.equal(toApiError(deliberate, FALLBACK), deliberate, "ApiError is pre-sanitized and must pass through untouched");

  // ── isInfrastructureError: the origin test itself ─────────────────────────
  assert.equal(isInfrastructureError(missingRelation), true, "a PostgrestError is infrastructure");
  assert.equal(isInfrastructureError(plainPostgrest), true, "a bare PostgREST object is infrastructure");
  assert.equal(isInfrastructureError(Object.assign(new Error("socket"), { code: "ECONNREFUSED" })), true, "a Node errno is infrastructure");
  assert.equal(isInfrastructureError(domainForbidden), false, "our own Error is not infrastructure");
  assert.equal(isInfrastructureError(deliberate), false, "ApiError's lower_snake_case code must never read as a SQLSTATE");
  assert.equal(isInfrastructureError(null), false, "null is not infrastructure");
  assert.equal(isInfrastructureError("boom"), false, "a thrown string is not infrastructure");

  // ── clientSafeErrorMessage: the drop-in for the raw ternary ───────────────
  assert.equal(
    clientSafeErrorMessage(missingRelation, "Forbidden."),
    "Forbidden.",
    "the route-level helper redacts infrastructure text the same way toApiError does",
  );
  assert.equal(
    clientSafeErrorMessage(domainForbidden, "Forbidden."),
    "Forbidden: Medical Rep cannot read payroll.",
    "behaviour is unchanged for every hand-authored error — that is why the codemod is safe",
  );
  assert.equal(
    clientSafeErrorMessage({ not: "an error" }, "Forbidden."),
    "Forbidden.",
    "a non-Error value falls back exactly as the ternary it replaced did",
  );
}
