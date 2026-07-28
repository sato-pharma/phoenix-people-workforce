import { NextResponse } from "next/server";

// Shared error mapping for the Territory Management routes. Mirrors app/api/coaching/_lib.
//
// The session guard itself is deliberately NOT wrapped here: tests/access-registry-coverage
// scans each route file's own source for `resolveAccessContext` + `assertPermission`, so the
// authorisation of a handler stays readable in the handler.

export function jsonError(error: unknown, fallback = "Territory request failed.") {
  const message = error instanceof Error ? error.message : fallback;
  if (message.startsWith("Forbidden:")) return NextResponse.json({ error: message }, { status: 403 });
  if (message.startsWith("Not authenticated")) return NextResponse.json({ error: message }, { status: 401 });
  if (message.startsWith("Not found")) return NextResponse.json({ error: message }, { status: 404 });
  if (message.startsWith("Invalid")) return NextResponse.json({ error: message }, { status: 400 });
  return NextResponse.json({ error: message }, { status: 500 });
}
