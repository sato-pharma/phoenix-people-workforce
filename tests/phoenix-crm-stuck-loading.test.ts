import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the silent dead screen.
 *
 * `useCrmGet` is the one read hook behind every Phoenix CRM screen, and every screen derives its
 * `locked` flag from `resource.loading`. Every button is disabled on `locked`, and the handlers
 * behind them open with `if (!view || !view.canEdit || locked) return;`. So `loading` stuck true is
 * not a spinner that never stops — it is a page that renders perfectly, with its data on screen and
 * no error anywhere, where Save, Send and the week switcher do NOTHING when pressed.
 *
 * It happened. The rejection handler swallowed EVERY aborted request:
 *
 *     if (controller.signal.aborted) return;
 *
 * which is right for the effect's own cleanup — another run is already on its way with a new tag —
 * and wrong for every other abort. A phone drops in-flight requests when the tab is backgrounded or
 * the network switches between 4G and WiFi; a deploy drops them too. Nothing then wrote `state`, so
 * `state.tag` kept the PREVIOUS value and `loading: state.tag !== tag` stayed true for good. Because
 * `data` survives a same-URL reload by design, the screen kept its last answer and looked healthy.
 * And `reload()` runs after every save, so a single dropped request poisoned the screen until the
 * tab was reloaded by hand.
 *
 * The fix distinguishes the two aborts with a `superseded` flag the cleanup sets. This file pins it.
 */
export function runPhoenixCrmStuckLoadingTests(): void {
  const source = stripComments(readFileSync("src/components/phoenix-crm/api.ts", "utf8"));

  // ── 1. The state machine's own arithmetic: why a swallowed rejection is fatal ──────────────────
  //
  // Modelled from the three derivations the file returns, which section 2 pins verbatim. The point
  // is not that this model is the code — it is that a tag which never advances is indistinguishable
  // from a load in progress, for ever, while the data stays on screen.
  {
    type State = { data: string | null; error: string | null; tag: string | null; url: string | null };
    const derive = (state: State, url: string | null, tag: string | null) => ({
      data: url !== null && state.url === url ? state.data : null,
      error: tag !== null && state.tag === tag ? state.error : null,
      loading: tag !== null && state.tag !== tag,
    });

    const url = "/api/phoenix-crm/plans?seatId=SEAT-AIF-REP-D13";
    const loaded: State = { data: "the week", error: null, tag: `0|${url}`, url };

    // A reload bumps the nonce, so the tag it waits for is a new one.
    const reloadTag = `1|${url}`;
    const swallowed = derive(loaded, url, reloadTag);
    assert.equal(swallowed.loading, true, "a reload whose answer never arrives is still loading");
    assert.equal(swallowed.data, "the week", "and the last answer is still on screen, so the page looks healthy");
    assert.equal(swallowed.error, null, "with no error, so no load error and no Retry is offered");

    // That triple — loading, data present, no error — IS the dead screen. Recording the rejection
    // ends it: the tag advances, so loading stops and the error reaches CrmLoadError's Retry.
    const recorded: State = { data: "the week", error: "Network request failed", tag: reloadTag, url };
    const surfaced = derive(recorded, url, reloadTag);
    assert.equal(surfaced.loading, false, "recording the rejection unsticks loading");
    assert.equal(surfaced.error, "Network request failed", "and the sentence reaches the screen");
  }

  // ── 2. The fix itself ─────────────────────────────────────────────────────────────────────────
  {
    assert.ok(
      !/if \(controller\.signal\.aborted\) return;/.test(source),
      "the rejection handler must NOT swallow every aborted request — only the effect's own cleanup may",
    );
    assert.ok(/let superseded = false;/.test(source), "the effect marks its own cleanup with a superseded flag");
    assert.ok(
      /return \(\) => \{\s*superseded = true;\s*controller\.abort\(\);\s*\};/.test(source),
      "the cleanup sets superseded BEFORE aborting, so its own rejection is the one that is swallowed",
    );
    assert.equal(
      (source.match(/if \(superseded\) return;/g) ?? []).length,
      2,
      "BOTH handlers stand down when superseded — a resolved answer from a superseded run is as stale as a rejected one",
    );

    // The derivations the model above depends on, pinned so the two cannot drift apart.
    assert.ok(/loading: tag !== null && state\.tag !== tag,/.test(source), "loading is still 'the tag has not advanced'");
    assert.ok(/data: url !== null && state\.url === url \? state\.data : null,/.test(source), "data still survives a same-URL reload");
  }

  // ── 3. The blast radius, so nobody re-narrows the fix to one screen ───────────────────────────
  {
    const planTab = stripComments(readFileSync("src/components/phoenix-crm/plan-tab.tsx", "utf8"));
    assert.ok(
      /const locked = busy !== null \|\| resource\.loading;/.test(planTab),
      "the plan tab locks every control on resource.loading — which is why a stuck load reads as a dead button",
    );
    assert.ok(
      /if \(!view \|\| !view\.canEdit \|\| locked\) return;/.test(planTab),
      "and the handlers return silently on it, so the press leaves no trace at all",
    );
  }
}
