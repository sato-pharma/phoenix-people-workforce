import { spawn } from "node:child_process";

const defaultAgentUrl = "http://127.0.0.1:8787";
const defaultStartScript = "local-attendance-agent\\start-agent.ps1";

export function attendanceAgentBaseUrl() {
  return process.env.ATTENDANCE_AGENT_LOCAL_URL?.trim() || defaultAgentUrl;
}

export function attendanceAgentUrl(pathname = "") {
  const baseUrl = attendanceAgentBaseUrl();
  return new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

export function attendanceAgentToken() {
  const token = process.env.ATTENDANCE_AGENT_TOKEN?.trim();
  if (!token) {
    throw new Error("ATTENDANCE_AGENT_TOKEN is required.");
  }
  return token;
}

export async function checkAttendanceAgentHealth(timeoutMs = 5000) {
  try {
    const response = await fetch(attendanceAgentUrl("health"), {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      reachable: true,
      status: response.status,
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      status: 0,
      payload: {
        message: error instanceof Error ? error.message : "Local attendance agent is not reachable.",
      },
    };
  }
}

export function startLocalAttendanceAgent() {
  const scriptPath = process.env.ATTENDANCE_AGENT_START_SCRIPT?.trim() || defaultStartScript;
  const workingDirectory = process.env.ATTENDANCE_AGENT_WORKING_DIRECTORY?.trim() || "local-attendance-agent";

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      scriptPath,
      "-SkipPrereqInstall",
    ],
    {
      cwd: workingDirectory,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();

  return { scriptPath, workingDirectory };
}

export async function ensureLocalAttendanceAgent() {
  const before = await checkAttendanceAgentHealth(2500);
  if (before.reachable) return { alreadyRunning: true, health: before };

  const started = startLocalAttendanceAgent();
  const deadline = Date.now() + 20_000;
  let health = before;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    health = await checkAttendanceAgentHealth(2500);
    if (health.reachable) {
      return { alreadyRunning: false, health, started };
    }
  }

  return { alreadyRunning: false, health, started };
}
