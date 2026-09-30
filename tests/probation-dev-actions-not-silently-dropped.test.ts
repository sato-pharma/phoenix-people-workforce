import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A probation DV feedback submit could open development actions, and the insert sat behind a bare
 * `.catch(() => undefined)`. A failure there dropped EVERY action the evaluator had just typed while
 * the submit returned 201 and the form printed "Feedback submitted" — nothing in the app, the audit
 * trail or the logs said the actions were gone. It needed no schema change to bite: the catch
 * swallowed everything, not just a missing column.
 *
 * The fix keeps the non-blocking design and removes the silence, so this pins BOTH directions:
 *
 *  - it must not go back to swallowing (the actions vanish with nobody told), and
 *  - it must not start THROWING either. By that point the scorecard row is inserted, version 1 is
 *    written and the DV-Day has already moved to `feedback_completed`, so a throw would report a
 *    failure that did not happen and invite a duplicate submission of feedback already on the case.
 *
 * The one correct shape is: catch it, log it, carry it into the audit row, and hand it back so the
 * evaluator is told his actions were not created.
 */

function src(p: string) {
  return readFileSync(p, "utf8");
}

export function runProbationDevActionsNotSilentlyDroppedTests() {
  const wf = src("src/lib/probation/intelligence/feedback-workflow.ts");

  // ── 1. The swallow is gone, in any spelling ────────────────────────────────
  assert.doesNotMatch(
    wf,
    /createDevelopmentActions\([\s\S]*?\)\s*\.catch\(/,
    "createDevelopmentActions must not be followed by a .catch() — a promise-level catch here is the "
      + "defect itself: it drops every development action while the submit reports success",
  );

  // ── 2. It is caught, and the failure is actually READ ──────────────────────
  const callIndex = wf.indexOf("await createDevelopmentActions({");
  assert.ok(callIndex > 0, "submitDvFeedback still opens the development actions");

  const region = wf.slice(Math.max(0, callIndex - 900), callIndex + 1600);
  assert.match(region, /try\s*\{/, "the call sits in a try block");
  assert.match(
    region,
    /catch\s*\(\s*error\s*\)\s*\{/,
    "the failure is caught rather than left to fail the submit",
  );
  assert.match(
    region,
    /developmentActionsError\s*=\s*$|developmentActionsError\s*=/m,
    "the catch RECORDS the failure — a catch that only logs still leaves the evaluator told nothing",
  );
  assert.match(region, /console\.error\(/, "the failure reaches the server logs");

  // ── 3. It does NOT rethrow — the submit still stands ───────────────────────
  const catchStart = wf.indexOf("} catch (error) {", callIndex);
  assert.ok(catchStart > callIndex, "the catch follows the call");
  const catchBody = wf.slice(catchStart, wf.indexOf("\n  }", catchStart));
  assert.doesNotMatch(
    catchBody,
    /\bthrow\b/,
    "the catch must NOT rethrow: the feedback row and the DV-Day transition are already written, so "
      + "failing here would report a failure that did not happen",
  );

  // ── 4. The failure is carried out of the function, not just logged ─────────
  assert.match(
    wf,
    /export type SubmitFeedbackResult = \{[\s\S]*?developmentActionsError: string \| null;[\s\S]*?\};/,
    "submitDvFeedback returns a result that can carry the partial-save failure",
  );
  assert.match(
    wf,
    /\): Promise<SubmitFeedbackResult> \{/,
    "submitDvFeedback's return type is that result, not a bare ProbationFeedback",
  );
  assert.match(
    wf,
    /return \{ feedback, developmentActionsError \};/,
    "the failure leaves the function alongside the saved feedback",
  );

  // ── 5. The durable record says so too ──────────────────────────────────────
  assert.match(
    wf,
    /developmentActionsFailed/,
    "the audit row records that the development actions were not created",
  );

  // ── 6. The order matters: the submit is COMPLETE before the actions ────────
  const dvDayUpdate = wf.indexOf('dv_status: "feedback_completed"');
  assert.ok(dvDayUpdate > 0, "the DV-Day still advances to feedback_completed");
  assert.ok(
    dvDayUpdate < callIndex,
    "the development actions are opened AFTER the feedback and the DV-Day transition are written — "
      + "that ordering is what makes the non-blocking catch correct rather than lossy",
  );

  // ── 7. The route hands it to the client ───────────────────────────────────
  const route = src("app/api/probation/dv/[dvDayId]/feedback/route.ts");
  assert.match(
    route,
    /const \{ feedback, developmentActionsError \} = await submitDvFeedback\(/,
    "the route reads the partial-save failure off the result",
  );
  assert.match(
    route,
    /NextResponse\.json\(\{ feedback, developmentActionsError \}/,
    "the route returns it to the caller",
  );

  // ── 8. The evaluator is told, on the success screen ───────────────────────
  const form = src("src/components/probation/structured-feedback-form.tsx");
  assert.match(
    form,
    /developmentActionsError/,
    "the form reads the partial-save failure off the 201 response",
  );
  assert.match(
    form,
    /setActionsWarning\(/,
    "the form keeps it in state",
  );
  assert.match(
    form,
    /\{actionsWarning && \(/,
    "the done screen renders it — a partial save is never shown as a plain success",
  );
  // The square-edge golden rule (AGENTS.md §4): the notice carries no radius.
  assert.doesNotMatch(
    form,
    /rounded[^\s"]*\s[^"]*bg-amber-50|bg-amber-50[^"]*\srounded/,
    "the warning notice has no rounded corners (square-edge golden rule)",
  );
}
