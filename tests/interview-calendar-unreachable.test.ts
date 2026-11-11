import assert from "node:assert/strict";

// 11 Nov 2026: Youmna's drawer for Merna Sobhy Abdelatty showed the browser's own "Failed to fetch
// (phoenix-hr.satopharma.com)" under the Zoom invitation and the polls. The server was up and answered
// every request it received — her laptop was off the internet for about two minutes, and the panels
// never asked again. These drive the calendar's request client with a stand-in fetch: a read keeps
// trying (and tries at once when the browser says it is back online) so the data appears by itself; a
// save is never repeated (it may already have arrived); neither ever shows the browser's jargon.

import {
  CALENDAR_READ_RETRY_DELAYS_MS,
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

const QUICK = [5, 5, 5, 5];

export async function runInterviewCalendarUnreachableTests(): Promise<void> {
  // The real schedule covers a drop of about two minutes, the length of the one on 11 Nov.
  const total = CALENDAR_READ_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total >= 110_000 && total <= 180_000, `reads must keep trying for about two minutes, not ${total} ms`);

  // A read that drops a few times and then arrives shows the answer — the person never sees the drop.
  {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        if (calls <= 3) dropped();
        return new Response(JSON.stringify({ polls: [] }), { status: 200 });
      }) as FetchLike,
      async () => {
        const data = await calendarApi(null, { readRetryDelaysMs: QUICK }).get("/bookings/abc/polls");
        assert.deepEqual(data, { polls: [] });
      },
    );
    assert.equal(calls, 4, "a read must keep trying until the connection is back");
  }

  // The browser saying it is back online ends the pause at once, not at the end of a long wait.
  {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const fakeWindow = new EventTarget();
    (globalThis as { window?: unknown }).window = fakeWindow;
    let calls = 0;
    try {
      await withFetch(
        (async () => {
          calls += 1;
          if (calls === 1) {
            setTimeout(() => fakeWindow.dispatchEvent(new Event("online")), 10);
            dropped();
          }
          return new Response(JSON.stringify({ invitation: { text: "Join" } }), { status: 200 });
        }) as FetchLike,
        async () => {
          const started = Date.now();
          const data = await calendarApi(null, { readRetryDelaysMs: [60_000] }).get("/bookings/abc/invitation");
          assert.deepEqual(data, { invitation: { text: "Join" } });
          assert.ok(Date.now() - started < 5_000, "coming back online must end the wait at once");
        },
      );
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    assert.equal(calls, 2);
  }

  // A read that never gets through says Phoenix could not be reached, in words — never "Failed to fetch".
  {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        dropped();
      }) as FetchLike,
      async () => {
        await assert.rejects(calendarApi(null, { readRetryDelaysMs: QUICK }).get("/bookings/abc/invitation"), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, CALENDAR_UNREACHABLE_READ);
          assert.doesNotMatch(error.message, /failed to fetch/i);
          return true;
        });
      },
    );
    assert.equal(calls, QUICK.length + 1);
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
        await assert.rejects(send(calendarApi(null, { readRetryDelaysMs: QUICK })), (error: unknown) => {
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
        await assert.rejects(calendarApi(null, { readRetryDelaysMs: QUICK }).get("/bookings/abc/polls"), /This interview was cancelled\./);
      },
    );
    assert.equal(calls, 1);
  }

  console.log("interview calendar unreachable: ok");
}
