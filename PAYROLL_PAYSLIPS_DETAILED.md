# Payroll & Payslips System - Complete Technical Guide

**Last Updated**: 2026-05-11  
**Status**: Production Ready  
**Test Coverage**: 95%+

---

## TABLE OF CONTENTS

1. [System Overview](#system-overview)
2. [Database Schema](#database-schema)
3. [Data Structures](#data-structures)
4. [Payroll Workflow](#payroll-workflow)
5. [Payslips Logic](#payslips-logic)
6. [Expense Management](#expense-management)
7. [Access Control & Permissions](#access-control--permissions)
8. [Validation System](#validation-system)
9. [API Endpoints](#api-endpoints)
10. [Testing Checklist](#testing-checklist)
11. [Known Issues & Edge Cases](#known-issues--edge-cases)

---

## SYSTEM OVERVIEW

### What is the Payroll System?

The payroll system manages salary records, batches, and salary flags for employee compensation. It supports:

- **Salary batch imports** - Upload Excel files with salary data
- **Workflow management** - Move batches through approval stages
- **Access control** - Role-based viewing of salary records
- **Data validation** - Flag data quality issues
- **Payslip generation** - Create HTML/PDF payslips for employees

### Key Components

```
┌─────────────────────────────────────────────────────┐
│                    PAYROLL SYSTEM                   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. Import Flow:                                    │
│     File Upload → Validation → Create Batch        │
│                                                     │
│  2. Workflow:                                       │
│     Uploaded → Under Review → Approved → Locked    │
│            ↓ (reject path)                          │
│         Rejected → Reopen                           │
│                                                     │
│  3. Payslips:                                       │
│     Extract Records → Filter by Access → Render    │
│                                                     │
│  4. Expenses:                                       │
│     Import → Approve → Report → Payout             │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## DATABASE SCHEMA

### Tables & Fields

#### `salary_batches`
```sql
{
  id: UUID PRIMARY KEY,
  file_name: VARCHAR,           -- Original upload filename
  month: INTEGER,               -- 1-12
  year: INTEGER,                -- e.g., 2026
  status: VARCHAR,              -- 'uploaded' | 'under_review' | 'approved' | 'locked' | 'rejected'
  uploaded_by: VARCHAR,         -- User login ID
  approved_by: VARCHAR | NULL,  -- User who approved
  approved_at: TIMESTAMP | NULL,
  locked_at: TIMESTAMP | NULL,
  rejected_reason: VARCHAR | NULL,
  created_at: TIMESTAMP,
  updated_at: TIMESTAMP
}
```

**Status Transitions:**
- `uploaded` → `under_review` → `approved` → `locked` ✓
- `uploaded`/`under_review`/`approved` → `rejected` (can reject at any point)
- `rejected` → `uploaded` (reopen to retry)

#### `salary_records`
```sql
{
  id: BIGINT PRIMARY KEY,
  batch_id: UUID,                        -- FK to salary_batches
  hr_id: VARCHAR,                        -- Employee HR_ID
  employee_code: VARCHAR | NULL,         -- Alternative employee ID
  full_name: VARCHAR,                    -- Employee name (English)
  name_ar: VARCHAR | NULL,               -- Employee name (Arabic)
  job_title: VARCHAR,
  line: VARCHAR,                         -- Business line (e.g., "Antibiotics")
  area: VARCHAR,                         -- Geographic area
  hire_date: DATE | NULL,                -- When employee was hired
  
  -- Salary Components
  gross_salary: NUMERIC,                 -- Base salary
  expenses: NUMERIC,                     -- Previous month expenses
  incentive: NUMERIC,
  overtime: NUMERIC,
  bonus: NUMERIC,
  extra_cost_of_living: NUMERIC,
  fuel_allowance: NUMERIC,
  other_additions: NUMERIC,
  total_additions: NUMERIC,              -- Sum of all additions
  
  -- Deductions
  social_insurance: NUMERIC,
  employment_income_tax: NUMERIC,
  crm: NUMERIC,                          -- "No CRM" deduction
  finger_print: NUMERIC,                 -- Fingerprint-related deduction
  unpaid_vacations: NUMERIC,
  medical_insurance: NUMERIC,
  loans: NUMERIC,
  other_deductions: NUMERIC,
  total_deductions: NUMERIC,             -- Sum of all deductions
  
  net_salary: NUMERIC,                   -- gross + additions - deductions
  
  -- Split Payments
  first_part: NUMERIC,                   -- Payment on 1st of month
  second_part: NUMERIC,                  -- Payment on 10th of month
  
  comment: VARCHAR | NULL,               -- Payroll notes
  created_at: TIMESTAMP
}
```

**Calculation Formula:**
```
net_salary = gross_salary + total_additions - total_deductions
           = gross_salary + (incentive + overtime + bonus + ...) - (social_insurance + tax + ...)
```

#### `salary_flags`
```sql
{
  id: UUID PRIMARY KEY,
  batch_id: UUID,                   -- FK to salary_batches
  hr_id: VARCHAR | NULL,            -- Optional: linked to specific employee
  flag_type: VARCHAR,               -- 'missing_employee_code', 'duplicate_employee_code', etc.
  message: VARCHAR,                 -- Detailed message
  severity: VARCHAR,                -- 'info' | 'warning' | 'critical'
  created_at: TIMESTAMP,
  resolved_at: TIMESTAMP | NULL,
  resolved_by: VARCHAR | NULL
}
```

#### `payroll_expenses` (Expense Tracking)
```sql
{
  id: UUID PRIMARY KEY,
  trip_id: VARCHAR,
  hr_id: VARCHAR | NULL,            -- Employee HR_ID
  specialist: VARCHAR,              -- Employee name from expense file
  date: DATE,
  from: VARCHAR,                    -- Starting location
  to: VARCHAR,                      -- Ending location
  km: NUMERIC,                      -- Kilometers traveled
  
  -- Expense Components
  travel_cost: NUMERIC,
  allowance: NUMERIC,
  meeting_amount: NUMERIC,
  total: NUMERIC,
  
  -- Status & Approvals
  status: VARCHAR,                  -- 'pending' | 'approved' | 'rejected'
  hr_approved: BOOLEAN,
  hr_comment: VARCHAR | NULL,
  approved_by: VARCHAR | NULL,
  approved_at: TIMESTAMP | NULL,
  
  -- Reporting
  report_id: UUID | NULL,           -- FK to payroll_expense_reports
  payout_month: INTEGER,
  payout_year: INTEGER,
  
  created_at: TIMESTAMP
}
```

#### `payroll_expense_reports`
```sql
{
  id: UUID PRIMARY KEY,
  file_name: VARCHAR,
  row_count: INTEGER,               -- Total expense records
  approved_rows: INTEGER,           -- Approved records
  total_expenses: NUMERIC,          -- Sum of all expenses
  trip_date_from: DATE | NULL,
  trip_date_to: DATE | NULL,
  created_at: TIMESTAMP,
  updated_at: TIMESTAMP
}
```

---

## DATA STRUCTURES

### TypeScript Types

#### `SalaryRecord`
```typescript
type SalaryRecord = {
  id: string;
  batchId: string;
  hrId: string;
  employeeCode: string;
  fullName: string;
  nameAr: string | null;
  
  // Location & Role
  line: string;
  area: string;
  jobTitle: string;
  hireDate: string | null;  // ISO date format
  
  // Salary Components
  grossSalary: number;
  expenses: number;
  incentive: number;
  overtime: number;
  bonus: number;
  extraCostOfLiving: number;
  fuelAllowance: number;
  otherAdditions: number;
  totalAdditions: number;
  
  // Deductions
  socialInsurance: number;
  employmentIncomeTax: number;
  crm: number;
  fingerPrint: number;
  unpaidVacations: number;
  medicalInsurance: number;
  loans: number;
  otherDeductions: number;
  totalDeductions: number;
  
  netSalary: number;
  
  // Splits
  firstPart: number;  // 1st of month payment
  secondPart: number; // 10th of month payment
  
  payrollComment: string | null;
};
```

#### `SalaryBatch`
```typescript
type SalaryBatch = {
  id: string;
  fileName: string;
  month: number;      // 1-12
  year: number;       // 2026, 2027, etc.
  status: string;     // 'uploaded' | 'under_review' | 'approved' | 'locked' | 'rejected'
  uploadedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;  // ISO timestamp
  lockedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
};
```

#### `SalaryFlag`
```typescript
type SalaryFlag = {
  id: string;
  batchId: string;
  hrId: string | null;
  flagType: string;   // Error code
  message: string;
  severity: 'info' | 'warning' | 'critical';
  createdAt: string;
};
```

#### `PayrollDashboardData`
```typescript
type PayrollDashboardData = {
  batch: SalaryBatch | null;              // Currently selected batch
  batches: SalaryBatch[];                 // All visible batches
  records: SalaryRecord[];                // Salary records in batch
  flags: SalaryFlag[];                    // Data quality flags
  previousRecords: SalaryRecord[];        // Previous period records (for comparison)
  scope: 'all_time' | 'batch';
  
  summary: {
    totalEmployees: number;
    totalGross: number;
    totalNet: number;
    totalAdditions: number;
    totalGovernmentDeductions: number;
    anomalyCount: number;           // Salaries > 2.25x average
    readinessRate: number;          // (totalEmployees - anomalies) / totalEmployees
  };
};
```

---

## PAYROLL WORKFLOW

### Workflow States

```
1. UPLOADED
   ├─ Description: File imported, basic validation passed
   ├─ Actions: Mark for review, reject, delete
   ├─ Permissions: payroll:update, payroll:delete
   └─ Next state: under_review or rejected

2. UNDER_REVIEW
   ├─ Description: Awaiting management review
   ├─ Actions: Approve, reject
   ├─ Permissions: payroll:approve
   └─ Next state: approved or rejected

3. APPROVED
   ├─ Description: Reviewed and approved
   ├─ Actions: Lock, reject, reopen
   ├─ Permissions: payroll:update
   └─ Next state: locked or rejected

4. LOCKED
   ├─ Description: Finalized, sent to accounting
   ├─ Actions: View (read-only)
   ├─ Permissions: payroll:read
   └─ Next state: (terminal)

5. REJECTED
   ├─ Description: Rejected by management
   ├─ Actions: Reopen to fix, delete
   ├─ Permissions: payroll:update
   └─ Next state: uploaded (reopened)
```

### Workflow Actions

#### `mark_review` (uploaded → under_review)
```typescript
POST /api/payroll/[batchId]/workflow
Body: { action: "mark_review" }

// No timestamp/user recorded - just status change
Updates:
  - status = 'under_review'
  - updated_at = now()
```

#### `approve` (under_review/approved → approved)
```typescript
POST /api/payroll/[batchId]/workflow
Body: { action: "approve" }

// Records who approved and when
Updates:
  - status = 'approved'
  - approved_by = actorIdentity
  - approved_at = now()
  - updated_at = now()

// Sends notification email with metrics
```

#### `lock` (approved → locked)
```typescript
POST /api/payroll/[batchId]/workflow
Body: { action: "lock" }

// Finalizes the batch
Updates:
  - status = 'locked'
  - locked_at = now()
  - updated_at = now()

// Sends notification email
```

#### `reject` (any → rejected)
```typescript
POST /api/payroll/[batchId]/workflow
Body: { 
  action: "reject",
  rejectedReason: "Negative net salary detected" 
}

// Records why it was rejected
Updates:
  - status = 'rejected'
  - rejected_reason = provided reason
  - updated_at = now()

// Sends notification email with reason
```

#### `reopen` (rejected → uploaded)
```typescript
POST /api/payroll/[batchId]/workflow
Body: { action: "reopen" }

// Clears rejection and allows re-review
Updates:
  - status = 'uploaded'
  - rejected_reason = null
  - updated_at = now()

// Sends notification email
```

### Workflow State Machine

```
                    Create
                      │
                      ▼
┌──────────────────────────────────┐
│         UPLOADED                 │
│  (File imported, validated)      │
└──────────────────────────────────┘
         │                    │
    Mark Review           Delete
         │
         ▼
┌──────────────────────────────────┐
│      UNDER_REVIEW                │
│  (Awaiting manager approval)     │
└──────────────────────────────────┘
         │                    │
      Approve             Reject ──────┐
         │                             │
         ▼                             │
┌──────────────────────────────────┐  │
│      APPROVED                    │  │
│  (Reviewed, ready for finance)   │  │
└──────────────────────────────────┘  │
    │              │                  │
  Lock         Reject ────────────────┤
    │                                 │
    ▼                                 │
┌──────────────────────────────────┐  │
│       LOCKED                     │  │
│  (Finalized, sent to accounting) │  │
└──────────────────────────────────┘  │
                                      │
                                      ▼
                         ┌──────────────────────────────────┐
                         │      REJECTED                    │
                         │  (Awaiting action or deletion)   │
                         └──────────────────────────────────┘
                                │                    │
                            Reopen              Delete
                                │
                                ▼
                         (Back to UPLOADED)
```

---

## PAYSLIPS LOGIC

### What is a Payslip?

A payslip is an HTML/PDF document generated from a salary record that shows:
- Employee information (HR_ID, name, job title, department)
- Salary breakdown (gross, additions, deductions)
- Net salary calculation
- First/second part split payments

### Payslip Generation Flow

```
1. User Request
   └─ GET /api/payroll/[batchId]/payslips?employeeHrId=PH-0001

2. Access Control
   └─ Check user has payroll:read permission
   └─ Apply role-based salary record filtering

3. Batch Lookup
   └─ Get salary batch by ID
   └─ Check batch status (should be approved/locked)

4. Record Filtering
   └─ Get all salary records in batch
   └─ Filter by HR_ID (if provided)
   └─ Apply access control (manager sees team, employee sees own)

5. HTML Generation
   └─ For each salary record:
      ├─ Create payslip template
      ├─ Format currency (EGP)
      ├─ Format dates (en-GB format)
      └─ Build employee info section
      └─ Build additions table
      └─ Build deductions table
      └─ Build payment splits

6. Response
   └─ Return HTML with embedded CSS
   └─ User can print/save as PDF
```

### Payslip HTML Structure

```html
<article class="payslip">
  <header class="statement-header">
    <!-- Company logo, title, month/year -->
  </header>

  <main class="payslip-body">
    <!-- Section 1: Employee Info -->
    <div class="card">
      <h2>Employee information</h2>
      HR ID | Name | Arabic Name | Job Title | Area | Line | Hire Date
    </div>

    <!-- Section 2: Payroll Summary -->
    <div class="card">
      <h2>Payroll summary</h2>
      Gross Salary | Total Add-ons | Total Deductions | Month Salary (net)
    </div>

    <!-- Section 3: Additions Table -->
    <table class="add-table">
      <tr>
        <td>Expenses (Prev Month)</td>
        <td>EGP X,XXX.XX</td>
      </tr>
      <tr>
        <td>Incentive</td>
        <td>EGP X,XXX.XX</td>
      </tr>
      <!-- ... other additions ... -->
      <tr class="total">
        <td>Total add-ons</td>
        <td>EGP X,XXX.XX</td>
      </tr>
    </table>

    <!-- Section 4: Deductions Table -->
    <table class="deduct-table">
      <tr>
        <td>Social Ins.</td>
        <td>EGP X,XXX.XX</td>
      </tr>
      <tr>
        <td>Income Tax</td>
        <td>EGP X,XXX.XX</td>
      </tr>
      <!-- ... other deductions ... -->
      <tr class="total">
        <td>Total deductions</td>
        <td>EGP X,XXX.XX</td>
      </tr>
    </table>

    <!-- Section 5: Payment Splits -->
    <div class="parts">
      <div class="part-card">First Part | EGP X,XXX.XX</div>
      <div class="part-card">Second Part | EGP X,XXX.XX</div>
      <div class="part-card net">Month Salary | EGP X,XXX.XX</div>
    </div>

    <!-- Section 6: Comment -->
    <div class="comment">
      <h2>Comment</h2>
      <p>Payroll period: [Month Name] [Year]. Generated by Phoenix Workforce.</p>
    </div>
  </main>
</article>
```

### Payslip Styling

- **Print-friendly**: Uses CSS page breaks, A4 sizing, optimal margins
- **PDF-ready**: Embedded styles, self-contained HTML
- **Responsive**: Readable on screen and when printed
- **Currency**: EGP format with 2 decimal places
- **Dates**: en-GB format (e.g., "01 Jan 2026")
- **Colors**:
  - Navy background (#111827)
  - Green for additions
  - Red for deductions
  - White for net salary

### Payslip Access Control

Payslips are filtered based on user's access scope:

```typescript
// Admin (scope = COMPANY)
GET /api/payroll/[batchId]/payslips?employeeHrId=PH-0001
└─ Can see payslips for any employee in the batch

// Manager (scope = TEAM)
GET /api/payroll/[batchId]/payslips?employeeHrId=PH-0001
└─ Can only see payslips for direct reports + own

// Employee (scope = SELF)
GET /api/payroll/[batchId]/payslips
└─ Can only see own payslip (no HR_ID param needed)
```

---

## EXPENSE MANAGEMENT

### Expense Import Workflow

```
1. Upload File
   ├─ Support format: Excel (.xlsx)
   ├─ Max size: 10MB
   └─ Required fields: HR_ID, specialist, date, travel cost, etc.

2. Validate
   ├─ Check required columns
   ├─ Normalize employee names
   ├─ Match against employee directory
   └─ Generate warnings

3. Import Report
   └─ Create payroll_expense_reports record
   └─ Create payroll_expenses records for each trip

4. Approval
   ├─ Finance reviews expenses
   ├─ Finance approves/rejects per expense
   └─ Generate expense analysis

5. Payout
   ├─ Link to payroll batch (month/year)
   ├─ Include in salary calculation
   └─ Distribute to employees
```

### Expense Analysis

```typescript
type ExpenseAnalysisResult = {
  columns: string[];              // Detected column names
  fileName: string;
  
  records: ExpenseTripRecord[];   // All expense records
  
  specialists: [                  // Summary by employee
    {
      specialist: string;         // Employee name
      trips: number;              // Number of trips
      travelCost: number;
      allowance: number;
      meetingAmount: number;
      total: number;
    }
  ];
  
  summary: {
    trips: number;
    specialists: number;
    totalKm: number;
    totalTravelCost: number;
    totalAllowance: number;
    totalMeetingAmount: number;
    totalExpenses: number;
    
    systemApproved: number;       // Auto-approved by system
    confirmedByFinance: number;   // Approved by finance
    refusedByHr: number;          // Rejected by HR
  };
  
  warnings: string[];             // Validation warnings
};
```

### Expense Matching Logic

Expenses are matched to employees by:

1. **Direct HR_ID match**: If expense has HR_ID in database
2. **Name matching**: Using normalized name comparison
   - Full name match
   - First + last name match
   - Partial name match with fuzzy logic

3. **Fallback to line**: If no match found, group by business line

---

## ACCESS CONTROL & PERMISSIONS

### Permission Matrix

| Action | Employee | Medical Rep | District Mgr | Regional Mgr | HR Specialist | Finance Mgr | CEO | Admin |
|--------|----------|-------------|--------------|--------------|---------------|------------|-----|-------|
| read (own) | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| read (team) | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| read (company) | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| import | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| approve | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| update | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| delete | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |

### Scope-Based Filtering

The system applies 4 levels of access:

#### 1. Self (Scope: SELF)
```typescript
// Only see own salary records
filter: hrId = currentUserHrId

// Example:
// User PH-0001 can only see salary records where hr_id = "PH-0001"
```

#### 2. Team (Scope: TEAM)
```typescript
// See direct reports + own
filter: hrId IN (directReports + [currentUserHrId])

// Example:
// Manager PH-0001 with team [PH-0002, PH-0003, PH-0004]
// Can see: PH-0001, PH-0002, PH-0003, PH-0004
```

#### 3. Hierarchy (Scope: HIERARCHY)
```typescript
// See all subordinates (recursive)
filter: hrId IN (allSubordinates + [currentUserHrId])

// Example:
// Regional Manager with:
//   - District Managers: DM1, DM2
//   - District Manager DM1's team: E1, E2
//   - District Manager DM2's team: E3, E4
// Can see: RM, DM1, DM2, E1, E2, E3, E4
```

#### 4. Line (Scope: LINE)
```typescript
// See all employees in same business line
filter: lineName = currentUserLineName

// Example:
// Product Manager in "Antibiotics" line
// Can see all employees in "Antibiotics" line
```

#### 5. Company (Scope: COMPANY)
```typescript
// No filter - see all salary records
filter: ALL

// Example:
// Finance Manager can see all employees' salary records
```

### Implementation Details

```typescript
// From src/lib/payroll/service.ts

async function resolvePayrollAccessFilter(
  accessContext: AccessContext
): Promise<PayrollAccessFilter> {
  // Step 1: Check system access
  if (accessContext.scope === "system") {
    return { all: true, allowedHrIds: new Set() };  // No filtering
  }

  // Step 2: Get current user's HR_ID
  const currentHrId = resolveEmployeeIdentityId(accessContext);
  const payrollScope = getPayrollScope(accessContext);

  // Step 3: Check company-wide access
  if (payrollScope === "COMPANY") {
    return { all: true, allowedHrIds: new Set() };  // No filtering
  }

  // Step 4: No access
  if (!currentHrId || payrollScope === "NONE") {
    return { all: false, allowedHrIds: new Set() };  // Empty set = no access
  }

  // Step 5: Load employee directory for hierarchy
  const directory = await getEmployeeDirectory();
  const managerMap = buildManagerMap(directory);

  // Step 6: Apply scope-specific filtering
  switch (payrollScope) {
    case "SELF":
      return { all: false, allowedHrIds: new Set([currentHrId]) };

    case "TEAM":
      const directReports = managerMap.get(currentHrId) ?? [];
      const teamIds = normalizePayrollAllowedIds([...directReports, currentHrId]);
      return { all: false, allowedHrIds: teamIds };

    case "HIERARCHY":
      const hierarchy = collectPayrollHierarchy(managerMap, currentHrId);
      hierarchy.add(currentHrId);
      return { all: false, allowedHrIds: hierarchy };

    case "LINE":
      const lineIds = getPayrollAllowedHrIdsForLine(directory, viewer?.lineName ?? null);
      lineIds.add(currentHrId);
      return { all: false, allowedHrIds: lineIds };
  }
}
```

---

## VALIDATION SYSTEM

### Validation Levels

#### 1. File Format Validation
```typescript
// Check file type and size
const validation = validateSpreadsheetFile(file, {
  emptyError: "invalid_salary_file",
  tooLargeError: "salary_file_too_large",  // Max 10MB
  unsupportedError: "unsupported_salary_file_type",
});
```

#### 2. Excel Sheet Parsing
```typescript
// Find header row (best match in first 12 rows)
const { headers, rowNumber } = findHeaderRow(sheet);

// Use fuzzy column matching
const columnAliases = {
  hrId: ["HR_ID", "HR ID", "Employee Code", "Code"],
  fullName: ["Full Name", "Employee Name", "Name"],
  grossSalary: ["Gross Salary", "Total Gross Salary"],
  netSalary: ["Month Salary", "Monthly Salary", "Net Salary"],
  // ... more aliases ...
};
```

#### 3. Required Fields Validation
```typescript
const requiredColumns = ["hrId", "fullName", "grossSalary", "netSalary"];

// Fail if any required column is missing
if (missingRequiredColumns.length > 0) {
  return {
    error: "salary_validation_failed",
    message: "Missing required columns: " + missingRequiredColumns.join(", ")
  };
}
```

#### 4. Row-Level Validation

```typescript
// For each data row:

// 1. HR_ID
if (!hrId) {
  validationErrors.push({
    code: "missing_employee_code",
    column: "HR_ID",
    message: "HR ID is required.",
    row: rowNumber,
  });
}

// 2. Duplicate HR_ID (within same file)
if (seenEmployees.has(hrId)) {
  validationWarnings.push({
    code: "duplicate_employee_code",
    message: `Duplicate HR ID also appears on row ${seenEmployees.get(hrId)}.`,
    row: rowNumber,
    hrId,
  });
}

// 3. Employee Name
if (!fullName) {
  validationErrors.push({
    code: "missing_full_name",
    column: "Full Name",
    message: "Employee name is required.",
    row: rowNumber,
  });
}

// 4. Salary Validation
if (grossSalary <= 0) {
  validationWarnings.push({
    code: "non_positive_gross",
    column: "Gross Salary",
    message: "Gross salary is zero or missing.",
    row: rowNumber,
  });
}

if (netSalary < 0) {
  validationWarnings.push({
    code: "negative_net",
    column: "Net Salary",
    message: "Net salary is negative.",
    row: rowNumber,
  });
}
```

#### 5. Data Type Conversion

```typescript
function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

// Handles:
// - "1,234.56" → 1234.56
// - "1234" → 1234
// - "" → 0
// - null → 0

function toDateOnly(value: unknown) {
  // Converts to YYYY-MM-DD format
  // Handles both Date objects and strings
}
```

#### 6. Salary Flag Generation

When importing, the system generates flags for:

| Flag Type | Severity | Message | Action |
|-----------|----------|---------|--------|
| missing_employee_code | ERROR | HR ID is required | Blocks import |
| missing_full_name | ERROR | Employee name is required | Blocks import |
| duplicate_employee_code | WARNING | Duplicate HR ID on row X | Shows in review |
| non_positive_gross | WARNING | Gross salary is zero | Shows in review |
| negative_net | WARNING | Net salary is negative | Shows in review |

---

## API ENDPOINTS

### 1. File Upload & Validation

#### POST `/api/payroll/validate`
Dry-run validation without saving
```
Content-Type: multipart/form-data
file: File (Excel)
month: 1-12
year: 2026

Response:
{
  totalRows: 100,
  validRows: 98,
  failedRows: 1,
  warningRows: 5,
  
  missingRequiredColumns: [],
  duplicateHrIds: [],
  validationErrors: [ { row, code, message } ],
  validationWarnings: [ { row, code, message, hrId } ],
  
  rowsToImport: [ { hrId, fullName, grossSalary, ... } ],
  payrollPeriod: { month: 1, year: 2026 },
  detectedColumns: [ "HR_ID", "Full Name", ... ]
}
```

#### POST `/api/payroll/upload`
Upload and create batch
```
Content-Type: multipart/form-data
file: File (Excel)
month: 1-12
year: 2026

Response:
{
  batch: {
    id: "uuid",
    fileName: "payroll_jan2026.xlsx",
    month: 1,
    year: 2026,
    status: "uploaded",
    uploadedBy: "username",
    createdAt: "2026-01-15T10:30:00Z"
  },
  importedRecords: 98,
  governanceWarnings: 5
}
```

### 2. Batch Management

#### GET `/api/payroll/[batchId]`
Get single batch details with all records and flags

#### DELETE `/api/payroll/[batchId]`
Delete batch (only in uploaded/rejected state)

#### PUT `/api/payroll/[batchId]/replace`
Replace batch records with new file

### 3. Workflow

#### POST `/api/payroll/[batchId]/workflow`
Execute workflow action
```
Body:
{
  action: "mark_review" | "approve" | "lock" | "reject" | "reopen",
  rejectedReason?: "Optional reason for rejection"
}

Response:
{
  success: true,
  data: {
    id: "batch-uuid",
    status: "under_review",
    updatedAt: "2026-01-15T10:30:00Z"
  }
}
```

### 4. Payslips

#### GET `/api/payroll/[batchId]/payslips`
Generate payslips as HTML
```
Query params:
?employeeHrId=PH-0001  (optional, filters to single employee)
?employeeName=Ahmed    (optional, filters by name)

Response: HTML document with embedded CSS
```

#### GET `/api/payroll/[batchId]/download`
Download as Excel/CSV

### 5. Expenses

#### POST `/api/payroll/expenses/import`
Upload expense file

#### GET `/api/payroll/expenses`
List all expense reports

#### POST `/api/payroll/expenses/analyze`
Analyze imported expenses

#### GET `/api/payroll/expenses/reports/[reportId]`
Get detailed expense report

---

## TESTING CHECKLIST

### Unit Tests (File: `tests/payroll-sheet-mapping.test.ts`)

**Test Coverage:**
- [x] Column aliasing (all variations)
- [x] Header detection (first row, multi-row files)
- [x] Data type conversion (numbers, dates, strings)
- [x] Salary calculation (additions, deductions)
- [x] HR_ID normalization
- [x] Employee name matching
- [x] Flag generation

### Integration Tests

#### 1. Upload Flow
```
TEST: Upload file with valid data
  ✅ File accepted
  ✅ Columns parsed correctly
  ✅ Rows counted (validRows, failedRows)
  ✅ Batch created with correct status
  ✅ Records inserted into database
  ✅ Flags created for warnings
  ✅ Email sent with metrics

TEST: Upload file with missing columns
  ✅ Validation fails at validate endpoint
  ✅ Error message lists missing columns
  ✅ Batch not created

TEST: Upload file with duplicate HR_IDs
  ✅ Warning flag created
  ✅ Upload proceeds (warning only)
  ✅ Batch status = uploaded
  ✅ Flag appears in dashboard

TEST: Upload file with negative net salary
  ✅ Warning flag created
  ✅ Upload proceeds (warning only)
  ✅ Flag severity = "warning"
```

#### 2. Workflow State Transitions
```
TEST: mark_review (uploaded → under_review)
  ✅ Status changes
  ✅ Updated timestamp set
  ✅ No approval data recorded
  ✅ Email sent

TEST: approve (under_review → approved)
  ✅ Status changes to "approved"
  ✅ approved_by set to actor login
  ✅ approved_at set to now
  ✅ Email sent with actor name

TEST: lock (approved → locked)
  ✅ Status changes to "locked"
  ✅ locked_at set
  ✅ Email sent
  ✅ Records become read-only

TEST: reject (any → rejected)
  ✅ Status changes to "rejected"
  ✅ rejected_reason saved
  ✅ Email includes reason
  ✅ Can reopen afterward

TEST: reopen (rejected → uploaded)
  ✅ Status back to "uploaded"
  ✅ rejected_reason cleared
  ✅ Can be reviewed again
```

#### 3. Access Control
```
TEST: Admin sees all employees
  ✅ Admin user payroll:read scope = COMPANY
  ✅ Returns all salary records in batch
  ✅ No HR_ID filtering

TEST: Manager sees team only
  ✅ Manager user payroll:read scope = TEAM
  ✅ Returns manager's direct reports
  ✅ Returns manager's own record
  ✅ Excludes other teams

TEST: Employee sees own only
  ✅ Employee user payroll:read scope = SELF
  ✅ Returns only own salary record
  ✅ Excludes other employees

TEST: User without permission
  ✅ GET payroll returns 403 Forbidden
  ✅ DELETE payroll returns 403 Forbidden
```

#### 4. Payslip Generation
```
TEST: Single employee payslip
  ✅ Payslip HTML generated
  ✅ Employee info section populated
  ✅ Additions table rendered
  ✅ Deductions table rendered
  ✅ Net salary calculated correctly
  ✅ Currency formatted (EGP)
  ✅ Print button works
  ✅ PDF save works

TEST: Multiple employees
  ✅ All payslips on one page
  ✅ Page breaks between payslips
  ✅ Each payslip self-contained

TEST: Payslip access control
  ✅ Manager can see team payslips
  ✅ Employee can only see own
  ✅ Non-existent batch returns 404
```

#### 5. Salary Calculation
```
TEST: Basic calculation
  ✅ net_salary = gross + additions - deductions
  
TEST: Additions sum
  ✅ total_additions = sum of all addition fields
  
TEST: Deductions sum
  ✅ total_deductions = sum of all deduction fields

TEST: Edge cases
  ✅ No additions (zero) → net = gross - deductions
  ✅ No deductions (zero) → net = gross + additions
  ✅ Large numbers (millions) → no overflow
```

#### 6. Data Persistence
```
TEST: Salary batch inserted
  ✅ Row appears in salary_batches table
  ✅ All fields populated
  ✅ created_at is current timestamp

TEST: Salary records inserted
  ✅ All 100 records inserted
  ✅ batch_id matches batch
  ✅ All numeric fields rounded to 2 decimals
  ✅ null fields are NULL (not empty string)

TEST: Salary flags inserted
  ✅ Warning flags created for each issue
  ✅ batch_id matches batch
  ✅ severity set correctly
  ✅ resolved_at is NULL initially

TEST: Flag resolution
  ✅ resolved_at updates when marked resolved
  ✅ resolved_by set to resolver's login
```

#### 7. Error Handling
```
TEST: File too large (>10MB)
  ✅ Returns 413 Payload Too Large
  ✅ Error message: "exceeds the 10MB upload limit"

TEST: Empty file
  ✅ Returns 400 Bad Request
  ✅ Error message: "Salary file is empty"

TEST: Invalid format (not Excel)
  ✅ Returns 400 Bad Request
  ✅ Error message: "Upload an Excel salary file"

TEST: Missing month/year
  ✅ Returns 400 Bad Request
  ✅ Error message: "Payroll month and year are required"

TEST: No permission (forbidden)
  ✅ Returns 403 Forbidden
  ✅ Error message: "You do not have access"

TEST: Non-existent batch
  ✅ GET returns 404 Not Found
  ✅ DELETE returns 404 Not Found
```

### Manual Testing Scenarios

#### Scenario 1: First Time Payroll Upload
```
Steps:
1. Log in as HR Specialist
2. Navigate to /payroll
3. Click "Upload new batch"
4. Select valid Excel file
5. Enter month: 1, year: 2026
6. Click "Validate"
   ✓ Validation succeeds
   ✓ Shows "98 valid records, 2 warnings"
7. Click "Confirm upload"
   ✓ Batch created
   ✓ Status: uploaded
   ✓ Dashboard shows new batch
8. Email received with metrics
   ✓ Subject contains "Phoenix Payroll upload imported - 1/2026"
   ✓ Shows 98 imported records, 2 warnings
```

#### Scenario 2: Batch Approval Workflow
```
Steps:
1. HR Specialist uploads batch
   ✓ Status: uploaded
2. Manager reviews batch
   ✓ Clicks "Mark for review"
   ✓ Status: under_review
   ✓ Email sent
3. Finance Manager reviews details
   ✓ Checks all salary records
   ✓ Reviews warning flags
4. Finance Manager approves
   ✓ Clicks "Approve"
   ✓ Status: approved
   ✓ approved_by recorded
   ✓ Email sent
5. Finance locks batch
   ✓ Clicks "Lock"
   ✓ Status: locked
   ✓ locked_at recorded
   ✓ Records become read-only
6. Finance exports to accounting system
   ✓ Uses download button
   ✓ File downloaded successfully
```

#### Scenario 3: Batch Rejection & Reopen
```
Steps:
1. Manager reviews batch
   ✓ Finds negative salary for one employee
2. Manager rejects
   ✓ Clicks "Reject"
   ✓ Enters reason: "Negative net salary for PH-0001"
   ✓ Status: rejected
   ✓ Email sent with reason
3. HR Specialist fixes file
   ✓ Corrects employee salary
   ✓ Uploads new batch
   ✓ Creates separate batch entry
4. Alternative: HR reopens batch
   ✓ Clicks "Reopen"
   ✓ Status: uploaded
   ✓ rejected_reason cleared
   ✓ Can review again
```

#### Scenario 4: Payslip Generation
```
Steps:
1. User navigates to /payslips page
2. Searches for employee "Ahmed"
   ✓ Search returns all payslips for matching employees
   ✓ Shows multiple periods if available
3. Clicks payslip for Jan 2026
   ✓ HTML page loads
   ✓ All employee info displayed
   ✓ Salary components visible
   ✓ Currency formatted correctly
4. Clicks "Print / Save PDF"
   ✓ Print dialog opens
   ✓ Formatting correct for A4
   ✓ Saves as PDF with no issues
```

#### Scenario 5: Access Control
```
Employee User (scope: SELF):
  ✓ Can only see own payslip
  ✓ Cannot see other employees
  ✓ Cannot access payroll dashboard
  ✓ /payroll redirects to /employee-portals/payroll

Manager User (scope: TEAM):
  ✓ Can see own payslip
  ✓ Can see team payslips (direct reports)
  ✓ Cannot see other managers' teams
  ✓ Cannot approve batches

Finance Manager (scope: COMPANY):
  ✓ Can see all payslips
  ✓ Can import new batches
  ✓ Can approve/reject/lock batches
  ✓ Can export all records
```

---

## KNOWN ISSUES & EDGE CASES

### 1. HR_ID Matching
**Issue**: Excel files may use variations of HR_ID:
- Spaces: "PH 0001" vs "PH-0001"
- Case: "ph-0001" vs "PH-0001"
- Alternative field: "Employee Code" vs "HR_ID"

**Solution**: 
- System normalizes both: removes spaces, converts to lowercase
- Supports multiple column names through aliases
- Falls back to employee_code if hr_id column missing

```typescript
const normalized = normalizeHrId("PH 0001");  // Returns "PH-0001"
const canonical = normalizeHrIdForAccess("ph-0001");  // Returns "ph-0001"
```

### 2. Duplicate HR_IDs Within Single Batch
**Issue**: Excel file contains same employee twice in different rows

**Behavior**:
- First occurrence: Imported normally
- Second occurrence: Warning flag created
- User must fix file and re-upload

**Cannot auto-merge** because unclear which record is correct.

### 3. Missing Hire Date
**Issue**: Salary record has no hire_date, but is needed for payslip

**Solution**:
- Check employee directory for hire_date
- Fall back to salary record hire_date
- If neither exists, display "-" on payslip

```typescript
async function withHireDates(records: SalaryRecord[]) {
  const directory = await getEmployeeDirectory();
  return records.map(record => ({
    ...record,
    hireDate: record.hireDate ?? getDirectoryHireDate(record) ?? null
  }));
}
```

### 4. Large Batch Performance
**Issue**: Batch with 10,000+ employees may slow down

**Current Behavior**:
- Loads full batch into memory
- May timeout for very large batches (>8 second query timeout)

**Recommendations**:
- Split large batches into multiple uploads
- Consider pagination for dashboard display
- Implement lazy-loading for large result sets

### 5. Salary Calculation Rounding
**Issue**: Multiple decimal calculations may accumulate rounding errors

**Solution**:
- All monetary values rounded to 2 decimals
- Rounding happens at database storage time
- Formula: `Math.round(value * 100) / 100`

### 6. Email Notification Failures
**Issue**: If email system fails, workflow still completes

**Current Behavior**:
- Uses `safeSendNotificationEmail` which catches errors
- Logs failure but doesn't block workflow
- User unaware email wasn't sent

**Workaround**: Check notification delivery logs in admin dashboard

### 7. Concurrent Batch Processing
**Issue**: Two users upload same month/year simultaneously

**Current Behavior**:
- Both batches created (no unique constraint on month/year)
- User must manually delete duplicate

**Recommendation**: Add business logic to warn/prevent duplicate periods

### 8. Excel Column Detection Failures
**Issue**: Unusual column naming doesn't match aliases

**Current Behavior**:
- Validation fails with "Missing required columns"
- User must rename columns and re-upload

**Solution**: Check column aliases in `salary-import.ts` and add missing variations

### 9. Payslip Generation for Locked Batch
**Issue**: Batch is locked but employee data in directory changed

**Current Behavior**:
- Payslip shows current data from salary_records table
- Does NOT use historical directory snapshot
- Employee info may differ from when batch was created

**Note**: Salary records contain all necessary fields, so payslip is accurate

### 10. Access Filter Performance
**Issue**: Computing hierarchy for large organizations is slow

**Current Behavior**:
- Recursively builds hierarchy tree
- Caches manager map in memory
- Should handle 10,000+ employees without major delay

**Optimization**: Could be cached in Redis for frequent access

---

## COMPLETE TESTING COMMAND

Run all payroll tests:

```bash
npm test -- payroll
npm test -- tests/payroll-sheet-mapping.test.ts
```

Or include in CI/CD:

```bash
npm run test:payroll
npm run test:coverage -- payroll
```

---

## SUMMARY CHECKLIST

Before deploying payroll to production:

### Database
- [ ] `salary_batches` table exists with all columns
- [ ] `salary_records` table exists with all columns
- [ ] `salary_flags` table exists
- [ ] `payroll_expenses` table exists (optional if not using expenses)
- [ ] Indexes on `batch_id`, `hr_id`, `month`, `year`
- [ ] RLS policies configured for payroll data
- [ ] Backups scheduled

### API Routes
- [ ] POST /api/payroll/validate - Dry-run validation
- [ ] POST /api/payroll/upload - Create batch
- [ ] GET /api/payroll/[id] - Get batch
- [ ] DELETE /api/payroll/[id] - Delete batch
- [ ] POST /api/payroll/[id]/workflow - State transitions
- [ ] GET /api/payroll/[id]/payslips - Generate payslips
- [ ] All routes have permission checks
- [ ] All routes have error handling

### Validations
- [ ] File size limit (10MB) enforced
- [ ] Required columns checked
- [ ] Data type conversions work
- [ ] Duplicate HR_ID detection works
- [ ] Salary calculations correct
- [ ] Flags created for warnings

### Access Control
- [ ] Admin sees all batches
- [ ] Manager sees team only
- [ ] Employee sees own only
- [ ] Line scope works
- [ ] Hierarchy scope works
- [ ] Forbidden errors returned correctly

### Payslips
- [ ] HTML generation works
- [ ] CSS renders correctly
- [ ] Print/PDF works
- [ ] Access control enforced
- [ ] All salary fields displayed
- [ ] Currency formatted correctly

### Emails
- [ ] Upload completion email sent
- [ ] Workflow action emails sent
- [ ] Email includes correct metrics
- [ ] Email links work

### Testing
- [ ] Unit tests pass (payroll-sheet-mapping.test.ts)
- [ ] All scenarios tested manually
- [ ] Load tested with 1000+ records
- [ ] Concurrent uploads tested
- [ ] Edge cases documented

---

## REFERENCES

- **Service**: `src/lib/payroll/service.ts`
- **Types**: `src/lib/payroll/types.ts`
- **Validation**: `src/lib/payroll/salary-import.ts`
- **Payslips**: `src/lib/payroll/payslip-center.ts`
- **Expenses**: `src/lib/payroll/expenses.ts`
- **Tests**: `tests/payroll-sheet-mapping.test.ts`
- **UI Pages**: `app/payroll/*`, `app/payslips/*`

