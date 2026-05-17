using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

EnvLoader.Load();

if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ASPNETCORE_URLS"))) {
  Environment.SetEnvironmentVariable("ASPNETCORE_URLS", "http://127.0.0.1:8787");
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
});

var startupChecks = await validator.CheckAsync(includeDeviceConnect: false);
Log.Info("attendance_agent_startup_checks", startupChecks);

app.MapGet("/health", async (StartupValidator startupValidator) => {
  var checks = await startupValidator.CheckAsync(includeDeviceConnect: false);
  var healthy = checks.TokenConfigured && checks.SdkRegistered && checks.DeviceTcpReachable && checks.PhoenixReachable;
  return Results.Json(new {
    status = healthy ? "ok" : "degraded",
    checks,
  }, statusCode: healthy ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable);
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

app.MapPost("/sync-now", async (HttpRequest request, AgentConfig cfg, ZktecoDeviceClient deviceClient, PhoenixClient phoenixClient) => {
  if (!Auth.IsAuthorized(request, cfg.AttendanceAgentToken)) {
    return Results.Unauthorized();
  }

  var runId = $"{cfg.DeviceId}-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}-{Guid.NewGuid():N}";
  var startedAt = Stopwatch.GetTimestamp();
  Log.Info("sync_started", new { runId, cfg.DeviceId, syncStartDate = cfg.SyncStartDate.ToString("yyyy-MM-dd") });

  try {
    var tcpReachable = await NetworkChecks.CanConnectTcpAsync(cfg.DeviceIp, cfg.DevicePort, TimeSpan.FromSeconds(5));
    if (!tcpReachable) {
      return Results.Json(new {
        runId,
        totalRead = 0,
        filteredBeforeStart = 0,
        sent = 0,
        inserted = 0,
        duplicate = 0,
        skipped = 0,
        failed = 1,
        errors = new[] { $"Device TCP port is not reachable at {cfg.DeviceIp}:{cfg.DevicePort}." },
      }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    var punches = await Retry.DoAsync(
      () => deviceClient.ReadPunchesAsync(),
      "device-read",
      attempts: 2
    );

    var eligible = punches
      .Where(p => p.DeviceLocalTime.Date >= cfg.SyncStartDate.Date)
      .OrderBy(p => p.PunchTimeUtc)
      .ToList();

    var filteredBeforeStart = punches.Count - eligible.Count;
    var response = await phoenixClient.SendPunchesAsync(eligible, runId);
    var elapsedMs = Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;

    var summary = new {
      runId,
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
    return Results.Json(summary);
  } catch (Exception ex) {
    Log.Error("sync_failed", ex, new { runId });
    return Results.Json(new {
      runId,
      totalRead = 0,
      inserted = 0,
      duplicate = 0,
      skipped = 0,
      failed = 1,
      errors = new[] { ex.Message },
    }, statusCode: StatusCodes.Status500InternalServerError);
  }
});

app.Run();

sealed record AgentConfig(
  string PhoenixBaseUrl,
  string AttendanceAgentToken,
  string DeviceId,
  string DeviceIp,
  int DevicePort,
  int DeviceCommPassword,
  DateTime SyncStartDate,
  int DeviceOperationTimeoutSeconds
) {
  public static AgentConfig FromEnvironment() {
    return new AgentConfig(
      Required("PHOENIX_BASE_URL"),
      Required("ATTENDANCE_AGENT_TOKEN"),
      Required("DEVICE_ID"),
      Required("DEVICE_IP"),
      ParseInt("DEVICE_PORT", "4370"),
      ParseInt("DEVICE_COMM_PASSWORD", "0"),
      ParseDate("SYNC_START_DATE", "2026-01-01"),
      ParseInt("DEVICE_OPERATION_TIMEOUT_SECONDS", "30")
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
    var deviceTcpReachable = await NetworkChecks.CanConnectTcpAsync(config.DeviceIp, config.DevicePort, TimeSpan.FromSeconds(3));
    var phoenixReachable = await NetworkChecks.CanReachHttpAsync(config.PhoenixBaseUrl, TimeSpan.FromSeconds(5));
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

  public async Task<List<DevicePunch>> ReadPunchesAsync() {
    await deviceLock.WaitAsync();
    try {
      return await WithDeviceTimeout(StaRunner.RunAsync(() => {
        using var device = Connect();
        dynamic zkem = device.Instance;

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

          var localTime = new DateTime(year, month, day, hour, minute, second, DateTimeKind.Local);
          var punchTime = new DateTimeOffset(localTime);
          punches.Add(new DevicePunch(
            config.DeviceId,
            enrollNumber.Trim(),
            localTime,
            punchTime,
            inOutMode.ToString(),
            verifyMode.ToString(),
            workCode
          ));
        }

        return punches;
      }), "device attendance log read");
    } finally {
      deviceLock.Release();
    }
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
