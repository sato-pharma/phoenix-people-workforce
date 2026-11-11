import assert from "node:assert/strict";

// 11 Nov 2026: an interview drawer showed the browser's own "Failed to fetch (phoenix-hr.satopharma.com)"
// under the Zoom invitation and the polls. The server was up and answered every request it received —
// the laptop's connection had dropped for a moment. These drive the calendar's request client with a
// stand-in fetch: a read is tried once more after a pause, a save is never repeated (it may already
// have arrived), and neither ever shows the browser's jargon.

import {
  CALENDAR_UNREACHABLE_READ,
  CALENDAR_UNREACHABLE_WRITE,
  calendarApi,
} from "@/components/recruitment/interview-calendar/calendar-api";

type FetchLike = typeof globalThis.fetch;

async function withFetch(stub: FetchLike, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function dropped(): never {
  throw new TypeError("Failed to fetch (phoenix-hr.satopharma.com)");
}

export async function runInterviewCalendarUnreachableTests(): Promise<void> {
  // A read that drops once and then arrives shows the answer — the person never sees the drop.
  {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        if (calls === 1) dropped();
        return new Response(JSON.stringify({ polls: [] }), { status: 200 });
      }) as FetchLike,
      async () => {
        const data = await calendarApi(null).get("/bookings/abc/polls");
        assert.deepEqual(data, { polls: [] });
      },
    );
    assert.equal(calls, 2, "a read that dropped once must be tried exactly once more");
  }

  // A read that drops twice says Phoenix could not be reached, in words — never "Failed to fetch".
  {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        dropped();
      }) as FetchLike,
      async () => {
        await assert.rejects(calendarApi(null).get("/bookings/abc/invitation"), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, CALENDAR_UNREACHABLE_READ);
          assert.doesNotMatch(error.message, /failed to fetch/i);
          return true;
        });
      },
    );
    assert.equal(calls, 2);
  }

  // A save that drops is NOT repeated — a second POST could add the poll twice — and it says the
  // outcome is unknown rather than that nothing was saved.
  for (const send of [
    (api: ReturnType<typeof calendarApi>) => api.post("/bookings/abc/polls", { pollSetId: "x" }),
    (api: ReturnType<typeof calendarApi>) => api.patch("/bookings/abc", {}),
    (api: ReturnType<typeof calendarApi>) => api.del("/polls/abc"),
    (api: ReturnType<typeof calendarApi>) => api.postForm("/bookings/abc/files", new FormData()),
  ]) {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        dropped();
      }) as FetchLike,
      async () => {
        await assert.rejects(send(calendarApi(null)), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, CALENDAR_UNREACHABLE_WRITE);
          return true;
        });
      },
    );
    assert.equal(calls, 1, "a save must never be sent a second time");
  }

  // A server refusal is still the server's own sentence, and is not retried.
  {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: "This interview was cancelled." }), { status: 409 });
      }) as FetchLike,
      async () => {
        await assert.rejects(calendarApi(null).get("/bookings/abc/polls"), /This interview was cancelled\./);
      },
    );
    assert.equal(calls, 1);
  }

  console.log("interview calendar unreachable: ok");
}
