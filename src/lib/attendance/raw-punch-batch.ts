/**
 * How raw fingerprint punches reach the database: a few batched calls, with the old one-call-per-punch
 * path kept as the fallback.
 *
 * Why this exists. `POST /api/attendance/raw-punches` used to call `phx_insert_attendance_raw_punch`
 * once per punch, fifty at a time. On 18 Oct 2026 between 10:16 and 10:33 Cairo that was 10,461 calls --
 * the on-prem agent replaying punches the table already held, almost all of them duplicates -- while
 * production was entering the slowdown that timed out the login check from 10:30 to 11:55. One
 * `phx_insert_attendance_raw_punches` call takes up to 250 punches in a single INSERT ... ON CONFLICT DO
 * NOTHING, so a full 1,000-punch request costs four calls instead of up to a thousand.
 *
 * The rules, each pinned by `tests/attendance-raw-punch-batch.test.ts`:
 *   - `inserted` is what the database says it inserted; every other punch of the batch is a duplicate
 *     (`duplicate = batch size - inserted`), which is exactly what the per-punch path reported.
 *   - A batch that fails for ANY reason -- the function is missing (route deployed before the migration),
 *     a timeout, a malformed answer -- is retried punch by punch, at concurrency 10 rather than the old
 *     50, so a failure is still reported against the punch's own `input_index` and the agent still knows
 *     which punches to send again. A batch is one statement, so a failed one wrote nothing, and
 *     replaying it is safe either way: the insert is idempotent.
 *   - The per-punch path keeps its old reading of the answer: no id back means the punch was already
 *     there, and a stray 23505 is a duplicate, never a failure.
 *
 * One honest limit: if a batch commits but its answer is lost to the client's request timeout, the
 * fallback replays it and reports those punches as duplicates rather than inserted. Nothing is lost or
 * written twice; only the `inserted` figure for that request reads low.
 */

export const RAW_PUNCH_BATCH_FUNCTION = "phx_insert_attendance_raw_punches";
export const RAW_PUNCH_SINGLE_FUNCTION = "phx_insert_attendance_raw_punch";

/** Punches per database call. A 1,000-punch request is four calls. */
export const RAW_PUNCH_BATCH_SIZE = 250;

/** Parallel single-punch calls while falling back -- deliberately a fifth of the old 50. */
export const RAW_PUNCH_FALLBACK_CONCURRENCY = 10;

export type RawPunchRow = {
  device_id: string;
  device_user_id: string;
  employee_hr_id: string;
  punch_time: string;
  punch_type: string | null;
  verify_mode: string | null;
  raw_payload: unknown;
  source_run_id: string | null;
};

export type RawPunchToInsert = {
  /** The punch's position in the request body, so a failure can be reported against it. */
  inputIndex: number;
  row: RawPunchRow;
};

export type RawPunchRpcReply = {
  data: unknown;
  error: { code?: string | null; message: string } | null;
};

/** The one database call this module makes, injected so a test needs no database. */
export type RawPunchRpc = (functionName: string, args: Record<string, unknown>) => PromiseLike<RawPunchRpcReply>;

export type RawPunchFailure = { index: number; message: string };

export type RawPunchOutcome = {
  inserted: number;
  duplicate: number;
  failures: RawPunchFailure[];
  /** How many batches were retried punch by punch. Anything above zero is worth a look. */
  batchesFallenBack: number;
};

function singleArgs(row: RawPunchRow): Record<string, unknown> {
  return {
    p_device_id: row.device_id,
    p_device_user_id: row.device_user_id,
    p_employee_hr_id: row.employee_hr_id,
    p_punch_time: row.punch_time,
    p_punch_type: row.punch_type,
    p_verify_mode: row.verify_mode,
    p_raw_payload: row.raw_payload ?? {},
    p_source_run_id: row.source_run_id,
  };
}

/** The number the database inserted for this batch, or null when the answer cannot be trusted. */
async function insertBatch(chunk: RawPunchToInsert[], rpc: RawPunchRpc): Promise<number | null> {
  let reply: RawPunchRpcReply;
  try {
    reply = await rpc(RAW_PUNCH_BATCH_FUNCTION, {
      p_rows: chunk.map(({ row }) => ({ ...row, raw_payload: row.raw_payload ?? {} })),
    });
  } catch {
    return null;
  }
  if (reply.error) return null;
  const count = reply.data;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > chunk.length) return null;
  return count;
}

async function insertOneByOne(
  chunk: RawPunchToInsert[],
  rpc: RawPunchRpc,
  concurrency: number,
  outcome: RawPunchOutcome,
): Promise<void> {
  for (let i = 0; i < chunk.length; i += concurrency) {
    const group = chunk.slice(i, i + concurrency);
    const results = await Promise.all(
      group.map(async ({ inputIndex, row }) => ({
        inputIndex,
        reply: await rpc(RAW_PUNCH_SINGLE_FUNCTION, singleArgs(row)),
      })),
    );

    for (const { inputIndex, reply } of results) {
      if (reply.error) {
        if (reply.error.code === "23505") {
          outcome.duplicate += 1;
          continue;
        }
        outcome.failures.push({ index: inputIndex, message: reply.error.message });
        continue;
      }
      if (reply.data == null) outcome.duplicate += 1;
      else outcome.inserted += 1;
    }
  }
}

export async function insertRawPunches(
  items: ReadonlyArray<RawPunchToInsert>,
  rpc: RawPunchRpc,
  options: { batchSize?: number; fallbackConcurrency?: number } = {},
): Promise<RawPunchOutcome> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? RAW_PUNCH_BATCH_SIZE));
  const concurrency = Math.max(1, Math.floor(options.fallbackConcurrency ?? RAW_PUNCH_FALLBACK_CONCURRENCY));
  const outcome: RawPunchOutcome = { inserted: 0, duplicate: 0, failures: [], batchesFallenBack: 0 };

  // Batches go one after another: the point is fewer, calmer calls, and four in parallel would put the
  // load back.
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const insertedByBatch = await insertBatch(chunk, rpc);
    if (insertedByBatch !== null) {
      outcome.inserted += insertedByBatch;
      outcome.duplicate += chunk.length - insertedByBatch;
      continue;
    }
    outcome.batchesFallenBack += 1;
    await insertOneByOne(chunk, rpc, concurrency, outcome);
  }

  return outcome;
}
