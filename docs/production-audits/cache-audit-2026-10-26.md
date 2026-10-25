# Cache and caching audit — whole system, 26 Oct 2026

Read-only audit of every cache in Phoenix Workforce. It covers six areas: server data caches, tag
invalidation, in-memory caches, HTTP headers, browser storage, and database cache tables. Build and CI
caches were also checked. The code was read at `origin/main` `10d9fce40`, which is the revision production
was serving at 00:29 Cairo on 26 Oct. Nothing was changed.

## How the caches work here (the facts behind every verdict)

- **Two processes, two separate caches.** Production runs a website and a worker, one copy each.
  `next.config.ts` sets no `cacheHandler`, so the Next data cache, its tag state (a module-level `Map`) and
  every module-level `Map` live inside one process. A `revalidateTag` that runs on the worker never
  reaches the website.
- **`revalidateTag(tag, "max")` is stale-while-revalidate.** The first read after the bust still returns
  the OLD value and refreshes in the background. Only `{ expire: 0 }` (or no profile) makes that read
  wait for fresh data. Proof: `file-system-cache.js` `revalidateTag` sets `stale = now` and
  `expired = now + expire*1000`, and "max" is 365 days. The leave tags already moved to `{expire:0}` after
  the VAC-0686 incident (`src/lib/dashboard/invalidation.ts:103-110`).
- **A later "max" cancels an earlier `{expire:0}` in the same request.** Pending tags are applied in
  insertion order, and "max" rewrites `expired` back to a year away.
- **No shared cache sits in front of the site.** Railway's edge proxy (`railway-hikari`) adds no `age`,
  `via` or `x-cache`, even on immutable assets fetched twice. No CDN can serve one user's page to another.
- **Sign-out reloads the whole page** (`window.location.assign`), so in-memory browser caches never carry
  over between users. Sign-out does NOT clear localStorage or IndexedDB.

## P0 — wrong person's data, on a shared device

1. **An offline trip claim is filed under the next person who signs in.**
   - The key `phoenix-outstation-draft` (`src/lib/outstation/local-draft.ts:39`) holds no employee id.
   - The wizard restores the draft for whoever is signed in (`src/components/outstation/mobile-outstation-wizard.tsx:528`)
     and replays it with the current viewer's `employeeHrId` (`:709`). `/api/outstation/sync-offline` then
     files it for the session owner.
   - Rep A's amounts, arrival photo and GPS become rep B's money claim, and A's claim is lost.
   - The same missing owner check affects five more stores:
     - the vacation offline queue (`vacation-request-form.tsx:120-121`, IndexedDB `phoenix-vacation-offline-queue`)
     - the marketing validation queue (`marketing-validation-workspace.tsx:194-201`; the draft is guarded, the queue is not)
     - the Contact HR draft (`contact-hr-support-page.tsx:43`)
     - the expense-approval decisions draft (`expense-approvals-workspace.tsx:118`): reviewer B's Save submits A's amounts and comments
     - the CRM touch trail (`touch-trail-collector.tsx:48`): A's taps and typing are recorded under B
   - Fix:
     - Stamp `ownerHrId` into each draft and queue entry, and put it in the key.
     - Refuse to restore or replay a mismatch.
     - Also clear these keys in `src/lib/auth/sign-out-client.ts`. The owner check is still needed, because
       a 401 and a closed tab both skip sign-out.

## P1 — wrong or exposed data

2. **The payslip page and opened CV files carry no "do not store" header.**
   - `app/api/payroll/[id]/payslips/route.ts:90-97` sends only `Content-Type`.
   - `src/lib/recruitment/file-response.ts:81-87` sends no cache header on the raw or inline branch, although
     the base64 and doc-text branches at :63 and :70 send `private, no-store`.
   - On a shared PC the page can be reopened from history after sign-out.
   - Fix: send `Cache-Control: private, no-store` on both.
3. **An approved past-month leave signal still shows as unapproved.**
   - `app/api/vacation/company-report/approve/route.ts:140` runs `revalidateTag(…, "max")` after
     `createVacationRequestAsAdmin` has already expired the tag with `{expire:0}` (`invalidation.ts:101`).
   - A second click gets 409 `already_covered`, so no day is deducted twice.
   - Fix: delete line 140.
4. **Failures are cached as "nothing".**
   - `src/lib/vacation/service.ts:459-475` and `:5838`: PostgREST's restart error PGRST002 ("Could not query
     the database for the schema cache") matches `message.includes("schema cache")`, so `[]` is cached for
     60 s. During a database restart, such as the one at 16:14 Cairo on 25 Oct:
     - the Vacation Report and the approval badges show no requests;
     - the portal's leave tile shows the full entitlement as remaining.
     Fix: treat only PGRST205 and 42P01 as a missing table.
   - `src/lib/crm/master.ts:916-918` and `:1739-1741`: a CRM read error returns an empty result, and
     `memoInFlight` caches it for 60 s for every viewer. Fix: throw on error.
   - `src/lib/vacation/company-vacation-report.ts:351-354`: `.catch(() => new Set())` caches "nobody is
     fingerprint-mapped" for 300 s.
     - Days that fingerprints prove were worked then show as vacation signals.
     - The approve route trusts the day count sent by the screen (`approve/route.ts:45`), so an approval in
       that window can create leave for a worked day.
     - Fix: let it throw inside the cache and catch it outside.
   - `company-vacation-report.ts:229-253`: when the Google holiday feed fails, the month is returned
     without the moving holidays, and that result is cached for 6 h.
     - Eid days then count as vacation days in the report and its export.
     - Holiday-calendar edits (`bulkUpsertHolidayOverrides`) never bust this tag.
     - Fix: throw when a month is unreachable, and bust the tag on override saves.
5. **The reps' daily forecast keeps an old CNS closing.**
   - `src/lib/phoenix-crm/server/daily-forecast.ts:194-208` is tagged `sos-reference` with a 600 s TTL.
   - Publish and unpublish (`monthly-closing-publication.ts:421, :481`) and the three target routes
     (`app/api/sales/targets/upload|save|drop`) never bust it.
   - Fix: bust it on publish, unpublish and target saves.

## P2 — your own save does not show on the next screen

6. **"max" busts where the writer looks straight after the write.** Affected:
   - finance landing (`invalidation.ts:119`)
   - org tree, `sos-reference` (`:125`), which every CRM scope decision rests on after a seat move
   - contact-list edits (`src/lib/contact-lists/service.ts:635`)
   - sales dashboards (`:93`, `:143`)

   Fix: use `{expire:0}` for finance, org and contact lists, and keep "max" for the heavy sales rollups.
7. **Writes that bust nothing.**
   - Bulk employee import (`app/api/imports/employees/confirm/route.ts:1410`): it busts the directory
     only, so filled vacancies still show as open on the org tree and finance for up to 300 s.
   - Marketing request decisions (`marketing-requests/service.ts:4417`) and direct-order status writes
     (`direct-orders/service.ts:1698, :1913`): the finance landing keeps "waiting on you" for up to 5 min.
   - Target uploads: see item 5.
8. **The worker's contact-list bust never reaches the website.**
   - `app/api/cron/crm-contact-lists/route.ts:151` runs on the worker only (`refuseOnPageServer`, :85).
   - The live poller and housekeeping rebuilds bust nothing at all.
   - The website heals only on its 300 s TTL, and the comments at `:145-149` and `live-poller.ts:818` claim otherwise.
   - Fix: accept the TTL and correct the comments, or key the website read on a sync stamp.
9. **Parser and directory fallbacks are cached.**
   - `src/lib/sales/employees.ts:242-293`: when the rich directory read fails, a stripped-down list (no
     line, region or area) is cached for 5 min, and `invalidateSalesDirectoryCache` has no caller. Import
     rows in that window can be stamped "Unassigned". This was not traced through to a published figure.
   - `sales/normalizer/distributor-profile-store.ts:73-100` and `sales/weekly/weekly-column-profile-store.ts:140-165`
     cache an empty override map for 30 s after a read error, so uploads parse with the code defaults.
10. **Private files reached by 5-minute signed links are uploaded with a one-year browser cache.**
    - Upload sites set `cacheControl: "31536000"`:
      - `vacation/service.ts:3308, 3342, 3412`
      - `hiring-documents/file-storage.ts:94`
      - car evidence storage
      - marketing evidence
    - This rests on Supabase's documented header behaviour; it was not fetched live, because that needs credentials.
    - Fix: `no-store` or a short value.
11. **The employee photo is cached 24 h under unversioned links.**
    - The route is `app/api/employees/[hrId]/photo/route.ts:93`.
    - Callers with bare links:
      - `employee-management.tsx:1061`
      - `rankings-explorer.tsx:77`
      - `milestones-workspace.tsx:540`
    - Only `employee-photo.ts:116-123` versions the link by `updatedAt`.
12. **Memory growth.**
    - `src/lib/crm/reads.ts:592` holds up to 8 windows of 100,000 rows each. **Corrected while fixing:**
      `shared-read.ts:104` evicts until the rows of ALL entries together fit in `maxRowsTotal`, so it is
      100,000 rows per namespace (visits, check-ins), not 800,000. Already bounded; left as it is.
    - `crm/campaign-account.ts:124` and `crm/campaign-note-assist-model.ts:77` memoise readings by free
      comment text with no cap (25,046 distinct comments).

## P3 — tidy-ups

- About 20 download exports send no cache header. They are downloads anyway; one shared `private, no-store`
  in the download helper fixes all of them.
- Brand files under `public/` are cached 1 day plus 7 days stale, under unversioned links
  (`next.config.ts:634`). The comment at `:624-633` still describes Cloud CDN, and GCP is dead.
- Dispute and WhatsApp media keep a 300 s private cache. The share card's `s-maxage=3600` is unused
  because no shared cache exists.
- CRM photos are re-signed on every list load (`phoenix-crm/server/photos.ts:211`), so every photo is
  downloaded again each time. This costs time and bandwidth; it leaks nothing.
- Price edits can take up to 1 h to reach the unpublished month's store-split screen
  (`closing-store-split-net.ts:173`) and the achievement figures (`vs-target.ts:513`), because their keys
  miss the factory price and the price history. Published months are safe: the publish gate recomputes
  without the cache.
- Degraded results are cached:
  - the retention-risk board, 2 h, under a tag nothing busts (`retention-risk/service.ts:299, :348`)
  - Business Review "no data" sources, 300 s (`business-review/service.ts:153`)
  - admin data-health and role-coverage probes, 120 s and 300 s
  - brick centroids with unchecked errors (`crm/brick-geo.ts:147-156`)
  - partial product-manager lists (`phoenix-crm/server/visit-asks.ts:152-158`)
  - employee photo and CV indexes after an error
- The payroll statutory config caches the default after a read error (`payroll/statutory/config.ts:43-88`).
  That is harmless while the default equals the 2026 row, and becomes a money issue once a period's row
  differs.
- Cached CRM rows are written in place (`crm/master.ts:1062-1069, :1100-1113`).
- Misplaced or dead busts:
  - `revalidatePath("/overview")` (`invalidation.ts:89`) is dead.
  - A bust sits inside the pure `buildBatchReconciliation` (`sales/service.ts:280`).
  - A Telegram switch-off reaches the worker up to 30 s late (`telegram-governance.ts:158`).
- Browser storage:
  - Theme and action-center reads throw when site data is blocked (`theme-provider.tsx:30`, `action-center-hub.tsx:55`).
  - Plan drafts accumulate with no time limit (`plans-workspace.tsx:1612-1626`).
  - `markSessionActivity` is unguarded inside the login try (`client-session.ts:47-58`).
  - The outstation wizard's storage calls are unguarded (`mobile-outstation-wizard.tsx:501-625`).
- About 40 leftover backup schemas in production hold rollup copies, for example `sos_backup_20261012` (52 MB + 40 MB).

## Checked and healthy

- **Database cache tables.**
  - All four CRM cache tables showed 0 differences against their `_calc()` on their last runs:
    contact truth and person-by-HR-key at 00:15, entry days at 00:25, CRM ids at 00:07 Cairo, 26 Oct.
  - The four jobs ran 1,466 times between Thursday 23 Oct and 00:25 on 26 Oct with no failures.
- **The attribution rollup.**
  - Every unpublished month was refreshed at 20:05 or 20:20 Cairo on 25 Oct.
  - July, August and September are frozen because they are published. That is by design
    (`au.f_refresh_monthly_attribution` refuses a published period).
- **No cross-user leak in any server cache.** Every viewer-dependent cache either carries the viewer in its
  key or filters after the read.
- **Published closing figures cannot be frozen from a stale cache.**
- **Build and CI caches.**
  - The pnpm store and the Playwright and ESLint caches are keyed correctly; ESLint is keyed on the exact
    Node runtime and the content strategy.
  - The `.next` cache was removed after it was measured to save nothing.
  - `turbopackFileSystemCacheForBuild: false` is measured and correct.
- **React `cache()` wrappers, the session bundle, the permission matrix and the shared-read reference lists.**
  All are correct.
- **The only service worker is OneSignal's**, and it has no fetch handler.
