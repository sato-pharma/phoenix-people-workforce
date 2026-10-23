// scripts/check-railway-deploy-settings.mjs compares what Railway STORES with `.railway/railway.ts`.
//
// WHY IT NEEDS A TEST. It is the only thing watching the stored settings since both `railway.toml`
// files were retired on 2026-10-23: a dashboard edit no longer snaps back at the next deploy, and the
// day of the cutover the website's stored healthcheck window read 300 s against 900 s in every file.
// A comparison that silently compares nothing would report OK for ever, so each case below asserts
// one finding on its own, and the parser is run against the real authoring file and must read every
// service out of it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compareDeploySettings, parseAuthoringFile } from "../scripts/check-railway-deploy-settings.mjs";

/** What parseAuthoringFile returns — the script is plain JavaScript, so the shape is stated here. */
type Declared = {
  services: Record<
    string,
    {
      healthcheckPath?: string;
      healthcheckTimeout?: number;
      restartPolicyType?: string;
      restartPolicyMaxRetries?: number;
      mounts: Array<{ path: string; volume: string }>;
    }
  >;
  volumes: string[];
};

/** What readLiveSettings returns for one environment. */
type Live = {
  services: Record<
    string,
    {
      id: string;
      healthcheckPath: string | null;
      healthcheckTimeout: number | null;
      restartPolicyType: string | null;
      restartPolicyMaxRetries: number | null;
    }
  >;
  volumes: Array<{ name: string; mountPath: string | null; serviceId: string | null }>;
};

const FILE = `
import { defineRailway, volume, service } from "railway/iac";
export default defineRailway(() => {
  // healthcheckTimeout: 5 in a comment must never be read as the setting
  const disk = volume("files-disk", { sizeMB: 50000 });
  const app = service("app", {
    deploy: {
      healthcheckPath: "/api/readyz",
      healthcheckTimeout: 900,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
  });
  const tablets = service("tablets", {
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    volumeMounts: { "/srv/files": disk },
  });
});
`;

function liveMatching(): Live {
  return {
    services: {
      app: { id: "s-app", healthcheckPath: "/api/readyz", healthcheckTimeout: 900, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
      tablets: { id: "s-tab", healthcheckPath: null, healthcheckTimeout: null, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    },
    volumes: [{ name: "files-disk", mountPath: "/srv/files", serviceId: "s-tab" }],
  };
}

export function runRailwayDeploySettingsDriftTests() {
  const declared = parseAuthoringFile(FILE) as Declared;

  // The parser reads what the file states, and nothing out of its comments.
  assert.deepEqual(Object.keys(declared.services), ["app", "tablets"]);
  assert.equal(declared.services.app.healthcheckTimeout, 900, "a comment's number must never be read as the setting");
  assert.deepEqual(declared.services.tablets.mounts, [{ path: "/srv/files", volume: "files-disk" }]);
  assert.equal("healthcheckPath" in declared.services.tablets, false, "a field the file leaves out is not compared");

  // A match is a match.
  assert.deepEqual(compareDeploySettings(declared, liveMatching()), []);

  // 🔴 The 2026-10-23 finding: the stored window shorter than the file's.
  const shortWindow = liveMatching();
  shortWindow.services.app.healthcheckTimeout = 300;
  const windowDrift = compareDeploySettings(declared, shortWindow);
  assert.equal(windowDrift.length, 1);
  assert.match(windowDrift[0], /app: healthcheckTimeout is 300 on Railway, 900 in \.railway\/railway\.ts/);

  // A healthcheck removed in the dashboard reads as null, not as "nothing to compare".
  const noProbe = liveMatching();
  noProbe.services.app.healthcheckPath = null;
  assert.match(compareDeploySettings(declared, noProbe).join("\n"), /app: healthcheckPath is null on Railway/);

  // A restart policy switched to ALWAYS.
  const always = liveMatching();
  always.services.tablets.restartPolicyType = "ALWAYS";
  assert.match(compareDeploySettings(declared, always).join("\n"), /tablets: restartPolicyType is "ALWAYS"/);

  // 🔴 A detached disk — every tablet app download goes 404.
  const detached = liveMatching();
  detached.volumes[0] = { name: "files-disk", mountPath: null, serviceId: null };
  assert.match(compareDeploySettings(declared, detached).join("\n"), /files-disk should be mounted at \/srv\/files, but Railway has it on nothing \(detached\)/);

  // A disk mounted at the wrong path.
  const moved = liveMatching();
  moved.volumes[0].mountPath = "/elsewhere";
  assert.match(compareDeploySettings(declared, moved).join("\n"), /should be mounted at \/srv\/files, but Railway has it on tablets at \/elsewhere/);

  // 🔴 A live disk the file does not declare: a plan from the file would detach it (read on main, 23 Oct).
  const extra = liveMatching();
  extra.volumes.push({ name: "new-disk", mountPath: "/data", serviceId: "s-app" });
  assert.match(compareDeploySettings(declared, extra).join("\n"), /volume new-disk exists on Railway but \.railway\/railway\.ts does not declare it/);

  // A declared service that is gone from Railway.
  const gone = liveMatching();
  delete gone.services.tablets;
  assert.match(compareDeploySettings(declared, gone).join("\n"), /tablets: declared in \.railway\/railway\.ts but not found on Railway/);

  // The real authoring file: every service and every volume must be read out of it, or the scheduled
  // check would compare nothing and report OK.
  const real = parseAuthoringFile(readFileSync(resolve(".railway/railway.ts"), "utf8")) as Declared;
  const names = Object.keys(real.services);
  for (const name of ["phoenix-people-workforce", "phoenix-workforce-worker", "phoenix-headwind", "phoenix-cron", "headwind-db-eu"]) {
    assert.ok(names.includes(name), `the parser did not read ${name} out of .railway/railway.ts, so it would go unchecked`);
  }
  assert.equal(real.services["phoenix-people-workforce"].healthcheckPath, "/api/readyz");
  assert.ok(real.services["phoenix-people-workforce"].healthcheckTimeout >= 600, "the app's window was not read as the release gate needs it");
  assert.ok(real.volumes.includes("headwind-db-eu-volume"), "the parser did not read the Headwind database volume");
}
