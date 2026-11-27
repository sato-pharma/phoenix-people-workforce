// Starts the speak script so it OUTLIVES the hook. The app ends everything a hook started when the hook returns
// (a detached child died before it said a word, 20 Nov 2026), so the process is created by Windows itself
// (WMI Win32_Process.Create), outside the hook's process tree. Takes about a second.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const PYTHONW = "C:/Users/satoh/AppData/Local/Programs/Python/Python313/pythonw.exe";
export const SCRIPT = join(homedir(), ".claude", "scripts", "speak-arabic-reply.py");

export function launchSpeak(args) {
  const commandLine = [PYTHONW, SCRIPT, ...args].map((part) => `"${String(part).replace(/"/g, "")}"`).join(" ");
  const ps = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' } | Out-Null`;
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 8000,
  });
}
