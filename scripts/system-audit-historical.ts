#!/usr/bin/env node
/**
 * THE SYSTEM AUDIT'S HISTORICAL RUN — every detector over a past window, once, to give the ledger
 * its starting point.
 *
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/system-audit-historical.ts --app-errors <snapshot.csv> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out <dir>]
 *
 *   ...the same with --apply to write the ledger.
 *
 * DRY RUN (the default) WRITES NOTHING TO THE DATABASE. Every detector writes through the file sink,
 * and the run leaves three files in `--out` (default `xlsx/system-audit-historical/<Cairo stamp>/`,
 * which git ignores):
 *   MASTER_ERROR_AUDIT.csv  the owner's eleven columns plus the technical ones, one row per occurrence;
 *   excluded-noise.csv      what was left out on purpose, per detector and class — never silently;
 *   coverage.json           what each detector read, what it could not, and the window.
 * The dry run READS production (the detectors' own sources, read-only) except the error table, which
 * comes from `--app-errors`, a CSV snapshot of `app_error_events` taken once: reading 90 days of that
 * table twice, once to look and once to apply, is exactly the load the sweep is built to avoid.
 *
 * --apply WRITES THE LEDGER, in this order, and stops at the first failure:
 *   1. checks the six ledger tables exist (a missing one answers PGRST205: apply the two
 *      20261023051847 / 20261023051848 migrations first);
 *   2. runs every detector through the database sink — the errors from `--app-errors` when given,
 *      otherwise from the live table;
 *   3. applies the reviewed triage seed (src/lib/system-audit/triage-seed.ts) as `seed:<short sha>`;
 *   4. marks every issue the first daily message would carry as already told — history is the page's
 *      job, not a 5 a.m. message with a backlog of a thousand issues in it;
 *   5. sets each detector's watermark, so the nightly sweep carries on from where this stopped.
 *
 * The verifier is NOT run: it changes statuses on evidence measured after a fix, and a historical
 * window has no "after" to measure yet. The integrity checks run ONCE, as of now — their past was
 * never stored, so there is none to replay.
 *
 * GUARDS. The Supabase host is printed FIRST, before anything is read. The run refuses 09:00–17:00
 * Cairo — the database's working day — and refuses any flag it does not know, rather than ignoring it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AppErrorEventRow } from "@/lib/system-audit/signature";
import type { AuditDetector, DetectorResult, FindingSink } from "@/lib/system-audit/types";

export const KNOWN_FLAGS = ["--apply", "--app-errors", "--from", "--to", "--out", "--help"] as const;
const VALUE_FLAGS = new Set(["--app-errors", "--from", "--to", "--out"]);
const LEDGER_TABLES = [
  "system_audit_issues",
  "system_audit_issue_fixes",
  "system_audit_occurrences",
  "system_audit_status_history",
  "system_audit_detector_runs",
  "system_audit_watermarks",
] as const;
/** app_error_events keeps 90 days; a window older than that has nothing to read. */
const DEFAULT_WINDOW_DAYS = 90;

export type HistoricalArgs = {
  apply: boolean;
  appErrors: string | null;
  from: string;
  to: string;
  out: string | null;
  help: boolean;
};

const USAGE = `Usage: scripts/system-audit-historical.ts --app-errors <snapshot.csv> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out <dir>] [--apply]`;

function cairoHourMinute(now: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Africa/Cairo" }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { hour: value("hour") % 24, minute: value("minute") };
}

export function cairoDateOf(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(now);
}

/** Refuses the database's working day: 09:00 up to 17:00 Cairo. THROWS, with the time it read. */
export function assertOffPeakCairo(now: Date): void {
  const { hour, minute } = cairoHourMinute(now);
  if (hour >= 9 && hour < 17) {
    const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    throw new Error(
      `Refused: it is ${clock} Cairo. The historical run reads months of production data and is allowed only outside 09:00–17:00 Cairo, when nobody is working.`,
    );
  }
}

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Pure: the arguments, or a thrown refusal naming what is wrong. */
export function parseHistoricalArgs(argv: readonly string[], now: Date = new Date()): HistoricalArgs {
  const values = new Map<string, string>();
  let apply = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [flag, inline] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, null];
    if (!(KNOWN_FLAGS as readonly string[]).includes(flag)) {
      throw new Error(`Unknown flag ${token} — refused rather than ignored. Known: ${KNOWN_FLAGS.join(", ")}.`);
    }
    if (flag === "--apply") apply = true;
    else if (flag === "--help") help = true;
    else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[index + 1];
      if (inline === null) index += 1;
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
      values.set(flag, value);
    }
  }
  const today = cairoDateOf(now);
  const from = values.get("--from") ?? addDays(today, -DEFAULT_WINDOW_DAYS);
  const to = values.get("--to") ?? today;
  for (const [flag, date] of [["--from", from], ["--to", to]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`${flag} must be a date, YYYY-MM-DD (got ${date}).`);
  }
  if (from > to) throw new Error(`--from ${from} is after --to ${to}.`);
  const appErrors = values.get("--app-errors") ?? null;
  if (!apply && !help && !appErrors) {
    throw new Error("A dry run reads the errors from a snapshot: pass --app-errors <snapshot.csv> (a CSV export of app_error_events).");
  }
  return { apply, appErrors, from, to, out: values.get("--out") ?? null, help };
}

/** Pure RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("The CSV ends inside a quoted field — the snapshot is truncated.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ""));
}

const REQUIRED_COLUMNS = ["id", "created_at", "source", "route", "message", "stack", "environment"] as const;
const OPTIONAL_COLUMNS = ["hr_id", "login_id", "role", "module_key", "module_label", "route_type", "digest", "release", "user_agent"] as const;

/** Pure: a snapshot CSV of app_error_events → rows. An empty cell is null. Refuses a missing column. */
export function appErrorRowsFromCsv(text: string): AppErrorEventRow[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  const index = new Map(header.map((name, position) => [name.trim().toLowerCase(), position] as const));
  const missing = REQUIRED_COLUMNS.filter((name) => !index.has(name));
  if (missing.length > 0) throw new Error(`The snapshot is missing the column(s) ${missing.join(", ")}.`);
  const cell = (cells: string[], name: string): string | null => {
    const position = index.get(name);
    if (position === undefined) return null;
    const value = cells[position];
    return value === undefined || value === "" ? null : value;
  };
  return body.map((cells, line) => {
    const id = cell(cells, "id");
    const createdAt = cell(cells, "created_at");
    if (!id || !createdAt || Number.isNaN(Date.parse(createdAt))) throw new Error(`Snapshot row ${line + 2} has no usable id or created_at.`);
    const row: AppErrorEventRow = {
      id,
      created_at: createdAt,
      source: cell(cells, "source") ?? "server",
      hr_id: cell(cells, "hr_id"),
      route: cell(cells, "route"),
      message: cell(cells, "message"),
      stack: cell(cells, "stack"),
      environment: cell(cells, "environment"),
    };
    for (const name of OPTIONAL_COLUMNS) {
      if (name === "hr_id") continue;
      (row as Record<string, unknown>)[name] = cell(cells, name);
    }
    return row;
  });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function shortSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

async function main(): Promise<void> {
  // 1. The host FIRST — before the arguments are judged, before anything is read.
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(rawUrl).host;
  } catch {
    // Reported just below.
  }
  console.log(`Supabase host: ${host || "(NEXT_PUBLIC_SUPABASE_URL is not set)"}`);
  if (!host) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set, so there is no database to read. Run with --env-file-if-exists=.env.local.");

  const args = parseHistoricalArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  assertOffPeakCairo(new Date());

  const [
    { getSupabaseAdmin },
    { createDatabaseSink, finishDetectorRun, loadAlertCandidates, markIssuesAlerted, startDetectorRun, transitionIssueStatus },
    { createFileSink },
    { appErrorFoldDetector, createAppErrorFoldDetector, createArrayAppErrorSource },
    { createPersonDirectory },
    { syncRunsDetector },
    { jobFailuresDetector },
    { dataLinkageDetector },
    { visitLifecycleDetector },
    { createReconciliationDetector },
    { TRIAGE_SEED, triageSeedProblems },
    { getDeployRevision },
  ] = await Promise.all([
    import("@/lib/supabase/server"),
    import("@/lib/system-audit/repository"),
    import("@/lib/system-audit/sinks/file-sink"),
    import("@/lib/system-audit/detectors/app-error-fold"),
    import("@/lib/system-audit/person-directory"),
    import("@/lib/system-audit/detectors/sync-runs"),
    import("@/lib/system-audit/detectors/job-failures"),
    import("@/lib/system-audit/detectors/data-linkage"),
    import("@/lib/system-audit/detectors/visit-lifecycle"),
    import("@/lib/system-audit/detectors/reconciliation-ledger"),
    import("@/lib/system-audit/triage-seed"),
    import("@/lib/observability/deploy-identity"),
  ]);

  const seedProblems = triageSeedProblems(TRIAGE_SEED);
  if (seedProblems.length > 0) throw new Error(`The triage seed would be refused by the ledger:\n  ${seedProblems.join("\n  ")}`);

  const supabase = getSupabaseAdmin({ requestTimeoutMs: 30_000 });
  console.log(`Window: ${args.from} to ${args.to} (Cairo days) · mode: ${args.apply ? "APPLY — writes the ledger" : "dry run — writes files only"}`);

  if (args.apply) {
    for (const table of LEDGER_TABLES) {
      const { error } = await supabase.from(table).select("*").limit(1);
      if (error) {
        if (error.code === "PGRST205") {
          throw new Error(`The ledger table ${table} is not in this database (PGRST205). Apply migrations 20261023051847 and 20261023051848 first.`);
        }
        throw new Error(`The ledger table ${table} could not be read: ${error.message}`);
      }
    }
  }

  const fileSink = args.apply ? null : createFileSink();
  const sink: FindingSink = fileSink ?? createDatabaseSink();

  let appErrors: AuditDetector = appErrorFoldDetector;
  if (args.appErrors) {
    const rows = appErrorRowsFromCsv(readFileSync(args.appErrors, "utf8"));
    console.log(`App errors: ${rows.length.toLocaleString("en-US")} rows from ${args.appErrors}`);
    appErrors = createAppErrorFoldDetector({ source: createArrayAppErrorSource(rows), people: createPersonDirectory(supabase) });
  } else {
    console.log("App errors: read from the live app_error_events table");
  }

  const reconciliation = createReconciliationDetector();
  const detectors: AuditDetector[] = [appErrors, syncRunsDetector, jobFailuresDetector, dataLinkageDetector, visitLifecycleDetector, reconciliation];
  const release = getDeployRevision();
  const runGroup = crypto.randomUUID();
  const results: Array<{ detector: string; result: DetectorResult }> = [];

  for (const detector of detectors) {
    const startedAt = Date.now();
    const ownsRun = detector === reconciliation;
    const runId = args.apply && !ownsRun ? await startDetectorRun({ detector: detector.id, mode: "historical", runGroup, release }) : null;
    let result: DetectorResult;
    try {
      result = await detector.run({
        mode: "historical",
        // Generous: this is a one-off, off-peak run, and a detector that stops half-way would leave
        // a window half-read. Each detector still checks the clock between batches.
        deadline: startedAt + 30 * 60_000,
        sink,
        runId,
        now: () => Date.now(),
        window: { from: args.from, to: args.to },
      });
    } catch (error) {
      result = { status: "errored", scanned: 0, excludedCounts: {}, inserted: 0, updated: 0, unreadableSources: [], error: errorText(error) };
    }
    if (runId) await finishDetectorRun(runId, result);
    results.push({ detector: detector.id, result });
    console.log(
      `  ${detector.id}: ${result.status} · scanned ${result.scanned.toLocaleString("en-US")} · new ${result.inserted} · updated ${result.updated}` +
        (result.unreadableSources.length > 0 ? ` · NOT MEASURED: ${result.unreadableSources.join(", ")}` : "") +
        (result.error ? ` · ${result.error}` : ""),
    );
    // On --apply, a detector that failed outright stops the run before anything is marked as told.
    if (args.apply && result.status === "errored") {
      throw new Error(`${detector.id} failed, so the seed, the told-marks and the watermarks were NOT applied. Fix it and run again — every write so far is idempotent.`);
    }
  }

  if (args.apply) {
    const actor = `seed:${shortSha()}`;
    let seeded = 0;
    for (const entry of TRIAGE_SEED) {
      const { data, error } = await supabase.from("system_audit_issues").select("id").eq("signature_key", entry.signatureKey).maybeSingle();
      if (error) throw new Error(`The seed could not find ${entry.signatureKey}: ${error.message}`);
      if (!data) {
        console.log(`  seed: ${entry.signatureKey} was not found in the ledger — skipped`);
        continue;
      }
      await transitionIssueStatus({
        issueId: (data as { id: string }).id,
        to: entry.to,
        actor,
        reason: entry.reason,
        fixSha: entry.fixSha ?? null,
        fixLiveAt: entry.fixLiveAt ?? null,
        evidence: entry.evidence ?? {},
      });
      seeded += 1;
    }
    console.log(`Triage seed: ${seeded} of ${TRIAGE_SEED.length} applied as ${actor}`);

    const candidates = await loadAlertCandidates();
    const marked = await markIssuesAlerted(candidates.map((candidate) => candidate.issueId));
    console.log(`Marked as already told: ${marked} issue(s) — the first daily message carries only what is new after tonight.`);

    for (const { detector, result } of results) {
      if (detector === reconciliation.id || !result.watermarkTo || result.status === "errored") continue;
      await sink.write(detector, null, { issues: [], occurrences: [], merge: "max", cursor: result.watermarkTo });
      console.log(`  watermark set: ${detector}`);
    }
    return;
  }

  // Dry run: the three files.
  const finishedAt = new Date();
  const clock = cairoHourMinute(finishedAt);
  const stamp = `${cairoDateOf(finishedAt)}-${String(clock.hour).padStart(2, "0")}${String(clock.minute).padStart(2, "0")}`;
  const outDir = args.out ?? join("xlsx", "system-audit-historical", stamp);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "MASTER_ERROR_AUDIT.csv"), fileSink!.toMasterCsv());
  const noiseLines = ["Detector,Excluded class,Rows"];
  for (const { detector, result } of results) {
    for (const [noiseClass, count] of Object.entries(result.excludedCounts)) noiseLines.push([detector, noiseClass, count].map(csvCell).join(","));
  }
  writeFileSync(join(outDir, "excluded-noise.csv"), `﻿${noiseLines.join("\r\n")}\r\n`);
  writeFileSync(
    join(outDir, "coverage.json"),
    `${JSON.stringify(
      {
        host,
        window: { from: args.from, to: args.to, zone: "Africa/Cairo" },
        appErrorsFrom: args.appErrors ?? "app_error_events (live)",
        detectors: results.map(({ detector, result }) => ({
          detector,
          status: result.status,
          scanned: result.scanned,
          rowsWritten: result.inserted + result.updated,
          excluded: result.excludedCounts,
          notMeasured: result.unreadableSources,
          error: result.error ?? null,
          report: result.report ?? null,
        })),
        notRun: { verifier: "changes statuses on evidence measured after a fix; a historical window has no after yet" },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote MASTER_ERROR_AUDIT.csv, excluded-noise.csv and coverage.json to ${outDir}`);
}

const isEntry = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().catch((error: unknown) => {
    console.error(errorText(error));
    process.exit(1);
  });
}
