# Master Map — the live sheet

The Master Map is a Google Sheet that keeps itself up to date from Phoenix: eleven tabs, one row
per shop, refreshed every five minutes without anyone touching it.

Sheet: <https://docs.google.com/spreadsheets/d/1za3G8C6HCi74qmq4PwP_T7d-rM16UU1XivqEV7A48Hg>

## The tabs

| Tab | What it is |
| --- | --- |
| **Find a pharmacy** | The one you work in. Four dropdowns — Region, Area, Brick, Channel — that narrow each other, plus a box that searches name, code and address at once. Leave a box empty to include all of it. |
| **Master** | Every region, grouped and banded, one after another. |
| **All customers** | One flat row per shop, frozen header, filterable. Everything else reads from this tab. |
| *(region)* × 9 | The same grouping, one region at a time. |
| **Lists** | Hidden. Holds the dropdown lists and the single live filter that both the count and the results read. Do not edit it. |

The finder shows at most 500 shops at a time and states the true total beside it. Spilling all
50,000 into a tab that recalculates on every dropdown change makes the sheet unusable, and a
silent cap would read as missing data.

## How it works, and why it works this way

The script in [Code.gs](Code.gs) runs **inside the spreadsheet**, as its owner, on a five-minute
timer. It asks Phoenix what changed and paints the answer.

**There is no Google credential anywhere** — not in this repository, not in Railway, not in
Phoenix's environment. That is the point. Google's org policy
(`constraints/iam.disableServiceAccountKeyCreation`, enforced on `omarrr-g-3003-org`) blocks
service-account key creation, and the alternatives meant either weakening that policy or spending
~1,500 GitHub Actions minutes a month against a budget that has frozen merges before. A script
bound to the sheet already has permission to write that sheet, so it needs nothing granted to it.

The only secret is a shared token going the other way — Phoenix → sheet — so that the customer
master is not readable by anyone who guesses the URL.

### The three requests it makes

| Request | Cost | When |
| --- | --- | --- |
| `?probe=1` | five aggregate queries, no rows | every 5 minutes |
| `?plan=1` | loads the crosswalk, returns a content hash per tab | only when the probe moved, or hourly |
| `?tab=…` | one slice of one tab | only for tabs whose hash actually changed |

On an unchanged database a tick costs one `probe` and stops. Nothing is repainted, and the sheet
is not touched at all.

### Two things worth knowing before changing it

**The hourly full check is not belt-and-braces padding.** None of the `source_of_sales_*` tables
has an update trigger — verified against production, `pg_trigger` returns nothing for all five — so
`updated_at` moves only when application code sets it. Hand-applied SQL, which is routine in this
repo, would change a pharmacy without moving the stamp. Additions and removals always move the row
count and so are caught within five minutes; edits are caught by the hourly plan fetch, which
compares real content hashes. Remove that hourly check and hand-edited rows go stale silently.

**A tab is painted clear → text → formatting, in that order.** Apps Script kills an execution at
six minutes and a big repaint spans two of them, so every intermediate state is one the owner can
open the sheet and see. Clearing and formatting before writing the text would leave a perfectly
banded *empty* Master tab for the length of the write, which reads as data loss. This order's worst
visible state is correct text that has not been styled yet.

## Installing it

Once, by hand. Steps 1–4 are in the sheet; step 5 is in Railway.

1. Open the sheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with [Code.gs](Code.gs) from this folder. Then click the gear
   (**Project Settings**) → tick **Show "appsscript.json" manifest file in editor**, open the new
   `appsscript.json` tab, and replace it with [appsscript.json](appsscript.json).

   **Nothing needs enabling under Services.** The script talks to the Sheets REST API directly with
   its own OAuth token rather than through the "advanced Sheets service" — that service is not
   offered in every project's picker (it was missing from this one), and a script that only works
   when a dropdown happens to list an entry breaks silently the next time someone recreates it.
3. Still in **Project Settings**, under **Script Properties**, add two:
   - `PHOENIX_BASE_URL` → `https://phoenix-hr.satopharma.com` (no trailing slash)
   - `PHOENIX_TOKEN` → the same value as `MASTER_MAP_SYNC_TOKEN` in Railway
4. Back in the editor, select the **`setup`** function and click **Run**. Approve the permission
   prompt. It checks the URL and token really work *before* installing the timer, so a typo shows
   up here rather than as a silently dead sheet next week. The log should read
   `Timer installed — the sheet now refreshes itself every 5 minutes.`
5. In Railway, set `MASTER_MAP_SYNC_TOKEN` on the `production` environment to a long random string.
   Generate one with `openssl rand -base64 32`. **Never commit it.** Until it is set, the endpoint
   refuses every request in production rather than serving the customer master unauthenticated.

## Running it by hand

From the Apps Script editor, pick a function and click **Run**:

- **`syncMasterMap`** — do a tick right now instead of waiting for the timer.
- **`forceFullResync`** — forget every stored hash so the next tick repaints all eleven tabs.
  Use this after changing the layout in `sheet-render.ts`, since the text can be identical while
  the formatting is not.
- **`removeTrigger`** — stop the sheet refreshing itself.

**View → Executions** shows every run, its log, and any failure.

## The Phoenix side

| Piece | File |
| --- | --- |
| Change stamp | [`src/lib/sales/master-map/fingerprint.ts`](../../src/lib/sales/master-map/fingerprint.ts) |
| Plan and slices | [`src/lib/sales/master-map/payload.ts`](../../src/lib/sales/master-map/payload.ts) |
| The endpoint | [`app/api/sales/master-map/sheet/route.ts`](../../app/api/sales/master-map/sheet/route.ts) |
| Merge rule and its guards | [`src/lib/sales/master-map/customer-merge.ts`](../../src/lib/sales/master-map/customer-merge.ts) |
| Layout and provenance wording | [`src/lib/sales/master-map/tree.ts`](../../src/lib/sales/master-map/tree.ts) |

There is also a direct push that bypasses the sheet's own script entirely — `pnpm run
master-map:sync`, which writes all eleven tabs from this machine. It needs a Google token in
`MASTER_MAP_GOOGLE_ACCESS_TOKEN` and exists for development and for repainting after a layout
change, not for production.
