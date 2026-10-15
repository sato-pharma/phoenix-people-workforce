import { systemAccessContext } from "@/lib/auth/permissions";
import { runVacationRetentionPurge } from "@/lib/vacation/service";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "vacation-retention-purge",
  entry: import.meta.url,
  known: ["--execute"],
});

const execute = process.argv.includes("--execute");

if (execute && process.env.PHOENIX_ALLOW_LEAVE_RETENTION_PURGE !== "true") {
  throw new Error("Set PHOENIX_ALLOW_LEAVE_RETENTION_PURGE=true before running an actual leave retention purge.");
}

const result = await runVacationRetentionPurge(systemAccessContext, {
  dryRun: !execute,
});

console.log(JSON.stringify(result, null, 2));
