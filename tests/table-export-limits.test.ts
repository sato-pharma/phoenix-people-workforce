import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  readTableExportBody,
  TABLE_EXPORT_MAX_BODY_BYTES,
  TABLE_EXPORT_MAX_ROWS,
  TABLE_EXPORT_RATE_LIMIT_SCOPE,
  tableExportBodyTooLarge,
  tableExportRowCapMessage,
} from "../src/lib/http/table-export-limits.ts";

/**
 * The shared table export (`POST /api/exports/table`, about 25 screens) took any number of requests,
 * of any size and any row count, from anyone signed in, and built each workbook in memory. Since
 * 2026-10-26 it answers 429 past 10 exports a minute per person, 413 for a body over 10 MB (a
 * declared size refused before the body is read; an undeclared one cut off as it is read), and 413
 * for more than 20,000 rows — and it still asks for a session only, no permission.
 */

const ORIGIN = "http://localhost:3000";
const ROUTE_URL = `${ORIGIN}/api/exports/table`;

function streamOf(chunkBytes: number, chunkCount: number) {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls >= chunkCount) {
        controller.close();
        return;
      }
      pulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, stats: () => ({ cancelled, pulls }) };
}

async function limitsHelperTests() {
  assert.equal(TABLE_EXPORT_RATE_LIMIT_SCOPE, "export:table", "the table export counts under its own scope");
  assert.equal(TABLE_EXPORT_MAX_ROWS, 20_000, "one export holds at most 20,000 rows");
  assert.equal(TABLE_EXPORT_MAX_BODY_BYTES, 10 * 1024 * 1024, "the body cap is the proxy's 10 MB, so nothing that reached the route before is refused");

  // A declared size.
  assert.equal(tableExportBodyTooLarge(null), false, "no Content-Length is not 'too large' — the read is capped instead");
  assert.equal(tableExportBodyTooLarge(""), false);
  assert.equal(tableExportBodyTooLarge("not-a-number"), false);
  assert.equal(tableExportBodyTooLarge(String(TABLE_EXPORT_MAX_BODY_BYTES)), false, "exactly 10 MB is allowed");
  assert.equal(tableExportBodyTooLarge(String(TABLE_EXPORT_MAX_BODY_BYTES + 1)), true, "one byte over 10 MB is refused");

  // The row cap and its message.
  assert.equal(tableExportRowCapMessage(0), null);
  assert.equal(tableExportRowCapMessage(TABLE_EXPORT_MAX_ROWS), null, "exactly 20,000 rows is allowed");
  const overCap = tableExportRowCapMessage(TABLE_EXPORT_MAX_ROWS + 1);
  assert.ok(overCap, "20,001 rows is refused");
  assert.match(overCap, /20,001 rows/, "the message names how many rows were sent");
  assert.match(overCap, /at most 20,000/, "and the cap");
  assert.match(overCap, /Filter it to fewer rows/, "and what to do about it");

  // The read: a small body parses.
  const small = await readTableExportBody(
    new Request(ROUTE_URL, { body: JSON.stringify({ columns: [{ key: "a", label: "A" }], rows: [] }), method: "POST" }),
  );
  assert.equal(small.ok, true, "a body under the cap is read and parsed");
  assert.deepEqual(small.ok && small.payload, { columns: [{ key: "a", label: "A" }], rows: [] });

  // A body that is not JSON is a 400, not a 500.
  const garbled = await readTableExportBody(new Request(ROUTE_URL, { body: "{not json", method: "POST" }));
  assert.equal(garbled.ok, false);
  assert.equal(!garbled.ok && garbled.status, 400, "an unreadable body is the caller's 400, not a server fault");

  // A body with no Content-Length that runs past the cap is refused AS IT IS READ — it is never held
  // whole. 64 chunks of 1 MB are on offer; the read must stop at the 11th.
  const oversized = streamOf(1024 * 1024, 64);
  const refused = await readTableExportBody(
    new Request(ROUTE_URL, { body: oversized.stream, duplex: "half", method: "POST" } as RequestInit & { duplex: "half" }),
  );
  assert.equal(refused.ok, false, "an undeclared body over 10 MB is refused");
  assert.equal(!refused.ok && refused.status, 413);
  assert.equal(!refused.ok && refused.error, "too_large");
  assert.ok(oversized.stats().pulls <= 12, `the read stops just past the cap (pulled ${oversized.stats().pulls} of 64 MB)`);
  assert.equal(oversized.stats().cancelled, true, "and the rest of the body is cancelled, not drained");
}

async function routeBehaviourTests() {
  const { POST } = await import("../app/api/exports/table/route.ts");

  // A declared body over the cap is answered 413 before the session is read: no database, no limiter.
  // (Under this runner there is no database at all, so reaching either would be a 401 or a 500.)
  const declaredTooLarge = await POST(
    new Request(ROUTE_URL, {
      body: "{}",
      headers: { "content-length": String(TABLE_EXPORT_MAX_BODY_BYTES + 1), "content-type": "application/json", origin: ORIGIN },
      method: "POST",
    }),
  );
  assert.equal(declaredTooLarge.status, 413, "a declared body over 10 MB is refused with a 413");
  const declaredBody = (await declaredTooLarge.json()) as { error?: string; message?: string };
  assert.equal(declaredBody.error, "too_large");
  assert.match(declaredBody.message ?? "", /larger than 10 MB/, "the 413 says why");

  // The CSRF refusal still comes first.
  const crossSite = await POST(
    new Request(ROUTE_URL, {
      body: "{}",
      headers: { "content-length": String(TABLE_EXPORT_MAX_BODY_BYTES + 1), origin: "https://evil.example" },
      method: "POST",
    }),
  );
  assert.equal(crossSite.status, 403, "a cross-site POST is still refused before anything else");
}

function routeSourceTests() {
  const source = readFileSync("app/api/exports/table/route.ts", "utf8");
  const at = (needle: string) => {
    const index = source.indexOf(needle);
    assert.ok(index >= 0, `the export route calls ${needle}`);
    return index;
  };

  const csrf = at("assertSameOriginMutation(request)");
  const declared = at('tableExportBodyTooLarge(request.headers.get("content-length"))');
  const session = at("resolveAccessContext(request)");
  const limiter = at("assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: TABLE_EXPORT_RATE_LIMIT_SCOPE })");
  const read = at("readTableExportBody(request)");
  const rowCap = at("tableExportRowCapMessage(rows.length)");
  const build = at("buildPhoenixTableWorkbook(");

  assert.ok(csrf < declared, "the CSRF check runs first");
  assert.ok(declared < session, "a declared oversized body is refused before the session is read");
  assert.ok(session < limiter, "the limiter counts the signed-in person");
  assert.ok(limiter < read, "the limiter runs BEFORE the body is read, so a flood is refused unread");
  assert.ok(read < rowCap && rowCap < build, "the row cap is checked after the read and before the workbook is built");
  assert.match(source, /if \(rowCapMessage\) return tooLarge\(rowCapMessage\)/, "more than 20,000 rows answers the 413");
  assert.match(source, /status: 413/, "the cap's answer is a 413");

  assert.doesNotMatch(source, /request\.(json|text|arrayBuffer|formData)\(\)/, "the body is read only through the capped reader");
  assert.match(
    source,
    /isApiRateLimitError\(error\)[\s\S]{0,200}"Retry-After": String\(error\.retryAfterSeconds\)[\s\S]{0,40}status: 429/,
    "a person over the limit gets a 429 that says when to try again",
  );

  // 25 screens use this route with a session and nothing more; the limits must not become a gate.
  assert.doesNotMatch(source, /assertPermission\(|requirePermission\(|assertPageOpenForRole\(/, "the export route adds no permission gate");
  assert.match(
    source,
    /if \(!access\.loginId && !access\.hrId\) \{\s*return NextResponse\.json\(\{ error: "Not authenticated\." \}, \{ status: 401 \}\);/,
    "a signed-in session is still the whole requirement",
  );
}

export async function runTableExportLimitsTests() {
  await limitsHelperTests();
  await routeBehaviourTests();
  routeSourceTests();
}
