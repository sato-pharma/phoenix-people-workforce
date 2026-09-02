import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { candidateRegionCodes, candidateRegionLabels } from "../src/lib/recruitment/candidate-region.ts";
import {
  CLASSIFY_REASK_QUIET_MS,
  classifySessionSteps,
  reaskPromptForStep,
  shouldReaskParkedSession,
} from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";

/**
 * A CV arriving into a conversation that is already open must re-ask its question, never go silent.
 *
 * THE BUG THIS PINS WAS PERMANENT SILENCE. `startClassification` found the sender's open row and
 * returned `already_open` without sending anything — and because nothing was sent, the one thing
 * that ever closed a stalled row (Meta rejecting a send as `window_closed`) could not fire either.
 * The row stayed open and every future CV from that number got no reply, for good. Production on
 * 2026-09-02: 68 open conversations, all quiet over six hours, 22 of them still on question one with
 * not one answer between them, and three senders who had already re-sent a CV into the silence.
 *
 * Two halves, and breaking either must go red: the mapping below (every step a conversation can park
 * on has a question ready to re-send) and the wiring (startClassification actually calls it).
 */
export function runWhatsAppClassifyReaskTests() {
  const region = candidateRegionCodes[0];
  const areas = ["Cairo 1", "Cairo 2"];

  // ── Every parkable step can be re-asked ────────────────────────────────────────────────────────
  // `done` is the one step in the list with nothing to ask; it is also never open, since finishing
  // the conversation is what writes it.
  for (const step of classifySessionSteps) {
    const prompt = reaskPromptForStep({ areaNames: areas, regionCode: region, step });
    if (step === "done") {
      assert.equal(prompt, null, "a finished conversation must not be re-asked anything");
      continue;
    }
    assert.ok(
      prompt,
      `step "${step}" has no question to re-ask, so a CV arriving while a conversation is parked there is answered with silence`,
    );
  }

  // The headline case, and the one production was actually stuck in: asked what they are applying
  // for, never tapped an answer, sent another CV. It must get the job-title menu back.
  const jobTitle = reaskPromptForStep({ areaNames: [], regionCode: null, step: "job_title" });
  assert.equal(
    jobTitle?.kind === "menu" ? jobTitle.menu.step : null,
    "job_title",
    "a conversation parked on question one must be re-sent question one",
  );

  // Salary is the one built-in question sent as plain text, so its wording is resolved by the caller
  // (it goes through the owner's override seam asynchronously) rather than carried here.
  assert.equal(
    reaskPromptForStep({ areaNames: [], regionCode: null, step: "salary" })?.kind,
    "salary",
    "the salary step must be re-asked through its own override-resolving path, not as a fixed body",
  );

  for (const step of ["job_title_other", "background_other", "region_other", "area_other"]) {
    const prompt = reaskPromptForStep({ areaNames: [], regionCode: null, step });
    assert.equal(prompt?.kind, "text", `"${step}" has nothing to tap, so it must be re-asked as text`);
    assert.ok(
      prompt?.kind === "text" && prompt.body.trim().length > 0,
      `"${step}" would be re-asked with an empty message`,
    );
  }

  // ── The area menu is the one built from live data ──────────────────────────────────────────────
  const area = reaskPromptForStep({ areaNames: areas, regionCode: region, step: "area" });
  assert.equal(area?.kind, "menu");
  assert.equal(
    area?.kind === "menu" ? area.regionLabel : null,
    candidateRegionLabels[region],
    "the area question is the only prompt carrying a token, so its re-ask must pass the region label too",
  );
  // Meta rejects an empty list as a 400 for the whole message, not a truncation — so a region with
  // no areas left, or a row with no region on it at all, must stay quiet rather than send a shell.
  assert.equal(reaskPromptForStep({ areaNames: [], regionCode: region, step: "area" }), null);
  assert.equal(reaskPromptForStep({ areaNames: areas, regionCode: null, step: "area" }), null);
  assert.equal(reaskPromptForStep({ areaNames: areas, regionCode: "not-a-region", step: "area" }), null);

  // The admin-defined loop holds its position in its own column (`extra_current_question_key`), so
  // this file cannot build the question — it returns the marker and the session layer resolves it.
  // Covered since 2026-09-02: it was originally out of scope because nothing was parked there, which
  // was only true because those questions had gone live hours earlier.
  assert.deepEqual(reaskPromptForStep({ areaNames: [], regionCode: null, step: "extra" }), { kind: "extra" });
  assert.equal(reaskPromptForStep({ areaNames: [], regionCode: null, step: "whatever" }), null);

  // ── Quiet time separates a stalled conversation from a live one ────────────────────────────────
  const now = Date.UTC(2026, 8, 2, 10, 0, 0);
  assert.equal(
    shouldReaskParkedSession({ nowMs: now, updatedAt: new Date(now - 5 * 60 * 1000).toISOString() }),
    false,
    "someone mid-conversation who sends a second document must not be asked the same thing twice",
  );
  assert.equal(
    shouldReaskParkedSession({ nowMs: now, updatedAt: new Date(now - CLASSIFY_REASK_QUIET_MS).toISOString() }),
    true,
    "the quiet threshold must be inclusive",
  );
  assert.equal(
    shouldReaskParkedSession({ nowMs: now, updatedAt: new Date(now - 27 * 60 * 60 * 1000).toISOString() }),
    true,
    "a conversation quiet for a day is stalled, and a fresh CV is the applicant trying again",
  );
  // Silence is the failure being fixed; a duplicate question is the smaller harm, so an unreadable
  // or missing timestamp asks rather than stays quiet.
  assert.equal(shouldReaskParkedSession({ nowMs: now, updatedAt: null }), true);
  assert.equal(shouldReaskParkedSession({ nowMs: now, updatedAt: "not a date" }), true);

  // ── The wiring ─────────────────────────────────────────────────────────────────────────────────
  // The mapping above is inert unless startClassification uses it. This is the exact line that was
  // the bug, and reinstating it would leave every assertion above passing.
  const sessionSource = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-classify-session.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    /if\s*\(existing\)\s*return\s*"already_open"/.test(sessionSource),
    false,
    "startClassification answers an open conversation with silence again — a CV from a stalled sender gets no reply, permanently",
  );
  assert.ok(
    /if\s*\(existing\)\s*return\s*reaskOpenSession\(/.test(sessionSource),
    "startClassification no longer routes an already-open conversation through reaskOpenSession",
  );

  const webhookSource = readFileSync(
    new URL("../app/api/webhooks/whatsapp/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    /classifyOutcome === "reasked"/.test(webhookSource),
    "the webhook does not count a re-ask against its per-delivery prompt budget, so one stalled sender's payload can spend it unbounded",
  );
}
