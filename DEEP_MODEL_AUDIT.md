# Phoenix Workforce: Deep Model & Workflow Audit

## Executive Summary
Phoenix Workforce is a **complex multi-domain HR system with severe data consistency, workflow logic, and cross-model linkage issues**. The architecture uses independent service layers for each domain (Payroll, Offers, Leave, Coaching, Admin) but **fails to enforce single-source-of-truth data governance**. Changes in the Admin module (employee directory) do NOT automatically propagate to Employee Portal views, leaving data stale and inconsistent.

**Overall Data Linkage Score: 2/10** — Architecturally fragmented with manual sync points.

---

## 1. PAYROLL SERVICE: Score 3/10

### Model: `SalaryBatch` & `SalaryRecord`

**Structure:**
```
salary_batches (master record)
├── id, file_name, month, year, status
├── uploaded_by, approved_by, approved_at
├── part1_paid_at, part1_paid_by
├── part2_ready_at, part2_ready_by
└── locked_at, rejected_reason

salary_records (fact table)
├── batch_id (FK)
├── hr_id, employee_code (lookup keys — DUAL KEY PROBLEM)
├── base_salary, gross_salary, net_salary
├── 25+ additive/deductive fields
└── hire_date (cached from employees table)
```

### Critical Issues

1. **Dual-Key Lookup Brittleness** (3/10)
   - Records match on **both `hr_id` AND `employee_code`**, with fallback contains-match logic
   - If admin updates HR ID format, payroll engine can't find matching records
   - Example: `normalizeHrId()` and `normalizeHrIdForAccess()` produce DIFFERENT canonical forms
   - **Impact**: Portal sees one HR ID, payroll sees another → data mismatch

2. **Hard-Coded Actor for Batch Transitions** (2/10)
   ```typescript
   // payroll/service.ts line 1165-1177
   if (transition.setPart1Paid) {
     updates.part1_paid_by = actorName;  // ← String passed directly
     updates.part1_paid_at = now;
   }
   ```
   - Actor name is a **string parameter**, not linked to `app_auth_users` or `employees`
   - Audit is unresolvable if user is deleted or renamed
   - **Workflow**: Payroll workflows set transitions as strings, not references

3. **Access Filter Fragmentation** (4/10)
   - Payroll scope resolved via `getPayrollScope(accessContext)` → `COMPANY|SELF|TEAM|HIERARCHY|LINE|NONE`
   - Each scope rebuilds a `Set<string>` of allowed HR IDs
   - **Portal sees different filter than Admin** because portal uses `RLS client`, admin uses `admin client`
   - Portal may load payroll records invisible to the employee due to cache/stale directory

4. **Calculated vs. Stored Fields Conflict** (5/10)
   - Fields like `totalAdditions`, `governmentalDeductions` are **both uploaded AND calculated**
   - If recalculation logic changes, old batches show inconsistent data
   - No versioning of calculation formulas
   - **Issue**: Admin approval of batch uses uploaded values; portal display may recalculate differently

5. **Previous Batch Delta Logic Is Weak** (3/10)
   ```typescript
   // getPayrollDashboard loads latest batch, then finds ONE previous batch
   if (scope === "batch" && prevBatch) {
     // Only loads directly prior batch, not full history
   }
   ```
   - Assumes sequential months; if months skipped, comparison is wrong
   - No monthly vs. quarterly normalization

### Workflow Opinion
❌ **Payroll workflow is **ad-hoc transaction-less multi-step process**:
- Upload → Approve → Part1 Paid → Part2 Ready → Locked
- Each step is a separate `UPDATE` call on `salary_batches`
- **No transaction wrapping** — partial failures leave batch in intermediate state
- Concurrent edits can cause status conflicts (see `PayrollConflictError`)
- **No idempotency**: retrying approval can double-record payments

### Cross-Model Linkage: Admin → Payroll
- ✅ Hire dates fetched on-demand from `employees` table
- ❌ **No invalidation** when employee `hire_date` changes
- ❌ If employee is deleted, orphan salary records remain (no FK constraint)
- ❌ **Portal doesn't re-fetch hire dates** after admin changes them

**Recommendation**: 
- Introduce versioned fact tables for salary calculations
- Wrap payroll state transitions in PostgreSQL functions with transactions
- Hard-link actors to `app_auth_users(login_id)` with audit trail
- Invalidate payroll cache on employee directory changes

---

## 2. OFFERS SERVICE: Score 2/10

### Model: `job_offers`

**Structure:**
```
job_offers (lifecycle)
├── id, offer_code
├── candidate_name, candidate_email, candidate_phone
├── job_title, template_key
├── area_id, line_id, position_id, department_id, manager_hr_id
├── salary_amount, start_date
├── status (draft → sent → accepted/rejected → expired)
├── accepted_at, rejected_at, onboarding_status
├── secure_token_hash (SHA256 of one-time token)
└── created_by_hr_id (nullable, inferred from line)

job_offer_audit_logs (audit trail)
├── offer_id, action, actor_type, actor_reference, details
```

### Critical Issues

1. **GET Side Effects (Security + Data Integrity)** (1/10)
   ```typescript
   // offers/service.ts
   export async function decideOffer(token: string, decision: "accepted" | "rejected"): Promise<OfferActionResult> {
     const offer = await getOfferByToken(token);
     // ...
     const updated = await updateOffer(offer.id, {
       accepted_at: decision === "accepted" ? now : null,
       onboarding_status: decision === "accepted" ? "pending_hr_approval" : "not_started",
       rejected_at: decision === "rejected" ? now : null,
       status: decision,
     });
   ```
   - **This function is called from public routes `/offers/{token}/accept` (GET/POST)**
   - **GET requests with side effects** → Prefetch crawlers, load balancers, CDN caches trigger unintended acceptances
   - **Critical Bug**: Candidate's browser prefetch can auto-accept offer
   - Only mitigation: `secure_token_hash` prevents brute-force, but doesn't prevent crawlers

2. **Multiple Independent Writes Without Transaction** (2/10)
   ```typescript
   // Create offer: 1 insert to job_offers, then N audits
   // Accept offer: update job_offers status, then send N emails (failed email doesn't rollback offer status)
   ```
   - Offer is marked "accepted" BEFORE emails sent
   - If email fails, offer state is stale
   - No rollback mechanism

3. **Hard-Coded Actor Reference** (2/10)
   ```typescript
   await insertAudit(offer.id, "offer_sent", "hr", { expiresInDays }, resolvedCreatedByHrId);
   ```
   - Audit log stores **string actor type** ("hr", "candidate", "system"), not FK
   - Created HR ID is nullable and inferred from line hierarchy
   - **No way to trace who actually approved** an offer if multiple HRs edit

4. **Lookup Resolution Is Inconsistent** (3/10)
   ```typescript
   async function resolveHrId(value: string | null | undefined) {
     const exact = await supabaseRest(...ilike.${requested});
     if (exact.length > 0 && exact[0].hr_id) return ...
     const caseInsensitive = await supabaseRest(...ilike.${requested});
     return ...
   }
   ```
   - Two separate HTTP calls to resolve ONE HR ID
   - First tries exact match, then case-insensitive fallback
   - **No caching** → N lookups per offer creation = N+1 queries
   - If HR ID changes case format in employees table, offer references become stale

5. **Offer Approval Cascades to Employee Creation** (4/10)
   ```typescript
   export async function approveAcceptedOffer(
     id: string,
     approvedByHrId?: string | null,
     manualHrId?: string | null,
   ) {
     const rpcResult = await supabaseRpc<{ employee_hr_id: string }>("phx_approve_accepted_offer", {
       p_approved_by_hr_id: approvedByHrId ?? null,
       p_employee_hr_id: manualHrId ?? offer.employee_hr_id ?? null,
       ...
     });
   ```
   - Approval RPC creates employee record **in one atomic call**
   - If RPC partially succeeds (employee created, offer status not updated), inconsistency results
   - Employee created with same HR ID could collide with existing employee
   - **No deduplication check before creation**

6. **Stale Lookups on Offer Dashboard** (3/10)
   ```typescript
   async function loadLookupMaps(rows: OfferDbRow[]) {
     // Fetch departments, lines, managers for EACH offer render
     // No caching, no invalidation
     // If manager's name changes, old offers show old name (in audit, but not in dashboard display)
   }
   ```

### Workflow Opinion
❌ **Offer lifecycle has **critical UX and security flaws**:
- Token-based links are one-time, but GET-based acceptance is vulnerable
- **Workflow should be POST-only** with CSRF protection
- Approval should NOT auto-create employees; separate onboarding step required
- **Manual HR ID override (`manualHrId`) is a backdoor** for duplicate employees

### Cross-Model Linkage: Admin → Offers
- ✅ Manager lookups cached per dashboard load
- ❌ **Lookups NOT invalidated** when manager name/line changes
- ❌ **Offer approval creates employee** without checking for existing matches
- ❌ **If employee deleted after offer accepted, orphan employee record created**

**Recommendation**:
- Change `/offers/{token}/accept` to POST-only with CSRF token
- Wrap approval in transaction that rolls back if employee creation fails
- Add deduplication: check `employees(hr_id)` before creating
- Remove manual HR ID override; use inferred value only
- Cache lookups globally, invalidate on employee directory changes

---

## 3. LEAVE SERVICE: Score 4/10

### Model: `VacationRequest`

**Structure:**
```
vacation_requests (application)
├── id, employee_key (composite: email/id/name)
├── start_date, end_date, day_type (Full/AM/PM)
├── request_type (Annual/Sick/Unpaid/Compensatory)
├── status (Pending/Approved/Rejected)
├── workflow_status (awaiting_manager/awaiting_hr/awaiting_payout)
├── direct_manager, direct_manager_email, direct_manager_hr_id
├── payment_status (Paid/Unpaid), rejection_reason
└── Multiple cached snapshot fields (available_balance_at_submission, etc.)
```

**Calculation Model:**
- First year: 15 days (usable after 6 months probation)
- Post year-1: 21 days
- Cycle resets annually on hire-date anniversary

### Critical Issues

1. **Employee Key Is Fragile** (3/10)
   ```typescript
   function buildEmployeeKey({ employeeEmail, employeeId, employeeName }: EmployeeIdentifiers) {
     const email = sanitizeString(employeeEmail).toLowerCase();
     const id = sanitizeString(employeeId).toLowerCase();
     if (email) return `email:${email}`;
     if (id) return `id:${id}`;
     return `name:${sanitizeString(employeeName).toLowerCase()}`;
   }
   ```
   - Keys are **never synced** with actual `hr_id` from employees table
   - If employee changes email, new leave requests are unlinked from old requests
   - If name has typo, can't match historical records
   - **Workflow**: Portal stores `employee_key` as provided by form input, NOT from directory

2. **Cached Balance Snapshot Is Static** (3/10)
   ```typescript
   availableBalanceAtSubmission: number;  // Frozen at submission time
   currentAnnualEntitlementAtSubmission: number;
   usedPaidLeaveAtSubmission: number;
   ```
   - Balance captured at submission time, never updated
   - If admin changes entitlement policy mid-year, old requests are locked with old values
   - No way to recalculate all historical requests if policy changes
   - **Issue**: Dashboard shows current balance, but approval uses submission-time balance

3. **Multi-Step Workflow Without Atomic Transitions** (2/10)
   ```
   draft → pending_manager → manager_approved → pending_hr → hr_approved → awaiting_payout
   ```
   - Each step is a separate API call
   - If manager approves and HR simultaneously rejects, state is undefined
   - No version/revision tracking to detect concurrent edits
   - **Probation employees**: If hired 6 months ago, first day of entitlement is ambiguous

4. **Direct Manager Linkage Is Nullable** (3/10)
   ```typescript
   directManagerHrId: String;  // Always populated from form input?
     // OR
   if (directManagerMissing && dbStatus === "pending_manager") {
     return "needs_routing" as LeaveWorkflowStatus;  // Fallback state
   }
   ```
   - If manager is missing, request goes into `needs_routing` state
   - Can remain stuck there indefinitely
   - No auto-escalation or fallback to skip manager approval

5. **Half-Day Logic Is Fragile** (2/10)
   ```typescript
   function isHalfDayRangeInvalid({ dayType, endDate, startDate }) {
     if (dayType === "Full Day") return false;
     return startDate !== endDate;  // ← Only valid if same day
   }
   ```
   - Half-days only allowed for single-day ranges
   - If employee tries AM on Monday, rest on Tuesday, it fails
   - No UI/UX guidance, just silent validation failure

### Workflow Opinion
⚠️ **Leave workflow is **decoupled from employee directory**:
- Requests are bound to `employee_key` (email/id/name), not `hr_id`
- **Portal employee adds leave request with email, Admin changes email, Portal loses reference**
- No cascade invalidation
- Entitlement policy is hardcoded (15 / 21 days); no admin config panel
- Balance snapshots are immutable; policy changes require manual recalculation

### Cross-Model Linkage: Admin → Leave
- ❌ **Requests are NOT linked to employees table**
- ❌ **If employee hire date changes in Admin, leave balance NOT recalculated**
- ❌ **If employee deleted, orphan leave requests remain**
- ❌ **If manager changed, manager approval still goes to old manager**

**Recommendation**:
- **Link requests to `employees(hr_id)` with FK**
- Add policy configuration table; version entitlements
- Auto-cascade hire date changes to recalculate balances
- Atomic workflow state machine with version field to detect concurrent edits
- Add manager escalation: if manager absent, escalate to line manager

---

## 4. COACHING SERVICE: Score 5/10

### Model: `CoachingReport` & `CoachingScoreItem`

**Structure:**
```
coaching_reports (master)
├── id, report_id, report_number
├── medical_rep_hr_id, coach_hr_id
├── coaching_date, coaching_month, coaching_quarter, coaching_year
├── status (draft → submitted → reviewed_by_employee → locked)
├── actual_score, max_score, final_score_percent, performance_zone
├── area_of_development, strength_points, general_remarks
├── locked_at, acknowledged_at
└── created_by, updated_by (actor strings)

coaching_score_items (child)
├── report_id (FK)
├── score_item_key, score_item_label, parameter_category
├── score (0-120 scale, 20 items total)
└── display_order

coaching_reports_summary (materialized view)
├── Same as coaching_reports + denormalized names
```

### Critical Issues

1. **Role-Based Access Control Is Hardcoded** (3/10)
   ```typescript
   const companyRoles = new Set<AccessContext["role"]>(["Super Admin", "CEO", "HR Specialist"]);
   const teamCoachingRoles = new Set(["District Manager", "Regional Sales Manager", "National Sales Manager"]);
   const lineRoles = new Set(["National Sales Manager", "Regional Sales Manager", "Product Manager", ...]);
   ```
   - Roles are enum strings, not database references
   - If admin adds new role ("Regional Manager" vs "Regional Sales Manager"), RBAC breaks
   - **No dynamic role updates** — hardcoded list must be edited in code
   - Inconsistent with Admin/Payroll which use `canManageCoachingReports(access)` function

2. **Score Calculation Is Black-Box** (4/10)
   ```typescript
   const scoreResult = calculateCoachingScore(input.scores);
   // Actual calculation hidden in separate module
   // 20 items, max 120 points total
   // No documentation of formula: is it (sum/20)*100? Or something else?
   ```
   - Score formula is opaque
   - If calculation logic changes, old reports show inconsistent score
   - Submitted reports lock score, so no retroactive adjustment
   - **Issue**: Dashboard aggregates scores; if formula changes, aggregates are wrong

3. **Coach HR ID Is Nullable in Audit** (2/10)
   ```typescript
   async function requireActorHrId(access: AccessContext) {
     const hrId = normalizeHrId(access.hrId);
     if (!hrId) throw new Error("A linked employee HR_ID is required for coaching actions.");
     return hrId;
   }
   // But actorId() can return access.loginId or access.role as fallback
   ```
   - Audit log stores **actor** as nullable or as role string
   - Can't trace WHO approved report if actor is stored as "Training Manager"

4. **Materialized View Staleness** (3/10)
   ```typescript
   // coaching_reports_summary is a view that denormalizes coach/employee names
   // If coach or medical rep name changes in employees table, summary is not refreshed
   ```
   - View is queried directly; no trigger to refresh
   - Dashboard shows stale names until view is manually refreshed
   - **Cross-model**: Employee name changes in Admin, Coaching dashboards show old name

5. **Submission RPC Is Monolithic** (3/10)
   ```typescript
   export async function submitCoachingReport(id: string, input: ..., access: AccessContext) {
     const { data, error } = await getSupabaseAdmin().rpc("submit_coaching_report", {
       p_actor_hr_id: actorId(access),
       p_area_of_development: ...,
       p_scores: scorePayload,
       ...
     });
   }
   ```
   - All state transitions wrapped in single RPC call
   - If scores don't validate, entire submission fails
   - No partial success or retry logic

### Workflow Opinion
⚠️ **Coaching workflow is **weakly integrated with employee directory**:
- Reports reference `medical_rep_hr_id` and `coach_hr_id`, but not linked to employees table
- **If employee is deleted from directory, orphan coaching reports remain**
- Names are denormalized but not auto-updated when employee name changes
- Access control is hardcoded roles; new org roles require code changes
- Score calculations are immutable; policy changes require manual recalculation

### Cross-Model Linkage: Admin → Coaching
- ❌ **Reports NOT linked to employees table with FK**
- ❌ **If employee/coach deleted in Admin, coaching reports NOT deleted**
- ❌ **If coach or medical rep name changes, summary view shows stale names**
- ❌ **If line/area changes, coaching reports show historical line/area (no cascade)**

**Recommendation**:
- Add FK constraints: `coaching_reports.medical_rep_hr_id` → `employees(hr_id)` with CASCADE DELETE
- Externalize role configuration to `role_definitions` table; query dynamically
- Add score formula versioning; track which formula version each report used
- Auto-refresh materialized view on employee directory changes (trigger)
- Add audit log for role changes impacting coaching access

---

## 5. EMPLOYEE PORTAL: Score 3/10

### Model: Portal-Specific Views

**Structure:**
```
EmployeePortal (client-side aggregation)
├── Payroll View (RLS filtered salary_records)
├── Leave View (leave_requests filtered by employee_key)
├── Coaching View (coaching_reports filtered by medical_rep_hr_id)
└── Profile View (employees table filtered by auth user)
```

**Key Issue**: Portal fetches data **client-side from API routes**, which query RLS-protected tables. **No caching, no invalidation, no sync trigger**.

### Critical Issues

1. **Payroll Portal Sees Different Data Than Admin** (2/10)
   ```typescript
   // Admin sees:
   export async function getPayrollDashboard(batchId: string | undefined, accessContext: AccessContext) {
     const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
     // Uses RLS client if available, else admin client
   }
   
   // Portal sees:
   // Calls API route, which uses getSupabaseRlsClientIfAvailable(), which uses session JWT
   // JWT scope may be narrower than admin scope
   ```
   - **Same API endpoint returns different data depending on client (portal vs admin)**
   - Portal RLS session may have narrower payroll scope than admin
   - **Caching inconsistency**: Admin caches payroll data, portal refreshes, both see different data

2. **Leave Requests Are Not Synced With Directory** (2/10)
   ```typescript
   // Portal creates leave request with employee_key = email
   export async function loadEmployeePortalVacationData(): Promise<EmployeePortalVacationData> {
     const response = await fetch("/api/employee-portals/vacation-requests");
     // Returns requests bound to employee_key (email), NOT to hr_id
   }
   
   // Admin changes employee email → Portal loses reference to historical requests
   ```
   - Leave requests use email-based key, employees table uses `hr_id`
   - **No join between** `leave_requests` and `employees`
   - If email changes, portal shows 0 balance because request key doesn't match

3. **Coaching Portal Sees Only Their Own Reports** (3/10)
   ```typescript
   export async function getMyCoachingReports(access: AccessContext) {
     const hrId = requireActorHrId(access);
     return getCoachingReports({ medicalRepHrId: hrId }, access);
   }
   ```
   - Portal endpoint filters `medical_rep_hr_id` to current user's `hr_id`
   - If HR ID changes in Admin, portal can't find historical coaching reports

4. **Portal Cache Is Never Invalidated** (1/10)
   - Portal uses browser cache + Next.js `cache: "no-store"`
   - **But Admin doesn't emit change events** to invalidate Portal caches
   - If Admin updates employee record, portal still shows stale data until manual refresh
   - **No pubsub, no webhooks, no cache invalidation**

5. **Profile Edit Doesn't Cascade** (3/10)
   ```typescript
   // Portal allows employee to edit personal details
   // But changes are made directly to employees table
   // No sync to leave_requests, coaching_reports, payroll_records (hr_id normalization)
   ```
   - If employee changes name in portal, coaching reports still reference old name
   - If employee changes line/area, payroll records are out-of-sync

### Workflow Opinion
❌ **Employee Portal is **fragmented and stale**:
- Payroll, Leave, and Coaching are **separate API routes**, each with independent RLS filters
- **No single source of truth**: Portal sees data differently than Admin
- **Cache coherency is broken**: Admin changes data, Portal still shows old values
- **No cross-domain linkage**: Updating profile in one domain doesn't update references in other domains

### Cross-Model Linkage: Admin → Portal
- ❌ **Portal doesn't invalidate on Admin changes**
- ❌ **Portal uses email-based key for leaves; HR ID-based for payroll; no normalization**
- ❌ **If employee deleted in Admin, portal may crash (FK missing)**
- ❌ **Portal edits (profile update) don't propagate to dependent records**

**Recommendation**:
- **Normalize all employee references to `hr_id` FK**
- **Add data change events**: emit `employee_updated`, `payroll_changed` to pub/sub
- **Portal subscribes to events** and invalidates local cache
- **Implement optimistic updates**: show change immediately, revert on conflict
- **Add sync endpoint**: Admin can ping `/api/sync` to invalidate portal caches
- **Use Supabase Realtime or Postgres LISTEN/NOTIFY** for cache invalidation

---

## 6. ADMIN SERVICE: Score 4/10

### Model: `AdminMonitoringStats` & `DataHealthStats`

**Structure:**
```
Admin Dashboard Aggregates:
├── PhoenixAdminStats (employee count, payroll count, salary flags)
├── AdminMonitoringStats (auth/notification health)
└── DataHealthStats (orphan audit, employee issues, sales classification)

Backing Tables:
├── app_auth_users (auth account linking)
├── employees (directory source of truth)
├── user_access_profiles (access control)
├── audit_logs (event log)
└── Many lookup tables (lines, areas, departments, etc.)
```

### Critical Issues

1. **No Enforced Schema Version** (2/10)
   ```typescript
   export async function getPhoenixAdminStats(): Promise<PhoenixAdminStats> {
     // Queries 10 different tables with assumes they all exist
     // If salary_flags table is missing, entire query fails
   }
   ```
   - Admin dashboard crashes if any single table is missing
   - No graceful degradation
   - **On deployment, if migration doesn't apply, Admin shows 500 error**

2. **Orphan Records Are Not Cleaned** (2/10)
   ```typescript
   const orphans = Array.isArray(orphanAudit.data) ? orphanAudit.data : [];
   // Lists orphan HR IDs, but doesn't DELETE them
   ```
   - Admin dashboard reports orphans, but provides no cleanup action
   - Orphans accumulate over time
   - **No cascade delete** when employee is removed

3. **Sales Classification Is Computed On-Demand** (3/10)
   ```typescript
   async function getDataHealthStats(): Promise<DataHealthStats> {
     const [directory, appAuthUsers, accessProfiles, salesRows, ...] = await Promise.all([...]);
     // Fetches ALL sales records, ALL employees, ALL vacancies
     // No pagination, no filtering
   }
   ```
   - Fetches **all rows** from `sales_records`, `employees`, `vacancies`
   - For large orgs (10k+ employees), this can timeout
   - **No caching** — Admin dashboard refresh = full re-scan

4. **Sales Ownership Linkage Is Opaque** (3/10)
   ```typescript
   const ownershipContext = buildSalesOwnershipContext({
     areaIdByName,
     employees: employeeNodes,
     lineIdByAreaId,
     lineIdByName,
     vacancies: vacancyRows.map(vacancySignalFromRow),
   });
   
   for (const row of salesRows) {
     const ownership = classifySalesOwnership(salesOwnershipRecordFromRow(row), ownershipContext);
     // Classification logic is in separate module
   }
   ```
   - Sales ownership calculation is **magic**: not auditable, not versioned
   - If business rule changes, can't tell which sales records were classified under old vs. new rule
   - **No re-classification** on employee/territory changes

5. **Health Status Is Flagged But Not Actioned** (2/10)
   ```typescript
   if (healthStatus !== "ok") {
     employeeIssues.push({...});  // Lists issues, but doesn't resolve
   }
   ```
   - Admin sees list of broken employees
   - But no "Fix" button; requires manual reconciliation
   - No auto-remediation

### Workflow Opinion
⚠️ **Admin Service is **read-only reporting, not operational**:
- Aggregates health stats but provides no corrective actions
- Classifies sales records but provides no reconciliation
- Reports orphans but doesn't clean them
- **No enforcement**: Health issues are flagged, not prevented

### Cross-Model Linkage: Admin Sources of Truth
- ✅ Admin reads employees table (source of truth for directory)
- ❌ **But Payroll, Leave, Coaching cache employee data; changes don't propagate**
- ❌ **Changes to employees table don't trigger downstream updates**
- ❌ **Health stats are snapshot at read-time; stale by next request**

**Recommendation**:
- **Implement schema versioning**: require all tables to exist before serving requests
- **Add cleanup actions**: Admin can trigger orphan deletion, status reset
- **Cache health stats for 5 min**: avoid re-scanning entire dataset on each refresh
- **Version sales classification logic**: track which employees were classified under which rule
- **Add webhooks/events**: when employee/sales changes, emit event to invalidate downstream caches
- **Auto-remediation**: disable broken employees, escalate to manager

---

## 7. DATA LINKAGE MATRIX: The Central Problem

| Source | Target | Linkage Type | Status | Risk |
|--------|--------|--------------|--------|------|
| Admin `employees.hr_id` | Payroll `salary_records.hr_id` | FK (soft) | ❌ No FK | High |
| Admin `employees.hr_id` | Leave `leave_requests.employee_key` | Key match | ❌ None | **Critical** |
| Admin `employees.hr_id` | Coaching `coaching_reports.medical_rep_hr_id` | FK (soft) | ❌ No FK | High |
| Admin `employees.hire_date` | Leave entitlement balance | Denorm | ❌ Cached | Medium |
| Admin `employees.manager_hr_id` | Leave approval routing | Denorm | ❌ Cached | High |
| Admin `lines.id` | Coaching `coaching_reports.line_id` | FK (soft) | ❌ No FK | Medium |
| Payroll `salary_batches.id` | Payroll `salary_records.batch_id` | FK | ✅ Yes | Low |
| Offers `job_offers.id` | Offers audit | Manual | ⚠️ Strings | Medium |

**Finding**: Only **1 of 8** critical linkages has proper FK constraints. Most use **soft matches on string columns**.

### The Cascade Problem
1. **Admin deletes employee** → Orphan records in Payroll, Leave, Coaching (no FK cascade)
2. **Admin changes employee HR ID format** → Payroll/Leave/Coaching can't match (normalization mismatch)
3. **Admin changes hire date** → Leave balance not recalculated (cached snapshot)
4. **Admin changes manager** → Leave approval still goes to old manager (cached in request)
5. **Admin changes line** → Coaching reports show old line (denormalized, not updated)

---

## 8. WORKFLOW STATE MACHINES: The Fragmentation Problem

| Domain | Workflow | Atomicity | Idempotency | Rollback |
|--------|----------|-----------|-------------|----------|
| Payroll | Upload → Approve → Pay1 → Pay2 → Lock | ❌ None | ❌ None | ❌ None |
| Offers | Draft → Sent → Accept → Approve → Onboard | ❌ None | ❌ Partial | ❌ None |
| Leave | Draft → PendingMgr → MgrApproved → PendingHR → HRApproved → Payout | ❌ None | ⚠️ Stale | ❌ None |
| Coaching | Draft → Submitted → ReviewedByEmployee → Locked | ⚠️ RPC wraps | ✅ Idempotent | ⚠️ Partial |

**Finding**: Most workflows use sequential API calls with **no transactions**, **no version checks**, **no rollbacks**.

### Failure Modes
- **Payroll**: Admin approves, system crashes before status update → payroll stuck in "under review"
- **Offers**: Approval succeeds, employee creation fails → offer marked hired but no employee record
- **Leave**: Manager and HR both click approve simultaneously → state undefined
- **Coaching**: Submission RPC partially succeeds → scores saved, status not updated

---

## 9. RECOMMENDATIONS: Unified Data Linkage Architecture

### Phase 1: FK Constraints (Week 1)
```sql
-- Add missing FKs
ALTER TABLE salary_records ADD CONSTRAINT fk_batch_id
  FOREIGN KEY (batch_id) REFERENCES salary_batches(id) ON DELETE CASCADE;

ALTER TABLE leave_requests ADD CONSTRAINT fk_employee_hr_id
  FOREIGN KEY (employee_hr_id) REFERENCES employees(hr_id) ON DELETE CASCADE;

ALTER TABLE coaching_reports ADD CONSTRAINT fk_medical_rep_hr_id
  FOREIGN KEY (medical_rep_hr_id) REFERENCES employees(hr_id) ON DELETE CASCADE;

ALTER TABLE coaching_reports ADD CONSTRAINT fk_coach_hr_id
  FOREIGN KEY (coach_hr_id) REFERENCES employees(hr_id) ON DELETE CASCADE;

ALTER TABLE job_offers ADD CONSTRAINT fk_manager_hr_id
  FOREIGN KEY (manager_hr_id) REFERENCES employees(hr_id) ON DELETE SET NULL;
```

### Phase 2: Normalize HR ID (Week 2)
```typescript
// Single HR ID normalization function
export function normalizeHrId(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  // Consistent rule: always UPPERCASE, trim whitespace
  return text.length > 0 ? text : null;
}

// Use consistently across all services
// Remove normalizeHrIdForAccess() and normalizePayrollPaymentMode()
// Single source of truth for normalization
```

### Phase 3: Transactional Workflows (Week 3)
```typescript
// Payroll: Wrap state transitions in transaction
export async function approveSalaryBatch(batchId: string, approverHrId: string) {
  const supabase = getSupabaseAdmin();
  return supabase.rpc("transact_approve_salary_batch", {
    p_batch_id: batchId,
    p_approver_hr_id: approverHrId,
    p_now: new Date().toISOString(),
  });
}

// PostgreSQL RPC wraps all updates in single transaction
// Atomic success/failure, no partial states
```

### Phase 4: Cache Invalidation (Week 4)
```typescript
// Pub/Sub: Listen for employee directory changes
supabase
  .channel("employee_changes")
  .on(
    "postgres_changes",
    {
      event: ["UPDATE", "DELETE"],
      schema: "public",
      table: "employees",
    },
    async (payload) => {
      // Invalidate dependent caches
      invalidatePayrollCache(payload.new?.hr_id);
      invalidateLeaveBalance(payload.new?.hr_id);
      invalidateCoachingReports(payload.new?.hr_id);
    }
  )
  .subscribe();

// Portal subscribes and invalidates local state
```

### Phase 5: Cross-Domain Sync (Week 5)
```typescript
// When employee created/updated in Admin, trigger sync
export async function syncEmployeeToDownstreamSystems(hrId: string) {
  const [employee, payroll, leave, coaching] = await Promise.all([
    getEmployeeById(hrId),
    getPayrollRecordsForEmployee(hrId),
    getLeaveRequestsForEmployee(hrId),
    getCoachingReportsForEmployee(hrId),
  ]);

  // Recalculate leave balance if hire date changed
  if (employee.hireDateChanged) {
    await recalculateLeaveBalance(hrId);
  }

  // Update payroll hire date cache
  if (employee.hireDateChanged || employee.lineChanged) {
    await invalidatePayrollCache(hrId);
  }

  // Emit change event for Portal cache invalidation
  await emitEvent("employee_updated", { hrId, changes: employee.changes });
}
```

---

## 10. FINAL SCORECARD

| Domain | Current Score | Issues | Urgency |
|--------|---------------|--------|---------|
| Payroll | 3/10 | Dual-key brittleness, hard-coded actors, stale calculations | 🔴 High |
| Offers | 2/10 | GET side effects, no transactions, stale lookups | 🔴 Critical |
| Leave | 4/10 | Email-based key, cached balance, stale manager | 🔴 High |
| Coaching | 5/10 | No FKs, hard-coded roles, stale names | 🟡 Medium |
| Portal | 3/10 | Stale cache, no invalidation, fragmented views | 🔴 High |
| Admin | 4/10 | No schema enforcement, orphans not cleaned | 🟡 Medium |
| **Data Linkage** | **2/10** | **No FKs, multiple normalization schemes, no cache invalidation** | 🔴 **Critical** |

---

## Conclusion

Phoenix Workforce is a **feature-rich but fragmented system**. Each domain (Payroll, Offers, Leave, Coaching) operates independently with its own data model and normalization rules. **There is no single source of truth for employee identity**, leading to cascading data inconsistencies:

- Admin updates employee, Portal shows stale data
- Employee changes email, Leave requests become orphaned
- Employee deleted, Payroll records remain (no cascade delete)
- Workflow transitions are not atomic; crashes leave system in intermediate states

**The system is unsuitable for production without**:
1. ✅ FK constraints on all employee/batch references
2. ✅ Single HR ID normalization function
3. ✅ Transactional workflow state machines
4. ✅ Cache invalidation on data changes
5. ✅ Cross-domain sync triggers

**Estimated remediation time: 6-8 weeks** for a full overhaul.
