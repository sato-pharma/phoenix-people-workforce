import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  DRY_RUN_BRANCH,
  MARKER_PATH,
  URGENT_BRANCH,
  classifyLive,
  formatTrailers,
  parseTrailers,
} from "../scripts/urgent-deploy.mjs";
import { stripComments, stripHashComments } from "./support/comment-strip.ts";

/**
 * The urgent "live in five minutes" route (owner, 2026-10-18; docs/deployment.md, "The urgent route").
 *
 * Two properties carry the whole design, and each would fail SILENTLY if lost:
 *
 *   1. The workflow runs only on a push to its own `urgent-deploy/*` branches. A run on `main` would
 *      attach a check suite to main HEAD, and Railway's Wait for CI would hold — or, on a red finish,
 *      permanently withhold — the NORMAL deploy. Nothing turns red when that happens.
 *   2. The guard's verdict. "handed-over" must require EVERY urgent PR's merge inside the live build;
 *      a guard that stood down early would let the next normal deploy remove the fix with no alarm.
 *
 * And the plumbing that makes the live build nameable: a `railway up` upload has no git sha, so the
 * probes read public/urgent-deploy.json, which must never be committed.
 */
export function runUrgentDeployTests(): void {
  // ── 1. Trailers round-trip, and an unknown service name is dropped ───────────────────────────
  {
    const message = `urgent deploy: #6080 on top of main\n\n${formatTrailers({ prs: [6080, 6081], services: ["web", "worker"] })}\n`;
    assert.deepEqual(parseTrailers(message), { prs: [6080, 6081], services: ["web", "worker"] });
    assert.deepEqual(parseTrailers("Urgent-PR: 7\r\nUrgent-Services: web,bogus\r\n"), { prs: [7], services: ["web"] });
    assert.deepEqual(parseTrailers("no trailers here"), { prs: [], services: ["web"] });
  }

  // ── 2. The guard's verdict ───────────────────────────────────────────────────────────────────
  {
    const urgentSha = "u".repeat(40);
    const history: Record<string, string[]> = { live1: ["m1"], live2: [] };
    const contains = (ancestor: string, descendant: string) => (history[descendant] ?? []).includes(ancestor);

    assert.equal(classifyLive({ live: null, urgentSha, prs: [{ mergeSha: null }], contains }), "unknown");
    assert.equal(classifyLive({ live: urgentSha, urgentSha, prs: [{ mergeSha: null }], contains }), "urgent-serving");
    assert.equal(classifyLive({ live: "live1", urgentSha, prs: [{ mergeSha: "m1" }], contains }), "handed-over");
    assert.equal(
      classifyLive({ live: "live1", urgentSha, prs: [{ mergeSha: "m1" }, { mergeSha: null }], contains }),
      "regressed",
      "one urgent PR still unmerged: a normal build cannot carry it, so the fix is gone",
    );
    assert.equal(
      classifyLive({ live: "live2", urgentSha, prs: [{ mergeSha: "m1" }], contains }),
      "regressed",
      "merged, but the live build predates the merge: the fix is not serving",
    );
    assert.equal(classifyLive({ live: "live1", urgentSha, prs: [], contains }), "regressed", "an empty PR list never counts as handed over");
  }

  // ── 3. The workflow can never run on main ────────────────────────────────────────────────────
  {
    const workflow = stripHashComments(readFileSync(".github/workflows/urgent-deploy.yml", "utf8")).replace(/\r\n/g, "\n");
    const on = /^on:\n([\s\S]*?)\n(?=\S)/m.exec(workflow)?.[1] ?? "";
    assert.ok(on.length > 0, "the workflow must have an on: block");
    assert.match(on, /^ {2}push:\n {4}branches:\n/m, "triggered by push");
    const branches = [...on.matchAll(/^ {6}- (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(branches.sort(), [DRY_RUN_BRANCH, URGENT_BRANCH].sort(), "exactly the two urgent branches");
    for (const forbidden of ["pull_request", "schedule", "workflow_dispatch", "workflow_run", "main"]) {
      assert.ok(!on.includes(forbidden), `the on: block must not mention ${forbidden}`);
    }
    assert.match(workflow, /cancel-in-progress: true/, "a newer launch replaces an older guard");
    assert.match(
      workflow,
      /if: github\.ref_name == 'urgent-deploy\/production'\n\s+run: node scripts\/urgent-deploy\.mjs guard/,
      "the guard runs on the production branch only, never on a dry run",
    );
  }

  // ── 4. The probes name an urgent build, and the marker is never committed ────────────────────
  {
    for (const route of ["app/api/healthz/route.ts", "app/api/readyz/route.ts"]) {
      const source = stripComments(readFileSync(route, "utf8"));
      assert.match(source, /revision: readUrgentDeployRevision\(\) \?\? getDeployRevision\(\)/, `${route} reads the urgent marker first`);
    }
    const marker = stripComments(readFileSync("src/lib/observability/urgent-deploy-marker.ts", "utf8"));
    assert.ok(marker.includes(`"public", "urgent-deploy.json"`), "the probe reads the file the script writes");
    assert.equal(MARKER_PATH, "public/urgent-deploy.json");
    assert.ok(!existsSync(MARKER_PATH), `${MARKER_PATH} must never be committed — a normal build would then claim to be urgent`);
  }
}
