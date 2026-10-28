import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LOW_MEMORY_MB,
  LOW_MEMORY_MINUTES,
  LOW_ROOT_DISK_MB,
  assessDbHostAlarms,
  cairoDay,
  createDbHostAlarmState,
  dbHostAlarmMessage,
  dbHostMetricsUrl,
  dbHostRates,
  dbHostSamplerRefusal,
  parseDbHostMetrics,
  type DbHostSample,
} from "../src/lib/observability/db-host-metrics.ts";
import { stripComments } from "./support/comment-strip.ts";

// The once-a-minute reading of the production DATABASE SERVER (28 Oct 2026): Supabase's metrics text read
// into one sample, the per-minute rates, the five-minute memory rule and the disk rule, who samples, and
// the wiring that keeps it one unref'd timer on one process.

function read(path: string) {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

const MB = 1048576;

// The shape Supabase answers with (names and labels as read on 28 Oct 2026), the figures made up.
function exposition(overrides: { avail?: number; cpu0User?: number; pswpin?: number; rootAvail?: number } = {}) {
  const avail = overrides.avail ?? 879 * MB;
  const rootAvail = overrides.rootAvail ?? 1210 * MB;
  return [
    "# HELP node_memory_MemAvailable_bytes Memory information field MemAvailable_bytes.",
    "# TYPE node_memory_MemAvailable_bytes gauge",
    `node_memory_MemAvailable_bytes{supabase_project_ref="ref",service_type="db"} ${avail}`,
    `node_memory_MemTotal_bytes{supabase_project_ref="ref",service_type="db"} 2.025455616e+09`,
    `node_memory_SwapTotal_bytes{service_type="db"} 1.073737728e+09`,
    `node_memory_SwapFree_bytes{service_type="db"} 8.68073472e+08`,
    `node_vmstat_pswpin{service_type="db"} ${overrides.pswpin ?? 1000000}`,
    `node_vmstat_pswpout{service_type="db"} 1.713408e+06`,
    `node_vmstat_pgmajfault{service_type="db"} 2915854`,
    `node_vmstat_oom_kill{service_type="db"} 0`,
    `node_load1{service_type="db"} 0.23`,
    `node_load5{service_type="db"} 0.1`,
    `node_load15{service_type="db"} 0.08`,
    `node_cpu_seconds_total{cpu="0",mode="idle",service_type="db"} 1000`,
    `node_cpu_seconds_total{cpu="0",mode="user",service_type="db"} ${overrides.cpu0User ?? 400}`,
    `node_cpu_seconds_total{cpu="0",mode="steal",service_type="db"} 10`,
    `node_cpu_seconds_total{cpu="1",mode="idle",service_type="db"} 1000`,
    `node_cpu_seconds_total{cpu="1",mode="user",service_type="db"} 400`,
    `node_cpu_seconds_total{cpu="1",mode="steal",service_type="db"} 10`,
    `node_filesystem_avail_bytes{device="/dev/nvme0n1p2",fstype="ext4",mountpoint="/",service_type="db"} ${rootAvail}`,
    `node_filesystem_size_bytes{device="/dev/nvme0n1p2",fstype="ext4",mountpoint="/",service_type="db"} 1.0461904896e+10`,
    `node_filesystem_avail_bytes{device="/dev/nvme1n1",fstype="ext4",mountpoint="/data",service_type="db"} 6.831878144e+09`,
    `node_filesystem_size_bytes{device="/dev/nvme1n1",fstype="ext4",mountpoint="/data",service_type="db"} 1.2643950592e+10`,
    `node_filesystem_avail_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/run",service_type="db"} 1000`,
    `process_start_time_seconds{service_type="postgresql"} 1.79293406642e+09`,
    `process_start_time_seconds{service_type="gotrue"} 1.79293407357e+09`,
    `pg_up{service_type="postgresql"} 1`,
    // Lines the parser must skip: other metrics, a name with a timestamp suffix, an unparseable value.
    `auth_users_user_count{server="localhost:5432"} 207`,
    `node_load1_extra{service_type="db"} 99 1730000000000`,
    `node_memory_SwapFree_bytes_bogus NaN`,
    "",
  ].join("\n");
}

export async function runDbHostMetricsTests() {
  // --- parsing -------------------------------------------------------------------------------------
  const sample = parseDbHostMetrics(exposition());
  assert.equal(sample.memAvailableMb, 879, "MemAvailable is read in MB");
  assert.equal(sample.memTotalMb, 1932, "MemTotal 2,025,455,616 bytes is 1,932 MB — the Small host");
  assert.equal(sample.swapTotalMb, 1024);
  assert.equal(sample.swapUsedMb, 196, "swap used is total minus free");
  assert.equal(sample.rootDiskFreeMb, 1210, "the ROOT disk is mountpoint=\"/\"");
  assert.equal(sample.rootDiskSizeMb, 9977);
  assert.equal(sample.dataDiskFreeMb, 6515, "the data disk is mountpoint=\"/data\", never confused with the root disk");
  assert.deepEqual([sample.load1, sample.load5, sample.load15], [0.23, 0.1, 0.08]);
  assert.equal(sample.cpuCount, 2, "two CPUs are counted from their labels");
  assert.deepEqual(sample.counters.cpuSeconds, { idle: 2000, steal: 20, user: 800 }, "CPU seconds are summed over every CPU, per mode");
  assert.equal(sample.counters.swapInPages, 1000000);
  assert.equal(sample.counters.swapOutPages, 1713408, "Go's 1.713408e+06 is read as a number");
  assert.equal(sample.counters.majorFaults, 2915854);
  assert.equal(sample.counters.oomKills, 0);
  assert.equal(sample.postgresStartedAt, "2026-10-25T13:14:26.420Z", "Postgres's start is the postgresql service's process_start_time");
  assert.equal(sample.authStartedAt, "2026-10-25T13:14:33.570Z", "Auth's start is the gotrue service's process_start_time");
  assert.equal(sample.postgresUp, true);

  const empty = parseDbHostMetrics("garbage\n{not a line}\n# only a comment");
  assert.equal(empty.memAvailableMb, null, "a missing metric is null, never zero");
  assert.equal(empty.rootDiskFreeMb, null);
  assert.equal(empty.postgresStartedAt, null);
  assert.equal(empty.postgresUp, null);
  assert.equal(empty.cpuCount, 0);
  assert.doesNotThrow(() => parseDbHostMetrics(undefined as unknown as string), "the parser never throws");

  // --- per-minute rates ----------------------------------------------------------------------------
  const later = parseDbHostMetrics(exposition({ cpu0User: 460, pswpin: 1000300 }));
  const rates = dbHostRates(sample.counters, later.counters, 60);
  assert.equal(rates.counterReset, false);
  assert.equal(rates.swapInPagesPerMin, 300, "300 pages swapped in over 60 s is 300 a minute");
  assert.equal(rates.swapOutPagesPerMin, 0);
  assert.equal(rates.oomKills, 0);
  assert.deepEqual(rates.cpuPercent, { idle: 0, steal: 0, user: 100 }, "the CPU share is of the interval, not of all time");

  const slow = dbHostRates(sample.counters, later.counters, 120);
  assert.equal(slow.swapInPagesPerMin, 150, "a reading two minutes after the last is normalised to one minute");

  const reset = dbHostRates(later.counters, sample.counters, 60);
  assert.equal(reset.counterReset, true, "a counter that went down means the host reset between readings");
  assert.equal(reset.swapInPagesPerMin, null, "and no rate across a reset is honest");
  assert.equal(reset.cpuPercent, null);

  // --- the five-minute memory rule -----------------------------------------------------------------
  const low = { ...sample, memAvailableMb: LOW_MEMORY_MB - 1 } satisfies DbHostSample;
  const edge = { ...sample, memAvailableMb: LOW_MEMORY_MB } satisfies DbHostSample;
  const day1 = Date.parse("2026-10-28T08:00:00Z");
  const minute = 60_000;

  const state = createDbHostAlarmState();
  for (let i = 0; i < LOW_MEMORY_MINUTES - 1; i += 1) {
    assert.deepEqual(assessDbHostAlarms(state, low, day1 + i * minute), [], `minute ${i + 1} under ${LOW_MEMORY_MB} MB is not yet an alarm`);
  }
  assert.deepEqual(
    assessDbHostAlarms(state, low, day1 + (LOW_MEMORY_MINUTES - 1) * minute),
    ["low_memory"],
    `the ${LOW_MEMORY_MINUTES}th consecutive minute under ${LOW_MEMORY_MB} MB raises the alarm`,
  );
  assert.deepEqual(assessDbHostAlarms(state, low, day1 + 5 * minute), [], "a sixth minute does not raise it again");
  assessDbHostAlarms(state, sample, day1 + 6 * minute);
  for (let i = 0; i < LOW_MEMORY_MINUTES; i += 1) {
    assert.deepEqual(assessDbHostAlarms(state, low, day1 + (7 + i) * minute), [], "a second episode the same Cairo day is in the log, not a second message");
  }

  const broken = createDbHostAlarmState();
  for (let i = 0; i < LOW_MEMORY_MINUTES - 1; i += 1) assessDbHostAlarms(broken, low, day1 + i * minute);
  assert.deepEqual(assessDbHostAlarms(broken, edge, day1 + 4 * minute), [], `exactly ${LOW_MEMORY_MB} MB is not under the line, and breaks the run`);
  for (let i = 0; i < LOW_MEMORY_MINUTES - 1; i += 1) {
    assert.deepEqual(assessDbHostAlarms(broken, low, day1 + (5 + i) * minute), [], "the run starts again from one after a break");
  }
  const missing = createDbHostAlarmState();
  for (let i = 0; i < LOW_MEMORY_MINUTES - 1; i += 1) assessDbHostAlarms(missing, low, day1 + i * minute);
  assessDbHostAlarms(missing, { ...sample, memAvailableMb: null }, day1 + 4 * minute);
  assert.equal(missing.lowMemoryStreak, 0, "a reading with no memory figure is not a low one, so it breaks the run");

  // 08:00 UTC on 28 Oct is 11:00 Cairo (summer time, UTC+3); 22:30 UTC is already 29 Oct in Cairo.
  assert.equal(cairoDay(day1), "2026-10-28");
  assert.equal(cairoDay(Date.parse("2026-10-28T22:30:00Z")), "2026-10-29", "the day is CAIRO's, not UTC's");
  const nextDay = Date.parse("2026-10-28T22:30:00Z");
  assert.equal(state.lowMemoryStreak, LOW_MEMORY_MINUTES, "the second episode's run is still going");
  assert.deepEqual(
    assessDbHostAlarms(state, low, nextDay),
    ["low_memory"],
    "a run still going when the Cairo day turns raises on the new day's first minute",
  );
  const fresh = createDbHostAlarmState();
  fresh.lastRaisedDay.low_memory = "2026-10-28";
  let raisedNextDay: string[] = [];
  for (let i = 0; i < LOW_MEMORY_MINUTES; i += 1) raisedNextDay = assessDbHostAlarms(fresh, low, nextDay + i * minute);
  assert.deepEqual(raisedNextDay, ["low_memory"], "the next Cairo day the alarm can fire again");

  // --- the root-disk rule --------------------------------------------------------------------------
  const disk = createDbHostAlarmState();
  const fullDisk = parseDbHostMetrics(exposition({ rootAvail: (LOW_ROOT_DISK_MB - 1) * MB }));
  assert.deepEqual(assessDbHostAlarms(disk, fullDisk, day1), ["low_root_disk"], `one reading under ${LOW_ROOT_DISK_MB} MB on the root disk raises it`);
  assert.deepEqual(assessDbHostAlarms(disk, fullDisk, day1 + minute), [], "once a Cairo day");
  const atLine = parseDbHostMetrics(exposition({ rootAvail: LOW_ROOT_DISK_MB * MB }));
  assert.deepEqual(assessDbHostAlarms(createDbHostAlarmState(), atLine, day1), [], `exactly ${LOW_ROOT_DISK_MB} MB is not under the line`);
  assert.deepEqual(assessDbHostAlarms(createDbHostAlarmState(), sample, day1), [], "a healthy host raises nothing");

  // --- the wording ---------------------------------------------------------------------------------
  const memoryText = dbHostAlarmMessage("low_memory", low);
  assert.match(memoryText.message, /99 MB available of 1,932 MB/, "the message carries the host's own figures");
  assert.match(memoryText.message, /Nothing is changed automatically/, "it says nothing was done on its own");
  assert.match(memoryText.message, /Compute and Disk screen/, "and names the screen where the size is decided — never a chat OK");
  const diskText = dbHostAlarmMessage("low_root_disk", fullDisk);
  assert.match(diskText.message, /499 MB free/);
  assert.match(diskText.message, /not the data disk/, "the disk message says which disk");

  // --- who samples ---------------------------------------------------------------------------------
  const production = {
    APP_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NODE_ENV: "production",
    PHOENIX_PROCESS_ROLE: "worker",
    SUPABASE_SERVICE_ROLE_KEY: "test-key-not-real",
  };
  assert.equal(dbHostSamplerRefusal(production), null, "the production worker samples");
  assert.equal(dbHostSamplerRefusal({ ...production, PHOENIX_PROCESS_ROLE: undefined }), null, "a single 'all' process samples");
  assert.match(String(dbHostSamplerRefusal({ ...production, PHOENIX_PROCESS_ROLE: "web" })), /web/, "a page server never samples — one process only");
  assert.match(String(dbHostSamplerRefusal({ ...production, APP_ENV: "staging" })), /APP_ENV/, "staging builds as NODE_ENV=production and still never samples");
  assert.match(String(dbHostSamplerRefusal({ ...production, NODE_ENV: "development" })), /production build/);
  assert.match(String(dbHostSamplerRefusal({ ...production, PHOENIX_DB_HOST_METRICS: "off" })), /off/, "PHOENIX_DB_HOST_METRICS=off is the kill switch");
  assert.match(String(dbHostSamplerRefusal({ ...production, SUPABASE_SERVICE_ROLE_KEY: "" })), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(dbHostMetricsUrl("https://example.supabase.co/"), "https://example.supabase.co/customer/v1/privileged/metrics");
  assert.equal(dbHostMetricsUrl("http://example.supabase.co"), null, "the key is never sent over plain http");
  assert.equal(dbHostMetricsUrl("not a url"), null);

  // --- wiring --------------------------------------------------------------------------------------
  const sampler = read("src/lib/observability/db-host-sampler.ts");
  assert.match(sampler, /signal: AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/, "every read has a deadline");
  assert.match(sampler, /const FETCH_TIMEOUT_MS = 10_000;/);
  assert.match(sampler, /if \(inFlight\) return;/, "a slow read is never doubled by the next minute");
  assert.match(sampler, /"User-Agent": USER_AGENT/, "the agent is named: the secret key refuses a browser one");
  assert.match(sampler, /\.unref\?\.\(\)/, "the timer never holds the process open");
  assert.match(sampler, /dbHostSamplerRefusal\(process\.env\)/, "the sampler starts only where the pure gate allows");
  assert.doesNotMatch(sampler, /^import[^\n]*@\/lib\/notifications/m, "the notification graph is loaded only when an alarm fires");
  assert.doesNotMatch(sampler, /log(?:Info|Warning|Error)\([^;]*\bkey\b/, "the key never reaches a log line");

  const alert = read("src/lib/observability/db-host-alert.ts");
  assert.match(alert, /channels: \["in_app", "telegram", "push"\]/, "the alarm goes in-app, Telegram and push");
  assert.doesNotMatch(alert, /"email"/, "never by email");
  assert.match(alert, /idempotencyKey: `database-host-\$\{kind\}:\$\{day\}:\$\{recipient\.hrId\}`/, "one message per kind per Cairo day survives a redeploy");
  assert.match(alert, /module: "system"/);

  const instrumentation = read("instrumentation.ts");
  const healthAt = instrumentation.indexOf('await import("@/lib/observability/process-health")');
  const samplerAt = instrumentation.indexOf('await import("@/lib/observability/db-host-sampler")');
  const elseAt = instrumentation.indexOf('console.log("[schedulers] not started: not a production build');
  assert.ok(
    healthAt > 0 && samplerAt > healthAt && elseAt > samplerAt,
    "instrumentation.ts imports the sampler dynamically, after process-health, inside the production-build block",
  );
  assert.doesNotMatch(instrumentation, /^import[^\n]*db-host/m, "never a static import — instrumentation is bundled for the edge runtime too");
}
