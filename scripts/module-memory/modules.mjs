// THE MODULE MAP — the single definition every part of module memory reads.
//
// WHAT MODULE MEMORY IS (owner-approved 2026-10-02; account: docs/module-memory.md)
// The auto-loaded rulebook (AGENTS.md + the MEMORY.md index) has a hard ceiling, so every new
// rule pushed an old one out of sight. Module memory moves each module's rules and memory notes
// into `.claude/rules/<id>.md`. Claude Code loads that file BY ITSELF the moment a session reads a
// file matching its `paths:` globs (proven on 2.1.284, 2026-10-02: no file read -> not loaded;
// another module's file -> not loaded; this module's file -> loaded). Work that never reads a file
// (a question, a database query, a shell `cat`) is covered by `.claude/hooks/module-memory-injector.mjs`,
// which matches `keywords` against the prompt and `keywords`/`tables` against tool input.
//
// WHO READS THIS FILE
//   scripts/module-memory/build.mjs   writes each rules file's frontmatter and notes block
//   .claude/hooks/module-memory-injector.mjs   keyword / table / path matching
//   scripts/module-memory/fold.mjs    files new inbox notes under a module
//   tests/module-memory.test.ts       proves the map, the files and the assignments agree
//
// GLOBS are matched against repo-relative paths with forward slashes: `**` crosses folders, `*`
// does not, `{a,b}` is an alternative. Never write a route group's parentheses — `(admin)` is a
// glob GROUP, not a literal; `app/**/payroll/**` reaches app/(admin)/payroll and its siblings.
// Every glob must match at least one tracked file (the test refuses a dead one).
//
// KEYWORDS are matched case-insensitively as whole words against the owner's message and against
// shell commands. Keep them SPECIFIC: a generic word ("area", "target", "report") would load a
// module into every session for nothing.

/** @typedef {{ id: string, title: string, scope: string, globs: string[], keywords: string[], tables: string[] }} MemoryModule */

/** @type {MemoryModule[]} */
export const MODULES = [
  {
    id: "payroll",
    title: "Payroll, salaries and deductions",
    scope: "Salary runs and batches, the automated payroll, payslips, deductions, statutory figures, finance exports.",
    globs: [
      // `dispute-center` and `disputes` belong here: this module holds the Dispute Center's rules
      // (its three outcomes, the refund into Other Additions, the charge basis), and until
      // 2026-10-09 no module's globs matched those folders at all — so a session editing the money
      // path of a dispute loaded no module memory while the rules for it sat in this file.
      "src/lib/{payroll,automated-payroll,deductions,daily-deductions,finance,reconciliation,calculator,dispute-center}/**",
      "src/components/{payroll,automated-payroll,disputes}/**",
      "app/**/{payroll,automated-payroll,m-payroll,payroll-copilot,payroll-management,payslips-center,payslips,daily-deductions,deductions,finance-command-center,disputes}/**",
      "tests/*{payroll,payslip,salary,deduction,statutory,dispute}*",
      "supabase/migrations/*{payroll,salary,payslip,deduction}*",
    ],
    keywords: ["payroll", "salary", "salaries", "payslip", "payslips", "deduction", "deductions", "net pay", "gross pay", "basic salary", "social insurance", "salary batch", "مرتب", "مرتبات", "رواتب"],
    tables: ["salary_records", "salary_batches", "automated_payroll", "payroll_", "payslip", "deduction"],
  },
  // 🔴 SPLIT 2026-10-12, FOR THE REASON `phoenix-crm-approvals` BELOW RECORDS: `payroll` reached 32
  // rules and its injected pointer measured 4,067 bytes against the 4,000-byte margin
  // `tests/module-memory.test.ts` holds, the moment the weekly-plan-is-never-coverage rule landed. The
  // DISPUTE family is the clean cut: the Dispute Center has its own folders, its own three outcomes and
  // its own charge rule, and none of its rules are read while editing a deduction connector. `payroll`
  // KEEPS EVERY GLOB IT HAD, so a dispute file loads the PAIR and nothing that used to arrive stops
  // arriving. The file itself was nowhere near its 72,000-byte cap — two different limits, and this is
  // the small one.
  {
    id: "payroll-disputes",
    title: "Payroll — disputes and the Dispute Center",
    scope: "An employee's dispute of a deduction: where it is decided, what a decision charges, the case briefing, and which disputes each side still sees.",
    globs: [
      "src/lib/dispute-center/**",
      "src/components/disputes/**",
      "app/**/disputes/**",
      "tests/*dispute*",
    ],
    keywords: ["dispute", "dispute center", "disputed deduction", "case briefing", "accept the dispute", "reject the dispute", "refund the deduction", "اعتراض"],
    tables: ["deduction_disputes", "dispute_"],
  },
  // ── The sales area is THREE modules, and the split is deliberately LOPSIDED ──
  //
  // One file held all of it until 2026-10-02, when it reached 87% of MODULE_FILE_MAX_BYTES. The cap
  // is not cosmetic: crossing it fails `build.mjs --check` inside the required `validate` job, so
  // the next closing note would have turned somebody else's PR red in a place nobody would think to
  // look. Sales is also the fastest-growing area in this repo, so one file was always going to lose.
  //
  // 🔴 `sales-closing` KEEPS the broad `src/lib/sales/*` glob on purpose, and the other two ADD to
  // it rather than carve it up. Touch an ingestion or an attribution file and you get the closing
  // rules TOO — because the closing golden rules (the published month is the only sales truth, never
  // correct an announced month, the Office and El Qema splits) govern what those files are allowed
  // to produce. The narrow modules only mean the reverse is no longer true: editing the closing
  // engine no longer drags in every upload-parser and brick-mapping note. Splitting the broad glob
  // between them would be the obvious-looking tidy-up and would silently drop a money rule from the
  // sessions that most need it.
  {
    id: "sales-closing",
    title: "Monthly Closing, the Office and El Qema money rules, the Business Review",
    scope: "The monthly closing engine and its exports, publication and locks, corrections, the store split, the Office allocation and El Qema/city rules, product prices, the Business Review. Source of Sales ingestion is `sales-imports`; attribution, targets and bricks are `sales-attribution`.",
    globs: [
      "src/lib/sales/*",
      "src/lib/sales/make-it-happen/**",
      "src/lib/business-review/**",
      "src/components/{sales,business-review}/**",
      "app/**/{sales,monthly-closing,sales-vs-target,dsms-performance,med-reps-performance,team-performance,make-it-happen,business-review}/**",
      "tests/*{closing,qema,office-golden,city-split,business-review,rankings}*",
      "supabase/migrations/*{closing,store_split}*",
    ],
    keywords: ["monthly closing", "closing", "el qema", "qema", "office rule", "city rule", "business review", "factory price", "تقفيل", "مبيعات"],
    tables: ["phx_closing", "phx_monthly", "monthly_closing"],
  },
  // 🔴 SPLIT, 2026-10-12, BY THE SAME HOOK-SHORTENING PASS AS `phoenix-crm-visits` ABOVE: splitting the two
  // longest sales-closing bullets at their clause boundaries took the module from 31 rules at 3,699 bytes to
  // 36 at 4,114, over the 4,000 pointer margin. The surfaces a closing is READ from are one family — the
  // premium workbook and the frozen old export, the Closing Matrix (No Office) tab, the Rankings tab and the
  // Performance Review pack — and NONE of them decides a number, which is why they are the safe half to move:
  // every money and golden rule stays in `sales-closing`, which keeps every glob it had, so an export file
  // loads the pair. Account: `docs/module-memory.md`, "Limits".
  {
    id: "sales-closing-exports",
    title: "Monthly Closing — the exports, the premium workbook and the Performance Review pack",
    scope: "The surfaces a closing is READ from rather than computed in: the premium executive workbook and the frozen old export, the Closing Matrix (No Office) tab, the Rankings tab, and the Performance Review pack — its series, its per-rep units-by-month block, its shared pipeline with the consolidated closing, and the total it is allowed to call national.",
    globs: [
      "src/lib/sales/{closing-consolidated-premium-export,closing-export-filename,closing-export-payload,closing-matrix-without-office,closing-performance-review,closing-performance-review-access,closing-performance-review-export,closing-performance-review-portal,closing-performance-review-regions,closing-performance-review-scope,closing-ranking-dress,closing-rep-ranking,closing-rep-ranking-export,closing-rep-ranking-filter,closing-rep-ranking-legacy-shape,closing-rep-ranking-line,closing-rep-ranking-workbook,closing-review-sheets,closing-workbook-lock,monthly-closing-consolidated-export,monthly-closing-export,rankings,rankings-page,sales-workbook-kit}.ts",
      "src/components/sales/{closing-matrix-table,closing-performance-review-workspace}.tsx",
      "src/components/sales/rankings/**",
      "tests/closing-{consolidated-export,engine-export,export-filename,export-matches-screen,export-organogram-region-labels,filtered-export-keeps-direct,matrix-no-office,performance-review,performance-review-export-gate,performance-review-series-reuse,total-sheet-matches-matrix,workbook-lock}*",
      "tests/closing-rep-ranking*",
      "tests/monthly-closing-export-*",
    ],
    keywords: ["closing export", "premium closing", "performance review", "rankings tab", "no office matrix", "consolidated closing", "national total", "filtered total", "workbook"],
    tables: [],
  },
  // 🔴 SPLIT 2026-10-15, FOR THE SAME REASON AND BY THE SAME TEST AS `sales-closing-exports` ABOVE:
  // the Kafr El-Sheikh 2 rule took `sales-closing` from 35 rules to 36 and its pointer from 3,960 to
  // 4,149, over the 4,000 margin. 🔴 THE MODULE WAS ALREADY AT THE MARGIN WITH 35 — 40 bytes under —
  // so no new rule of any length would have fitted, and shortening the incoming one could not have
  // helped: at 95 bytes of headline instead of 184 the pointer still read 4,060. That is what makes
  // this a split and not a trim.
  //
  // The half moved is the one that decides NO number: the Monthly Closing's screens and deep links,
  // and the detectors that REPORT on a closing without ever repairing one. Every money and golden
  // rule stays in `sales-closing`, which keeps every glob it had, so touching a screen or a drift
  // script loads the pair and a session cannot reach a detector without the rules it detects
  // against. Splitting the broad glob instead would silently drop a money rule from the sessions
  // that most need it — see the note above `sales-closing`. Account: `docs/module-memory.md`,
  // "Limits".
  {
    id: "sales-closing-screens",
    title: "Monthly Closing — the screens, the deep links and the drift detectors",
    scope: "The surfaces a closing is READ on and the checks that report on it, none of which decides a number: the matrix screen's head, filter and Details tab, the publish email's one link and the stale-deep-link notice, the publication-drift and Office-allocation-drift detectors, the month-completeness gate and the coverage banner, and the SoS dashboard cache. What a number IS stays in `sales-closing`.",
    globs: [
      "src/lib/sales/{closing-deep-link,closing-details-span,closing-filter-narrowing,closing-load-gate,closing-publication-drift,closing-publish-destination,office-allocation-drift,source-coverage,source-quiet-periods,sos-month-complete,sos-dashboard,portal-sos-dashboard}.ts",
      "src/components/sales/{closing-details-panel,closing-details-standalone,closing-matrix-table,monthly-closing-workspace}.tsx",
      "scripts/check-{closing-publication-drift,office-allocation-drift,sos-month-complete}.ts",
      "tests/closing-{deep-link-silent-substitution,details-span-notice,load-gate,matrix-head-never-ellipsises,office-respread,publication-drift,publish-email-destination,refresh-keeps-the-filter}*",
      "tests/{needs-you-board,sos-dashboard-packed-cache,sos-month-complete,source-coverage}*",
    ],
    keywords: ["closing screen", "closing matrix head", "closing details tab", "publication drift", "office allocation drift", "month completeness", "coverage banner", "deep link", "publish email link"],
    tables: [],
  },
  {
    id: "sales-imports",
    title: "Source of Sales — distributor imports, customer mapping and rollups",
    scope: "Getting sales INTO the system: the distributor uploads and their parsers, the normalizer, master data and the master map, customer/brick mapping and its guards, batch supersede, rollups, source coverage and the import diagnostics. What the closing then does with it is `sales-closing`.",
    globs: [
      "src/lib/sales/{normalizer,master-data,master-map,ai}/**",
      "src/lib/sales/{import,upload,source-of-sales,distributor,customer,mapping,sos}-*",
      "src/lib/sales/{sales-upload,sales-import-upload-path,monthly-distributor-import,monthly-import-request,parser,recognize,raw-template,bulk-import-gating,source-coverage,source-audit-workbook,master-workbook,offline-lookup-workbook,upload-validation}.ts",
      "app/**/{source-of-sales,master-data,customers-database}/**",
      "tests/*{source-of-sales,sos-,distributor,import,mapping}*",
      "supabase/migrations/*{source_of_sales,sos_,distributor}*",
    ],
    keywords: ["source of sales", "sos", "distributor", "distributors", "sales import", "sales upload", "master map", "customer map", "normalizer"],
    tables: ["source_of_sales", "sos_", "distributor"],
  },
  {
    id: "sales-attribution",
    title: "Attribution, achievement, targets and sales territory",
    scope: "Who a sale is credited to and what it is measured against: the `au` attribution engine and its period-aware as-of resolution, achievement, monthly/rep targets, Sales vs Target, seat and area scope, bricks and the dated area moves.",
    globs: [
      "src/lib/sales/territory/**",
      "src/lib/sales/{attribution,brick,vs-target,rep,portal,targets}-*",
      "src/lib/sales/{monthly-attribution,monthly-targets,employee-achievement,seat-area-scope,medical-rep-area-scope,closing-area-merges,channels-by-rep,sfe-performance,vs-target,seat-tenure-credit}.ts",
      "app/**/{targets,territory-drilldown,brick-coverage}/**",
      "tests/*{attribution,achievement,brick,upper-egypt,kafr-el-sheikh,delta,seat-tenure}*",
      "supabase/migrations/*{attribution,achievement,brick,monthly_targets}*",
    ],
    keywords: ["attribution", "achievement", "sales vs target", "monthly target", "monthly targets", "brick", "bricks", "line area map"],
    tables: ["au.", "line_area_map", "monthly_targets", "monthly_achievement"],
  },
  {
    id: "weekly-sales",
    title: "Weekly sales and stock",
    scope: "Weekly depot sales and stock uploads, the weekly BI and NSM/DSM exports, weekly mapping.",
    globs: [
      "src/lib/sales/weekly/**",
      "app/**/{weekly-sales,weekly-stock}/**",
      "tests/*weekly*",
      "supabase/migrations/*weekly*",
    ],
    keywords: ["weekly sales", "weekly stock", "weekly export", "weekly report", "nsm/dsm", "weekly bi"],
    tables: ["weekly_sales", "weekly_stock", "weekly_"],
  },
  {
    id: "direct-orders",
    title: "Direct orders",
    scope: "Direct orders from pharmacies, their pricing, the Finance booking month, the direct-order desk.",
    globs: [
      "src/lib/direct-orders/**",
      "src/components/direct-orders/**",
      "app/**/{direct-orders,direct-orders-in-my-area}/**",
      "tests/*direct-order*",
      "supabase/migrations/*direct_order*",
    ],
    keywords: ["direct order", "direct orders", "direct-order"],
    tables: ["direct_order"],
  },
  {
    id: "incentives",
    title: "Incentives and targets payout",
    scope: "The 2026 incentive scheme, achievement-to-payout, semester targets, the portal Incentive tab.",
    globs: [
      "src/lib/incentives/**",
      "app/**/incentive/**",
      "tests/*incentive*",
    ],
    keywords: ["incentive", "incentives", "payout curve", "semester target"],
    tables: ["incentive"],
  },
  {
    id: "production-planning",
    title: "Production Planner (toll manufacturing — Ivyronc and Guamusin)",
    scope: "Run geometry and the buy list for two toll-manufactured products — a syrup measured in millilitres and a powder in 5 g sachets, twelve to a box — with stock per lot across three locations, the cost layer and its dollar rate, the consumption learner, and the two alarms: reorder and expiry.",
    globs: [
      "src/lib/production-planning/**",
      "src/components/production-planning/**",
      "app/**/production-planning/**",
      "app/api/cron/production-planning-*/**",
      "tests/production-planning-*",
      "supabase/migrations/*production_planning*",
    ],
    keywords: ["ivyronc", "guamusin", "sachet", "production planner", "production planning", "toll manufacturing", "egpi", "dbk", "raw material", "raw materials", "reorder alarm", "expiry alarm", "overage", "تشغيلة", "خامات", "جواموسين", "كيس"],
    tables: ["prodplan_"],
  },
  {
    id: "phoenix-crm",
    title: "Phoenix CRM (the reps' own CRM)",
    scope: "The rep's visit app on the web, plans and weeks, places and customers, list admission, approvals, location integrity, the CRM admin.",
    globs: [
      "src/lib/phoenix-crm/**",
      "src/components/phoenix-crm/**",
      "app/**/phoenix-crm/**",
      "tests/*phoenix-crm*",
      "supabase/migrations/*phoenix_crm*",
    ],
    keywords: ["phoenix crm", "phoenix-crm", "phoenix_crm", "visit app", "rep's app", "list admission", "location integrity", "mock location"],
    tables: ["phoenix_crm"],
  },
  // 🔴 `phoenix-crm` KEEPS EVERY GLOB IT HAD, and `phoenix-crm-approvals` ADDS its own narrower ones,
  // so an approvals file loads the PAIR and nothing that used to arrive stops arriving. The split is
  // for the POINTER, not the file: phoenix-crm had 38 rules and its injected pointer measured 4,478
  // of the 4,500 bytes `tests/module-memory.test.ts` allows, so the NEXT CRM rule would have reddened
  // the required `validate` job (measured 2026-10-03: a real 39th rule took it to 4,518). The file
  // itself was only at 70% of its 72,000-byte cap — two different limits, and this was the small one.
  {
    id: "phoenix-crm-approvals",
    title: "Phoenix CRM — lists, validation, plans and approvals",
    scope: "Who may admit a customer to a rep's list and who validates it, grades, drop/add/bring-back, the weekly plan and its review, off-plan and pharmacy calls, and the decision queues that count what is waiting.",
    globs: [
      "src/lib/phoenix-crm/{adoption-rules,approval-nudge-rules,customer-list-grouping,entry-rules,list-request-rules,list-row-facts,list-sheet-hours,list-template-rules,monthly-plan-rules,offplan-day,pharmacy-call-rules,plan-board-answer,plan-edit-rules,plan-review-rules,plan-rules,unplanned-rules,validate-next}.ts",
      "src/lib/phoenix-crm/server/{adoption,approval-nudge,awaiting-decisions,decision-queues,refused-readings}.ts",
      "app/api/phoenix-crm/list/**",
      "app/**/phoenix-crm/list-template/**",
      "tests/phoenix-crm-{adoption,approval-notices,approval-nudge,customer-list-board,list-admission,list-curation,list-edges,list-row-facts,list-sheet-hours,list-template,manager-validates,refused-readings}*",
    ],
    keywords: ["list admission", "off-plan", "off plan", "bring back", "bring-back", "plan review", "decision queue", "awaiting decision", "validated at the door", "refused reading", "rough location", "drop from the list", "move the customer", "another rep", "curate"],
    tables: ["phoenix_crm_refused_readings", "phoenix_crm_customer_moves"],
  },
  // 🔴 SPLIT, 2026-10-20, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `phoenix-crm-approvals`
  // measured a 4,047-byte pointer against the 4,000 margin `tests/module-memory.test.ts` holds, the moment
  // the two-asks-a-week cap on editing a sent week taught its rule. The rep's weekly plan — the one week he
  // plans, its send, its review, the plan status words and asking to edit a sent week — is one family, so its
  // rules move together. `phoenix-crm-approvals` KEEPS EVERY GLOB IT HAD, so a plan file loads the PAIR and
  // nothing that used to arrive stops arriving.
  {
    id: "phoenix-crm-week-plan",
    title: "Phoenix CRM — the rep's weekly plan, its review and asking to edit it",
    scope: "The one week a rep plans and sends, the caps re-checked on the send, its review by the district manager, the words that say whose turn it is, the board that chases a sent week, and asking to edit a sent week — the district manager, then SFE, twice a week at most.",
    globs: [
      "src/lib/phoenix-crm/{monthly-plan-rules,plan-board-answer,plan-edit-rules,plan-review-rules,plan-rules,approval-nudge-rules}.ts",
      "src/lib/phoenix-crm/server/{plans,monthly-plans,plan-edits,plan-edit-expiry,plan-review,plan-day-status,approval-nudge,awaiting-decisions,decision-queues}.ts",
      "src/components/phoenix-crm/plan-*.tsx",
      "app/api/phoenix-crm/plans/{copy-source,decide,edit-requests,history,reviews,submit}/**",
      "tests/phoenix-crm-plan-*",
    ],
    keywords: ["weekly plan", "ask to edit", "edit request", "plan edit", "send this week", "sent week", "plan status", "week to review"],
    tables: ["phoenix_crm_plan"],
  },
  // 🔴 SPLIT AGAIN, 2026-10-04, FOR THE SAME REASON AS THE ONE ABOVE: `phoenix-crm` reached 33 rules and its
  // injected pointer measured 4,019 bytes against the 4,000 margin `tests/module-memory.test.ts` holds, the
  // moment the SFE's refused-readings board added its rule. The silent detectors (location, behaviour and
  // photo integrity), the touch trail and the two SFE boards that read them are ONE family of rules — the
  // evidence a rep is never shown and who may read it — so they move together. `phoenix-crm` still keeps every
  // glob it had, so a file in this family loads the PAIR and nothing that used to arrive stops arriving.
  {
    id: "phoenix-crm-boards",
    title: "Phoenix CRM — the silent detectors, the touch trail and the SFE's boards",
    scope: "Location, behaviour and photo integrity, mock-location detection, the touch trail, refused readings and duplicate customers — the evidence a rep is never shown, and the admin boards that read it and who may open each.",
    globs: [
      "src/lib/phoenix-crm/{behaviour-integrity,duplicate-photos,location-integrity,refused-readings-rules,touch-trail,touch-trail-reader}.ts",
      "src/lib/phoenix-crm/server/{behaviour,blind-payloads,duplicate-customers,integrity-board,location-integrity,photo-dupes,refused-readings-board,silent-detectors,touch-trail,touch-trail-reader}.ts",
      "src/components/phoenix-crm/touch-trail-{board,collector}.tsx",
      // The location-integrity board's own pure modules and its view (2026-10-13). They sit under
      // `crm-integrity/`, which the `crm` module owns as a BROAD glob — so these narrow globs load
      // this file IN ADDITION to that one, which is the intended way round: the rules a session needs
      // when it touches the board are the detector rules, not the iReports360 analytics ones.
      "src/lib/crm-integrity/integrity-{board-filters,board-rows,case-map,case-story,settle-presets}.ts",
      "src/components/crm-integrity/integrity-{board-view,settle}.tsx",
      "app/**/phoenix-crm/{integrity,duplicates,refused-readings}/**",
      "app/**/field-crm/touch-trail/**",
      "app/api/phoenix-crm/touch-trail/**",
      "app/api/cron/phoenix-crm-integrity-sweep/**",
      "tests/phoenix-crm-{behaviour-integrity,blind,duplicate,location-integrity,refused-readings-board,touch-trail}*",
      "tests/crm-integrity-*",
      // The Visit report generator (2026-10-15) reads the integrity evidence and shares its audience, so its
      // files load this module's rules too.
      "src/lib/phoenix-crm/{visit-report-*,server/visit-report*}.ts",
      "src/components/phoenix-crm/visit-report/**",
      "app/**/phoenix-crm/visit-report/**",
      "app/employee-portals/visit-report/**",
      "tests/phoenix-crm-visit-report*",
    ],
    keywords: ["visit report", "integrity board", "behaviour integrity", "photo sweep", "duplicate customers", "touch trail", "refused readings", "mock-location", "mock location detection"],
    tables: ["phoenix_crm_location_integrity", "phoenix_crm_behaviour_integrity", "phoenix_crm_photo_fingerprints", "phoenix_crm_touch_trail"],
  },
  // 🔴 SPLIT 2026-10-20, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `phoenix-crm-boards`'s
  // injected pointer measured 4,098 bytes against the 4,000-byte margin the moment the Visit Report's
  // manager choice landed (owner, 2026-10-20: "when you filter by manager you find no manager"). The
  // Visit Report generator is the clean cut: its audience, its fields by reader tier, its manager and
  // district kinds and its own-visit rows are read while editing the generator, never while editing a
  // silent detector. `phoenix-crm-boards` KEEPS EVERY GLOB IT HAD, so a visit-report file loads the PAIR.
  {
    id: "phoenix-crm-visit-report",
    title: "Phoenix CRM — the Visit Report generator",
    scope: "The Visit Report: who may run it and for whom (a rep, a district or a manager), the fields each reader tier may see, the participants filter, and a manager's own visits listed but counted nowhere.",
    globs: [
      "src/lib/phoenix-crm/{visit-report-*,server/visit-report*}.ts",
      "src/components/phoenix-crm/visit-report/**",
      "app/**/phoenix-crm/visit-report/**",
      "app/employee-portals/visit-report/**",
      "tests/phoenix-crm-visit-report*",
    ],
    keywords: ["visit report", "who visited", "visit report generator", "manager's own visit"],
    tables: [],
  },
  // 🔴 SPLIT AGAIN, 2026-10-13, ONE BYTE OVER: `phoenix-crm-boards` reached 33 rules and its injected
  // pointer measured 4,001 bytes against the 4,000-byte margin, the moment a browser-blocked
  // permission added its two rules. The refusals a capture leaves behind are one family — the table,
  // its four reasons, the SFE's board that reads them and the browser's own report of a blocked
  // permission — so they move together. `phoenix-crm-boards` and `phoenix-crm-approvals` keep every
  // glob they had, so a file here loads this file IN ADDITION to theirs and nothing stops arriving.
  {
    id: "phoenix-crm-refused-readings",
    title: "Phoenix CRM — the refusals a capture leaves behind",
    scope: "Every capture Phoenix CRM did not keep: the three server refusals (no fix, too rough, off its Google listing), the browser's own report that it blocked location or the camera, and the one board the SFE and the Super Admin read them on.",
    globs: [
      "src/lib/phoenix-crm/refused-readings-rules.ts",
      "src/lib/phoenix-crm/server/refused-readings.ts",
      "src/lib/phoenix-crm/server/refused-readings-board.ts",
      "src/components/phoenix-crm/report-blocked-permission.ts",
      "app/**/phoenix-crm/refused-readings/**",
      "app/api/phoenix-crm/refused-readings/**",
      "tests/phoenix-crm-refused-readings*",
    ],
    keywords: ["refused reading", "refused readings", "blocked permission", "location blocked", "camera blocked", "off listing", "off_listing", "rough location"],
    tables: ["phoenix_crm_refused_readings"],
  },
  // 🔴 SPLIT, 2026-10-26: the signed-out 401 rule took `phoenix-crm`'s pointer to 4,031, over the 4,000
  // margin. What a Phoenix CRM request hands the screen is one family — the value it returns, the sentence a
  // refusal reads as, the Try again a dropped connection leaves, the 401 an ended sign-in answers — and none of
  // it decides who may do what, so it is the safe half to move. `phoenix-crm` keeps every glob it had, so a
  // file here loads the pair. Account: `docs/module-memory.md`, "Limits".
  {
    id: "phoenix-crm-requests",
    title: "Phoenix CRM — how a request answers the screen",
    scope: "What a Phoenix CRM read or save hands back to the screen: the value useCrmGet and crmPost return, the browser's own refusals and how they are named, the Try again a dropped connection leaves and a refusal never does, and the 401 an ended sign-in answers.",
    globs: [
      "src/components/phoenix-crm/api.ts",
      "src/lib/phoenix-crm/server/http.ts",
      "src/lib/auth/signed-out-refusal.ts",
      "tests/phoenix-crm-signed-out*",
      "tests/phoenix-crm-tap-to-retry*",
      "tests/phoenix-crm-browser-name*",
      "tests/phoenix-crm-shared-place.test.ts",
    ],
    keywords: ["tap to retry", "try again", "signed out", "signed_out", "session ended", "connection dropped", "load failed", "failed to fetch", "useCrmGet", "crmPost", "useCrmAction", "browserNamed", "phoenixCrmFailure"],
    tables: [],
  },
  // 🔴 NEW 2026-10-17, its own module from birth: the district manager's weekly plan is a separate table
  // family with its own approval chain, its own visits that count in HIS report only, and Manager's own
  // list. Its rules are the owner's five rounds of 2026-10-16, and none of them binds a rep's plan, so they
  // must not grow `phoenix-crm`'s pointer. `phoenix-crm` keeps every glob it had, so a file here loads the
  // pair and nothing that used to arrive stops arriving.
  {
    id: "phoenix-crm-manager-plan",
    title: "Phoenix CRM — the district manager's weekly plan",
    scope: "The district manager's own week in Phoenix CRM: with a rep, Admin or a single visit per half-day, Manager's own list, his single visits, the RSM/NSM approval in the Approvals Hub, the actual-versus-planned report, and the switch that retires his legacy Weekly Plan.",
    globs: [
      "src/lib/phoenix-crm/manager-plan-rules.ts",
      "src/lib/phoenix-crm/manager-visit-*.ts",
      "src/lib/phoenix-crm/server/manager-*.ts",
      "src/components/phoenix-crm/manager-*.tsx",
      "src/components/approvals-hub/manager-plan-*.tsx",
      "src/lib/workforce/plan-second-approver.ts",
      "app/api/phoenix-crm/manager-plans/**",
      "src/lib/phoenix-crm/old-crm-plan-*.ts",
      "src/lib/phoenix-crm/server/old-crm-plan-*.ts",
      "app/api/phoenix-crm/plans/old-crm/**",
      "supabase/migrations/*phoenix_crm_manager_plan*",
      "tests/phoenix-crm-manager-plan*",
      "tests/phoenix-crm-training-manager-plan*",
    ],
    keywords: ["manager plan", "manager's plan", "manager's own list", "district manager plan", "district manager's plan", "dm plan", "single visits"],
    tables: ["phoenix_crm_manager_"],
  },
  // 🔴 SPLIT, 2026-10-23, BEFORE `phoenix-crm-manager-plan` CROSSED THE POINTER MARGIN: its 34th rule — the marks
  // on each customer of his plan board — measured its injected pointer at 4,089 bytes against the 4,000 margin
  // `tests/module-memory.test.ts` holds. The marks are their own read and their own rules; the board and the
  // server file still match `phoenix-crm-manager-plan`'s globs, so a file here loads the pair.
  {
    id: "phoenix-crm-manager-customer-marks",
    title: "Phoenix CRM — the marks on each customer of a manager's plan board",
    scope: "What a manager sees on each customer while he plans his week: the grade edge, the rep's visits this month against the grade's number, his own visits, a live marketing request, the groups the shown customers share, and Go first.",
    globs: [
      "src/lib/phoenix-crm/manager-customer-marks-rules.ts",
      "src/lib/phoenix-crm/server/manager-customer-marks.ts",
      "src/components/phoenix-crm/manager-customer-marks.tsx",
      "app/api/phoenix-crm/manager-plans/customers/insight/**",
      "tests/phoenix-crm-manager-customer-marks*",
    ],
    keywords: ["customer marks", "go first", "frequency pips", "highlight the customers", "marketing request on the customer"],
    tables: [],
  },
  // 🔴 SPLIT, 2026-10-23, WHEN `phoenix-crm-manager-plan` CROSSED THE POINTER MARGIN AGAIN: its 35th rule — a district
  // manager's half-day with his manager or product manager — measured its injected pointer at 4,038 bytes against
  // the 4,000 margin `tests/module-memory.test.ts` holds. The two half-days spent with another manager (`with_dm`,
  // `with_senior`) are one family and move together; every glob here is also `phoenix-crm-manager-plan`'s, so a
  // file here loads the pair and nothing that used to arrive stops arriving.
  {
    id: "phoenix-crm-manager-ride-alongs",
    title: "Phoenix CRM — a manager's half-day with another manager",
    scope: "The half-days a manager spends with another manager rather than a rep: a regional, national or product manager's With a district manager (`with_dm`), and the double visit between two of a line's managers (`with_senior`: the DM's With my manager or product manager, everyone else's With a manager or product manager), its organogram picker, the areas ticked, Done by a chain visit, and how the Approvals Hub shows them.",
    globs: [
      "src/lib/phoenix-crm/manager-plan-rules.ts",
      "src/lib/phoenix-crm/server/manager-plans.ts",
      "src/lib/phoenix-crm/server/manager-plan-report.ts",
      "src/components/phoenix-crm/manager-plan-board.tsx",
      "src/components/approvals-hub/manager-plan-request-detail.tsx",
      "supabase/migrations/*phoenix_crm_manager_plan_with_*",
      "tests/phoenix-crm-manager-plan*",
    ],
    keywords: ["with a district manager", "with my manager", "visit with dm", "with the regional manager", "with the product manager", "ride-along half-day"],
    tables: [],
  },
  // 🔴 SPLIT, 2026-10-24, WHEN `phoenix-crm-manager-plan` CROSSED THE POINTER MARGIN A THIRD TIME: the Training
  // Manager's week (three rules at once) measured its injected pointer at 4,238 bytes against the 4,000 margin
  // `tests/module-memory.test.ts` holds. Her kind, her region scopes and her companion visits are one family and
  // move together; every glob here is also `phoenix-crm-manager-plan`'s, so a file here loads the pair and nothing
  // that used to arrive stops arriving.
  {
    id: "phoenix-crm-manager-plan-training-manager",
    title: "Phoenix CRM — the Training Manager's weekly plan",
    scope: "The Training Manager's own week in Phoenix CRM: her plan kind with no seat, a region then a rep, an area or the Office per half-day, never a doctor, and her place as the companion on a rep's visit on every line.",
    globs: [
      "src/lib/phoenix-crm/manager-plan-rules.ts",
      "src/lib/phoenix-crm/server/manager-plan-reach.ts",
      "src/lib/phoenix-crm/server/manager-plans.ts",
      "src/components/phoenix-crm/manager-plan-board.tsx",
      "supabase/migrations/*phoenix_crm_manager_plan_training_manager*",
      "tests/phoenix-crm-manager-plan*",
      "tests/phoenix-crm-training-manager-plan*",
    ],
    keywords: ["training manager plan", "training manager's plan", "training manager week", "with an area", "region scope"],
    tables: [],
  },
  // 🔴 SPLIT, 2026-10-08, BEFORE `phoenix-crm` OR `phoenix-crm-boards` COULD CROSS THE POINTER MARGIN: the
  // photo-validation audit taught seven rules at once (the signboard check, the closed refusal reasons, the
  // "Validate again" notice, the validate-first order, the Place checks reader, the same-seat merge and the
  // brick lookup). They are one family — what makes a captured place a VALIDATED one, and what the rep is
  // told when it is not — so they move together. `phoenix-crm` keeps every glob it had, so a file here loads
  // the pair and nothing that used to arrive stops arriving.
  {
    id: "phoenix-crm-validation",
    title: "Phoenix CRM — validating a place: the signboard, the refusal, the merge",
    scope: "What turns a captured place into a validated one — the signboard read, capture trust, the shared place a rep captures once and seats customers in, the timetable read, the Place checks page, the closed refusal reasons the rep is told, the customers waiting to be captured again, the validate-first order, the brick lookup and the same-seat duplicate merge.",
    globs: [
      "src/lib/phoenix-crm/{signboard-rules,schedule-rules,shared-place-rules,shared-place-groups,place-match-groups,validation-feedback,duplicate-merge-rules,validation-review-filters,place-photo-size,photo-reading-rules}.ts",
      "src/lib/phoenix-crm/server/{venue-timetable,signboard-check,signboard-sweep,signboard-holds,schedule-check,shared-places,place-location,place-match-groups,validation-reviews}.ts",
      "src/components/phoenix-crm/{seat-in-venue-screen,venue-timetable-screen,refusal-reason-field,reopened-customer-list,shared-place-customers,shared-place-list,shared-place-screens,place-match-board,validated-place-list,validation-review-queue,validation-reviews-board,signboard-retake-screen,live-photo-capture,capture-location}.tsx",
      // The camera's own reading (2026-10-22): which of its readings becomes the photo's is what capture
      // trust later measures, so a session editing the camera gets the cold-reading rule with it.
      "src/components/phoenix-crm/location-receiver.ts",
      "app/**/field-crm/validation-reviews/**",
      "app/api/phoenix-crm/{shared-places,validation-reviews}/**",
      "app/api/phoenix-crm/list/places/{seat,signboard}/**",
      "scripts/{phoenix-crm-merge-same-seat-duplicates.ts,phoenix-crm-reread-signboards.mjs}",
      "tests/phoenix-crm-{seat-in-venue,signboard-check,held-signboard,capture-trust-place,validation-feedback,place-brick-lookup,place-location-frozen,place-match-groups,shared-place,duplicate-merge,refuse-validation,validation-review-filters,place-checks-in-overflow,photo-reading}*",
    ],
    keywords: ["signboard", "refusal reason", "validate again", "duplicate merge", "place checks", "capture trust", "brick lookup", "shared place", "polyclinic", "timetable", "same place", "place match"],
    tables: [],
  },
  // 🔴 SPLIT, 2026-10-17, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `phoenix-crm-validation`
  // measured a 4,160-byte pointer against the 4,000 margin `tests/module-memory.test.ts` holds, the moment
  // the same-place comparison taught its rule. What the Place checks PAGE draws and how the Super Admin
  // decides on it — the polyclinic groups, the bulk answers, the rejections taken back, the comments and
  // the same-place comparison — is one family, so it moves together. `phoenix-crm-validation` KEEPS EVERY
  // GLOB IT HAD, so a Place checks file loads the PAIR and nothing that used to arrive stops arriving.
  {
    id: "phoenix-crm-place-checks",
    title: "Phoenix CRM — the Place checks page: groups, the same-place comparison and the decisions",
    scope: "What the Place checks page draws and how the Super Admin and the SFE Manager decide on it — the polyclinics tab and its groups, the same-place comparison between reps, the bulk answers, a rejection taken back, the comments and a district manager's read-only board.",
    globs: [
      "src/lib/phoenix-crm/{shared-place-groups,place-match-groups,validation-review-filters}.ts",
      "src/lib/phoenix-crm/server/{place-match-groups,validation-reviews}.ts",
      "src/components/phoenix-crm/{place-match-board,shared-place-customers,shared-place-list,validated-place-list,validation-review-queue,validation-reviews-board,reopened-customer-list,place-check-done}.tsx",
      "app/**/field-crm/validation-reviews/**",
      "app/api/phoenix-crm/validation-reviews/**",
      // The one-by-one review (owner, 2026-10-18): its shell, its pure slides, the integrity slide and
      // the read of the open cases it is built from.
      "src/components/place-review-deck/**",
      "src/lib/place-review-deck/**",
      "src/components/crm-integrity/integrity-review-slide.tsx",
      "app/api/admin/phoenix-crm/integrity/cases/**",
      "tests/place-review-deck*",
      "tests/phoenix-crm-{place-match-groups,shared-place-groups,refuse-validation,validation-review-filters,place-checks-in-overflow,sfe-place-checks}*",
    ],
    keywords: ["place checks", "same place", "place match", "polyclinic group", "bulk answer", "reject a customer", "approve after rejection", "district manager place checks"],
    tables: ["phoenix_crm_place_match_answers"],
  },
  // 🔴 SPLIT, 2026-10-19, FOR THE SAME REASON AGAIN: `phoenix-crm-validation` measured a 4,144-byte
  // pointer against the 4,000 margin the moment the AM short forms and the new-photo advice taught their
  // rules. How the signboard READER reads a photo and judges it against the list — the nightly pass, the
  // one-read-per-photo budget, the quorum and short forms, a person's name, the re-read script and the
  // two-reading flag — is one family, so it moves together. `phoenix-crm-validation` KEEPS EVERY GLOB IT
  // HAD (and the golden signboard rule itself), so a signboard file loads the PAIR and nothing that used
  // to arrive stops arriving.
  {
    id: "phoenix-crm-signboard",
    title: "Phoenix CRM — the signboard reader: reading a photo and judging it against the list",
    scope: "How the signboard reader reads a place's photo and judges it against the customer list — the nightly pass and its budget, one read per photo, every sign in the frame, the facility quorum and the list's short forms, a person's name, the advice on a sign, the re-read script and the two-reading flag.",
    globs: [
      "src/lib/phoenix-crm/{signboard-rules,place-check-advice}.ts",
      "src/lib/phoenix-crm/server/{signboard-check,signboard-sweep,signboard-holds}.ts",
      "src/components/phoenix-crm/signboard-retake-screen.tsx",
      "app/api/phoenix-crm/list/places/signboard/**",
      "scripts/phoenix-crm-reread-signboards.mjs",
      "tests/phoenix-crm-{signboard-check,held-signboard,place-check-advice}*",
    ],
    keywords: ["signboard reader", "unreadable sign", "re-read", "one read per photo", "short form", "quorum", "new photo asked", "sign advice"],
    tables: [],
  },
  // 🔴 SPLIT, 2026-10-09, FOR THE SAME REASON AS THE THREE ABOVE: `phoenix-crm` reached 33 rules and its
  // injected pointer measured 4,064 bytes against the 4,000 margin `tests/module-memory.test.ts` holds, the
  // moment the pharmacy's own pin added its rule. The manager-facing reports and boards and the ARITHMETIC
  // behind each figure are one family — the exceptions board's working days, brick coverage keyed by line,
  // plan vs actual, counting visits through the KPI view, the tracking sheet and workbook, and the catalogue
  // every report must be offered through — so they move together. `phoenix-crm` keeps every glob it had, so a
  // file here loads the pair and nothing that used to arrive stops arriving.
  {
    id: "phoenix-crm-reports",
    title: "Phoenix CRM — the reports, the boards and how every figure is counted",
    scope: "The manager-facing reports, the exceptions board and the 06:55 digest's figures, and the arithmetic behind each — working days, brick coverage keyed by line, plan vs actual, counting visits through the KPI view, the tracking sheet and the workbook, and the report catalogue.",
    globs: [
      "src/lib/phoenix-crm/{brick-report,daily-plan-report,exceptions,report-guide,report-rules,samples-report,team-calendar}.ts",
      "src/lib/phoenix-crm/server/{brick-report,daily-digest,daily-plan-report,exceptions,insight-reports,reports,reports-workbook,team-calendar}.ts",
      "src/components/phoenix-crm/calendar-tab.tsx",
      "app/api/phoenix-crm/reports/**",
      "tests/phoenix-crm-{brick-coverage-report,daily-digest,daily-plan-report,exceptions,insight-reports,report-comparison,reports-export,wave2-reports}*",
    ],
    keywords: ["exceptions board", "working day", "call rate denominator", "brick coverage", "plan vs actual", "tracking sheet", "reports workbook", "report catalogue", "report guide", "daily digest figures"],
    tables: [],
  },
  // 🔴 SPLIT, 2026-10-12, FOR THE SAME REASON AS THE FOUR ABOVE — but this time the pointer was pushed over
  // by SHORTENING rules, not by adding one. The ten longest rule bullets in the repo were split at their own
  // clause boundaries so the 1,200-byte gate has real headroom again (52 long of 538 → 42 of 559, against a
  // ceiling of 55), and every new bullet contributes its own headline: `phoenix-crm` went from 30 rules at
  // 3,707 bytes to 37 at 4,303, over the 4,000 margin `tests/module-memory.test.ts` holds. What a rep
  // RECORDS on a visit is one family — the form and its folded steps, the 02:00 day, the pharmacy call, who
  // was on a double, the Super Admin's correction and the call prep that reads it back — so it moves
  // together. `phoenix-crm` keeps every glob it had, so a visit file loads the pair and nothing that used to
  // arrive stops arriving. Account: `docs/module-memory.md`, "Limits".
  {
    id: "phoenix-crm-visits",
    title: "Phoenix CRM — the visit a rep records: the form, the day, the pharmacy call",
    scope: "What a rep records on a visit and when: the Add-visit form and its folded steps, the start-work confirmation, the 02:00 visit-day boundary and the no-past-day rule, the objection and next step, the pharmacy visit and the pharmacy he adds himself, who was on a double visit, the Super Admin's correction, and the call prep that reads it all back.",
    globs: [
      "src/lib/phoenix-crm/{call-prep,day-activities,day-detail,day-start-rules,double-visit-request-rules,last-visit-products,pharmacy-call-rules,today-rules,visit-ask-rules,visit-company,visit-detail-edit-rules,visit-edit-rules,visit-kind-labels,visit-location-words,visit-outcome,visit-rollup-rules}.ts",
      "src/lib/phoenix-crm/server/{call-prep,double-visit-requests,visit-asks,visit-detail-edit,visit-edit,visit-locations,visit-rollup,visits}.ts",
      "src/components/phoenix-crm/{add-pharmacy,call-prep-panel,double-visit-question,double-visit-requests,pharmacy-details,unplanned-visit-card,visit-asks,visit-company-picker,visit-customer-picker,visit-detail-panel,visit-edit-panel,visit-log-form,visit-start,visits-tab}.tsx",
      "app/api/phoenix-crm/{call-prep,double-visit-requests,visit-asks,visit-detail,visit-edit,visits}/**",
      "app/**/double-visit-requests/**",
      "supabase/migrations/*phoenix_crm_double_visit_requests*",
      "tests/phoenix-crm-{call-prep,countable-visits,double-visit-requests,first-visit,last-visit-products,one-tap-visit,pharmacy-calls,pharmacy-pin,pharmacy-visit-logged,visit-asks,visit-company,visit-dating,visit-detail-edit,visit-dwell,visit-form-ease,visit-organogram-titles,visit-outcome,visit-product-manager,visit-rollup,visits-everywhere}*",
    ],
    keywords: ["add visit", "visit form", "visit day", "pharmacy visit", "add a pharmacy", "call prep", "next step", "objection", "double visitor", "correct a visit", "started working"],
    tables: ["phoenix_crm_visits", "phoenix_crm_pharmacies"],
  },
  {
    id: "crm",
    title: "Field CRM analytics (iReports360) — visits, KPIs, reps lists and plans",
    scope: "The vendor CRM sync (iReports360), visits and call rates, coverage and frequency, Reps List, Reps Plans, KPIs, double visits, doctor lists, field activity.",
    globs: [
      "src/lib/{crm,crm-integrity,customer-360,customer-identity,double-visit-analytics,visits-report,field-activity,weekly-planning}/**",
      "src/components/{crm,crm-integrity,customer-360,customer-identity,double-visit-analytics,double-visit-report,field-activity,weekly-planning}/**",
      "app/**/{crm,crm-integrity,crm-tools,field-crm,customer-360,double-visit-analytics,double-visit-data-integrity,double-visit-report,dv-planner,doctor-coverage,doctor-coverage-settings,doctor-list,doctor-list-changes,rep-doctor-lists,reps-list,reps-plans,kpis,field-activity,visit-entry,visits,plan-verification,weekly-plans,plans,my-list,contact-review}/**",
      "tests/*{crm,ireports,visit,reps-list,reps-plans,kpi,double-visit,doctor-list,coverage}*",
      "tests/dm-plan*",
      "supabase/migrations/*{crm,ireports,visit}*",
      // Phoenix Ranks (owner, 2026-10-05) — the shared rep board built on the KPIs board.
      "src/lib/rep-ranks/**",
      "src/components/rep-ranks/**",
      "app/**/ranks/**",
      "tests/*rep-ranks*",
      "supabase/migrations/*rep_ranks*",
    ],
    keywords: ["phoenix ranks", "rep ranks", "leaderboard", "ireports360", "ireports", "call rate", "reps list", "reps plans", "double visit", "doctor list", "coverage", "frequency", "kpis board", "crm sync", "visit type", "doctor list changes", "drop a doctor", "contact list"],
    tables: ["crm_", "ireports", "visit"],
  },
  // 🔴 SPLIT 2026-10-23, FOR THE REASON `phoenix-crm-approvals` RECORDS, AND THE SECOND TIME `crm` HAS
  // HIT IT: its injected pointer measured 4,054 bytes against the 4,000-byte margin
  // `tests/module-memory.test.ts` holds, the moment the entry-days cache rule landed — the same squeeze
  // that cut the KPIs board out three days earlier. The SQL doors are the clean cut: how
  // `crm_visits_unified`, `crm_checkins_unified` and `phoenix_crm_countable_visits` are BUILT and read is
  // one family — which source wins a day, the entry days behind it, the exclusion, the partner slots, the
  // contact id all three doors emit — and none of it is read while editing a call rate or a Reps List
  // screen. `crm` KEEPS EVERY GLOB IT HAD, so a door file loads the PAIR and nothing that used to arrive
  // stops arriving. Both files are far from their 72,000-byte cap — two different limits, and this is the
  // small one.
  {
    id: "crm-unified-doors",
    title: "The CRM union doors — crm_visits_unified, crm_checkins_unified and the entry days",
    scope: "How the two union views are built and read: which source wins a day, the entry-days cache behind \"Phoenix wins the day\", the departed-agent exclusion, the two partner slots, the contact id all three doors emit, and the day-at-a-time scan that reads them.",
    globs: [
      "src/lib/crm/{reads,master,phoenix-work-evidence,phoenix-vendor-leftovers,phoenix-team-starts,phoenix-kpi-data}.ts",
      "supabase/migrations/*unified*",
      "supabase/migrations/*countable*",
      "supabase/migrations/*entry_days*",
      "supabase/migrations/*agent_crm_ids*",
      "supabase/migrations/*team_starts*",
      "supabase/migrations/*no_statistics*",
      "tests/phoenix-crm-{countable-visits,rep-entry-days-cache,vendor-leftovers,visits-everywhere}*",
      "tests/crm-agent-crm-ids-{cache,reconcile-heartbeat}.test.ts",
      "tests/phoenix-crm-team-starts-statistics.test.ts",
    ],
    keywords: ["crm_visits_unified", "crm_checkins_unified", "countable visits", "entry days", "phoenix wins the day", "unified door", "union view", "departed agent exclusion", "partner slot", "day-at-a-time scan"],
    tables: ["phoenix_crm_rep_entry_days_cache", "crm_agent_crm_ids_cache"],
  },
  // 🔴 SPLIT 2026-10-20, FOR THE REASON `rep-ranks` BELOW RECORDS: `crm`'s injected pointer measured
  // 4,029 bytes against the 4,000-byte margin the moment the KPIs board's manager rows landed (owner,
  // 2026-10-20: "every dm kpis is calculated based on his reps average and nsm based on dsms av"). The
  // KPIs board is the clean cut: its summary and three reports, their filters and the manager rows are
  // read while editing the board, never while editing an iReports360 sync or a doctor list. `crm` KEEPS
  // EVERY GLOB IT HAD, so a KPIs file loads the PAIR and nothing that used to arrive stops arriving.
  {
    id: "crm-kpis",
    title: "KPIs — the board, its three reports and the manager rows",
    scope: "The KPIs board: the Summary and the Frequency, Coverage and Call Rate reports, their filters and links, and the manager rows built by averaging the rows beneath each manager.",
    globs: [
      "src/lib/crm/kpis*",
      "src/components/crm/kpis*",
      "app/**/kpis/**",
      "tests/*kpi*",
    ],
    keywords: ["kpis board", "kpi reports", "manager rows", "reports to"],
    tables: [],
  },
  // 🔴 SPLIT 2026-10-12, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `crm` reached 34 rules
  // and its injected pointer measured 4,121 bytes against the 4,000-byte margin
  // `tests/module-memory.test.ts` holds, the moment the place-case rep-key rule landed. Phoenix Ranks is
  // the clean cut: it reads Phoenix CRM only, it has its own folders, pillars, windows, insignia and
  // certificate, and none of its rules are read while editing an iReports360 sync or a doctor list.
  // `crm` KEEPS EVERY GLOB IT HAD, so a ranks file loads the PAIR and nothing that used to arrive stops
  // arriving. The file itself was at 71% of its 72,000-byte cap — two different limits, and this is the
  // small one.
  {
    id: "rep-ranks",
    title: "Phoenix Ranks — the rep board, its pillars and the certificate",
    scope: "The shared rep ranking built on Phoenix CRM only: the pillars and what each divides by, the five windows, who sees whose breakdown, the nightly rebuild, the ladder, the insignia and the certificate.",
    globs: [
      "src/lib/rep-ranks/**",
      "src/components/rep-ranks/**",
      "app/**/ranks/**",
      "app/api/cron/rep-ranks/**",
      "tests/*rep-ranks*",
      "tests/rep-rank*",
      "supabase/migrations/*rep_ranks*",
    ],
    keywords: ["phoenix ranks", "rep ranks", "integrity pillar", "pillar", "insignia", "rank certificate", "standings", "ladder", "field accuracy", "am start"],
    tables: ["rep_rank_standings"],
  },
  // 🔴 SPLIT 2026-10-18, FOR THE REASON `rep-ranks` ABOVE RECORDS: `crm`'s injected pointer measured 4,116
  // bytes against the 4,000-byte margin the moment the Group Product Manager's half-day rule landed. The
  // legacy Weekly / Monthly Plan form (the Plans tab, `employee_plan_headers`) is the clean cut: its
  // workweek, completeness and week-key rules are read while editing that form, never while editing an
  // iReports360 sync or a KPI board. `crm` KEEPS EVERY GLOB IT HAD, so a weekly-planning file loads the PAIR.
  {
    id: "weekly-planning",
    title: "Weekly and Monthly Plan — the Plans tab form",
    scope: "The legacy Weekly / Monthly Plan form in the portal Plans tab: each role's workweek, which days and halves must be planned before submit, week keys and deadlines, and its approval chain.",
    globs: [
      "src/lib/weekly-planning/**",
      "src/components/employee-portal/plans-{workspace,history}.tsx",
      "tests/{plan-workweek-linkage,plan-slot-merge,weekly-plan-*,weekly-planning-*,weekly-plans-*}*",
    ],
    keywords: ["weekly plan", "monthly plan", "plans tab", "workweek", "full day", "half day", "am only", "pm only", "week key"],
    tables: ["employee_plan_"],
  },
  // 🔴 SPLIT 2026-10-15, FOR THE REASON `rep-ranks` ABOVE RECORDS: `crm` reached 31 rules and its
  // injected pointer measured 4,101 bytes against the 4,000-byte margin `tests/module-memory.test.ts`
  // holds, the moment the one-read rule for `crm_contact_master_refresh` landed. The doctor list is the
  // clean cut: `crm_contact_master_refresh` and the contact-list service are one mechanism with its own
  // files, its own cron route and its own tests, and none of its rules are read while editing a call
  // rate, a KPI board or a double visit. `crm` KEEPS EVERY GLOB IT HAD, so a doctor-list file loads the
  // PAIR and nothing that used to arrive stops arriving. The FILE was at 70% of its 72,000-byte cap —
  // two different limits, and this is the small one.
  {
    id: "crm-doctor-lists",
    title: "Doctor lists — the contact master, its refresh and the list changes",
    scope: "crm_contacts and crm_contact_assignments: the hourly contact-master refresh and its five assignment passes, the per-team hand-over from the vendor list to the Phoenix CRM list, and the doctor-list change requests.",
    globs: [
      "src/lib/crm/contact-lists/**",
      "src/lib/crm/contact-lists.ts",
      "src/lib/crm/contact-master.ts",
      "src/lib/crm/phoenix-team-starts.ts",
      "app/api/cron/crm-contact-lists/**",
      "app/**/{doctor-list,rep-doctor-lists,my-list}/**",
      "tests/*{contact-master,contact-list,doctor-list}*",
      "supabase/migrations/*contact_master*",
      "supabase/migrations/*contact_list*",
      "supabase/migrations/*contact_refresh*",
    ],
    keywords: ["doctor list", "contact master", "contact list", "contact assignments", "contact-lists cron", "doctor list changes", "drop a doctor", "regrade", "hand the vendor list over", "fifth pass"],
    tables: ["crm_contacts", "crm_contact_assignments"],
  },
  // 🔴 SPLIT 2026-10-19, FOR THE REASON `crm-doctor-lists` ABOVE RECORDS: `crm` was at 3,952 bytes with
  // 31 rules, 48 under the 4,000-byte margin `tests/module-memory.test.ts` holds, so no new rule of any
  // length fitted, and the restart-marker hold took it to 4,116. The poller's schedule is the clean
  // cut: the in-process loop, the deep runs it times and the markers a restart reads back are one
  // mechanism with its own files and tests, and none of its rules are read while editing a call rate,
  // a KPI board or a double visit. `crm` KEEPS EVERY GLOB IT HAD, so a poller file loads the PAIR and
  // nothing that used to arrive stops arriving.
  {
    id: "crm-sync",
    title: "Field CRM sync — the iReports360 live poller, its scheduled jobs and their restart markers",
    scope: "The in-process iReports360 loop: the live probe, the rolling 10-day sync, the weekly 30-day reconcile, the plan sync, the contact-list sweep and the parity sweep, the order it runs them in, and the markers a deploy restart reads back so it does not run one again.",
    globs: [
      "src/lib/crm/{live-poller,sync,sync-run-groups,parity,plan-sync,cutover,housekeeping-scheduler}.ts",
      "app/api/cron/ireports360-visits-{live-sync,reconcile,sync}/**",
      "tests/crm-live-*",
    ],
    keywords: ["live poller", "crm poller", "rolling sync", "weekly reconcile", "wide reconcile", "parity sweep", "restart marker", "deep run", "scheduled work", "seed the markers"],
    tables: ["ireports360_visits_sync_runs"],
  },
  {
    id: "marketing",
    title: "Marketing requests, venues, pharmacies and ROI",
    scope: "Marketing requests and approvals, venue and pharmacy validation, distributor codes, customer-pharmacy links, verified captures, market awareness, marketing ROI.",
    globs: [
      "src/lib/{marketing-requests,venues,pharmacy-master,pharmacy-search,customer-pharmacy-mapping,verified-captures,market-awareness,sales-marketing-intelligence,evidence}/**",
      "src/components/{marketing-requests,venues,pharmacy-master,pharmacy-search,customer-pharmacy-mapping,market-awareness,sales-marketing-intelligence,validation}/**",
      "app/**/{marketing-requests,archived-marketing-requests,marketing,marketing-roi,marketing-roi-report,marketing-roi-tracker,roi,roi-tracker,pharmacy-master,pharmacy-search,customer-pharmacy-mapping,customer-links,verified-captures,market-awareness,sales-marketing-intelligence}/**",
      "tests/*{marketing,venue,pharmacy,wholesaler,customer-pharmacy,verified-capture,roi}*",
      "supabase/migrations/*{marketing,venue,pharmacy}*",
    ],
    keywords: ["marketing request", "marketing requests", "venue", "venues", "pharmacy code", "distributor code", "makhzan", "wholesaler", "marketing roi", "verified capture", "صيدلية"],
    tables: ["marketing_", "venue", "pharmacy", "customer_pharmacy"],
  },
  // 🔴 SPLIT 2026-10-16, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `marketing` had 85 bytes
  // of pointer left under the 4,000-byte margin `tests/module-memory.test.ts` holds (3,915), and the
  // hourly fact rebuild's period-read rule took it to 4,085. The ROI half is the clean cut — the verdict
  // and its three copies, the fact rebuild, the Tracker, the Coverage Report and the Manager Scorecard
  // are one family and none of it is read while editing a venue, a pharmacy code or a licence.
  // `marketing` KEEPS EVERY GLOB IT HAD, so an ROI file loads the PAIR and nothing that used to arrive
  // stops arriving. The file itself was at 69% of its 72,000-byte cap — two different limits, and this
  // was the small one.
  {
    id: "marketing-roi",
    title: "Marketing ROI — the fact rebuild, the verdict, the Tracker, the Coverage Report and the Scorecard",
    scope: "How a marketing request's return is measured and shown: the stored ROI facts and their hourly rebuild, the awaiting-data verdict and its copies, the ROI Tracker and its live stages, the Coverage Report, and the Manager Scorecard.",
    globs: [
      "src/lib/marketing-requests/{roi,coverage-report,manager-scorecard}*",
      "src/components/marketing-requests/{roi,coverage,marketing-roi,marketing-coverage,marketing-manager-scorecard}*",
      "app/**/{marketing-roi,marketing-roi-report,marketing-roi-tracker,roi-tracking,coverage-report,manager-scorecard,roi-refresh,roi-business-report,roi-tracker,roi-explain}/**",
      "tests/*{marketing-roi,marketing-coverage,marketing-manager-scorecard}*",
      "supabase/migrations/*marketing_roi*",
    ],
    keywords: ["roi tracker", "roi tracking", "marketing roi", "coverage report", "manager scorecard", "awaiting data", "roi facts", "roi refresh"],
    tables: ["marketing_roi_"],
  },
  {
    id: "recruitment",
    title: "Recruitment, CVs and offers",
    scope: "Candidates and the ATS, CV intake (email and WhatsApp), CV database and lookup, screening, interviews, job offers, vacancies.",
    globs: [
      "src/lib/{recruitment,cv,offers,whatsapp-inbox,mailbox-monitor,zoom}/**",
      "src/components/{recruitment,cv,offers,whatsapp-inbox}/**",
      "app/**/{recruitment,recruitment-hiring,recruitment-candidates,recruitment-engagement,cv-database,cv-lookup,offers,interview-calendar,vacancies,intake-health,screening-questions,mailbox-monitor,whatsapp-inbox,whatsapp,whatsapp-connect}/**",
      "tests/*{recruitment,candidate,cv-,cv_,offer,ats,interview,whatsapp,vacanc,screening}*",
      "supabase/migrations/*{recruitment,candidate,ats_,offer,whatsapp,cv_}*",
    ],
    keywords: ["recruitment", "candidate", "candidates", "cv", "cvs", "job offer", "offer letter", "interview", "vacancy", "vacancies", "ats", "whatsapp cv", "screening", "توظيف"],
    tables: ["ats_", "recruitment", "candidate", "offer", "whatsapp", "cv_"],
  },
  // 🔴 SPLIT 2026-10-16, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `recruitment` reached 28
  // rules and its injected pointer measured 4,097 bytes against the 4,000-byte margin
  // `tests/module-memory.test.ts` holds, the moment the Product Manager question gate landed. The
  // INBOUND half is the clean cut: what an applicant is ASKED and READS — the bot's own words, its role
  // menu, the owner-worded screening questions with their show_if/end_on rules, and the public careers
  // form that renders the same set — is one family, and none of it is read while editing an offer
  // letter, a candidate's card or the interview calendar. `recruitment` KEEPS EVERY GLOB IT HAD, so an
  // inbound file loads the PAIR and nothing that used to arrive stops arriving. The file itself was far
  // under its 72,000-byte cap — two different limits, and this is the small one.
  {
    id: "recruitment-inbound",
    title: "Recruitment — the WhatsApp bot, the screening questions and the careers form",
    scope: "What an applicant is asked and reads: the WhatsApp classify flow and its role menu, the owner-worded auto-replies and screening questions, show_if/end_on, and the public careers application form.",
    globs: [
      "src/lib/recruitment/inbound/**",
      "app/api/public/apply/**",
      "app/**/screening-questions/**",
      "tests/*{whatsapp,screening,website-apply}*",
      "supabase/migrations/*{whatsapp,screening}*",
    ],
    keywords: ["whatsapp bot", "screening question", "screening questions", "auto reply", "auto-replies", "careers form", "careers page", "apply form", "role menu", "show_if", "end_on"],
    tables: ["ats_whatsapp_"],
  },
  // 🔴 SPLIT AGAIN 2026-10-18, for the same reason: the WhatsApp CV Archive rule took `recruitment`'s
  // pointer to 4,084 bytes against the 4,000-byte margin. The INTERVIEW CALENDAR is the next clean cut —
  // booking an interview and the role it names, the outcome panel and the outcome that settles itself
  // are one family, read while working the calendar and its interview files, not while editing an offer
  // or the pool. Its three rules moved VERBATIM; `recruitment` KEEPS EVERY GLOB IT HAD (its
  // `interview-calendar` app glob included), so an interview file loads the PAIR.
  {
    id: "recruitment-interviews",
    title: "Recruitment — the interview calendar and interview outcomes",
    scope: "The interview calendar: booking an interview and the role it is for, invitations, reminders and requests, and the outcome of an interview once it has happened.",
    globs: [
      "src/lib/recruitment/interview*",
      "src/components/recruitment/interview-calendar/**",
      "app/**/interview-calendar/**",
      "tests/*interview*",
    ],
    keywords: ["interview calendar", "interview outcome", "interview request", "interview requests", "interview invitation", "interview reminder", "book an interview"],
    tables: ["ats_interview"],
  },
  // 🔴 SPLIT 2026-10-18, THE SAME WAY: `recruitment` measured 4,139 bytes against the 4,000-byte margin
  // the moment the candidate-delete storage rule landed (28 rules, then 29). The OFFER LETTER is the
  // second clean cut — its designs, the email it fires, the mailboxes it may leave from and the hand-off
  // to the Employee Master are one family, and none of it is read while editing the pool, a candidate's
  // files or the interview calendar. `recruitment` KEEPS EVERY GLOB IT HAD, so an offer file loads the
  // PAIR and nothing that used to arrive stops arriving. The eight rules moved word for word.
  {
    id: "recruitment-offers",
    title: "Recruitment — the job offer letter, its email and the hand-off to the Employee Master",
    scope: "The job offer letter and its designs, the offer email and the mailboxes it may fire from, the candidate's accept and decline, and the offer-to-employee hand-off.",
    globs: [
      "src/lib/offers/**",
      "src/components/offers/**",
      "app/**/offers/**",
      "tests/*offer*",
      "supabase/migrations/*offer*",
    ],
    keywords: ["offer letter", "job offer", "offer email", "offer template", "offer letter design", "joining form", "accept button", "offer job titles"],
    tables: ["offer_"],
  },
  // 🔴 SPLIT 2026-10-23, THE SAME WAY: the CV-parsing limits rule (technical audit, P5-04) took
  // `recruitment`'s pointer to 4,143 bytes against the 4,000-byte margin. READING A CV FILE — its text,
  // the worker thread that bounds it, OCR, the rule pass and the model read — is one family, read while
  // working those engine files, never while editing the workspace, an offer or the calendar.
  // `recruitment` KEEPS EVERY GLOB IT HAD, so a CV-reading file loads the PAIR.
  {
    id: "recruitment-cv-reading",
    title: "Recruitment — reading a CV file: its text, OCR, the rule pass and the model read",
    scope: "How a CV file becomes fields: text extraction and its isolated worker thread, scanned-CV OCR, the free rule pass, the paid model read and its limits — and the size limits on a CV the application PDF opens.",
    globs: [
      "src/lib/recruitment/cv-*",
      "src/lib/recruitment/whatsapp-application-pdf.ts",
      "tests/*{cv-extraction,cv-text,rule-extraction}*",
    ],
    keywords: ["cv extraction", "cv parsing", "cv text", "pdf-parse", "mammoth", "ocr", "tesseract", "rule extraction"],
    tables: ["ats_candidate_cv_extractions"],
  },
  {
    id: "hiring-documents",
    title: "Hiring documents, contracts and company papers",
    scope: "The hiring pack, contracts, HR forms and papers, the Sato document identity on paper, seals and print marks, business cards, the spotlight sheet, PDFs and workbook exports.",
    globs: [
      "src/lib/{hiring-pack,hiring-documents,contracts,business-cards,email-signature,spotlight,pdf,export}/**",
      "src/components/{hiring-pack,hiring-documents,contracts,business-cards,email-signature,spotlight,phoenix-signature-card}/**",
      "app/**/{hiring-pack,hiring-documents,contracts,business-cards,business-card-requests,email-signature,spotlight,print}/**",
      "tests/*{hiring-pack,hiring-document,contract,hr-forms,business-card,email-signature,spotlight,house-identity,premium-identity,document-mark,pdf}*",
      ".claude/skills/hr-premium-identity/**",
    ],
    keywords: ["hiring pack", "hiring documents", "contract", "contracts", "hr forms", "business card", "business cards", "spotlight", "seal", "stamp", "document identity", "premium identity", "عقد"],
    tables: ["hiring_", "contract", "business_card", "spotlight"],
  },
  {
    id: "employees",
    title: "Employees and the HR lifecycle",
    scope: "Employee master data, hiring into a seat, Employee 360, resignations and exits, retention, the HR command centre, HR seats and functions, test accounts.",
    globs: [
      "src/lib/{employees,employee-lifecycle,employee-360,hr,hr-reminders,hr-ops-reports,resignations,retention,retention-risk,lifecycle-risk,new-hire-mailbox}/**",
      "src/components/{employees,employee-360,hr,hr-reminders,hr-ops-reports,people,resignations,retention,new-hire-mailbox}/**",
      "app/**/{employees,employee-360,resignations,retention,people-management,hr-command-center,hr-reminders,hr-reports,hr-ops-reports,new-hire-mailboxes,test-accounts,account-activation}/**",
      "tests/*{employee,hr-,resignation,retention,lifecycle,hire,leaver,test-account}*",
      "supabase/migrations/*{employee,resignation,retention,lifecycle,hire,hr_team_reminders,hr_ops_reports}*",
    ],
    keywords: ["employee master", "employee 360", "resignation", "resignations", "leaver", "leavers", "new hire", "hire date", "last working date", "retention", "hr command", "test account", "موظف"],
    tables: ["employees", "employee_", "exit_record", "resignation", "retention", "app_auth_users"],
  },
  {
    id: "probation",
    title: "Probation and employee milestones",
    scope: "Probation tracking, the Day 30/60/75 milestone emails, probation settings, milestone cards.",
    globs: [
      "src/lib/{probation,milestones}/**",
      "src/components/{probation,milestones}/**",
      "app/**/{probation,probation-settings,probation-tools,ceo-probation,milestones}/**",
      "tests/*{probation,milestone}*",
      "supabase/migrations/*{probation,milestone}*",
    ],
    keywords: ["probation", "milestone", "milestones", "day 30", "day 60", "day 75"],
    tables: ["probation", "milestone"],
  },
  {
    id: "time-off",
    title: "Vacations, attendance and calendars",
    scope: "Annual vacation requests and balances, attendance and fingerprints, excuses, Early Birds, the HR and team calendars, private calendars, the Field Absence Calendar.",
    globs: [
      "src/lib/{vacation,attendance,excuses,early-birds,hr-calendar,private-calendar,calendar}/**",
      "src/components/{vacation,attendance,early-birds,hr-calendar}/**",
      "app/**/{vacation-request,vacation-control,vacation-report,leave-management,finance-leave-management,attendance,fingerprint-analytics,excuses,early-birds,hr-calendar,company-calendar,team-calendar,private-calendar,private-calendars,private-calendar-disputes}/**",
      "local-attendance-agent/**",
      // The Field Absence Calendar (owner, 2026-10-18) — who the system did not see at all on a working
      // day. A calendar over this module's own records (vacation, fingerprints) plus the CRM and trips.
      "src/{lib,components}/field-absence/**",
      "app/**/field-absence/**",
      "tests/*{vacation,attendance,excuse,early-bird,calendar,leave}*",
      "supabase/migrations/*{vacation,attendance,excuse,leave,calendar}*",
    ],
    keywords: ["vacation", "vacations", "annual leave", "attendance", "fingerprint", "excuse", "excuses", "early birds", "calendar", "field absence", "اجازة", "إجازة", "حضور"],
    tables: ["vacation", "attendance", "excuse", "leave_", "calendar"],
  },
  {
    id: "expenses",
    title: "Expenses and outstation trips",
    scope: "Expense claims and submissions, outstation trips and allowances, duplicate-claim holds, the expense dashboard.",
    globs: [
      "src/lib/outstation/**",
      "src/components/outstation/**",
      "src/components/employee-portal/personal-expense-workload-dashboard*.tsx",
      "app/**/{outstation,outstation-expenses,outstation-review,expenses,expense-dashboard,expense-submissions,submit-expense,team-expenses}/**",
      "tests/*{expense,outstation,per-diem,trip}*",
      "supabase/migrations/*{expense,outstation}*",
    ],
    keywords: ["expense", "expenses", "expense claim", "outstation", "per diem", "allowance", "trip", "trips", "مصاريف"],
    tables: ["expense", "outstation"],
  },
  {
    id: "org",
    title: "Organogram, territory and geography",
    scope: "The organogram and AU seat model, lines, regions and areas, territory management, field workforce compliance, Egypt place vocabulary and geocoding.",
    globs: [
      "src/lib/{org,workforce,field-workforce-compliance,territory-management,geo,geocoding,google-maps}/**",
      "src/components/{organogram,field-workforce-compliance,territory-management}/**",
      "app/**/{organogram,territory-management,field-workforce-compliance,scope-visibility}/**",
      "tests/*{organogram,org-,seat,territory,geo,region,area-}*",
      "supabase/migrations/*{org,seat,territory,area,region}*",
    ],
    keywords: ["organogram", "org chart", "seat", "seats", "vacant seat", "territory", "region", "governorate", "geocoding", "line manager"],
    tables: ["au.", "seat", "areas", "regions", "lines", "teams", "territor"],
  },
  {
    id: "portal",
    title: "Employee portal, dashboards and command centres",
    scope: "The employee portal shell and landing pages, the admin shell and sidebar, action centre, Needs You, CEO/SFE/HR command centres, company activity report, support requests.",
    globs: [
      "src/lib/{employee-portal,navigation,overview,dashboard,action-center,needs-you,ceo,company-activity-report,support-requests,workspace,reports,activity}/**",
      "src/components/{employee-portal,layout,action-center,company-activity-report,workspace,reports,activity,analytics}/**",
      "src/config/system-navigation.ts",
      "app/employee-portals/*",
      "app/**/{overview,action-center,needs-you,ceo-command-center,sfe-command-center,company-activity-report,support-requests,contact-hr-support,sidebar-layout,workspace,reports,analytics,profile,actions}/**",
      "tests/*{portal,sidebar,navigation,landing,overview,command-center,needs-you,action-center}*",
    ],
    keywords: ["employee portal", "portal", "sidebar", "landing page", "command center", "command centre", "needs you", "action center"],
    tables: ["portal", "navigation", "support_request"],
  },
  {
    id: "notifications",
    title: "Email, notifications and messaging",
    scope: "Outbound email and templates, the notification outbox and recipients, Telegram mirrors, distribution lists, the two composers (Sato and CEO), Sato mailboxes and mailbox offboarding, internal messages.",
    globs: [
      "src/lib/{email,email-templates,notifications,communication,internal-messages,distribution-lists,sato-email,ceo-email,personal-mailbox,mailbox-offboarding,conversations,whatsapp-videos}/**",
      "src/components/{notifications,conversations,mailbox-offboarding}/**",
      "src/emails/**",
      "app/**/{email-control-center,email-notifications,email-reply-composer,email-templates,notifications,notification-confidence,notification-recipients,distribution-lists,sato-email,ceo-email,mailbox-offboarding,messages,access-communication}/**",
      "tests/*{email,notification,telegram,outbox,mailbox,distribution-list,digest}*",
      "supabase/migrations/*{email,notification,outbox,mailbox}*",
    ],
    keywords: ["email", "emails", "notification", "notifications", "telegram", "outbox", "mailbox", "distribution list", "resend", "turbify", "email composer", "ceo email"],
    tables: ["notification", "email", "outbox", "mailbox"],
  },
  // ── The Turbify console is ONE console driven by TWO robots, so it gets its own module ──
  //
  // Found 2026-10-02: `src/lib/turbify/**` was claimed by NO module, so the four files holding the
  // console's confirmed wordings and its row-resolution refusal loaded nothing. Worse, the robots
  // that drive it sat in different modules — the joiner (`new-hire-mailbox`) under `employees`, the
  // leaver (`mailbox-offboarding`) under `notifications` — so a session working one side could not
  // see a console rule learned on the other, and the rules had been filed on the joiner's side.
  //
  // 🔴 This module ADDS to those two rather than taking the directories from them: a session on
  // either robot loads its own module AND this one. The shared danger is the CONSOLE (288 rows share
  // one `aria-label="Reset password"`, so a first-match click resets the WRONG employee's mailbox),
  // and that danger is identical whoever is driving.
  {
    id: "turbify",
    title: "Turbify mailbox console — the shared browser driver",
    scope: "The Turbify admin console both mailbox robots drive: its confirmed on-screen wordings, row resolution and refusals, click delivery, and the two robots themselves (new-hire adoption and leaver offboarding). Email delivery and templates stay in `notifications`; the HR lifecycle around a joiner or leaver stays in `employees`.",
    globs: [
      "src/lib/turbify/**",
      "src/lib/{new-hire-mailbox,mailbox-offboarding}/**",
      "tests/*{turbify,mailbox}*",
      "app/**/mailbox-offboarding/**",
    ],
    keywords: ["turbify", "mailbox console", "app password", "app passwords", "new hire mailbox", "mailbox offboarding", "two-step"],
    tables: ["mailbox_offboarding", "new_hire_mailbox", "personal_mailbox"],
  },
  // ── Split out of `turbify` on 2026-10-04, which had reached 4,142 of the 4,000-byte margin ──
  //
  // 🔴 THE BROAD GLOBS STAY ON `turbify`, so this is an ADDITION and never a replacement: a session
  // in `src/lib/new-hire-mailbox/**` loads the console's golden rules AND these. Splitting the other
  // way round — narrowing `turbify` to `src/lib/turbify/**` — would have taken the substring-identity
  // rule and the click-delivery rule away from the robot that needs them most, which is precisely
  // the forgetting this module system exists to end.
  //
  // The seam is CONSOLE versus PROVISIONING FLOW. `turbify` keeps what is true whoever is driving:
  // on-screen wordings, row resolution, click delivery, the two login pages, the redaction rules.
  // This holds the new-hire half's own sequence — a create lands PENDING, the invitation carries the
  // credential, the app password has one window, and what a run may report or record.
  {
    id: "turbify-provisioning",
    title: "Turbify provisioning — creating a mailbox, its invitation and its app password",
    scope: "The new-hire half of the Turbify robot: what a CREATE actually leaves behind, the invitation that carries the credential, adopting an existing mailbox by reset, the one window in which an app password can be minted, and what a run may report or record. The console's own wordings, row resolution and click delivery stay in `turbify`, which loads beside this.",
    globs: [
      "src/lib/new-hire-mailbox/**",
      "src/components/new-hire-mailbox/**",
      "app/api/new-hire-mailboxes/**",
      "tests/new-hire-mailbox-*",
    ],
    keywords: ["new hire mailbox", "invite inbox", "invitation", "temp password", "one-time password", "pending mailbox", "provisioning"],
    tables: ["new_hire_mailbox"],
  },
  {
    id: "coaching",
    title: "Coaching, training and visual aids",
    scope: "Field coaching and coaching analytics, the training manager, visual aids.",
    globs: [
      "src/lib/{coaching,visual-aids}/**",
      "src/components/{coaching,visual-aids}/**",
      "app/**/{coaching,coaching-analytics,field-coaching,training-manager,visual-aids}/**",
      "tests/*{coaching,visual-aid,training}*",
      "supabase/migrations/*{coaching,visual_aid,training}*",
    ],
    keywords: ["coaching", "visual aid", "visual aids", "training manager"],
    tables: ["coaching", "visual_aid", "training"],
  },
  {
    id: "report-it",
    title: "Report It (pharmacovigilance — patient data)",
    scope: "Adverse-event reports (patient data, not HR), the pharmacovigilance desk and its export.",
    globs: [
      "src/lib/report-it/**",
      "src/components/report-it/**",
      "app/**/{report-it,pharmacovigilance}/**",
      "tests/*report-it*",
    ],
    keywords: ["report it", "report-it", "pharmacovigilance", "adverse event", "adr"],
    tables: ["report_it"],
  },
  {
    id: "approvals",
    title: "Approvals and workflow",
    scope: "Approval chains, the approvals hub, the workflow registry and workflow control.",
    globs: [
      "src/lib/{approvals-hub,workflow-control,workflow-registry,approvals}/**",
      "src/components/{approvals-hub,workflow-control}/**",
      "app/**/{approvals,approvals-hub,workflow-control,workflow-registry}/**",
      "tests/*{approval,workflow}*",
      "supabase/migrations/*{approval,workflow}*",
    ],
    keywords: ["approval chain", "approvals hub", "workflow registry", "approver", "approval flow"],
    tables: ["approval", "workflow"],
  },
  {
    id: "devices",
    title: "Devices and tablet management (Headwind MDM)",
    scope: "The device register, Headwind MDM, the company tablets as managed devices.",
    globs: [
      "src/lib/devices/**",
      "src/components/devices/**",
      "app/**/devices/**",
      "tests/*{device,headwind,manageengine,mdm}*",
      "docker-compose.headwind.yml",
    ],
    keywords: ["headwind", "mdm", "device register", "tablet", "tablets"],
    tables: ["device"],
  },
  {
    id: "platform",
    title: "Platform — auth, security, cron, data access and shared UI",
    scope: "Login and sessions, access control and roles, security, cron jobs and background work, observability and errors, share links, imports and uploads, AI assist, shared UI primitives and styles.",
    globs: [
      "src/lib/{auth,security,platform,cron-control,background-jobs,observability,error-monitor,system-audit,share-links,share,http,imports,uploads,ai,validation,qr,operations,synthetic-journeys,admin,format,i18n,ui,utils}/**",
      "src/components/{auth,admin,ui,charts}/**",
      "src/styles/**",
      "app/api/{auth,cron,health,healthz,readyz,dev-auth,errors,webhooks,share,exports,imports,integrations,public}/**",
      "app/**/{access,admin-tools,cron-control,error-monitor,logs,monitoring,module-locks,system-audit,system-cleanup,system-issues,synthetic-journeys,data-backup,data-health,dev-preview,login,password-setup,share}/**",
      "proxy.ts",
      "instrumentation.ts",
      "tests/*{auth,access,role,permission,cron,security,login,session,share-link,error,system-audit,square-edge,fits-the-screen,form-design}*",
      "supabase/migrations/*system_audit*",
      "supabase/migrations/*{auth,role,permission,cron}*",
    ],
    keywords: ["login", "access control", "permission", "permissions", "role sweep", "cron", "cron job", "error monitor", "system audit", "share link", "dev-auth"],
    tables: ["auth.", "app_auth", "app_error", "system_audit_", "cron."],
  },
  // 🔴 SPLIT 2026-10-23, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `platform` reached 33
  // rules and its injected pointer measured 4,136 bytes against the 4,000-byte margin
  // `tests/module-memory.test.ts` holds, the moment the crash screenshot (#6358) and the block
  // screenshot (#6359) landed together. The System Audit board, its daily message, and the two
  // screenshots of what a person saw are one family — what went wrong for a person and how the Super
  // Admin sees it — so their rules moved VERBATIM. `platform` KEEPS EVERY GLOB IT HAD, so a System Audit
  // or error-monitor file loads the PAIR and nothing that used to arrive stops arriving.
  {
    id: "platform-system-audit",
    title: "Platform — the System Audit board, its daily message and the error screenshots",
    scope: "The Super-Admin System Audit board and its ledger, the nightly sweep and its one daily message, where the board starts, and the two pictures of what a person saw — the crash screenshot and the block screenshot — who may see them and how long they are kept.",
    globs: [
      "src/lib/system-audit/**",
      "src/lib/error-monitor/{screen-capture,screen-capture-rules,screen-intake,user-error-screens,capture-screenshot,screenshot-intake,screenshot-ticket}.ts",
      "src/components/admin/system-audit/**",
      "app/**/system-audit/**",
      "app/api/errors/{screen,client/screenshot}/**",
      "scripts/system-audit-*",
      "tests/*{system-audit,user-error-screens,error-screenshot}*",
      "supabase/migrations/*{system_audit,user_error_screens,app_error_events_screenshot}*",
    ],
    keywords: ["system audit", "system-audit", "daily message", "error screenshot", "crash screenshot", "what the person saw", "what the employee saw", "blocked"],
    tables: ["system_audit_", "user_error_screens"],
  },
  // 🔴 SPLIT 2026-10-18, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `platform` reached 29
  // rules and its injected pointer measured 4,141 bytes against the 4,000-byte margin
  // `tests/module-memory.test.ts` holds, the moment the AI-providers rule landed. The cut is the
  // Design tokens section — nine rules about the shared look in code (the radius tokens, the one
  // wizard shell, the button, panel-header and depth tokens, the form-control guard), none of which is
  // read while editing a login, a cron or an error screen. They moved VERBATIM. `platform` KEEPS EVERY
  // GLOB IT HAD, so a file under `src/components/ui/` or `src/styles/` loads the PAIR and nothing that
  // used to arrive stops arriving. The file itself was at 79% of its 72,000-byte cap — two different
  // limits, and this was the small one.
  {
    id: "platform-design-tokens",
    title: "Platform — design tokens, the form kit and the square-edge look",
    scope: "The shared look in code: the `--phx-radius` tokens and the square-edge rule, the one wizard shell in `form-kit.tsx`, the approve, danger and WhatsApp button tokens, the dark panel header and depth tokens, and the guard that refuses a form control painting its own box.",
    globs: [
      "src/components/ui/{form-kit,form-tokens,brand-tokens}*",
      "src/components/admin/admin-design-tokens.ts",
      "src/styles/**",
      "tests/*{form-design,admin-shell-palette}*",
    ],
    keywords: ["design token", "design tokens", "form-kit", "form-tokens", "brand-tokens", "square-edge", "wizard shell", "panel header band"],
    tables: [],
  },
  // 🔴 SPLIT 2026-10-23, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `platform` measured a
  // 4,013-byte pointer against the 4,000-byte margin `tests/module-memory.test.ts` holds, the moment the
  // audit-outbox rules landed. The cut is the OBSERVABILITY family — Sentry, `app_error_events` and what a
  // row carries, the crash screenshot, the System Audit board and its start point, the job re-fire policy,
  // and the audit trail's own persistence — none of which is read while editing a login, a permission or a
  // share link. They moved VERBATIM. `platform` KEEPS EVERY GLOB IT HAD, so an observability file loads the
  // PAIR and nothing that used to arrive stops arriving.
  {
    id: "platform-observability",
    title: "Platform — structured logging, Sentry and the audit trail's own persistence",
    scope: "Structured logging and what an `app_error_events` row carries, Sentry, job failure and re-fire policy, and how the audit trail itself is persisted. The System Audit board and the error screenshots are `platform-system-audit`.",
    globs: [
      "src/lib/observability/**",
      "src/lib/error-monitor/**",
      "src/lib/admin/audit*.ts",
      "src/lib/http/api-errors.ts",
      "src/components/admin/audit-log-viewer*",
      "app/api/errors/client/route.ts",
      "app/api/telemetry/**",
      "app/**/{error-monitor,logs,monitoring}/**",
      "instrumentation.ts",
      "src/components/layout/page-timing-beacon.tsx",
      "src/lib/http/server-timing.ts",
      "tests/performance-phase-3.test.ts",
      "tests/*{error-monitor,structured-log,sentry,audit-outbox,job-refire,heartbeat}*",
      "supabase/migrations/*{app_error,audit_log,heartbeat}*",
    ],
    keywords: ["error monitor", "app_error_events", "system audit", "sentry", "structured log", "logError", "audit outbox", "audit_logs", "job failure"],
    tables: ["app_error", "audit_log"],
  },
  {
    id: "database",
    title: "Database, migrations and Supabase",
    scope: "Supabase projects, migrations, RLS, grants, functions and views, PostgREST behaviour.",
    globs: [
      "supabase/**",
      "src/lib/supabase/**",
      "scripts/*{migration,supabase,sql}*",
    ],
    keywords: ["migration", "migrations", "supabase", "rls", "postgrest", "apply_migration", "execute_sql"],
    tables: [],
  },
  {
    id: "engineering",
    title: "Engineering — CI, tests, scripts and deploys",
    scope: "CI and the required checks, PRs and merges, the test runner and how tests prove things, repo scripts, Railway deploys and what is live, the self-hosted runner and preview box.",
    globs: [
      ".github/**",
      "scripts/*",
      "tests/run-tests.ts",
      "package.json",
      "Dockerfile",
      ".railway/**",
      "next.config.ts",
      "infra/**",
    ],
    keywords: ["ci", "github actions", "workflow run", "required check", "required checks", "railway", "deploy", "deployed", "test runner", "roll-up", "rollup"],
    tables: [],
  },
  // 🔴 SPLIT 2026-10-23, FOR THE REASON `phoenix-crm-approvals` ABOVE RECORDS: `engineering` reached
  // 72,540 bytes against its 72,000 cap the moment one more note was filed — and a module file at its
  // cap is SPLIT, never trimmed. The coherent half that stands alone is TESTING: what makes a test
  // prove something, what makes a green run mean nothing, and how the runner and its shards behave.
  // It is about whether a result is evidence; `engineering` keeps CI, PRs, merges and the scripts.
  // 🔴 `engineering` KEEPS EVERY GLOB IT HAD — `tests/run-tests.ts` included — and this module ADDS
  // its own, so a session editing the runner loads the PAIR and nothing that used to arrive stops.
  {
    id: "engineering-tests",
    title: "Engineering — tests, and what makes a result evidence",
    scope: "How a test proves something here: the runner and its shards, source-pinning and break tests, the seams, the environment a suite really runs in, and the many shapes of a green run that proves nothing.",
    globs: [
      // 🔴 NOT "tests/*.test.ts": almost every AGENTS.md rule names the test that pins it, so that
      // glob makes a rule true everywhere look like it belongs to this one module, and
      // tests/module-memory.test.ts fails the required validate job saying so. A session writing a
      // test reaches these rules through the runner it must register in, through tests/support, or
      // through the injector's keywords.
      "tests/support/**",
      "tests/run-tests.ts",
      "scripts/*test*",
    ],
    keywords: ["test", "tests", "suite", "assertion", "break test", "shard", "pinning", "green run", "regression test"],
    tables: [],
  },
  // 🔴 SPLIT 2026-10-09, FOR THE REASON THE TWO ABOVE WERE: `engineering`'s injected pointer measured
  // 4,103 bytes against the 4,000 margin `tests/module-memory.test.ts` holds, the moment one deploy
  // rule was added — and a module at its pointer limit is SPLIT, never trimmed. The Production-hooks
  // section (Railway, the deploy gate, what is actually serving, and the CLI's own traps) is the one
  // coherent half that can stand alone: it is about what REACHES production, not about what CI says.
  // 🔴 `engineering` KEEPS EVERY GLOB IT HAD — `Dockerfile`, `.railway/**` and `infra/**` included —
  // and this module ADDS its own, so a Dockerfile edit loads the PAIR and nothing that used to arrive
  // stops arriving.
  {
    id: "engineering-deploys",
    title: "Engineering — Railway deploys and what is actually serving",
    scope: "The Railway deploy and its CI gate, the build itself and where its base image comes from, what revision is live and how to prove it, deployment states, volumes and regions, and the railway CLI's own traps.",
    globs: [
      "Dockerfile",
      ".railway/**",
      "infra/**",
      "app/api/healthz/**",
      "app/api/readyz/**",
      ".claude/skills/ship/verify-shipped.mjs",
      "tests/verify-shipped-selftest.test.ts",
      // The ship skill's phase 7b: did the deploy bring a new error (the error table and Sentry).
      "scripts/lib/post-deploy-errors.mjs",
      "tests/post-deploy-errors.test.ts",
      // 🔴 Added 2026-10-19 with the deploy NOTES moved here from `engineering` (it sat at 71,001 of its 72,000
      // bytes): a session editing a deploy or Railway script or workflow still gets them, as it did before.
      "scripts/*{railway,deploy}*",
      ".github/workflows/*{railway,deploy}*",
      "scripts/check-dockerfile.mjs",
      "tests/dockerfile-parse-gate.test.ts",
      "tests/railway-deploy-config.test.ts",
      // The web/worker process roles decide which Railway service runs the background jobs.
      "instrumentation.ts",
      "src/lib/platform/process-role.ts",
    ],
    keywords: ["railway", "deploy", "deployed", "revision", "healthz", "readyz", "wait for ci", "deploy gate", "base image", "docker hub", "dockerfile", "volume", "region"],
    tables: [],
  },
  // 🔴 SPLIT 2026-10-26, FOR THE REASON `engineering-deploys` ABOVE RECORDS: `engineering`'s injected
  // pointer measured 4,078 bytes against the 4,000 margin the moment the main-only cache rule landed beside
  // the tree-reuse shadow rule. The field day papers section (the nightly printer, its day-off reading,
  // the hand-written notes and the archive it keeps) is about one script folder and stands alone.
  // `engineering` KEEPS EVERY GLOB IT HAD; this module ADDS `scripts/field-day/**`, which no module
  // matched before, so the printer's rules now reach a session that opens the printer itself.
  {
    id: "engineering-field-day",
    title: "Engineering — the field day papers (scripts/field-day)",
    scope: "The nightly field day printer and its launcher, how a paper reads a day off, the hand-written notes keyed by day, and the archive a reprint keeps before replacing a paper that already went out.",
    globs: [
      "scripts/field-day/**",
      "xlsx/field-day-print.mjs",
      "tests/field-day-report.test.ts",
    ],
    keywords: ["field day", "field-day", "print-day", "nightly papers", "superseded paper"],
    tables: [],
  },
  // ── `sessions` split in two on 2026-10-03, at 69% of the cap and growing fastest ──
  //
  // 135 notes in one file, and they are NOT one subject: half are git and worktree MECHANICS (what a
  // squash merge leaves behind, which worktree a command is really in, how a branch or a husk
  // misleads you), the other half are the HARNESS, the laptop and the memory system. The first half
  // is what a session needs while running git; the second is what it needs while editing a hook,
  // reading the index, or judging free RAM.
  //
  // 🔴 `sessions` KEEPS EVERY GLOB IT HAD, and `git-worktrees` adds its own — the same lopsided
  // shape as the sales split. `scripts/new-session*`, `repo-doctor*` and `sync-worktree-env*` are in
  // BOTH on purpose, and the risky keywords (worktree, branch, merge, primary checkout) are in both
  // keyword lists, so git work loads the pair and nothing that used to arrive stops arriving. Only
  // the reverse narrows: editing a hook or the memory tooling no longer drags in 70 git notes.
  {
    id: "git-worktrees",
    title: "Git, worktrees and the shared primary checkout",
    scope: "Git mechanics in this repo and the worktrees sessions run in: branches and what a squash merge leaves behind, merging and `gh pr merge`, pushes and refs, which checkout a command is really acting on, husks and retirement, and the ways a parallel session collides with yours. The harness, the laptop and the memory system are `sessions`.",
    globs: [
      "scripts/{new-session,sync-worktree-env,repo-doctor}*",
      "docs/agents-worktree-and-machine-limits.md",
    ],
    keywords: ["worktree", "worktrees", "primary checkout", "squash merge", "squash-merged", "branch", "husk", "parallel session", "parallel sessions", "session lock", "git worktree", "rerere"],
    tables: [],
  },
  {
    id: "sessions",
    title: "Sessions — the Claude Code harness, this laptop and the memory system",
    scope: "The harness and the machine: Claude Code hooks and settings, permissions and the classifier, prompt suggestions, effort and models, compaction, subagents and MCP, the browser pane and dev-auth, the laptop's RAM and dev servers, shell and tooling traps, and the memory index and module memory itself. Git and worktree mechanics are `git-worktrees`.",
    globs: [
      ".claude/hooks/**",
      ".claude/settings.json",
      "scripts/{new-session,repo-doctor,sync-worktree-env,sync-cloud-context,memory-index-budget,memory-index-reachability,dev-server}*",
      "scripts/cloud-mirror/**",
      "scripts/module-memory/**",
      "docs/{module-memory,memory-index-budget,agents-worktree-and-machine-limits,agents-session-traps}*",
    ],
    keywords: ["worktree", "worktrees", "primary checkout", "parallel session", "parallel sessions", "session lock", "memory index", "module memory", "dev server", "claude code", "laptop"],
    tables: [],
  },
];

/** Notes that are true everywhere stay in the always-loaded MEMORY.md index. */
export const GLOBAL = "global";
/** Notes about retired platforms or frozen areas: listed in docs/module-memory/history.md, never loaded. */
export const HISTORY = "history";

export const MODULE_IDS = MODULES.map((m) => m.id);

/** Where each module's memory file lives, repo-relative. */
export const rulesFileOf = (id) => `.claude/rules/${id}.md`;

/** Full memory notes, repo-relative: the cloud mirror of the laptop memory folder (identical content). */
export const NOTES_DIR = ".claude/cloud-context/memory-mirror";

/** Ceiling for one module file — CI refuses a bigger one; split the module instead. */
export const MODULE_FILE_MAX_BYTES = 72_000;

/**
 * Glob -> RegExp. Supports `**` (any depth, including none when followed by `/`), `*` (one
 * segment), `?` and `{a,b}`. Paths are repo-relative with forward slashes.
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === "," && re.lastIndexOf("(?:") > re.lastIndexOf(")")) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Which modules own a repo-relative path. */
export function modulesForPath(relPath) {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return MODULES.filter((m) => m.globs.some((g) => globToRegExp(g).test(p))).map((m) => m.id);
}

/** Whole-word, case-insensitive keyword test (Arabic-safe: falls back to substring). */
export function mentions(text, word) {
  const t = String(text || "").toLowerCase();
  const w = word.toLowerCase();
  if (/[^\x00-\x7f]/.test(w)) return t.includes(w);
  const esc = w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${esc}($|[^a-z0-9_])`).test(t);
}
