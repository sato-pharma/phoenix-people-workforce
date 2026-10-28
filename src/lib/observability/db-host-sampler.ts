// Once a minute, read the production database server's own metrics from Supabase and log one `db_host`
// line. The reading, the rates and the alarm rule are pure and live in db-host-metrics.ts; the message
// is db-host-alert.ts, loaded only on the minute an alarm fires.
//
// `railway logs <deployment-id> -s phoenix-workforce-worker -e production -d --lines 5000 | grep db_host`
// reads the history back. Supabase keeps none: before this, the minutes before each of the 14 resets of
// 7–25 Oct 2026 were gone by the time anyone looked.
//
// 🔴 SERVER ONLY, AND THE KEY NEVER LEAVES THE REQUEST HEADER. The endpoint takes HTTP basic auth with the
// service-role key; it is read from the environment at the moment of the call, never stored, logged or put
// in a URL. Nothing read from the host is personal: the line keeps host figures and two start times only.
//
// Cost, measured 28 Oct 2026: one read is ~460 KB of text, sent gzip-compressed, and answers in 1.3–1.8 s.
// A 10 s timeout and a no-overlap guard keep a slow minute from stacking reads.

import {
  assessDbHostAlarms,
  createDbHostAlarmState,
  dbHostMetricsUrl,
  dbHostRates,
  dbHostSamplerRefusal,
  parseDbHostMetrics,
  type DbHostAlarmKind,
  type DbHostSample,
} from "@/lib/observability/db-host-metrics";
import { logInfo, logWarning } from "@/lib/observability/log";

const SAMPLE_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
// The secret key refuses a browser User-Agent with a 401 (memory note
// supabase-secret-key-refuses-a-browser-user-agent), so the agent is named, never left to a default.
const USER_AGENT = "phoenix-db-host-sampler";

let started = false;

export function startDbHostSampler(): { reason?: string; started: boolean } {
  if (started) return { reason: "already started", started: false };
  const refusal = dbHostSamplerRefusal(process.env);
  if (refusal) return { reason: refusal, started: false };
  const url = dbHostMetricsUrl(String(process.env.NEXT_PUBLIC_SUPABASE_URL));
  if (!url) return { reason: "NEXT_PUBLIC_SUPABASE_URL is not an https URL", started: false };
  started = true;

  const alarms = createDbHostAlarmState();
  let previous: { atMs: number; sample: DbHostSample } | null = null;
  let inFlight = false;

  const tick = async () => {
    // A read that is still going when the next minute starts is skipped, never doubled.
    if (inFlight) return;
    inFlight = true;
    const startedAtMs = Date.now();
    try {
      const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "text/plain",
          "Accept-Encoding": "gzip",
          Authorization: `Basic ${Buffer.from(`service_role:${key}`).toString("base64")}`,
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // The status only: the body of a refusal is Supabase's text and is not needed to act on it.
        await response.body?.cancel().catch(() => undefined);
        logWarning("database host metrics refused", {
          labels: { event: "db_host_failed" },
          context: { status: response.status },
        });
        return;
      }
      const text = await response.text();
      const atMs = Date.now();
      const sample = parseDbHostMetrics(text);
      const rates = previous
        ? dbHostRates(previous.sample.counters, sample.counters, (atMs - previous.atMs) / 1000, sample.cpuCount)
        : null;
      // A repeated snapshot keeps the last fresh one as the base, so the next minute's rates span the real
      // interval instead of starting from a copy of it (dbHostRates says why).
      if (!rates?.stale) previous = { atMs, sample };

      logInfo("database host", {
        labels: { event: "db_host" },
        context: {
          authStartedAt: sample.authStartedAt,
          cpuCount: sample.cpuCount,
          cpuPercent: rates?.cpuPercent ?? null,
          counterReset: rates?.counterReset ?? null,
          dataDiskFreeMb: sample.dataDiskFreeMb,
          intervalS: rates?.intervalS ?? null,
          load: [sample.load1, sample.load5, sample.load15],
          majorFaultsPerMin: rates?.majorFaultsPerMin ?? null,
          memAvailableMb: sample.memAvailableMb,
          memTotalMb: sample.memTotalMb,
          oomKills: rates?.oomKills ?? null,
          postgresStartedAt: sample.postgresStartedAt,
          postgresUp: sample.postgresUp,
          readMs: atMs - startedAtMs,
          rootDiskFreeMb: sample.rootDiskFreeMb,
          stale: rates?.stale ?? null,
          swapInPagesPerMin: rates?.swapInPagesPerMin ?? null,
          swapOutPagesPerMin: rates?.swapOutPagesPerMin ?? null,
          swapUsedMb: sample.swapUsedMb,
        },
      });

      for (const kind of assessDbHostAlarms(alarms, sample, atMs)) void raise(kind, sample);
    } catch (error) {
      // A timeout, a dropped connection or a parse surprise costs this minute's line, never the process.
      logWarning("database host metrics read failed", { error, labels: { event: "db_host_failed" } });
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    // A throw inside a timer callback is an uncaught exception, which ends the process.
    void tick().catch(() => undefined);
  }, SAMPLE_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { started: true };
}

async function raise(kind: DbHostAlarmKind, sample: DbHostSample): Promise<void> {
  try {
    // Loaded on the minute an alarm fires only, so the notification graph never sits in this module.
    const { sendDbHostAlarm } = await import("@/lib/observability/db-host-alert");
    await sendDbHostAlarm(kind, sample);
  } catch (error) {
    logWarning("database host alarm failed", { error, labels: { alarm: kind, event: "db_host_alarm_failed" } });
  }
}
