#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const providedArgs = process.argv.slice(2);

const [modeRaw, ...commandArgs] = providedArgs;
const mode = modeRaw?.toLowerCase();

if (!mode || mode === "-h" || mode === "--help" || !["local", "remote"].includes(mode)) {
  console.log("Usage: npm run db:supabase -- <local|remote> <supabase command>");
  console.log("Example: npm run db:supabase -- remote db push --yes");
  process.exit(mode === "-h" || mode === "--help" ? 0 : 1);
}

const rawRemoteUrl =
  process.env.SUPABASE_DB_URL ||
  "postgresql://postgres.ozucdzovmcqvepbozvqf:a7ayaneikAA%24%24@aws-1-eu-central-1.pooler.supabase.com:6543/postgres";

const localPassword = process.env.SUPABASE_DB_PASSWORD || "postgres";
const localHost = process.env.SUPABASE_DB_HOST || "127.0.0.1";
const localPort = process.env.SUPABASE_DB_PORT || "54322";
const localDbName = process.env.SUPABASE_DB_NAME || "postgres";
const defaultLocalUrl = `postgresql://postgres:${encodeURIComponent(localPassword)}@${localHost}:${localPort}/${localDbName}`;

function withSimpleProtocol(url) {
  if (/prefer_simple_protocol=true/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}sslmode=require&prefer_simple_protocol=true`;
}

const dbUrl = mode === "remote" ? withSimpleProtocol(rawRemoteUrl) : defaultLocalUrl;
const args = commandArgs.includes("--db-url") ? commandArgs : [...commandArgs, "--db-url", dbUrl];

const result = spawnSync("supabase", args, {
  stdio: "inherit",
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}
