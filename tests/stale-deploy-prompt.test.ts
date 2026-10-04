import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isNewerDeploy,
  readRevision,
  REVISION_FOCUS_MIN_GAP_MS,
  REVISION_POLL_MS,
  shouldCheckOnFocus,
} from "../src/lib/utils/deploy-revision-watch.ts";

export function runStaleDeployPromptTests() {
  // ── readRevision: only a non-blank string counts ────────────────────────────
  assert.equal(readRevision({ status: "ok", revision: "a90a2fe46" }), "a90a2fe46");
  assert.equal(readRevision({ revision: "  a90a2fe46 " }), "a90a2fe46");
  assert.equal(readRevision({ revision: null }), null);
  assert.equal(readRevision({ revision: "   " }), null);
  assert.equal(readRevision({ revision: 42 }), null);
  assert.equal(readRevision(null), null);
  assert.equal(readRevision("a90a2fe46"), null);

  // ── isNewerDeploy: prompts only when BOTH builds are known and differ ───────
  assert.equal(isNewerDeploy("aaa111", "bbb222"), true, "a different live build must prompt");
  assert.equal(isNewerDeploy("aaa111", "aaa111"), false, "the same build must never prompt");
  assert.equal(isNewerDeploy(null, "bbb222"), false, "a tab with no known build has nothing to compare");
  assert.equal(isNewerDeploy("aaa111", null), false, "an unreadable probe must not prompt");
  assert.equal(isNewerDeploy("", "bbb222"), false);
  assert.equal(isNewerDeploy("aaa111", undefined), false);
  assert.equal(isNewerDeploy(" aaa111 ", "aaa111"), false, "whitespace is not a different build");

  // ── focus checks are throttled, the first one is immediate ──────────────────
  assert.equal(shouldCheckOnFocus(null, 1_000), true);
  assert.equal(shouldCheckOnFocus(1_000, 1_000 + REVISION_FOCUS_MIN_GAP_MS - 1), false);
  assert.equal(shouldCheckOnFocus(1_000, 1_000 + REVISION_FOCUS_MIN_GAP_MS), true);
  assert.ok(REVISION_POLL_MS >= 60_000, "the poll must stay gentle: healthz is hit by every open tab");

  // ── wiring: the root layout stamps the build and mounts the prompt ──────────
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /import \{ StaleDeployPrompt \} from "@\/components\/layout\/stale-deploy-prompt"/);
  assert.match(layout, /<StaleDeployPrompt loadedRevision=\{getDeployRevision\(\)\} \/>/);

  // ── the component compares against healthz, never reloads by itself, keeps square edges ─
  const component = readFileSync(new URL("../src/components/layout/stale-deploy-prompt.tsx", import.meta.url), "utf8");
  assert.match(component, /fetch\("\/api\/healthz", \{ cache: "no-store" \}\)/);
  assert.match(component, /isNewerDeploy\(loadedRevision, live\)/);
  assert.equal(
    component.match(/location\.reload\(\)/g)?.length,
    1,
    "the only reload is the Refresh button's own click — a forced reload would discard a half-filled form",
  );
  assert.doesNotMatch(component, /rounded/, "square-edge golden rule: no rounded corners");
}
