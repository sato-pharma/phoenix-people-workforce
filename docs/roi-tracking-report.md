# ROI Tracking — premium pass, 9 November 2026

ROI Tracking is the Filter Engine at `/admin/marketing-requests/roi-tracking` and `/employee-portals/marketing-requests/roi-tracking`. Both shells mount one component. The Regional Sales Manager opens it from My Team's Reports, where the server limits it to the team's areas and the manager's own line (`resolveRegionRouteScope`, `docs/regional-team-reports.md`). The owner asked for the premium pass on 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish big work, every single component".

It is the last page of that pass, after the Weekly Sheet (`docs/weekly-sheet-report.md`). This file explains what the page shows and where each figure comes from. The engine, its attribution and its scope are unchanged. Only how the report is told changed.

## The rules the page keeps

- 🔴 **The team's money is the band's, never re-added from the rows.** Two campaigns can claim one sale, so the band's actual sales are deduplicated on the server through the attribution ledger. Every tile reads `report.kpi`. The panels hold no `.reduce(` of their own.
- 🔴 **Only a request graded "Behind" is short of anything.** A window still open past the loaded month reads "Data pending". It is never short, and it is never one of the requests to look at.
- **Sales are "loaded to" a month, never "attributed up to" it.** `phx_marketing_roi_latest_validated_period()` is a completeness flag, not a cap. The trust note reads "Sales loaded to Aug 2026". A missing month reads "No validated sales loaded yet", never a dash.
- **Names, never codes.** The confidential switch is shown to the CEO and the Super Admin only. It names Lacto Basic 1, Lacto Basic 2 and Satoslim, where it used to print three product codes. A request's status comes from the one shared map (`marketingRequestStatusLabel`), and the engine's own copy of that map is gone.
- **"Show all N requests in scope" sends no filter at all.** The report then covers the server's own role scope, and never anything wider. Before this pass, someone who had not chosen a filter got an empty page and a disabled button.
- **Square corners, and nothing below 11px.** The CSS already zeroed every radius on both shells. The classes are gone too, so the source matches what the screen shows. The 9px and 10px labels are now 11px.

## What the viewer sees

1. **The Filter Engine.** The filters cascade as before. A scope line reads "12 requests in scope", or "4 of 12 requests match" once filters narrow it. The values filled in for the viewer read "Applied for you". The buttons are Apply Filters, Reset, "Show all N requests in scope" (only while nothing is chosen), Download Excel and Copy share link. Saved views follow.
2. **Five tiles:**
   - Cost, with the number of requests.
   - Required return, as a multiple of the cost.
   - Actual sales, with the share of the required return and the forecast.
   - Behind ("2 of 3 measured are behind · 1 on track").
   - Not measured yet, split into waiting for sales data and no sales attributed.
3. **Trust notes:**
   - Where the sales are loaded to.
   - Money in requests not approved yet, counted in no figure.
   - Windows still open past the loaded month.
   - Requests with confidential products left out.
4. **Where the requests stand.** One bar of the four results in a fixed order: On track, Behind, Data pending, No attributed sales. The parts add to exactly 100; the part with the larger remainder takes the leftover point.
5. **Requests to look at.** The requests behind come first, largest shortfall first ("40% of EGP 30,000 · EGP 18,000 short of the required return"). Then come the requests whose window is complete with nothing attributed, and the engine's reason ("Nothing attributed: No pharmacy codes"). Each row links to View Sales.
6. **Every request.** A table on desktop and cards on a phone. Each request is headed by its customer, with the request code, requester and line under it.
   - Before this pass, the money column's header named two of the three figures in it. It now names all three: Required, Forecast, Actual.
   - The table is sorted by shortfall, largest first, so the request that most needs a look leads. A request with no coverage goes last, whichever way the column is sorted.
   - The pages are held inside the pages there are.

## Where the figures come from

- `getMarketingRoiReport` (`roi-report-service.ts`) builds the report: the rows, the band and the ledger. This pass did not change it.
- `src/lib/marketing-requests/roi-tracking-summary.ts` is the only place the words, the shortfall, the bar, the requests to look at, the order and the pages are decided. It is pure: no database, no clock.
- `src/components/marketing-requests/roi-report-panels.tsx` prints the report. `roi-filter-engine.tsx` holds the filters and mounts the panels.

## Tests

`tests/marketing-roi-tracking-premium.test.ts` works six requests by hand. They cover two behind, one on track, one with its window still open, one closed with nothing attributed, and one with its window not yet loaded. The band's actual sales are lower than the rows' sum, as a shared sale makes them. The test checks:
- every word and each request's shortfall;
- the band's captions and the trust notes;
- the bar adding up to 100, and the requests to look at;
- the order, including missing values going last, and the pages;
- in the source: square corners, nothing under 11px, no codes, no raw HR id, no re-added money, and no gendered words.

`tests/marketing-request-service.test.ts` and `tests/marketing-roi-labeling.test.ts` now read the report half from the panels file.
