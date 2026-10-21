import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DNS_TTL_SECONDS,
  DOMAIN,
  FORCED_KEYS,
  RAILWAY_TARGET,
  classifyTarget,
  filterVariables,
  flyTarget,
  planFlip,
  redact,
  renderSecrets,
  servedBy,
} from "../scripts/emergency-host.mjs";
import { stripComments } from "./support/comment-strip.ts";

/** Full-line comments out, line endings normalised (a Windows checkout carries CRLF, the runner LF). */
const withoutFullLineComments = (source: string): string =>
  source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/**
 * The emergency host: a standby copy of Phoenix on Fly.io in Frankfurt, switched by a button the owner presses
 * (owner, 2026-10-21; docs/deployment.md, "The emergency host").
 *
 * Each property below would fail SILENTLY if lost:
 *
 *   1. The standby never runs a scheduler or the CRM poller — fly.toml forces the web role and the poller off, and the
 *      variable copy can never override them or carry RAILWAY_ENVIRONMENT_NAME (the poller's host pin).
 *   2. The domain is flipped only from a state this route recognises, only to a standby that has a certificate and
 *      answers with the commit, and only back to a Railway that answers.
 *   3. Only a main commit with a green release-gate job reaches the standby — off Railway, the container's own gate is open.
 *   4. The workflow is started by hand only, never cancelled half way, and stays in Frankfurt.
 */
export function runEmergencyHostTests(): void {
  const workflow = withoutFullLineComments(readFileSync(".github/workflows/emergency-host.yml", "utf8"));
  const flyToml = withoutFullLineComments(readFileSync("infra/fly-standby/fly.toml", "utf8"));
  const script = stripComments(readFileSync("scripts/emergency-host.mjs", "utf8")).replace(/\r\n/g, "\n");

  // ── 1. Web only: no scheduler, no poller, no Railway identity ─────────────────────────────────────────────────────
  {
    const { kept, dropped } = filterVariables({
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      APP_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "production",
      RAILWAY_GIT_COMMIT_SHA: "abc",
      RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      PHOENIX_PROCESS_ROLE: "all",
      PHOENIX_LIVE_CRM_POLL: "true",
      PORT: "3000",
      HOSTNAME: "::",
      CLOUDFLARE_API_TOKEN: "dns-edit",
      EMPTY_ONE: "",
      "bad-name": "x",
    });
    assert.deepEqual(Object.keys(kept).sort(), ["APP_ENV", "SUPABASE_SERVICE_ROLE_KEY"], "only the app's own settings are copied");
    for (const name of ["RAILWAY_ENVIRONMENT_NAME", "RAILWAY_GIT_COMMIT_SHA", "PHOENIX_PROCESS_ROLE", "PHOENIX_LIVE_CRM_POLL", "PORT", "CLOUDFLARE_API_TOKEN"]) {
      assert.ok(dropped.includes(name), `${name} is never copied to the standby`);
    }

    assert.match(flyToml, /^primary_region = "fra"$/m, "the standby lives in Frankfurt, beside the database");
    const envBlock = /^\[env\]\n([\s\S]*?)(?:^\[|$(?![\s\S]))/m.exec(flyToml)?.[1] ?? "";
    assert.match(envBlock, /^\s*PHOENIX_PROCESS_ROLE = "web"$/m, "the standby is a web process: the schedulers refuse to start");
    assert.match(envBlock, /^\s*PHOENIX_LIVE_CRM_POLL = "false"$/m, "the CRM poller is off on the standby");
    const forced = [...envBlock.matchAll(/^\s*([A-Z_]+) = /gm)].map((m) => m[1]);
    assert.ok(forced.length >= 2, "fly.toml's [env] was read");
    for (const name of forced) assert.ok(FORCED_KEYS.includes(name), `${name} is forced by fly.toml, so the copy (a Fly secret, which outranks [env]) must drop it`);
    assert.doesNotMatch(flyToml, /RAILWAY_ENVIRONMENT_NAME/, "the standby never claims to be Railway production");
  }

  // ── The variable file `flyctl secrets import` reads ───────────────────────────────────────────────────────────────
  {
    assert.equal(renderSecrets({ A: "1", B: "x=y" }), "A=1\nB=x=y\n");
    assert.equal(renderSecrets({ KEY: "line1\nline2" }), 'KEY="""line1\nline2"""\n', "a multi-line value is triple-quoted");
    assert.throws(() => renderSecrets({ KEY: 'a\n"""b' }), /cannot be imported/);
    assert.equal(redact("token abcdef used", ["abcdef"]), "token *** used");
  }

  // ── 2. Where the domain points, who answered, and when a flip is allowed ──────────────────────────────────────────
  {
    assert.equal(classifyTarget(RAILWAY_TARGET, "phoenix-hr-standby"), "railway");
    assert.equal(classifyTarget("PHOENIX-HR-STANDBY.fly.dev.", "phoenix-hr-standby"), "fly", "case and a trailing dot do not matter");
    assert.equal(classifyTarget("something-else.example.com", "phoenix-hr-standby"), "unknown");
    assert.equal(flyTarget("phoenix-hr-standby"), "phoenix-hr-standby.fly.dev");

    assert.equal(servedBy(new Headers({ "fly-request-id": "01J" })), "fly");
    assert.equal(servedBy(new Headers({ server: "Fly/1a2b (2026-10-01)" })), "fly");
    assert.equal(servedBy(new Headers({ "x-railway-request-id": "r1" })), "railway");
    assert.equal(servedBy(new Headers({ server: "railway-edge" })), "railway");
    assert.equal(servedBy(new Headers({})), "unknown", "an unrecognised answer is never read as either host");

    assert.throws(() => planFlip({ current: "unknown", to: "fly" }), /nobody here set/, "a record nobody here set is never changed");
    assert.throws(() => planFlip({ current: "railway", to: "staging" }), /must be fly or railway/);
    assert.equal(planFlip({ current: "railway", to: "fly" }), "flip");
    assert.equal(planFlip({ current: "fly", to: "fly" }), "already");

    // Inside `point`: the certificate and the standby's own answer are read BEFORE the record is changed, and Railway's
    // own answer before a flip back. Proof afterwards is the DOMAIN answering from the chosen host.
    const point = /async function point\(flags\) \{([\s\S]*?)\n\}\n/.exec(script)?.[1] ?? "";
    assert.ok(point.length > 200, "the point command was found");
    const patchAt = point.indexOf('method: "PATCH"');
    assert.ok(patchAt > 0, "point changes the record");
    assert.ok(point.indexOf("certificates/${DOMAIN}") > 0 && point.indexOf("certificates/${DOMAIN}") < patchAt, "the certificate is checked before the flip");
    assert.ok(point.indexOf("healthz(`https://${flyTarget(app)}`)") < patchAt, "the standby must answer before the flip");
    assert.ok(point.indexOf("healthz(RAILWAY_DIRECT_URL)") < patchAt, "Railway must answer before a flip back");
    assert.ok(point.indexOf("healthz(`https://${DOMAIN}`)") > patchAt, "afterwards the domain itself is read");
    assert.match(point, /h\.host === to/, "the proof names the host that answered, not just a revision");
    assert.equal(DNS_TTL_SECONDS, 60, "a one-minute TTL, so the flip and the flip back reach users within about a minute");
    assert.equal(DOMAIN, "phoenix-hr.satopharma.com");
  }

  // ── 3. The gate ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    assert.match(workflow, /select\(\.path == "\.github\/workflows\/ci\.yml"\)/, "it asks about ci.yml's run");
    assert.match(workflow, /event=push/, "the main push run, the only one with a release-gate job that can succeed");
    assert.match(workflow, /select\(\.name == "release-gate"\)/);
    assert.match(workflow, /\[ "\$verdict" != "success" \]/, "anything but success refuses");
    assert.match(
      workflow,
      /if: \$\{\{ always\(\) && needs\.gate\.result == 'success' && \(needs\.image\.result == 'success' \|\| needs\.image\.result == 'skipped'\) \}\}/,
      "the standby job never runs without a passed gate",
    );
    assert.match(workflow, /uses: \.\/\.github\/workflows\/fallback-image\.yml\n\s+with:\n\s+ref: \$\{\{ needs\.gate\.outputs\.sha \}\}\n\s+deploy: none/, "the image comes from the fallback route's build, and that build touches no Railway service");
    const waitAt = workflow.indexOf("wait-standby --sha");
    const flipAt = workflow.indexOf("point --to fly --sha");
    assert.ok(waitAt > 0 && flipAt > waitAt, "the standby proves the commit on its own address before the domain moves");
    assert.match(workflow, /flyctl secrets import --stage -a "\$FLY_APP" < "\$RUNNER_TEMP\/standby\.env"\n\s+rm -f "\$RUNNER_TEMP\/standby\.env"/, "the copied variables are staged, and the file is removed");
  }

  // ── 4. By hand only, never cancelled, Frankfurt ───────────────────────────────────────────────────────────────────
  {
    const on = /^on:\n([\s\S]*?)^\S/m.exec(workflow)?.[1] ?? "";
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    assert.deepEqual(triggers, ["workflow_dispatch"], "only the owner starts it");
    assert.match(workflow, /cancel-in-progress: false/);
    assert.ok(!/cancel-in-progress: true/.test(workflow));
    assert.match(workflow, /--regions fra --ha=false/, "one machine, in Frankfurt");
    for (const action of ["status", "setup", "rehearse", "go-live", "back-to-railway"]) {
      assert.match(workflow, new RegExp(`^\\s+- ${action}$`, "m"), `the button offers ${action}`);
    }
    assert.doesNotMatch(workflow, /railway (up|redeploy)|serviceInstanceUpdate|serviceConnect/, "this route never changes a Railway service");
  }
}
