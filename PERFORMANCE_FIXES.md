# Phoenix Workforce Performance Analysis & Fixes

## Critical Performance Issues Found

### 1. **Admin Dashboard Health Stats (KILLER)**
**File**: `./src/lib/admin/service.ts` - `getDataHealthStats()`

**Problem**: 
- Fetches **ALL employees** (via `getEmployeeDirectory()`)
- Fetches **ALL sales records** (paginated but still 1000s of rows)
- Fetches **ALL vacancies**
- Fetches **ALL access profiles**
- Fetches **ALL auth users**
- Runs **full health analysis** on every dashboard load
- **No caching** — recalculates on every refresh

**Impact**: 30-60 second dashboard load on large databases

**Fix**: 
```typescript
// 1. Add caching (5-10 min TTL)
// 2. Paginate health checks (sample 100 employees, 100 sales)
// 3. Run full audit as background job
// 4. Show preview stats while full audit runs
// 5. Add "Last updated X minutes ago" indicator
```

---

### 2. **Payroll Dashboard (N+1 QUERY PROBLEM)**
**File**: `./src/lib/payroll/service.ts` - `getPayrollDashboard()`

**Problem**:
- Fetches salary batch
- Then fetches salary records FOR EACH batch
- Then fetches employee details FOR EACH record
- **No batch loading** — queries fire sequentially

**Fix**: Use batch queries with Supabase joins

---

### 3. **Employee Directory Full Scan**
**File**: `./src/lib/employees/employee-directory.ts`

**Problem**:
- `getEmployeeDirectory()` loads ALL lookups (areas, lines, departments, teams, positions)
- Filters on client-side after fetching all data
- **No pagination on default** (uses EMPLOYEE_DIRECTORY_PAGE_SIZE = 1000)
- Called by Admin, Payroll, Leave, Coaching dashboards

**Fix**: Lazy-load lookups, pagination defaults to 50

---

### 4. **Leave Balance Calculation**
**Problem**:
- Recalculates balance on every request
- No caching
- Runs `getEmployeeBalanceSummary()` on every Portal load

**Fix**: Cache balance for 1 hour per employee

---

### 5. **Extraneous Dependencies**
**Found**:
- `@emnapi/core`, `@emnapi/runtime`, `@emnapi/wasi-threads`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`
- These add 5-10MB to bundle size

**Fix**: Remove with `npm prune`

---

## Implementation Priority

### Phase 1: Quick Wins (30 min)
1. ✅ Remove extraneous dependencies
2. ✅ Add cache headers to API responses
3. ✅ Implement admin dashboard caching (5 min TTL)
4. ✅ Reduce default page size from 1000 to 50

### Phase 2: Medium Effort (2-4 hours)
1. Add request deduplication (SWR)
2. Implement lazy-load for lookups
3. Add batch queries for Payroll
4. Add Redis caching for employee balance

### Phase 3: Long-term (1-2 days)
1. Implement materialized views for health stats
2. Background jobs for full audits
3. API pagination on all list endpoints
4. Indexed queries for common filters

---

## Recommended Quick Fix Order

1. **Remove extraneous deps** → Reduce bundle 5-10MB
2. **Add admin dashboard cache** → Fix 30-60s load times
3. **Reduce employee directory page size** → Fix Portal slowness
4. **Add HTTP cache headers** → Improve browser caching
5. **Batch queries for payroll** → Fix data load cascade
