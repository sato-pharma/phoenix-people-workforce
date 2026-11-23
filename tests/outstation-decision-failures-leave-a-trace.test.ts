import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// A failed decision on /api/admin/outstation/[id] must leave a trace.
//
// 2026-09-03: an approval of request 99 failed three times from the admin screen and left
// NOTHING to say why — no row change, no audit entry, and no `app_error_events` record.
// Every handler in this file catches its own error and returns `clientSafeErrorMessage`,
// which is deliberately sanitised, so the real cause was discarded at the exact moment it
// was known.
//
// The cost was a wrong diagnosis, not just a slow one. An empty `app_error_events` was read
// as positive evidence that the request never reached the server, and the investigation went
// looking at deploy restarts and the browser instead. The table could not have held that row
// either way.
//
// This is the identical hole that was closed on /api/admin/outstation/expenses on 2026-08-12,
// whose own comment says it plainly: the error goes "nowhere: not to app_error_events, and not
// to instrumentation.ts's onRequestError either, because that only fires on errors the handler
// lets escape."
//
// So: every catch block in this route must record the unsanitised cause before it returns.
// The rule is per-catch rather than per-handler so a new verb added later is covered the day
// it is written.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_SOURCE = fileURLToPath(
  new URL("../app/api/admin/outstation/[id]/route.ts", import.meta.url),
);

const RECORDER = "recordOutstationDecisionFailure";

export async function runOutstationDecisionFailureTraceTests() {
  const source = readFileSync(ROUTE_SOURCE, "utf8");

  assert.ok(
    source.includes('import { logAppError } from "@/lib/error-monitor/service"'),
    "the route must import the error recorder, or a failed decision leaves no trace at all",
  );

  // Split on the catch keyword and inspect each block's body. `clientSafeErrorMessage` is what
  // makes these blocks lossy, so every block that reaches for it must also record the original.
  const blocks = source.split(/\}\s*catch\s*\(error\)\s*\{/).slice(1);
  assert.ok(
    blocks.length >= 4,
    `expected a catch block for each handler (GET/POST/PATCH/DELETE), found ${blocks.length}`,
  );

  blocks.forEach((block, index) => {
    const body = block.split("\n}")[0];
    if (!body.includes("clientSafeErrorMessage")) return;
    assert.ok(
      body.includes(RECORDER),
      `catch block ${index + 1} sanitises its error with clientSafeErrorMessage but never calls ` +
        `${RECORDER}, so the real cause is discarded — the exact failure that made an approval ` +
        "undiagnosable on 2026-09-03",
    );
    const recorderAt = body.indexOf(RECORDER);
    const returnAt = body.indexOf("return NextResponse.json");
    assert.ok(
      recorderAt < returnAt,
      `catch block ${index + 1} must record the cause BEFORE it returns; a recorder placed after ` +
        "the return never runs",
    );
  });

  // The recorder must be awaited. Fired-and-forgotten, it loses the row precisely when the
  // process is already unwinding a failure — which is how the sibling route lost its own.
  // Checked by string split rather than a built RegExp: a backslash class written through a
  // shell heredoc silently loses a level and yields a test that only ever passes.
  // `${RECORDER}({` matches the call sites only — the declaration reads
  // `${RECORDER}(input: {`, and counting it as a call made this very test fail on itself.
  const callSites = source.split(`${RECORDER}({`).slice(0, -1);
  assert.ok(callSites.length >= 4, `expected every handler to record its failure, found ${callSites.length}`);
  callSites.forEach((before, index) => {
    assert.ok(
      before.trimEnd().endsWith("await"),
      `${RECORDER} call ${index + 1} is not awaited; the row must be written before the response ` +
        "goes out, or it is dropped exactly when the process is unwinding a failure",
    );
  });
}
