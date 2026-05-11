import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

type DiscoveryResult = {
  anonKeyPresent: boolean;
  databaseUrlPresent: boolean;
  environment: string;
  source: string;
  targetClass: "existing_free_project" | "local_free";
  urlHost: string;
};

const localEnvPath = ".env.staging.rls.local";
const supabaseConfigPath = "supabase/config.toml";

function unquoteEnvValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnvFile(path: string) {
  if (!existsSync(path)) return { loadedKeys: 0, status: "not_found" as const };
  const source = readFileSync(path, "utf8");
  let loadedKeys = 0;
  for (const rawLine of source.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1));
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    process.env[key] = value;
    loadedKeys += 1;
  }
  return { loadedKeys, status: "found" as const };
}

function isNonProductionEnvironment(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized !== "production" &&
    normalized !== "prod" &&
    !normalized.includes("production") &&
    /(local|staging|stage|preview|dev|test|branch)/i.test(normalized)
  );
}

function assertFreeOnly() {
  if (process.env.PHOENIX_CONFIRM_STAGING_RLS_RUN !== "YES_STAGING_ONLY") {
    throw new Error("PHOENIX_CONFIRM_STAGING_RLS_RUN must be YES_STAGING_ONLY.");
  }
  if (process.env.PHOENIX_RLS_FREE_ONLY !== "1") {
    throw new Error("PHOENIX_RLS_FREE_ONLY must be 1.");
  }
  if (process.env.PHOENIX_RLS_ALLOW_PAID_BRANCH === "1") {
    throw new Error("PHOENIX_RLS_ALLOW_PAID_BRANCH must not be 1 in free-only mode.");
  }
}

function productionUrlReason(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (/(^|[-.])prod(uction)?([-.]|$)/i.test(url) || host.includes("production")) {
    return "URL contains production/prod marker";
  }
  return null;
}

function discoverExistingFreeProject(): DiscoveryResult | null {
  const environment = process.env.PHOENIX_STAGING_ENVIRONMENT?.trim() ?? "";
  const url = process.env.PHOENIX_STAGING_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.PHOENIX_STAGING_SUPABASE_ANON_KEY?.trim() ?? "";
  const database = process.env.PHOENIX_STAGING_DATABASE_URL?.trim() ?? "";
  if (!environment || !url) return null;
  if (!isNonProductionEnvironment(environment)) return null;
  if (productionUrlReason(url)) return null;
  return {
    anonKeyPresent: Boolean(anon),
    databaseUrlPresent: Boolean(database),
    environment,
    source: localEnvPath,
    targetClass: "existing_free_project",
    urlHost: new URL(url).hostname.toLowerCase(),
  };
}

function readSupabaseConfigValue(source: string, key: string) {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*([^\\r\\n#]+)`, "m"));
  return match ? unquoteEnvValue(match[1]) : null;
}

function discoverLocalFreeTarget(): DiscoveryResult | null {
  const explicitUrl = process.env.PHOENIX_LOCAL_SUPABASE_URL?.trim();
  const explicitAnon = process.env.PHOENIX_LOCAL_SUPABASE_ANON_KEY?.trim();
  const explicitDb = process.env.PHOENIX_LOCAL_SUPABASE_DATABASE_URL?.trim();
  if (explicitUrl || explicitAnon || explicitDb) {
    const url = explicitUrl || "http://127.0.0.1:54321";
    if (productionUrlReason(url)) return null;
    return {
      anonKeyPresent: Boolean(explicitAnon),
      databaseUrlPresent: Boolean(explicitDb),
      environment: "local",
      source: "PHOENIX_LOCAL_SUPABASE_* env",
      targetClass: "local_free",
      urlHost: new URL(url).hostname.toLowerCase(),
    };
  }

  if (!existsSync(supabaseConfigPath)) return null;
  const config = readFileSync(supabaseConfigPath, "utf8");
  const apiPort = readSupabaseConfigValue(config, "port") ?? "54321";
  const url = `http://127.0.0.1:${apiPort}`;
  return {
    anonKeyPresent: false,
    databaseUrlPresent: true,
    environment: "local",
    source: supabaseConfigPath,
    targetClass: "local_free",
    urlHost: new URL(url).hostname.toLowerCase(),
  };
}

async function upsertEnvValue(path: string, key: string, value: string) {
  const existing = existsSync(path) ? await readFile(path, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(existing)
    ? existing.replace(pattern, line)
    : `${existing.trimEnd()}\n${line}\n`;
  await writeFile(path, next);
}

async function writeLocalTargetIfComplete(target: DiscoveryResult) {
  if (!existsSync(localEnvPath)) return false;
  if (!target.anonKeyPresent || !target.databaseUrlPresent) return false;

  if (target.targetClass === "local_free") {
    const url = process.env.PHOENIX_LOCAL_SUPABASE_URL?.trim() || process.env.PHOENIX_STAGING_SUPABASE_URL?.trim();
    const anon = process.env.PHOENIX_LOCAL_SUPABASE_ANON_KEY?.trim();
    const db = process.env.PHOENIX_LOCAL_SUPABASE_DATABASE_URL?.trim();
    if (!url || !anon || !db) return false;
    await upsertEnvValue(localEnvPath, "PHOENIX_STAGING_ENVIRONMENT", "local");
    await upsertEnvValue(localEnvPath, "PHOENIX_STAGING_SUPABASE_URL", url);
    await upsertEnvValue(localEnvPath, "PHOENIX_STAGING_SUPABASE_ANON_KEY", anon);
    await upsertEnvValue(localEnvPath, "PHOENIX_STAGING_DATABASE_URL", db);
    return true;
  }

  return false;
}

async function main() {
  const loadInfo = loadLocalEnvFile(localEnvPath);
  console.log(
    loadInfo.status === "found"
      ? `PASS loaded ${localEnvPath} (${loadInfo.loadedKeys} keys, secrets not printed)`
      : `PASS ${localEnvPath} not found; using process environment only`,
  );

  assertFreeOnly();
  console.log("PASS free-only mode enforced");
  console.log("PASS paid Supabase branch/project creation disabled; discovery only");

  const existing = discoverExistingFreeProject();
  const local = discoverLocalFreeTarget();

  if (existing) {
    console.log(`PASS existing free staging/dev/test target found: class=${existing.targetClass}; host=${existing.urlHost}; anonKeyPresent=${existing.anonKeyPresent}; databaseUrlPresent=${existing.databaseUrlPresent}`);
  } else {
    console.log("WARN no existing free staging/dev/test Supabase project target found");
  }

  if (local) {
    console.log(`PASS local Supabase target found: class=${local.targetClass}; host=${local.urlHost}; anonKeyPresent=${local.anonKeyPresent}; databaseUrlPresent=${local.databaseUrlPresent}; source=${local.source}`);
    const updated = await writeLocalTargetIfComplete(local);
    console.log(updated ? `PASS updated ${localEnvPath} with local target values (secrets not printed)` : `WARN ${localEnvPath} not updated; local target is incomplete or env file is absent`);
  } else {
    console.log("WARN no local Supabase target found");
  }

  if (!existing && !local) {
    console.log("FAIL no safe free live target found; use static/dry-run validation only until an existing free staging/dev/test or local Supabase target is available");
    process.exitCode = 1;
    return;
  }

  const ready = [existing, local].some((target) => target?.anonKeyPresent && target.databaseUrlPresent);
  if (!ready) {
    console.log("FAIL a free target was detected, but anon key and database URL are not both available");
    process.exitCode = 1;
    return;
  }

  console.log("PASS free target discovery complete");
}

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
