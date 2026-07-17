import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

type CheckRow = {
  check: string;
  detail: string;
  status: CheckStatus;
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

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
}

function npmCliScript(command: "npm" | "npx") {
  const scriptName = command === "npm" ? "npm-cli.js" : "npx-cli.js";
  const scriptPath = join(dirname(process.execPath), "node_modules", "npm", "bin", scriptName);
  return existsSync(scriptPath) ? scriptPath : null;
}

function commandWorks(command: string, args: string[]) {
  let result = run(command, args);
  if ((command === "npm" || command === "npx") && result.error && process.platform === "win32") {
    const cliScript = npmCliScript(command);
    if (cliScript) {
      result = run(process.execPath, [cliScript, ...args]);
    }
  }
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    status: result.status,
    success: result.status === 0,
  };
}

function isNode20OrHigher() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return Number.isFinite(major) && major >= 20;
}

function supabaseLocalBinaryPath() {
  const extension = process.platform === "win32" ? "supabase.cmd" : "supabase";
  return join("node_modules", ".bin", extension);
}

function printRows(rows: CheckRow[]) {
  const checkWidth = Math.max("Check".length, ...rows.map((row) => row.check.length));
  const statusWidth = Math.max("Status".length, ...rows.map((row) => row.status.length));

  console.log(`${"Status".padEnd(statusWidth)}  ${"Check".padEnd(checkWidth)}  Detail`);
  console.log(`${"-".repeat(statusWidth)}  ${"-".repeat(checkWidth)}  ${"-".repeat(48)}`);

  for (const row of rows) {
    console.log(`${row.status.padEnd(statusWidth)}  ${row.check.padEnd(checkWidth)}  ${row.detail}`);
  }
}

function add(rows: CheckRow[], status: CheckStatus, check: string, detail: string) {
  rows.push({ check, detail, status });
}

function failWith(rows: CheckRow[], message: string) {
  printRows(rows);
  console.log("");
  console.log(`BLOCKER: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const rows: CheckRow[] = [];
  const loadInfo = loadLocalEnvFile(localEnvPath);

  add(
    rows,
    loadInfo.status === "found" ? "PASS" : "WARN",
    "local env file",
    loadInfo.status === "found"
      ? `${localEnvPath} loaded (${loadInfo.loadedKeys} keys, secrets not printed)`
      : `${localEnvPath} not found`,
  );

  add(
    rows,
    isNode20OrHigher() ? "PASS" : "FAIL",
    "Node.js",
    `detected ${process.version}; Node 20+ required for Supabase CLI npm/npx usage`,
  );

  const npmCheck = commandWorks("npm", ["--version"]);
  const runningUnderNpm = Boolean(process.env.npm_lifecycle_event || process.env.npm_package_name);
  const npmAvailable = npmCheck.success || runningUnderNpm;
  add(
    rows,
    npmAvailable ? "PASS" : "FAIL",
    "npm",
    npmCheck.success
      ? `detected ${npmCheck.output}`
      : runningUnderNpm
        ? "current script is running under npm; direct child-process npm check was unavailable"
        : "npm command is unavailable",
  );

  if (!isNode20OrHigher() || !npmAvailable) {
    failWith(rows, "Install Node.js 20+ and ensure npm is available before local RLS validation.");
    return;
  }

  const dockerVersion = commandWorks("docker", ["--version"]);
  add(
    rows,
    dockerVersion.success ? "PASS" : "FAIL",
    "Docker command",
    dockerVersion.success ? dockerVersion.output : "docker command is unavailable",
  );

  if (!dockerVersion.success) {
    failWith(rows, "Install Docker Desktop for Windows and start it. Local Supabase cannot run without Docker.");
    return;
  }

  const dockerDaemon = commandWorks("docker", ["info", "--format", "{{.ServerVersion}}"]);
  add(
    rows,
    dockerDaemon.success ? "PASS" : "FAIL",
    "Docker daemon",
    dockerDaemon.success ? `running; server ${dockerDaemon.output}` : "Docker is installed but the daemon is not running",
  );

  if (!dockerDaemon.success) {
    failWith(rows, "Open Docker Desktop and wait until it reports running, then re-run this preflight.");
    return;
  }

  const localSupabasePath = supabaseLocalBinaryPath();
  const localSupabaseExists = existsSync(localSupabasePath);
  add(
    rows,
    localSupabaseExists ? "PASS" : "WARN",
    "local Supabase CLI binary",
    localSupabaseExists ? `${localSupabasePath} exists` : `${localSupabasePath} not found`,
  );

  let localSupabaseWorks = false;
  if (localSupabaseExists) {
    const localSupabase = commandWorks(localSupabasePath, ["--help"]);
    localSupabaseWorks = localSupabase.success;
    add(
      rows,
      localSupabase.success ? "PASS" : "FAIL",
      "local Supabase CLI help",
      localSupabase.success ? "node_modules Supabase CLI responds to --help" : "local Supabase CLI failed --help",
    );
  }

  const npxSupabase = commandWorks("npx", ["--no-install", "supabase", "--help"]);
  add(
    rows,
    npxSupabase.success ? "PASS" : "WARN",
    "npx Supabase CLI help",
    npxSupabase.success
      ? "npx --no-install supabase --help succeeds"
      : "npx cannot find an installed Supabase CLI without downloading",
  );

  if (!localSupabaseWorks && !npxSupabase.success) {
    failWith(
      rows,
      "Supabase CLI is missing. Run: pnpm add --save-dev supabase. Do not install the Supabase CLI globally.",
    );
    return;
  }

  add(
    rows,
    existsSync(supabaseConfigPath) ? "PASS" : "WARN",
    "Supabase local config",
    existsSync(supabaseConfigPath)
      ? `${supabaseConfigPath} exists`
      : `${supabaseConfigPath} missing; local setup can initialize it when prerequisites pass`,
  );

  const freeOnly = process.env.PHOENIX_RLS_FREE_ONLY;
  add(
    rows,
    freeOnly === "1" ? "PASS" : "WARN",
    "free-only flag",
    freeOnly === "1" ? "PHOENIX_RLS_FREE_ONLY=1" : "PHOENIX_RLS_FREE_ONLY is not 1",
  );

  const paidBranch = process.env.PHOENIX_RLS_ALLOW_PAID_BRANCH;
  add(
    rows,
    paidBranch === "1" ? "FAIL" : "PASS",
    "paid branch flag",
    paidBranch === "1"
      ? "PHOENIX_RLS_ALLOW_PAID_BRANCH=1 is not allowed"
      : "paid branch creation is disabled or unset",
  );

  if (paidBranch === "1") {
    failWith(rows, "Disable paid branch/project creation by setting PHOENIX_RLS_ALLOW_PAID_BRANCH=0.");
    return;
  }

  printRows(rows);
  console.log("");
  console.log("PASS local RLS prerequisites are ready for free-only local Supabase validation.");
  console.log("Next commands:");
  console.log("  pnpm run db:rls:discover-free-target");
  console.log("  pnpm run db:validate:role-alignment:local:dry-run");
}

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
