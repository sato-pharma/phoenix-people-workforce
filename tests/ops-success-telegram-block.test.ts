import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  enforceOpsSuccessTelegramBlock,
  isRoutineOpsSuccessEvent,
} from "../src/lib/notifications/ops-success-digest-channel-guard.ts";

// Owner rule (2026-10-15): "stop the routine sync-success alerts reaching my Telegram".
//
// Measured before the rule: of 471 system-health alerts delivered to his Telegram between 21 June
// and 15 Oct 2026, 207 were routine confirmations that nothing was wrong — 44% of the channel —
// and `ireports360_sync_success` alone sent 178. That sender left with the iReports360 sync on
// 7 Nov 2026, so the weekly background-jobs digest is the one confirmation the guard holds now.
//
// Three things have to hold, and the quiet is only as good as the weakest one:
//   1. a routine SUCCESS loses Telegram
//   2. the matching FAILURE keeps every channel it had — the whole reason the guard is keyed on the
//      success event types and not on the module or the job
//   3. the delivery path actually calls the guard, or it is a pure function nothing consults

export function runOpsSuccessTelegramBlockTests() {
  // ── 1. A routine success loses Telegram, and keeps everything else ───────────────
  {
    assert.deepEqual(
      enforceOpsSuccessTelegramBlock(["in_app", "telegram", "push"], "background_jobs_run_success"),
      ["in_app", "push"],
      "the weekly background-jobs confirmation must not reach his Telegram — the class of message 178 iReports360 sync confirmations were",
    );
    // in_app is what keeps the confirmation on record and renderable in the bell. A guard that
    // emptied the list would turn "stop telling me on Telegram" into "stop recording it".
    assert.equal(
      enforceOpsSuccessTelegramBlock(["in_app", "telegram", "push"], "background_jobs_run_success").includes("in_app"),
      true,
      "the confirmation still has to exist somewhere — the owner asked for silence on one channel, not for the record to be dropped",
    );
    assert.deepEqual(
      enforceOpsSuccessTelegramBlock(["telegram"], "background_jobs_run_success"),
      [],
      "a success asking for Telegram alone is delivered nowhere rather than delivered anyway",
    );
    // Case and padding: these event types are built by string interpolation at two call sites, and
    // an exact-match set would read as handled while letting a differently-cased spelling through.
    assert.deepEqual(
      enforceOpsSuccessTelegramBlock(["in_app", "telegram"], "  Background_Jobs_Run_Success  "),
      ["in_app"],
      "matching is case-insensitive and trimmed, or one call site's spelling silently escapes the rule",
    );
  }

  // ── 2. The FAILURES keep Telegram — this is the half that matters ────────────────
  {
    assert.deepEqual(
      enforceOpsSuccessTelegramBlock(["in_app", "telegram", "push"], "background_jobs_run_failed"),
      ["in_app", "telegram", "push"],
      "a FAILED weekly background-jobs run must still reach his Telegram — silencing the failures with the noise is the one outcome worse than the noise",
    );
    assert.equal(isRoutineOpsSuccessEvent("background_jobs_run_failed"), false, "a failure is never a routine confirmation");
    assert.equal(isRoutineOpsSuccessEvent("scheduled_job_stranded"), false, "a stranded job is not one either");
    assert.equal(
      isRoutineOpsSuccessEvent("reconciliation_breach_detected"),
      false,
      "nor is a reconciliation breach — nothing outside the two named confirmations may be quietened by this guard",
    );
    // Unrelated traffic passes through untouched, deduped only.
    assert.deepEqual(
      enforceOpsSuccessTelegramBlock(["in_app", "telegram", "telegram"], "vacation_request_submitted"),
      ["in_app", "telegram"],
      "every other notification keeps its Telegram channel and is only deduped",
    );
  }

  // ── 3. The delivery path calls it ────────────────────────────────────────────────
  {
    // A guard is only enforcement if basePolicyChannels actually consults it. Both halves are
    // asserted: the import, and a call whose result is threaded into the rest of the chain.
    const system = readFileSync("src/lib/notifications/system.ts", "utf8");
    assert.match(
      system,
      /import \{ enforceOpsSuccessTelegramBlock \} from "@\/lib\/notifications\/ops-success-digest-channel-guard";/,
      "system.ts must import the guard",
    );
    assert.match(
      system,
      /const (\w+) = enforceOpsSuccessTelegramBlock\(\w+, input\.eventType\);/,
      "basePolicyChannels must call the guard with the event type",
    );
    const chained = system.match(/const (\w+) = enforceOpsSuccessTelegramBlock\(\w+, input\.eventType\);/)?.[1];
    assert.ok(chained, "the guard's result must be bound to a name");
    assert.match(
      system,
      new RegExp(`enforcePhoenixCrmEmailBlock\\(${chained}, input\\.module, input\\.eventType\\)`),
      "and that result must be threaded into the next link, or the guard runs and its output is discarded — which is indistinguishable from not guarding at all",
    );

    // The call site states the same intent where the digest is composed (the iReports360 sync digest
    // was the second one until the vendor was retired on 6 November 2026). Two co-operating values is
    // exactly what drifts, which is why the guard above is the enforcement — but a call site that asks
    // for Telegram on a success would still be a lie about what the code does.
    for (const file of ["src/lib/notifications/background-jobs-digest.ts"]) {
      assert.match(
        readFileSync(file, "utf8"),
        /channels: input\.status === "failed" \? \["in_app", "telegram", "push"\] : \["in_app", "push"\],/,
        `${file} must ask for Telegram on a failure and not on a success`,
      );
    }
  }

  // ── 4. The iReports360 confirmation left with the vendor (7 Nov 2026) ─────────────
  {
    // Its sender, the iReports360 sync digest, was deleted with the vendor sync. A name nothing can
    // raise any more is a dead entry: it reads as a guarded message while guarding nothing.
    assert.equal(
      isRoutineOpsSuccessEvent("ireports360_sync_success"),
      false,
      "ireports360_sync_success left the routine-success list with the retired vendor sync",
    );
    const guard = readFileSync("src/lib/notifications/ops-success-digest-channel-guard.ts", "utf8");
    const list = /const ROUTINE_SUCCESS_EVENT_TYPES = new Set<string>\(\[([\s\S]*?)\]\);/.exec(guard)?.[1];
    assert.ok(list !== undefined, "the routine-success list is still one literal Set this test can read");
    assert.doesNotMatch(list, /ireports360_/, "no iReports360 event name is listed: the vendor's events have no sender");
  }
}
