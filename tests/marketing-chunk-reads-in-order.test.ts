import assert from "node:assert/strict";

import { readChunksInOrder } from "../src/lib/marketing-requests/service.ts";

/**
 * THE CUSTOMER VALIDATION READS NOW RUN A FEW CHUNKS AT A TIME — AND ANSWER IN CHUNK ORDER.
 *
 * Owner, 2026-10-01: "the employee portal, specially the medical rep role, is slow to transfer
 * between page and page". fetchRowsByIds and fetchDistributorCodesByPharmacyIds read an id list
 * 100 ids per request, and each request waited for the one before it. They now share
 * readChunksInOrder, which runs up to six at once. What the callers see must not change:
 *
 *   1. rows come back concatenated in CHUNK order, however the reads finish;
 *   2. a failure throws what the one-at-a-time loop threw — the first failed chunk in chunk
 *      order, whether its read rejected or answered with an error, and the error itself, unwrapped;
 *   3. no more than six chunks are read at once, but more than one is.
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runMarketingChunkReadsInOrderTests() {
  // 1 + 3. Later chunks finish FIRST, and the rows still come back in chunk order.
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const batches = Array.from({ length: 10 }, (_, index) => [index]);
    const rows = await readChunksInOrder<number, number>(batches, async (batch) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(20 - batch[0] * 2);
      inFlight -= 1;
      return { data: [batch[0] * 10, batch[0] * 10 + 1], error: null };
    });
    assert.deepEqual(
      rows,
      batches.flatMap(([index]) => [index * 10, index * 10 + 1]),
      "rows are concatenated in chunk order, exactly as the one-at-a-time loop pushed them",
    );
    assert.ok(maxInFlight > 1, `chunks must overlap (saw ${maxInFlight} at once)`);
    assert.ok(maxInFlight <= 6, `at most six chunks at once (saw ${maxInFlight})`);
  }

  // 2. The first failed chunk in CHUNK order wins, even when a later chunk failed first in time.
  {
    const batches = Array.from({ length: 10 }, (_, index) => [index]);
    await assert.rejects(
      readChunksInOrder<number, number>(batches, async (batch) => {
        if (batch[0] === 7) throw new Error("chunk 7 rejected");
        if (batch[0] === 3) {
          await delay(30);
          return { data: null, error: { message: "chunk 3 answered with an error" } };
        }
        return { data: [], error: null };
      }),
      (error: unknown) => {
        assert.equal((error as { message?: unknown }).message, "chunk 3 answered with an error");
        return true;
      },
      "chunk 3 is earlier in the list than chunk 7, so its failure is the one thrown",
    );
  }

  // 2. The error a read answers with is thrown as it is — not wrapped — as `if (error) throw error` did.
  {
    const postgrestError = { code: "57014", message: "canceling statement due to statement timeout" };
    await assert.rejects(
      readChunksInOrder<number, number>([[1], [2]], async (batch) =>
        batch[0] === 2 ? { data: null, error: postgrestError } : { data: [1], error: null }),
      (error: unknown) => {
        assert.equal(error, postgrestError, "the very error object the read answered with");
        return true;
      },
    );
  }

  // An empty id list reads nothing.
  {
    let reads = 0;
    const rows = await readChunksInOrder<number, number>([], async () => {
      reads += 1;
      return { data: [1], error: null };
    });
    assert.deepEqual(rows, []);
    assert.equal(reads, 0);
  }
}
