<#
Phoenix Workforce  --  WINDOWS JOB OBJECT MEMORY CAP
====================================================
A HARD, OS-ENFORCED ceiling on node.exe memory. Dot-source this; it defines the type and two
functions and does nothing else.

WHY A JOB OBJECT AND NOT ANOTHER WATCHDOG RULE. mem-watchdog.ps1 polls every 3 seconds and kills
after the fact. That is enough for a slow climb and useless against a fast one: the 2026-08-26
runaway went 22.22 GB -> 41.19 GB of commit in about FORTY SECONDS, and the 2026-09-08 ExcelJS
probe went 22 -> 41 GB in 40s. A job object does not poll. The limit is enforced inside the
kernel's allocator, so the offending VirtualAlloc simply FAILS and node throws
"JavaScript heap out of memory" or aborts. There is no window in which the machine is over the
line, which is the whole difference between a crashed dev server and a frozen desktop.

mem-watchdog.ps1's own header already says this in as many words: "Only an external killer (or an
OS job object) reaches that memory." This is that job object. It was never built.

TWO LIMITS, AND THEY CATCH DIFFERENT THINGS:
  * PROCESS memory limit -- caps ONE process. Deterministic: the runaway is the process that
    fails, so it is the one that dies. This is the runaway catcher.
  * JOB memory limit -- caps the SUM across every assigned process. This is what a per-process
    limit can never do: on 2026-09-09 no single node process was over the line, four to seven of
    them TOGETHER were, and that is what froze the box. The cost is that the allocation which
    fails belongs to whichever process asks next, not necessarily the guilty one - so this is a
    last-resort backstop under the watchdog's rule 5, which picks its victim deliberately.

WHAT THIS DELIBERATELY DOES NOT DO:
  * NO JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. With that flag every assigned process dies the moment
    the last handle to the job closes - so a watchdog restart, or its own crash, would take the
    owner's dev server with it. Omitted on purpose. Do not add it.
  * It never touches claude, the browser, the editor or anything else. Only processes explicitly
    passed to Add-ProcessToPhxJob, which in practice means node.exe dev servers.

VERIFY IT, DO NOT TRUST IT: scripts/phx-job-cap.test.ps1 spawns a real node process that
allocates in a loop and asserts it dies at the cap instead of growing past it.
#>

$phxJobSig = @'
using System;
using System.Runtime.InteropServices;

public static class PhxJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  public const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
  public const uint JOB_OBJECT_LIMIT_JOB_MEMORY     = 0x00000200;
  public const int  JobObjectExtendedLimitInformation = 9;

  // AssignProcessToJobObject needs both of these on the process handle.
  public const uint PROCESS_TERMINATE = 0x0001;
  public const uint PROCESS_SET_QUOTA = 0x0100;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len, IntPtr ret);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  public const uint JOB_OBJECT_QUERY = 0x0004;
  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  // Answers "is pid inside the job called <name>" from OUTSIDE the watchdog, which is the only
  // way to check the ceiling is really attached rather than merely logged as attached.
  // Returns 1 yes, 0 no, -1 could not tell (job or process could not be opened).
  public static int IsPidInNamedJob(string name, int pid) {
    IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY, false, name);
    if (job == IntPtr.Zero) { return -1; }
    IntPtr proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
    if (proc == IntPtr.Zero) { CloseHandle(job); return -1; }
    try {
      bool inJob;
      if (!IsProcessInJob(proc, job, out inJob)) { return -1; }
      return inJob ? 1 : 0;
    } finally { CloseHandle(proc); CloseHandle(job); }
  }

  // Peak job memory read through the NAME, so a checker outside the watchdog can see the same
  // number the kernel is enforcing against.
  public static ulong PeakJobMemoryByName(string name) {
    IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY, false, name);
    if (job == IntPtr.Zero) { return 0; }
    try { return PeakJobMemory(job); } finally { CloseHandle(job); }
  }

  // Creates (or opens) the named job and stamps both limits on it.
  // Returns the job handle, or IntPtr.Zero with LastError set.
  public static IntPtr CreateCappedJob(string name, ulong perProcessBytes, ulong jobBytes) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
    if (job == IntPtr.Zero) { return IntPtr.Zero; }
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    uint flags = 0;
    if (perProcessBytes > 0) { flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY; info.ProcessMemoryLimit = (UIntPtr)perProcessBytes; }
    if (jobBytes > 0)        { flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;     info.JobMemoryLimit     = (UIntPtr)jobBytes; }
    info.BasicLimitInformation.LimitFlags = flags;
    int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr p = Marshal.AllocHGlobal(len);
    try {
      Marshal.StructureToPtr(info, p, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, p, (uint)len)) {
        CloseHandle(job);
        return IntPtr.Zero;
      }
    } finally { Marshal.FreeHGlobal(p); }
    return job;
  }

  // 0 = assigned, otherwise the Win32 error code.
  public static int Assign(IntPtr job, int pid) {
    IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, (uint)pid);
    if (h == IntPtr.Zero) { return Marshal.GetLastWin32Error(); }
    try {
      if (!AssignProcessToJobObject(job, h)) { return Marshal.GetLastWin32Error(); }
      return 0;
    } finally { CloseHandle(h); }
  }

  // Peak job memory in bytes, or 0 if it cannot be read. Proves the limit is really attached.
  public static ulong PeakJobMemory(IntPtr job) {
    int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr p = Marshal.AllocHGlobal(len);
    try {
      if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, p, (uint)len, IntPtr.Zero)) { return 0; }
      var info = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(p, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      return (ulong)info.PeakJobMemoryUsed;
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@

if (-not ('PhxJob' -as [type])) { Add-Type -TypeDefinition $phxJobSig -ErrorAction Stop }

function New-PhxJobCap {
  <#
    Creates the capped job. $PerProcessGB bounds ONE process; $JobGB bounds the SUM.
    Pass 0 for either to leave that limit off.
  #>
  param(
    [string]$Name = 'Global\PhoenixWorkforceNodeCap',
    [double]$PerProcessGB = 7.0,
    [double]$JobGB = 9.0
  )
  $pp = [uint64]($PerProcessGB * 1GB)
  $jb = [uint64]($JobGB * 1GB)
  $h = [PhxJob]::CreateCappedJob($Name, $pp, $jb)
  if ($h -eq [IntPtr]::Zero) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "CreateCappedJob failed, Win32 error $err"
  }
  return $h
}

function Add-ProcessToPhxJob {
  # Returns $true if the process is now inside the job. ERROR_ACCESS_DENIED (5) on a process
  # already in this job is a SUCCESS, not a failure - re-assignment is what a rescan does.
  param([IntPtr]$Job, [int]$ProcessId)
  $rc = [PhxJob]::Assign($Job, $ProcessId)
  if ($rc -eq 0) { return $true }
  return $false
}
