# Name the process holding a worktree or husk folder open.
#
# Windows exposes no process's current directory through any built-in tool -- not
# Get-Process, not Win32_Process, not Task Manager -- and Sysinternals handle.exe is
# not installed on this machine. So this reads each process's PEB directly. It is
# strictly read-only: it never terminates anything.
#
#   powershell -NoProfile -File scripts/find-worktree-holder.ps1
#   powershell -NoProfile -File scripts/find-worktree-holder.ps1 -Path "F:\Phoenix Workforce\_wt-foo"
#
# A folder whose `rmdir` fails with exit 32 is held by one of the processes printed.
# Close that session. If it will not die -- mostly-kernel CPU with zero threads in
# Terminated state -- it is stuck inside a kernel call: Stop-Process and Task Manager
# cannot unwind it, but ARCHIVING the owning session does end it, with no reboot.
# Restart only if that fails. See AGENTS.md 2.1 (Worktrees) before spending time on one.

param([string]$Path, [switch]$Json)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PebRead {
  [StructLayout(LayoutKind.Sequential)]
  public struct PBI { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask;
                      public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFrom; }
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI info, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, int sz, out IntPtr rd);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static string CurrentDir(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);   // QUERY_INFORMATION | VM_READ
    if (h == IntPtr.Zero) return null;
    try {
      PBI pbi = new PBI(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
      byte[] buf = new byte[8]; IntPtr rd;
      if (!ReadProcessMemory(h, (IntPtr)(pbi.PebBaseAddress.ToInt64() + 0x20), buf, 8, out rd)) return null;
      long pp = BitConverter.ToInt64(buf, 0);
      byte[] us = new byte[16];
      if (!ReadProcessMemory(h, (IntPtr)(pp + 0x38), us, 16, out rd)) return null;
      int len = BitConverter.ToUInt16(us, 0);
      long ptr = BitConverter.ToInt64(us, 8);
      if (len <= 0 || len > 2000 || ptr == 0) return null;
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, (IntPtr)ptr, s, len, out rd)) return null;
      return System.Text.Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}
"@

$me = $PID
$readable = 0
$rows = @()
foreach ($p in (Get-Process)) {
  if ($p.Id -eq $me) { continue }
  $cd = $null
  try { $cd = [PebRead]::CurrentDir($p.Id) } catch { }
  if (-not $cd) { continue }
  $readable++
  $match = if ($Path) { $cd -like "$Path*" } else { ($cd -like '*_wt-*') -or ($cd -like '*.claude\worktrees\*') }
  if ($match) {
    $proc = Get-Process -Id $p.Id -ErrorAction Ignore
    $kernel = if ($proc) { $proc.PrivilegedProcessorTime.TotalSeconds } else { 0 }
    $user = if ($proc) { $proc.UserProcessorTime.TotalSeconds } else { 0 }
    $stuck = ($kernel + $user) -gt 60 -and $kernel -gt $user
    $rows += [pscustomobject]@{
      Pid       = $p.Id
      Name      = $p.ProcessName
      KernelCpu = "{0:N0}s" -f $kernel
      Suspect   = if ($stuck) { "KERNEL-STUCK?" } else { "" }
      Cwd       = $cd
    }
  }
}

if ($Json) {
  # Machine-readable form, consumed by scripts/worktree-liveness.mjs.
  #
  # `readable` is the POSITIVE CONTROL and it is not decoration. An empty `rows` means "no session
  # is sitting in a worktree" ONLY when readable > 0. If the PEB sweep itself came back empty --
  # a hardened process, a policy block, ntdll refusing, this script run without the rights it
  # needs -- then rows is empty for a reason that has nothing to do with the folders, and a caller
  # that trusted it would read a broken probe as proof every folder is free. That is the exact
  # shape AGENTS.md section 2.3 records for a dependency sweep: without a positive control an
  # empty result is indistinguishable from a broken query.
  #
  # Built by hand rather than with ConvertTo-Json on the array: Windows PowerShell 5.1 collapses a
  # one-element array to a bare object, so a single holder would not parse as a list.
  $body = ($rows | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ","
  "{""readable"":$readable,""rows"":[$body]}"
  return
}

"read the working directory of $readable process(es)"
if ($rows.Count -eq 0) {
  if ($Path) { "no process is sitting in $Path" } else { "no process is sitting in any worktree" }
} else {
  $rows | Sort-Object Cwd, Pid | Format-Table -AutoSize
  "a row marked KERNEL-STUCK? may not be killable at all -- see AGENTS.md 2.1 (Worktrees)"
}
