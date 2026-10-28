// What the production DATABASE SERVER itself is doing, once a minute: its memory, its swap, its CPU, its
// two disks and when Postgres and Auth last started. The pure half — reading Supabase's metrics text, the
// per-minute rates, the alarm rule and its wording. The fetch, the log line and the message live in
// db-host-sampler.ts and db-host-alert.ts.
//
// WHY IT EXISTS (28 Oct 2026). Production's database host reset itself 14 times between 7 and 25 Oct,
// each a whole-machine reset with no OOM line and no signal in any log Phoenix can read. Supabase's own
// metrics endpoint is the only place the host's memory, swap and disk can be read, and it keeps NO
// history: a reading taken after a reset says nothing about the minutes before it. Sampled once a minute
// into the log, the next reset leaves its own lead-up behind. Whether memory pressure caused the resets is
// NOT proven — this records what the host did, so that the next one answers it.
//
// Import-free on purpose: the test loads it with no alias loader, and nothing in it touches IO.

/** Under this much available memory the host has no room left before it swaps hard. */
export const LOW_MEMORY_MB = 100;
/** Consecutive one-minute readings under LOW_MEMORY_MB before anyone is paged. */
export const LOW_MEMORY_MINUTES = 5;
/** The ROOT disk (system, logs), not /data. It sat at 1,210 MB free on 28 Oct, 88 % full. */
export const LOW_ROOT_DISK_MB = 500;

export type DbHostAlarmKind = "low_memory" | "low_root_disk";

/** The counters the rates are computed from. They only ever rise until the host resets. */
export type DbHostCounters = {
  /** CPU seconds by mode, summed over every CPU. */
  cpuSeconds: Record<string, number>;
  majorFaults: number | null;
  oomKills: number | null;
  swapInPages: number | null;
  swapOutPages: number | null;
};

export type DbHostSample = {
  authStartedAt: string | null;
  counters: DbHostCounters;
  cpuCount: number;
  dataDiskFreeMb: number | null;
  dataDiskSizeMb: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memAvailableMb: number | null;
  memTotalMb: number | null;
  postgresStartedAt: string | null;
  postgresUp: boolean | null;
  rootDiskFreeMb: number | null;
  rootDiskSizeMb: number | null;
  swapTotalMb: number | null;
  swapUsedMb: number | null;
};

// Only these names are parsed; every other line of the ~460 KB text is skipped on its first word.
const WANTED = new Set([
  "node_cpu_seconds_total",
  "node_filesystem_avail_bytes",
  "node_filesystem_size_bytes",
  "node_load1",
  "node_load15",
  "node_load5",
  "node_memory_MemAvailable_bytes",
  "node_memory_MemTotal_bytes",
  "node_memory_SwapFree_bytes",
  "node_memory_SwapTotal_bytes",
  "node_vmstat_oom_kill",
  "node_vmstat_pgmajfault",
  "node_vmstat_pswpin",
  "node_vmstat_pswpout",
  "pg_up",
  "process_start_time_seconds",
]);

const LABEL = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of raw.matchAll(LABEL)) labels[match[1]] = match[2];
  return labels;
}

function toMb(bytes: number | undefined): number | null {
  return bytes == null || !Number.isFinite(bytes) ? null : Math.round(bytes / 1048576);
}

function toIso(epochSeconds: number | undefined): string | null {
  if (epochSeconds == null || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  return new Date(Math.round(epochSeconds * 1000)).toISOString();
}

function finite(value: number | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : value;
}

/**
 * Read Supabase's Prometheus text into one sample. Never throws: a metric that is missing, renamed or
 * unreadable is null, so a change on Supabase's side costs that one figure, never the line.
 */
export function parseDbHostMetrics(text: string): DbHostSample {
  const plain = new Map<string, number>();
  const cpuSeconds: Record<string, number> = {};
  const cpus = new Set<string>();
  const disk: Record<string, { avail?: number; size?: number }> = {};
  const startedAt: Record<string, number> = {};

  for (const line of String(text ?? "").split("\n")) {
    if (!line || line.charCodeAt(0) === 35 /* # */) continue;
    const nameEnd = line.search(/[{\s]/);
    if (nameEnd <= 0) continue;
    const name = line.slice(0, nameEnd);
    if (!WANTED.has(name)) continue;

    let rest = line.slice(nameEnd);
    let labels: Record<string, string> = {};
    if (rest.startsWith("{")) {
      const close = rest.lastIndexOf("}");
      if (close < 0) continue;
      labels = parseLabels(rest.slice(1, close));
      rest = rest.slice(close + 1);
    }
    // "value" or "value timestamp"; Go writes floats like 1.268813824e+09.
    const value = Number(rest.trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;

    if (name === "node_cpu_seconds_total") {
      const mode = labels.mode ?? "unknown";
      cpuSeconds[mode] = (cpuSeconds[mode] ?? 0) + value;
      if (labels.cpu != null) cpus.add(labels.cpu);
    } else if (name === "node_filesystem_avail_bytes" || name === "node_filesystem_size_bytes") {
      const mount = labels.mountpoint;
      if (!mount) continue;
      disk[mount] ??= {};
      disk[mount][name === "node_filesystem_avail_bytes" ? "avail" : "size"] = value;
    } else if (name === "process_start_time_seconds") {
      // Each service on the host reports its own; service_type tells them apart.
      const service = labels.service_type;
      if (service) startedAt[service] = value;
    } else {
      plain.set(name, value);
    }
  }

  const swapTotal = plain.get("node_memory_SwapTotal_bytes");
  const swapFree = plain.get("node_memory_SwapFree_bytes");
  const pgUp = plain.get("pg_up");

  return {
    authStartedAt: toIso(startedAt.gotrue),
    counters: {
      cpuSeconds,
      majorFaults: finite(plain.get("node_vmstat_pgmajfault")),
      oomKills: finite(plain.get("node_vmstat_oom_kill")),
      swapInPages: finite(plain.get("node_vmstat_pswpin")),
      swapOutPages: finite(plain.get("node_vmstat_pswpout")),
    },
    cpuCount: cpus.size,
    dataDiskFreeMb: toMb(disk["/data"]?.avail),
    dataDiskSizeMb: toMb(disk["/data"]?.size),
    load1: finite(plain.get("node_load1")),
    load5: finite(plain.get("node_load5")),
    load15: finite(plain.get("node_load15")),
    memAvailableMb: toMb(plain.get("node_memory_MemAvailable_bytes")),
    memTotalMb: toMb(plain.get("node_memory_MemTotal_bytes")),
    postgresStartedAt: toIso(startedAt.postgresql),
    postgresUp: pgUp == null ? null : pgUp === 1,
    rootDiskFreeMb: toMb(disk["/"]?.avail),
    rootDiskSizeMb: toMb(disk["/"]?.size),
    swapTotalMb: toMb(swapTotal),
    swapUsedMb: swapTotal != null && swapFree != null ? toMb(swapTotal - swapFree) : null,
  };
}

export type DbHostRates = {
  /** True when a counter went DOWN — the host reset between the two readings, so no rate is honest. */
  counterReset: boolean;
  /** Share of CPU time per mode over the interval, whole percent. `steal` is time the cloud host took back. */
  cpuPercent: Record<string, number> | null;
  majorFaultsPerMin: number | null;
  oomKills: number | null;
  swapInPagesPerMin: number | null;
  swapOutPagesPerMin: number | null;
};

function perMinute(previous: number | null, current: number | null, elapsedS: number): number | null {
  if (previous == null || current == null || current < previous) return null;
  return Math.round(((current - previous) * 60) / elapsedS);
}

/** Per-minute rates between two readings. Pages are the host's 4 KB pages. */
export function dbHostRates(previous: DbHostCounters, current: DbHostCounters, elapsedS: number): DbHostRates {
  const empty: DbHostRates = {
    counterReset: false,
    cpuPercent: null,
    majorFaultsPerMin: null,
    oomKills: null,
    swapInPagesPerMin: null,
    swapOutPagesPerMin: null,
  };
  if (!(elapsedS > 0)) return empty;

  const pairs: Array<[number | null, number | null]> = [
    [previous.swapInPages, current.swapInPages],
    [previous.swapOutPages, current.swapOutPages],
    [previous.majorFaults, current.majorFaults],
    [previous.oomKills, current.oomKills],
    ...Object.keys(current.cpuSeconds).map((mode): [number | null, number | null] => [
      previous.cpuSeconds[mode] ?? null,
      current.cpuSeconds[mode],
    ]),
  ];
  if (pairs.some(([before, after]) => before != null && after != null && after < before)) {
    return { ...empty, counterReset: true };
  }

  let cpuPercent: Record<string, number> | null = null;
  const deltas: Record<string, number> = {};
  let total = 0;
  for (const mode of Object.keys(current.cpuSeconds)) {
    const before = previous.cpuSeconds[mode];
    if (before == null) continue;
    deltas[mode] = current.cpuSeconds[mode] - before;
    total += deltas[mode];
  }
  if (total > 0) {
    cpuPercent = {};
    for (const [mode, delta] of Object.entries(deltas)) cpuPercent[mode] = Math.round((delta / total) * 100);
  }

  return {
    counterReset: false,
    cpuPercent,
    majorFaultsPerMin: perMinute(previous.majorFaults, current.majorFaults, elapsedS),
    // A count, not a rate: any kill at all is the news.
    oomKills: previous.oomKills != null && current.oomKills != null ? current.oomKills - previous.oomKills : null,
    swapInPagesPerMin: perMinute(previous.swapInPages, current.swapInPages, elapsedS),
    swapOutPagesPerMin: perMinute(previous.swapOutPages, current.swapOutPages, elapsedS),
  };
}

export type DbHostAlarmState = {
  /** Cairo day (YYYY-MM-DD) each alarm last fired; one message per kind per Cairo day at most. */
  lastRaisedDay: Partial<Record<DbHostAlarmKind, string>>;
  lowMemoryStreak: number;
};

export function createDbHostAlarmState(): DbHostAlarmState {
  return { lastRaisedDay: {}, lowMemoryStreak: 0 };
}

/** The Cairo calendar day of an instant, as YYYY-MM-DD. */
export function cairoDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(nowMs));
}

/**
 * Feed one reading; get back which alarms this minute raises. Mutates `state`.
 *
 * Memory: LOW_MEMORY_MINUTES readings in a row under LOW_MEMORY_MB — one bad minute is a spike, five is
 * the host living there. A reading that is missing breaks the run, because it is not a low one. Disk: one
 * reading is enough, a disk does not empty and refill minute to minute. Either alarm fires at most ONCE PER
 * CAIRO DAY: the minute line still records every episode, and a second message about the same standing
 * fault on the same day tells him nothing the first did not.
 */
export function assessDbHostAlarms(state: DbHostAlarmState, sample: DbHostSample, nowMs: number): DbHostAlarmKind[] {
  const day = cairoDay(nowMs);
  const raised: DbHostAlarmKind[] = [];

  if (sample.memAvailableMb != null && sample.memAvailableMb < LOW_MEMORY_MB) {
    state.lowMemoryStreak += 1;
  } else {
    state.lowMemoryStreak = 0;
  }
  if (state.lowMemoryStreak >= LOW_MEMORY_MINUTES && state.lastRaisedDay.low_memory !== day) {
    state.lastRaisedDay.low_memory = day;
    raised.push("low_memory");
  }

  if (
    sample.rootDiskFreeMb != null &&
    sample.rootDiskFreeMb < LOW_ROOT_DISK_MB &&
    state.lastRaisedDay.low_root_disk !== day
  ) {
    state.lastRaisedDay.low_root_disk = day;
    raised.push("low_root_disk");
  }

  return raised;
}

function mb(value: number | null): string {
  return value == null ? "unknown" : `${value.toLocaleString("en-US")} MB`;
}

/** The title and body of the message. Host figures only — no name, no id, no credential. */
export function dbHostAlarmMessage(kind: DbHostAlarmKind, sample: DbHostSample): { message: string; title: string } {
  if (kind === "low_memory") {
    return {
      message:
        `The production database server has had less than ${LOW_MEMORY_MB} MB of memory available for ` +
        `${LOW_MEMORY_MINUTES} minutes in a row: ${mb(sample.memAvailableMb)} available of ${mb(sample.memTotalMb)}, ` +
        `swap ${mb(sample.swapUsedMb)} used of ${mb(sample.swapTotalMb)}. Nothing is changed automatically. ` +
        `The database's size is decided on Supabase's Compute and Disk screen.`,
      title: "The production database server is almost out of memory",
    };
  }
  return {
    message:
      `The production database server's system disk has ${mb(sample.rootDiskFreeMb)} free of ` +
      `${mb(sample.rootDiskSizeMb)} (under ${LOW_ROOT_DISK_MB} MB). This is the system disk, not the data disk ` +
      `(${mb(sample.dataDiskFreeMb)} free). If it fills, the database server may stop working. Nothing is changed ` +
      `automatically.`,
    title: "The production database server's system disk is nearly full",
  };
}

export type DbHostEnv = Partial<
  Record<
    | "APP_ENV"
    | "NEXT_PUBLIC_SUPABASE_URL"
    | "NODE_ENV"
    | "PHOENIX_DB_HOST_METRICS"
    | "PHOENIX_PROCESS_ROLE"
    | "SUPABASE_SERVICE_ROLE_KEY",
    string | undefined
  >
>;

/**
 * Why this process must not sample, or null when it should. ONE process samples: the worker (or the single
 * "all" process before a split), never a page server — two samplers would double the reads and the alarms.
 * Production only by APP_ENV, never by the build mode: staging builds as NODE_ENV=production too.
 * PHOENIX_DB_HOST_METRICS=off is the kill switch, with no deploy.
 */
export function dbHostSamplerRefusal(env: DbHostEnv): string | null {
  const flag = String(env.PHOENIX_DB_HOST_METRICS ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return "PHOENIX_DB_HOST_METRICS is off";
  if (env.NODE_ENV !== "production") return "not a production build";
  if (String(env.APP_ENV ?? "").trim().toLowerCase() !== "production") return "APP_ENV is not production";
  const role = String(env.PHOENIX_PROCESS_ROLE ?? "").trim().toLowerCase();
  if (role === "web") return "PHOENIX_PROCESS_ROLE is 'web' — the worker samples the database host";
  if (!String(env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim()) return "NEXT_PUBLIC_SUPABASE_URL is not set";
  if (!String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()) return "SUPABASE_SERVICE_ROLE_KEY is not set";
  return null;
}

/** Supabase's metrics address for a project URL. Null for anything that is not an https URL. */
export function dbHostMetricsUrl(supabaseUrl: string): string | null {
  try {
    const url = new URL(supabaseUrl.trim());
    if (url.protocol !== "https:") return null;
    return `${url.origin}/customer/v1/privileged/metrics`;
  } catch {
    return null;
  }
}
