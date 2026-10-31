import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The Direct Orders and Marketing Request Google Sheets fetch their Phoenix feed on a 1-minute
// trigger, and Phoenix ALSO pushes to each sheet's doPost the moment an order or request changes.
// Measured on the night of 30–31 October 2026, the two timers were about 2,100 of the ~9,000
// requests an hour Phoenix sent its database between 23:00 and 08:00 Cairo — sixty full feed reads
// an hour each, for a sheet nobody was reading, whose changes were already arriving by push.
//
// So overnight a TIMER tick now fetches only when an hour has passed since the last fetch. This
// suite drives the real .gs files through a fake clock and holds both halves of that:
//
//   - the saving: a night of timer ticks fetches about once an hour, never sixty times;
//   - what must NOT be paced: the daytime timer, a push, a token rotation, the "Refresh now" menu
//     and installTrigger all fetch at once, at any hour. The rotation matters most — Phoenix only
//     revokes the old token after it sees the sheet READ with the new one, so a paced rotation
//     would leave the old token live.
//
// The CV Lifecycle sheet is not in here: it runs every five minutes, and it was not a night load.
const SHEETS = [
  { file: "../docs/direct-orders-live-sheet.gs", refresh: "refreshDirectOrders" },
  { file: "../docs/marketing-request-live-sheet.gs", refresh: "refreshMarketingRequests" },
] as const;

const LAST_FETCH_KEY = "phoenixLastFeedFetchMs";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SECRET = "test-webhook-secret-not-a-real-one";
// What a time-driven trigger hands its function. doPost, the menu and the editor hand it nothing.
const TIMER_EVENT = { triggerUid: "4242", minute: 0, hour: 0 };

// December, so Cairo is UTC+2 on every tz database old or new — Egypt's summer time does not apply.
const CAIRO_MIDNIGHT_UTC = Date.parse("2026-12-01T22:00:00Z"); // 2 December 00:00 Cairo
/** 2 December 2026 at that Cairo time. */
const atCairo = (hour: number, minute = 0) => CAIRO_MIDNIGHT_UTC + hour * HOUR + minute * MINUTE;

const CAIRO_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "numeric", hourCycle: "h23" });

function loadSheet(file: string) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const clock = { ms: atCairo(3) };
  const props: Record<string, string> = { FEED_TOKEN: "test-feed-token-not-a-real-one", WEBHOOK_SECRET: SECRET };
  const fetched: string[] = [];
  const triggers: { name: string; minutes: number }[] = [];

  class FakeDate extends Date {
    constructor(value?: number | string) {
      if (value === undefined) super(clock.ms);
      else super(value);
    }
    static now() {
      return clock.ms;
    }
  }

  const scriptProperties = {
    getProperty: (key: string) => (key in props ? props[key] : null),
    setProperty: (key: string, value: string) => {
      props[key] = value;
    },
    deleteProperty: (key: string) => {
      delete props[key];
    },
  };

  const sandbox: Record<string, unknown> = {
    console: { error: () => {}, log: () => {} },
    Date: FakeDate,
    PropertiesService: { getScriptProperties: () => scriptProperties, getDocumentProperties: () => scriptProperties },
    // No spreadsheet: the failure banner returns early, so a fetch costs only the fetch.
    SpreadsheetApp: { getActiveSpreadsheet: () => null },
    Utilities: {
      formatDate: (date: Date, timeZone: string, format: string) => {
        assert.equal(timeZone, "Africa/Cairo", `${file}: the night window must be read in Cairo time`);
        return format === "H" ? CAIRO_HOUR.format(date) : "2026-12-02 03:00:00";
      },
    },
    UrlFetchApp: {
      fetch: (url: string) => {
        fetched.push(url);
        // Offline: the refresh announces it and stops, which is all this suite needs to count.
        throw new Error("offline in the test");
      },
    },
    ContentService: {
      MimeType: { TEXT: "text" },
      createTextOutput: (text: string) => ({ setMimeType: () => text }),
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: (name: string) => ({
        timeBased: () => ({
          everyMinutes: (minutes: number) => ({
            create: () => {
              triggers.push({ name, minutes });
            },
          }),
        }),
      }),
    },
    CacheService: {},
    LockService: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const call = (name: string, ...args: unknown[]) => (sandbox[name] as (...a: unknown[]) => unknown)(...args);
  return { call, clock, fetched, props, triggers };
}

export async function runLiveSheetNightPacingTests() {
  for (const sheet of SHEETS) {
    const where = `${sheet.file}`;

    // 1. A night of timer ticks: 23:00 to 08:00 Cairo is 540 ticks. Sixty an hour was the load.
    {
      const s = loadSheet(sheet.file);
      s.clock.ms = atCairo(23);
      for (let tick = 0; tick < 9 * 60; tick += 1) {
        s.call(sheet.refresh, TIMER_EVENT);
        s.clock.ms += MINUTE;
      }
      assert.ok(
        s.fetched.length >= 8 && s.fetched.length <= 10,
        `${where}: a night of 540 timer ticks must fetch about once an hour (9), fetched ${s.fetched.length}`,
      );
    }

    // 2. The daytime timer is untouched: an hour of ticks is sixty fetches.
    {
      const s = loadSheet(sheet.file);
      s.clock.ms = atCairo(10);
      for (let tick = 0; tick < 60; tick += 1) {
        s.call(sheet.refresh, TIMER_EVENT);
        s.clock.ms += MINUTE;
      }
      assert.equal(s.fetched.length, 60, `${where}: the daytime timer must still fetch every minute`);
    }

    // 3. The window's edges, each with a fetch 30 seconds ago: 22:59 and 08:00 are day, 23:00 and
    //    07:59 are night.
    for (const [hour, minute, paced] of [
      [22, 59, false],
      [23, 0, true],
      [3, 0, true],
      [7, 59, true],
      [8, 0, false],
    ] as const) {
      const s = loadSheet(sheet.file);
      s.clock.ms = atCairo(hour, minute);
      s.props[LAST_FETCH_KEY] = String(s.clock.ms - 30 * 1000);
      s.call(sheet.refresh, TIMER_EVENT);
      const label = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      assert.equal(
        s.fetched.length,
        paced ? 0 : 1,
        `${where}: a timer tick at ${label} Cairo must ${paced ? "wait for the hour" : "fetch"}`,
      );
    }

    // 4. Overnight, the hour is what decides — and doubt fetches.
    {
      const s = loadSheet(sheet.file);
      s.clock.ms = atCairo(3);
      s.props[LAST_FETCH_KEY] = String(s.clock.ms - 59 * MINUTE);
      s.call(sheet.refresh, TIMER_EVENT);
      assert.equal(s.fetched.length, 0, `${where}: 59 minutes after a fetch, a night tick must wait`);
      assert.equal(
        s.props[LAST_FETCH_KEY],
        String(s.clock.ms - 59 * MINUTE),
        `${where}: a tick that waited must not move the stamp, or the hour never arrives`,
      );
      assert.equal(s.props.phoenixFeedState, undefined, `${where}: a paced tick is not a failure and must paint no banner`);
      s.props[LAST_FETCH_KEY] = String(s.clock.ms - 61 * MINUTE);
      s.call(sheet.refresh, TIMER_EVENT);
      assert.equal(s.fetched.length, 1, `${where}: 61 minutes after a fetch, a night tick must fetch`);
      assert.equal(s.props[LAST_FETCH_KEY], String(s.clock.ms), `${where}: a fetch must stamp the time it ran`);
    }
    for (const stamp of [undefined, "", "not-a-number"]) {
      const s = loadSheet(sheet.file);
      s.clock.ms = atCairo(3);
      if (stamp !== undefined) s.props[LAST_FETCH_KEY] = stamp;
      s.call(sheet.refresh, TIMER_EVENT);
      assert.equal(s.fetched.length, 1, `${where}: a night tick with no readable stamp (${String(stamp)}) must fetch`);
    }

    // 5. Nothing but a timer tick is paced. Each runs at 03:00 with a fetch 30 seconds ago.
    const justFetched = () => {
      const s = loadSheet(sheet.file);
      s.clock.ms = atCairo(3);
      s.props[LAST_FETCH_KEY] = String(s.clock.ms - 30 * 1000);
      return s;
    };
    {
      // The "Refresh now" menu and a run from the editor call it with no arguments.
      const s = justFetched();
      s.call(sheet.refresh);
      assert.equal(s.fetched.length, 1, `${where}: Refresh now must fetch at night`);
    }
    {
      // An event that is not a time-driven trigger's carries no triggerUid.
      const s = justFetched();
      s.call(sheet.refresh, {});
      assert.equal(s.fetched.length, 1, `${where}: only an event with a triggerUid may be paced`);
    }
    {
      const s = justFetched();
      const answer = s.call("doPost", { postData: { contents: JSON.stringify({ secret: SECRET }) } });
      assert.equal(answer, "ok", `${where}: the push must be accepted`);
      assert.equal(s.fetched.length, 1, `${where}: a push must fetch at night — it is how a change reaches the sheet`);
      assert.equal(s.props[LAST_FETCH_KEY], String(s.clock.ms), `${where}: a push's fetch counts as that hour's look`);
    }
    {
      const s = justFetched();
      const token = "rotatedTokenForTheTest_0123456789";
      const answer = s.call("doPost", {
        postData: { contents: JSON.stringify({ secret: SECRET, rotateToken: token }) },
      });
      assert.equal(answer, "rotated", `${where}: the rotation must be accepted`);
      assert.equal(s.fetched.length, 1, `${where}: a rotation must read at once — Phoenix revokes the old token only after that read`);
      assert.ok(s.fetched[0].includes(token), `${where}: the rotation's read must use the NEW token`);
    }
    {
      const s = justFetched();
      s.call("installTrigger");
      assert.deepEqual(
        s.triggers,
        [{ name: sheet.refresh, minutes: 1 }],
        `${where}: the trigger must stay a 1-minute trigger on ${sheet.refresh} — the pacing lives in the function, so no sheet needs its trigger re-installed`,
      );
      assert.equal(s.fetched.length, 1, `${where}: installTrigger must fetch at once`);
    }
  }
}
