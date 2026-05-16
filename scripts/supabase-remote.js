#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const DEFAULT_REMOTE_DB_URL =
  "postgresql://postgres.ozucdzovmcqvepbozvqf:a7ayaneikAA%24%24@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&prefer_simple_protocol=true";

const providedArgs = process.argv.slice(2);

if (providedArgs.length === 0 || providedArgs.includes("-h") || providedArgs.includes("--help")) {
  console.log("Usage: npm run db:remote -- <supabase command>");
  console.log("Example: npm run db:remote -- db push --yes");
  process.exit(providedArgs.includes("-h") || providedArgs.includes("--help") ? 0 : 1);
}

const dbUrl = process.env.REMOTE_SUPABASE_DB_URL || DEFAULT_REMOTE_DB_URL;
const args = providedArgs.includes("--db-url")
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

