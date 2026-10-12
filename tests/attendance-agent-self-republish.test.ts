import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-pinning, deliberately. The behaviour is a PowerShell script that publishes a .NET project
// onto the owner's laptop, which no unit test can run; what can go wrong later is someone shortening
// the list of files it checks, or moving the check to where it never runs. Measured by hand on
// 2026-10-12 against a real publish folder instead (empty, complete, and missing only the two json
// files, which is how the production folder was found).
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (ps: string) =>
  ps
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

const ENSURE = "local-attendance-agent/ensure-published.ps1";
const START = "local-attendance-agent/start-agent.ps1";

export function runAttendanceAgentSelfRepublishTests() {
  const ensure = stripComments(read(ENSURE));
  const start = stripComments(read(START));

  // The incident was a folder with the .exe and .dll but neither json file. Each of the four is a
  // file the apphost cannot start without, so each must stay in the list.
  for (const file of [
    "Phoenix.Attendance.Agent.exe",
    "Phoenix.Attendance.Agent.dll",
    "Phoenix.Attendance.Agent.runtimeconfig.json",
    "Phoenix.Attendance.Agent.deps.json",
  ]) {
    assert.ok(
      ensure.includes(`"${file}"`),
      `${ENSURE} must treat ${file} as required - without it the agent exits at launch with 'hostpolicy.dll ... was not found'`,
    );
  }

  // It must rebuild with the project's own publish script, and fail loudly when it cannot.
  assert.ok(ensure.includes('"publish-agent.ps1"'), `${ENSURE} must rebuild through publish-agent.ps1`);
  assert.ok(ensure.includes("exit 1"), `${ENSURE} must exit 1 when the folder could not be made whole`);

  // Two starters (the logon task and the startup shortcut) race at logon, and a publish begins by
  // deleting the folder. The mutex is what keeps one from removing the other's fresh output.
  assert.ok(
    ensure.includes("Global\\PhoenixAttendanceAgentRepublish") && ensure.includes("WaitOne"),
    `${ENSURE} must serialise republishes behind a named mutex`,
  );

  // The starter must call it, after the port guard (a running agent means the folder is in use) and
  // before the line that only asks whether the .exe exists - that line is the check that failed.
  const portGuard = start.indexOf("AgentPortInUse");
  const ensureCall = start.indexOf("ensure-published.ps1");
  const exeOnlyCheck = start.indexOf("if (Test-Path $PublishedExe)");
  assert.ok(portGuard >= 0 && ensureCall >= 0 && exeOnlyCheck >= 0, `${START} lost one of its anchors`);
  assert.ok(
    portGuard < ensureCall && ensureCall < exeOnlyCheck,
    `${START} must call ensure-published.ps1 after the port guard and before it launches the published .exe`,
  );
  assert.ok(
    /ensure-published\.ps1"\)[^\n]*-Runtime \$Runtime\s*\n\s*if \(\$LASTEXITCODE -ne 0\)/.test(start),
    `${START} must stop when ensure-published.ps1 fails rather than launch a half-published agent`,
  );
}
