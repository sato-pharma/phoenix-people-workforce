using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Connections;

EnvLoader.Load();

if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ASPNETCORE_URLS"))) {
  Environment.SetEnvironmentVariable("ASPNETCORE_URLS", "http://127.0.0.1:8787");
}

var listenUrl = Environment.GetEnvironmentVariable("ASPNETCORE_URLS") ?? "http://127.0.0.1:8787";

// A SECOND agent must exit quietly, not crash.
//
// This agent is started from two places by design: the "Phoenix Attendance Agent - Run At Logon"
// scheduled task, and invoke-sync.ps1 whenever /health does not answer yet. On a cold boot the
// first copy needs ~9 seconds to reach the bind, so the two launches overlap - on 2026-08-26 both
// processes started inside the SAME SECOND (15:15:16.958 and 15:15:16). Kestrel's bind failure was
// an UNHANDLED exception, so the loser died with a 0xE0434352 fault written to the Application
// event log at EVERY boot (06:20:22, 11:13:53 and 15:15:21 on that one day). Nothing was ever
// lost - the winner serves and the 2-hourly task syncs - but a healthy system logged a hard crash
// every morning, and that is exactly the noise that hides a real fault later.
//
// The mutex settles the race before Kestrel is ever built. It is process-lifetime scoped, so a
// killed or crashed owner releases it and the next launch wins cleanly - there is no stale lock
// file anyone has to remember to clear.
using var singleInstance = new Mutex(initiallyOwned: true, "Phoenix.Attendance.Agent.SingleInstance", out var isOnlyInstance);
if (!isOnlyInstance) {
  Log.Info("attendance_agent_already_running", new {
    listenUrl,
    reason = "another agent instance holds the single-instance mutex",
  });
  return 0;
}

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(options => {
  options.SingleLine = true;
  options.TimestampFormat = "yyyy-MM-dd HH:mm:ss ";
});

builder.Services.ConfigureHttpJsonOptions(options => {
  options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
  options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

builder.Services.AddSingleton(AgentConfig.FromEnvironment());
builder.Services.AddSingleton<StartupValidator>();
builder.Services.AddSingleton<ZktecoDeviceClient>();
builder.Services.AddSingleton<AttendanceSyncRunner>();
builder.Services.AddHttpClient<PhoenixClient>((services, client) => {
  var config = services.GetRequiredService<AgentConfig>();
  client.BaseAddress = new Uri(config.PhoenixBaseUrl.TrimEnd('/') + "/");
  client.Timeout = TimeSpan.FromMinutes(5);
  client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.AttendanceAgentToken);
});

var app = builder.Build();
var config = app.Services.GetRequiredService<AgentConfig>();
var validator = app.Services.GetRequiredService<StartupValidator>();

Log.Info("attendance_agent_starting", new {
  listenUrl = Environment.GetEnvironmentVariable("ASPNETCORE_URLS"),
  config.DeviceId,
  config.DeviceIp,
  config.DevicePort,
  config.PhoenixBaseUrl,
  syncStartDate = config.SyncStartDate.ToString("yyyy-MM-dd"),
  config.AutoSyncEnabled,
  config.AutoSyncIntervalMinutes,
  requiredTimes = config.AutoSyncRequiredTimes,
});

// The startup checks must NOT delay the bind.
//
// They probe the fingerprint device (5s timeout) and Phoenix over the internet. Overnight the
// device is off the network and both probes run long, so the agent could take well over 30
// seconds to reach app.Run() - past the 30s invoke-sync.ps1 waits for /health before deciding
// the agent is down and launching ANOTHER one (scheduled-sync.log, 2026-08-25 02:00 and
// 2026-08-26 17:00). That duplicate is the same collision the single-instance mutex above had to
// be written for. Binding first removes the cause rather than only surviving it: /health answers
// in about a second, and the checks report into the log a moment later.
_ = Task.Run(async () => {
  var startupChecks = await validator.CheckAsync(includeDeviceConnect: false);
  Log.Info("attendance_agent_startup_checks", startupChecks);
});

if (config.AutoSyncEnabled) {
  AutoSyncScheduler.Start(app.Services, config);
}

app.MapGet("/health", async (StartupValidator startupValidator) => {
  var checks = await startupValidator.CheckAsync(includeDeviceConnect: true);
  // "critical" checks determine 200 vs 503: agent can still receive commands even when device is offline.
  var critical = checks.TokenConfigured && checks.SdkRegistered && checks.PhoenixReachable;
  var status = critical && checks.DeviceConnects ? "ok"
    : critical ? "degraded"
    : "down";
  return Results.Json(new { status, checks },
    statusCode: critical ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable);
});

app.MapPost("/test-device", async (HttpRequest request, AgentConfig cfg, ZktecoDeviceClient deviceClient) => {
  if (!Auth.IsAuthorized(request, cfg.AttendanceAgentToken)) {
    return Results.Unauthorized();
  }

  try {
    var tcpReachable = await NetworkChecks.CanConnectTcpAsync(cfg.DeviceIp, cfg.DevicePort, TimeSpan.FromSeconds(5));
    if (!tcpReachable) {
      return Results.Json(new { ok = false, message = "Device TCP port is not reachable." }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    var result = await Retry.DoAsync(
      () => deviceClient.TestConnectionAsync(),
      "device-test",
      attempts: 2
    );

    return Results.Json(new { ok = true, result });
  } catch (Exception ex) {
    Log.Error("test_device_failed", ex);
    return Results.Json(new { ok = false, error = ex.Message }, statusCode: StatusCodes.Status500InternalServerError);
  }
});

// Read-only: lists the users ENROLLED ON THE DEVICE, with the names the device itself stores.
// This exists because a device user id that has no row in attendance_device_user_map is otherwise
// anonymous - its punches are skipped on every sync and nothing anywhere can say who it belongs to.
// The SDK also returns each user's password; it is deliberately read into a discard and never
// serialised, so the response carries identity only.
app.MapGet("/device-users", async (HttpRequest request, AgentConfig cfg, ZktecoDeviceClient deviceClient) => {
  if (!Auth.IsAuthorized(request, cfg.AttendanceAgentToken)) {
    return Results.Unauthorized();
  }

  try {
    var tcpReachable = await NetworkChecks.CanConnectTcpAsync(cfg.DeviceIp, cfg.DevicePort, TimeSpan.FromSeconds(5));
    if (!tcpReachable) {
      return Results.Json(new { ok = false, message = $"Device {cfg.DeviceIp}:{cfg.DevicePort} is not reachable." },
        statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    var users = await deviceClient.ReadDeviceUsersAsync();
    return Results.Json(new { ok = true, deviceId = cfg.DeviceId, count = users.Count, users });
  } catch (Exception ex) {
    Log.Error("device_users_failed", ex);
    return Results.Json(new { ok = false, error = ex.Message }, statusCode: StatusCodes.Status500InternalServerError);
  }
});

app.MapPost("/sync-now", async (HttpRequest request, AgentConfig cfg, AttendanceSyncRunner syncRunner) => {
  if (!Auth.IsAuthorized(request, cfg.AttendanceAgentToken)) {
    return Results.Unauthorized();
  }

  try {
    var result = await syncRunner.SyncAsync("manual");
    return Results.Json(result.Body, statusCode: result.StatusCode);
  } catch (Exception ex) {
    Log.Error("sync_failed", ex, new { trigger = "manual" });
    return Results.Json(new {
      totalRead = 0,
      inserted = 0,
      duplicate = 0,
      skipped = 0,
      failed = 1,
      errors = new[] { ex.Message },
    }, statusCode: StatusCodes.Status500InternalServerError);
  }
});

// The mutex above settles the race between our own launchers, but not a port held by something
// that is NOT this agent - an older build with no mutex, or an unrelated process squatting on
// 8787. A bind failure must still never be an unhandled crash, and the two cases need different
// answers: another healthy agent is success (exit 0), a foreign squatter is a real fault the
// operator has to see (exit 1) rather than a stack trace in the event log.
try {
  app.Run();
} catch (IOException ex) when (ex.InnerException is AddressInUseException) {
  if (await NetworkChecks.IsAttendanceAgentServingAsync(listenUrl)) {
    Log.Info("attendance_agent_already_running", new {
      listenUrl,
      reason = "another agent instance already answers /health on this port",
    });
    return 0;
  }

  Log.Error("attendance_agent_port_unavailable", ex, new {
    listenUrl,
    reason = "a process that is not the Phoenix attendance agent is holding the listen port",
  });
  return 1;
}

return 0;

sealed record AgentConfig(
  string PhoenixBaseUrl,
  string AttendanceAgentToken,
  string DeviceId,
  string DeviceIp,
  int DevicePort,
  int DeviceCommPassword,
  string DeviceReadMethod,
  DateTime SyncStartDate,
  int DeviceOperationTimeoutSeconds,
  bool AutoSyncEnabled,
  int AutoSyncIntervalMinutes,
  string[] AutoSyncRequiredTimes
) {
  public static AgentConfig FromEnvironment() {
    return new AgentConfig(
      Required("PHOENIX_BASE_URL"),
      Required("ATTENDANCE_AGENT_TOKEN"),
      Required("DEVICE_ID"),
      Required("DEVICE_IP"),
      ParseInt("DEVICE_PORT", "4370"),
      ParseInt("DEVICE_COMM_PASSWORD", "0"),
      ReadMethod("DEVICE_READ_METHOD", "legacy"),
      ParseDate("SYNC_START_DATE", "2026-01-01"),
      ParseInt("DEVICE_OPERATION_TIMEOUT_SECONDS", "30"),
      ParseBool("AUTO_SYNC_ENABLED", "false"),
      ParseInt("AUTO_SYNC_INTERVAL_MINUTES", "120"),
      ParseList("AUTO_SYNC_REQUIRED_TIMES", "17:00")
    );
  }

  static string Required(string key) {
    var value = Environment.GetEnvironmentVariable(key)?.Trim();
    if (string.IsNullOrWhiteSpace(value) || value.StartsWith("replace-", StringComparison.OrdinalIgnoreCase)) {
      throw new InvalidOperationException($"{key} is required in .env.");
    }
    return value;
  }

  static int ParseInt(string key, string defaultValue) {
    var value = Environment.GetEnvironmentVariable(key)?.Trim();
    if (string.IsNullOrWhiteSpace(value)) value = defaultValue;
    return int.TryParse(value, out var parsed)
      ? parsed
      : throw new InvalidOperationException($"{key} must be a number.");
  }

  static string ReadMethod(string key, string defaultValue) {
    var value = Environment.GetEnvironmentVariable(key)?.Trim().ToLowerInvariant();
    if (string.IsNullOrWhiteSpace(value)) value = defaultValue;
    return value is "legacy" or "ssr" ? value : throw new InvalidOperationException($"{key} must be legacy or ssr.");
  }

  static bool ParseBool(string key, string defaultValue) {
    var value = Environment.GetEnvironmentVariable(key)?.Trim();
    if (string.IsNullOrWhiteSpace(value)) value = defaultValue;
    return value.Equals("true", StringComparison.OrdinalIgnoreCase)
      || value.Equals("1", StringComparison.OrdinalIgnoreCase)
      || value.Equals("yes", StringComparison.OrdinalIgnoreCase);
  }

  static string[] ParseList(string key, string defaultValue) {
    var value = Environment.GetEnvironmentVariable(key)?.Trim();
    if (string.IsNullOrWhiteSpace(value)) value = defaultValue;
    return value.Split(",", StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
  }

  static DateTime ParseDate(string key, string defaultValue) {
    var value = Environment.GetEnvironmentVariable(key)?.Trim();
    if (string.IsNullOrWhiteSpace(value)) value = defaultValue;
    return DateTime.TryParse(value, out var parsed)
      ? DateTime.SpecifyKind(parsed.Date, DateTimeKind.Local)
      : throw new InvalidOperationException($"{key} must be a date such as 2026-01-01.");
  }
}

sealed record StartupChecks(
  bool TokenConfigured,
  bool SdkRegistered,
  bool DeviceTcpReachable,
  bool DeviceConnects,
  bool PhoenixReachable,
  string[] Errors
);

sealed class StartupValidator(AgentConfig config) {
  public async Task<StartupChecks> CheckAsync(bool includeDeviceConnect) {
    var errors = new List<string>();
    var tokenConfigured = !string.IsNullOrWhiteSpace(config.AttendanceAgentToken);
    var sdkRegistered = ZktecoDeviceClient.FindComType() is not null;
    // These two probes are independent, so they run TOGETHER - awaiting them one after the other
    // made /health cost their SUM. That mattered: /health is the liveness check invoke-sync.ps1
    // uses to decide whether an agent is running, and it gives up after 5 seconds. With the
    // fingerprint device off the network overnight the TCP probe alone burns its full 3s timeout,
    // measured 3.4-3.7s end to end on 2026-08-26 - inside the budget, but only just. Any load
    // (a boot, a big compression job, several sessions) pushed it past 5s, invoke-sync concluded
    // "Agent not listening" about an agent that was serving perfectly, and launched a SECOND one.
    // That duplicate is what lost the race for port 8787 and died 0xE0434352 at every boot.
    var deviceTcpTask = NetworkChecks.CanConnectTcpAsync(config.DeviceIp, config.DevicePort, TimeSpan.FromSeconds(3));
    var phoenixTask = NetworkChecks.CanReachHttpAsync(config.PhoenixBaseUrl, TimeSpan.FromSeconds(5));
    await Task.WhenAll(deviceTcpTask, phoenixTask);
    var deviceTcpReachable = await deviceTcpTask;
    var phoenixReachable = await phoenixTask;
    var deviceConnects = false;

    if (!tokenConfigured) errors.Add("ATTENDANCE_AGENT_TOKEN is missing.");
    if (!sdkRegistered) errors.Add("ZKTeco SDK COM object is not registered. Install/register zkemkeeper.dll.");
    if (!deviceTcpReachable) errors.Add($"Device {config.DeviceIp}:{config.DevicePort} is not reachable.");
    if (!phoenixReachable) errors.Add($"Phoenix is not reachable at {config.PhoenixBaseUrl}.");

    if (includeDeviceConnect && sdkRegistered && deviceTcpReachable) {
      try {
        var result = await new ZktecoDeviceClient(config).TestConnectionAsync();
        deviceConnects = result.Connected;
      } catch (Exception ex) {
        errors.Add(ex.Message);
      }
    }

    return new StartupChecks(tokenConfigured, sdkRegistered, deviceTcpReachable, deviceConnects, phoenixReachable, errors.ToArray());
  }
}

sealed record DeviceConnectionResult(bool Connected, string DeviceId, string DeviceIp, int DevicePort);

sealed record AttendanceSyncResult(int StatusCode, object Body);

sealed class AttendanceSyncRunner(AgentConfig config, ZktecoDeviceClient deviceClient, PhoenixClient phoenixClient) {
  readonly SemaphoreSlim syncLock = new(1, 1);

  public async Task<AttendanceSyncResult> SyncAsync(string trigger) {
    if (!await syncLock.WaitAsync(0)) {
      return new AttendanceSyncResult(StatusCodes.Status202Accepted, new {
        syncInProgress = true,
        message = "Attendance sync is already running.",
        totalRead = 0,
        inserted = 0,
        duplicate = 0,
        skipped = 0,
        failed = 0,
        errors = new[] { "Attendance sync is already running." },
      });
    }

    var runId = $"{config.DeviceId}-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}-{Guid.NewGuid():N}";
    var startedAt = Stopwatch.GetTimestamp();
    Log.Info("sync_started", new { runId, config.DeviceId, trigger, syncStartDate = config.SyncStartDate.ToString("yyyy-MM-dd") });

    try {
      var tcpReachable = await NetworkChecks.CanConnectTcpAsync(config.DeviceIp, config.DevicePort, TimeSpan.FromSeconds(5));
      if (!tcpReachable) {
        var unreachable = new {
          runId,
          trigger,
          totalRead = 0,
          filteredBeforeStart = 0,
          sent = 0,
          inserted = 0,
          duplicate = 0,
          skipped = 0,
          failed = 1,
          errors = new[] { $"Device TCP port is not reachable at {config.DeviceIp}:{config.DevicePort}." },
        };
        Log.Warn("sync_device_unreachable", unreachable);
        return new AttendanceSyncResult(StatusCodes.Status503ServiceUnavailable, unreachable);
      }

      var punches = await Retry.DoAsync(
        () => deviceClient.ReadPunchesAsync(),
        "device-read",
        attempts: 2
      );

      var eligible = punches
        .Where(p => p.DeviceLocalTime.Date >= config.SyncStartDate.Date)
        .OrderBy(p => p.PunchTimeUtc)
        .ToList();

      var filteredBeforeStart = punches.Count - eligible.Count;
      var response = await phoenixClient.SendPunchesAsync(eligible, runId);
      var elapsedMs = Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;

      var summary = new {
        runId,
        trigger,
        totalRead = punches.Count,
        filteredBeforeStart,
        sent = eligible.Count,
        response.Inserted,
        response.Duplicate,
        response.Skipped,
        response.Failed,
        errors = response.Failures.Select(f => $"#{f.Index}: {f.Message}").ToArray(),
        elapsedMs = Math.Round(elapsedMs),
      };

      Log.Info("sync_completed", summary);
      return new AttendanceSyncResult(StatusCodes.Status200OK, summary);
    } catch (Exception ex) {
      Log.Error("sync_failed", ex, new { runId, trigger });
      return new AttendanceSyncResult(StatusCodes.Status500InternalServerError, new {
        runId,
        trigger,
        totalRead = 0,
        inserted = 0,
        duplicate = 0,
        skipped = 0,
        failed = 1,
        errors = new[] { ex.Message },
      });
    } finally {
      syncLock.Release();
    }
  }
}

static class AutoSyncScheduler {
  public static void Start(IServiceProvider services, AgentConfig config) {
    _ = Task.Run(async () => {
      Log.Info("auto_sync_scheduler_started", new {
        config.AutoSyncIntervalMinutes,
        config.AutoSyncRequiredTimes,
      });

      var runner = services.GetRequiredService<AttendanceSyncRunner>();
      var lastIntervalSync = DateTimeOffset.UtcNow;
      var requiredRuns = new HashSet<string>();

      while (true) {
        await Task.Delay(TimeSpan.FromMinutes(1));
        var now = DateTimeOffset.Now;

        if ((DateTimeOffset.UtcNow - lastIntervalSync).TotalMinutes >= Math.Max(15, config.AutoSyncIntervalMinutes)) {
          lastIntervalSync = DateTimeOffset.UtcNow;
          await runner.SyncAsync("auto-interval");
        }

        var currentTime = now.ToString("HH:mm");
        if (config.AutoSyncRequiredTimes.Contains(currentTime, StringComparer.OrdinalIgnoreCase)) {
          var key = $"{now:yyyy-MM-dd}-{currentTime}";
          if (requiredRuns.Add(key)) {
            await runner.SyncAsync($"auto-required-{currentTime}");
          }
        }
      }
    });
  }
}

sealed class ZktecoDeviceClient(AgentConfig config) {
  static readonly string[] ProgIds = ["zkemkeeper.CZKEM", "zkemkeeper.ZKEM", "zkemkeeper.ZKEM.1"];
  readonly SemaphoreSlim deviceLock = new(1, 1);

  public static Type? FindComType() {
    foreach (var progId in ProgIds) {
      var type = Type.GetTypeFromProgID(progId, throwOnError: false);
      if (type is not null) return type;
    }
    return null;
  }

  public async Task<DeviceConnectionResult> TestConnectionAsync() {
    await deviceLock.WaitAsync();
    try {
      return await WithDeviceTimeout(StaRunner.RunAsync(() => {
        using var device = Connect();
        return new DeviceConnectionResult(true, config.DeviceId, config.DeviceIp, config.DevicePort);
      }), "device connection");
    } finally {
      deviceLock.Release();
    }
  }

  public async Task<List<DeviceUser>> ReadDeviceUsersAsync() {
    await deviceLock.WaitAsync();
    try {
      return await WithDeviceTimeout(StaRunner.RunAsync(() => {
        using var device = Connect();
        dynamic zkem = device.Instance;

        Log.Info("device_user_read_started", new { method = "ssr" });
        // Always SSR_GetAllUserInfo, even when DEVICE_READ_METHOD is legacy - unlike the punch
        // readers, which mirror that setting. The legacy GetAllUserID takes `ref string` for the
        // name and password, and a ref-string argument cannot be marshalled through C# dynamic
        // COM dispatch: the call dies with "Could not convert argument 3 for call to GetAllUserID"
        // (confirmed against the live device, 2026-08-23). SSR_GetAllUserInfo uses out-params,
        // marshals correctly, and is supported by the firmware this agent talks to.
        return ReadDeviceUsersSsr(zkem);
      }), "device user list read");
    } finally {
      deviceLock.Release();
    }
  }

  List<DeviceUser> ReadDeviceUsersSsr(dynamic zkem) {
    return ReadWithDeviceDisabled<DeviceUser>((object)zkem, () => {
      if (!zkem.ReadAllUserID(1)) {
        throw new InvalidOperationException("Connected to device, but ReadAllUserID failed.");
      }

      var users = new List<DeviceUser>();
      while (true) {
        string enrollNumber = "";
        string name = "";
        string password = "";
        int privilege = 0;
        bool enabled = false;

        bool ok = zkem.SSR_GetAllUserInfo(1, out enrollNumber, out name, out password, out privilege, out enabled);
        if (!ok) break;
        if (string.IsNullOrWhiteSpace(enrollNumber)) continue;

        users.Add(new DeviceUser(enrollNumber.Trim(), (name ?? "").Trim(), privilege, enabled));
      }

      return users;
    }, "device_user_read_completed");
  }

  public async Task<List<DevicePunch>> ReadPunchesAsync() {
    await deviceLock.WaitAsync();
    try {
      return await WithDeviceTimeout(StaRunner.RunAsync(() => {
        using var device = Connect();
        dynamic zkem = device.Instance;

        Log.Info("device_log_read_started", new { method = config.DeviceReadMethod });
        return config.DeviceReadMethod switch {
          "ssr" => ReadPunchesSsr(zkem),
          _ => ReadPunchesLegacy(zkem),
        };
      }), "device attendance log read");
    } finally {
      deviceLock.Release();
    }
  }

  List<DevicePunch> ReadPunchesLegacy(dynamic zkem) {
    return ReadWithDeviceDisabled<DevicePunch>((object)zkem, () => {
      if (!zkem.ReadGeneralLogData(1)) {
        throw new InvalidOperationException("Connected to device, but ReadGeneralLogData failed.");
      }

      var punches = new List<DevicePunch>();
      while (true) {
        int terminalMachineNumber = 0;
        int enrollNumber = 0;
        int enrollMachineNumber = 0;
        int verifyMode = 0;
        int inOutMode = 0;
        int year = 0;
        int month = 0;
        int day = 0;
        int hour = 0;
        int minute = 0;

        bool ok = zkem.GetGeneralLogData(
          1,
          ref terminalMachineNumber,
          ref enrollNumber,
          ref enrollMachineNumber,
          ref verifyMode,
          ref inOutMode,
          ref year,
          ref month,
          ref day,
          ref hour,
          ref minute
        );

        if (!ok) break;
        if (enrollNumber <= 0) continue;
        if (!IsValidDeviceDate(year, month, day, hour, minute, 0)) continue;

        punches.Add(BuildPunch(enrollNumber.ToString(), year, month, day, hour, minute, 0, inOutMode, verifyMode, 0));
      }

      return punches;
    }, "device_log_read_completed");
  }

  List<DevicePunch> ReadPunchesSsr(dynamic zkem) {
    return ReadWithDeviceDisabled<DevicePunch>((object)zkem, () => {
      if (!zkem.ReadGeneralLogData(1)) {
        throw new InvalidOperationException("Connected to device, but ReadGeneralLogData failed.");
      }

      var punches = new List<DevicePunch>();
      while (true) {
        string enrollNumber = "";
        int verifyMode = 0;
        int inOutMode = 0;
        int year = 0;
        int month = 0;
        int day = 0;
        int hour = 0;
        int minute = 0;
        int second = 0;
        int workCode = 0;

        bool ok = zkem.SSR_GetGeneralLogData(
          1,
          out enrollNumber,
          out verifyMode,
          out inOutMode,
          out year,
          out month,
          out day,
          out hour,
          out minute,
          out second,
          ref workCode
        );

        if (!ok) break;
        if (string.IsNullOrWhiteSpace(enrollNumber)) continue;
        if (!IsValidDeviceDate(year, month, day, hour, minute, second)) continue;

        punches.Add(BuildPunch(enrollNumber.Trim(), year, month, day, hour, minute, second, inOutMode, verifyMode, workCode));
      }

      return punches;
    }, "device_log_read_completed");
  }

  // Shared by the punch read and the user-list read: both must disable the device for the
  // duration of an SDK bulk read and re-enable it afterwards, whatever happens.
  List<T> ReadWithDeviceDisabled<T>(object zkemObject, Func<List<T>> read, string completedEvent) {
    dynamic zkem = zkemObject;
    var disabled = false;
    try {
      disabled = zkem.EnableDevice(1, false);
      var items = read();
      Log.Info(completedEvent, new { method = config.DeviceReadMethod, totalRead = items.Count });
      return items;
    } finally {
      if (disabled) {
        try {
          zkem.EnableDevice(1, true);
        } catch {
          // Best-effort device re-enable after SDK read.
        }
      }
    }
  }

  DevicePunch BuildPunch(string enrollNumber, int year, int month, int day, int hour, int minute, int second, int inOutMode, int verifyMode, int workCode) {
    var localTime = new DateTime(year, month, day, hour, minute, second, DateTimeKind.Local);
    var punchTime = new DateTimeOffset(localTime);
    return new DevicePunch(
      config.DeviceId,
      enrollNumber,
      localTime,
      punchTime,
      inOutMode.ToString(),
      verifyMode.ToString(),
      workCode
    );
  }

  async Task<T> WithDeviceTimeout<T>(Task<T> operation, string label) {
    var timeout = TimeSpan.FromSeconds(Math.Max(5, config.DeviceOperationTimeoutSeconds));
    var completed = await Task.WhenAny(operation, Task.Delay(timeout));
    if (completed != operation) {
      throw new TimeoutException($"{label} did not complete within {timeout.TotalSeconds:0} seconds. Check the SDK registration, device IP/port, comm password, and whether another attendance app is connected.");
    }

    return await operation;
  }

  ComDevice Connect() {
    var type = FindComType() ?? throw new InvalidOperationException("ZKTeco SDK COM object is not registered. Install/register zkemkeeper.dll.");
    var instance = Activator.CreateInstance(type) ?? throw new InvalidOperationException("Could not create ZKTeco SDK COM object.");
    dynamic zkem = instance;

    if (config.DeviceCommPassword > 0) {
      zkem.SetCommPassword(config.DeviceCommPassword);
    }

    bool connected = zkem.Connect_Net(config.DeviceIp, config.DevicePort);
    if (!connected) {
      Marshal.FinalReleaseComObject(instance);
      throw new InvalidOperationException($"Could not connect to fingerprint device {config.DeviceIp}:{config.DevicePort}.");
    }

    return new ComDevice(instance);
  }

  static bool IsValidDeviceDate(int year, int month, int day, int hour, int minute, int second) {
    try {
      _ = new DateTime(year, month, day, hour, minute, second);
      return year >= 2000;
    } catch {
      return false;
    }
  }

  sealed class ComDevice(object instance) : IDisposable {
    public object Instance => instance;

    public void Dispose() {
      try {
        dynamic zkem = instance;
        zkem.Disconnect();
      } catch {
        // Best-effort COM cleanup.
      } finally {
        if (Marshal.IsComObject(instance)) {
          Marshal.FinalReleaseComObject(instance);
        }
      }
    }
  }
}

// Identity only. The SDK also hands back each user's device password; it is never captured here.
sealed record DeviceUser(
  string DeviceUserId,
  string Name,
  int Privilege,
  bool Enabled
);

sealed record DevicePunch(
  string DeviceId,
  string DeviceUserId,
  DateTime DeviceLocalTime,
  DateTimeOffset PunchTimeUtc,
  string PunchType,
  string VerifyMode,
  int WorkCode
);

sealed class PhoenixClient(HttpClient httpClient, AgentConfig config) {
  static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
  const int BatchSize = 250;

  public async Task<PhoenixIngestionResponse> SendPunchesAsync(IReadOnlyList<DevicePunch> punches, string runId) {
    var aggregate = new PhoenixIngestionResponse(0, 0, 0, 0, 0, []);

    foreach (var batch in punches.Chunk(BatchSize)) {
      var body = new {
        punches = batch.Select(punch => new RawPunchDto {
          DeviceId = punch.DeviceId,
          DeviceUserId = punch.DeviceUserId,
          PunchTime = punch.PunchTimeUtc.ToString("O"),
          PunchType = punch.PunchType,
          VerifyMode = punch.VerifyMode,
          SourceRunId = runId,
          RawPayload = new {
            punch.DeviceId,
            punch.DeviceUserId,
            device_ip = config.DeviceIp,
            device_port = config.DevicePort,
            device_local_time = punch.DeviceLocalTime.ToString("yyyy-MM-dd HH:mm:ss"),
            punch.WorkCode,
            agent_timezone = TimeZoneInfo.Local.Id,
          },
        }).ToArray(),
      };

      using var response = await Retry.DoAsync(
        () => {
          var content = new StringContent(JsonSerializer.Serialize(body, JsonOptions), Encoding.UTF8, "application/json");
          return httpClient.PostAsync("api/attendance/raw-punches", content);
        },
        "phoenix-ingestion",
        attempts: 3
      );
      var text = await response.Content.ReadAsStringAsync();

      if (!response.IsSuccessStatusCode) {
        throw new InvalidOperationException($"Phoenix ingestion failed with HTTP {(int)response.StatusCode}: {text}");
      }

      var parsed = JsonSerializer.Deserialize<PhoenixIngestionResponse>(text, JsonOptions)
        ?? throw new InvalidOperationException("Phoenix ingestion returned an empty response.");

      aggregate = aggregate.Add(parsed);
    }

    return aggregate;
  }
}

sealed class RawPunchDto {
  [JsonPropertyName("device_id")]
  public string DeviceId { get; set; } = "";

  [JsonPropertyName("device_user_id")]
  public string DeviceUserId { get; set; } = "";

  [JsonPropertyName("punch_time")]
  public string PunchTime { get; set; } = "";

  [JsonPropertyName("punch_type")]
  public string? PunchType { get; set; }

  [JsonPropertyName("verify_mode")]
  public string? VerifyMode { get; set; }

  [JsonPropertyName("source_run_id")]
  public string? SourceRunId { get; set; }

  [JsonPropertyName("raw_payload")]
  public object RawPayload { get; set; } = new();
}

sealed record PunchFailure(int Index, string Message);

sealed record PhoenixIngestionResponse(
  int Received,
  int Inserted,
  int Duplicate,
  int Skipped,
  int Failed,
  PunchFailure[] Failures
) {
  public PhoenixIngestionResponse Add(PhoenixIngestionResponse other) => new(
    Received + other.Received,
    Inserted + other.Inserted,
    Duplicate + other.Duplicate,
    Skipped + other.Skipped,
    Failed + other.Failed,
    Failures.Concat(other.Failures).ToArray()
  );
}

static class Auth {
  public static bool IsAuthorized(HttpRequest request, string expectedToken) {
    var header = request.Headers.Authorization.ToString();
    if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) {
      return false;
    }

    var actualToken = header["Bearer ".Length..].Trim();
    var expectedBytes = Encoding.UTF8.GetBytes(expectedToken);
    var actualBytes = Encoding.UTF8.GetBytes(actualToken);
    return expectedBytes.Length == actualBytes.Length
      && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
  }
}

static class Retry {
  public static async Task<T> DoAsync<T>(Func<Task<T>> action, string operation, int attempts) {
    Exception? last = null;

    for (var attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await action();
      } catch (Exception ex) when (attempt < attempts) {
        last = ex;
        Log.Warn("retrying_operation", new { operation, attempt, error = ex.Message });
        await Task.Delay(TimeSpan.FromMilliseconds(500 * attempt));
      }
    }

    throw last ?? new InvalidOperationException($"{operation} failed.");
  }
}

static class StaRunner {
  public static Task<T> RunAsync<T>(Func<T> action) {
    var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
    var thread = new Thread(() => {
      try {
        tcs.SetResult(action());
      } catch (Exception ex) {
        tcs.SetException(ex);
      }
    });

    thread.IsBackground = true;
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
    return tcs.Task;
  }
}

static class NetworkChecks {
  public static async Task<bool> CanConnectTcpAsync(string host, int port, TimeSpan timeout) {
    try {
      using var cts = new CancellationTokenSource(timeout);
      using var client = new TcpClient();
      await client.ConnectAsync(host, port, cts.Token);
      return true;
    } catch {
      return false;
    }
  }

  // Is the process already holding our listen port THIS agent, or an unrelated squatter?
  //
  // "Something answers on 8787" is not enough to conclude the attendance agent is up - anything
  // can bind a loopback port. /health is matched on a field only this agent emits, so a foreign
  // listener is reported as a fault instead of being mistaken for a healthy sibling. A degraded
  // agent still counts: it answers 503 when the fingerprint device is off the network overnight,
  // and that is a running agent, not a free port.
  public static async Task<bool> IsAttendanceAgentServingAsync(string listenUrl) {
    var timeout = TimeSpan.FromSeconds(5);
    try {
      var healthUrl = listenUrl.TrimEnd('/') + "/health";
      using var cts = new CancellationTokenSource(timeout);
      using var client = new HttpClient { Timeout = timeout };
      using var response = await client.GetAsync(healthUrl, cts.Token);
      var body = await response.Content.ReadAsStringAsync(cts.Token);
      using var document = JsonDocument.Parse(body);
      return document.RootElement.TryGetProperty("checks", out var checks)
        && checks.TryGetProperty("tokenConfigured", out _);
    } catch {
      return false;
    }
  }

  public static async Task<bool> CanReachHttpAsync(string url, TimeSpan timeout) {
    try {
      using var cts = new CancellationTokenSource(timeout);
      using var client = new HttpClient { Timeout = timeout };
      using var response = await client.GetAsync(url, cts.Token);
      return (int)response.StatusCode < 500;
    } catch {
      return false;
    }
  }
}

static class EnvLoader {
  public static void Load() {
    var baseDir = AppContext.BaseDirectory;
    var currentDir = Directory.GetCurrentDirectory();
    var paths = new[] {
      Path.Combine(currentDir, ".env"),
      Path.Combine(baseDir, ".env"),
      Path.Combine(Directory.GetParent(baseDir)?.FullName ?? baseDir, ".env"),
    }.Distinct(StringComparer.OrdinalIgnoreCase);

    foreach (var path in paths) {
      if (!File.Exists(path)) continue;
      foreach (var line in File.ReadAllLines(path)) {
        var trimmed = line.Trim();
        if (trimmed.Length == 0 || trimmed.StartsWith('#')) continue;
        var index = trimmed.IndexOf('=');
        if (index <= 0) continue;

        var key = trimmed[..index].Trim();
        var value = trimmed[(index + 1)..].Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key))) {
          Environment.SetEnvironmentVariable(key, value);
        }
      }
    }
  }
}

static class Log {
  static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

  public static void Info(string eventName, object payload) => Write("info", eventName, payload);

  public static void Warn(string eventName, object payload) => Write("warn", eventName, payload);

  public static void Error(string eventName, Exception ex, object? payload = null) => Write("error", eventName, new {
    error = ex.Message,
    type = ex.GetType().Name,
    payload,
  });

  static void Write(string level, string eventName, object payload) {
    Console.WriteLine(JsonSerializer.Serialize(new {
      ts = DateTimeOffset.UtcNow,
      level,
      eventName,
      payload,
    }, Options));
  }
}
