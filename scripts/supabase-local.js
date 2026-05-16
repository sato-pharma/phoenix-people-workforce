#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const dbPassword = process.env.SUPABASE_DB_PASSWORD || "postgres";
const dbHost = process.env.SUPABASE_DB_HOST || "127.0.0.1";
const dbPort = process.env.SUPABASE_DB_PORT || "54322";
const dbName = process.env.SUPABASE_DB_NAME || "postgres";

const DEFAULT_LOCAL_DB_URL =
  `postgresql://postgres:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;

const providedArgs = process.argv.slice(2);

if (providedArgs.length === 0 || providedArgs.includes("-h") || providedArgs.includes("--help")) {
  console.log("Usage: npm run db:local -- <supabase command>");
  console.log("Example: npm run db:local -- db reset");
  process.exit(providedArgs.includes("-h") || providedArgs.includes("--help") ? 0 : 1);
}

const dbUrl = process.env.SUPABASE_LOCAL_DB_URL || DEFAULT_LOCAL_DB_URL;
const isStartCommand = (() => {
  if (providedArgs.length === 0) return false;
  if (providedArgs[0] === "start") return true;
  if (providedArgs[0] === "db" && providedArgs[1] === "start") return true;
  return false;
})();

const args = providedArgs.includes("--db-url") || isStartCommand
  ? providedArgs
  : [...providedArgs, "--db-url", dbUrl];

const result = spawnSync("supabase", args, {
  stdio: "inherit",
  shell: false,
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}

