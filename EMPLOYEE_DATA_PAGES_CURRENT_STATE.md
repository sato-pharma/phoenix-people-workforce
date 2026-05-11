# Employee Data Pages - Current State

**Question:** هل بيانات الموظف مجمعة في صفحة واحدة ولا متفرقة في صفحات مختلفة؟  
**Answer:** **متفرقة جداً في صفحات مختلفة** ❌ - لا توجد صفحة master واحدة للموظف

---

## 📍 WHERE EMPLOYEE DATA IS SCATTERED

### 🏢 FOR EMPLOYEES (Self-Service)

Employee can see their data scattered across **11 different pages:**

```
/employee-portals/                      ← Main dashboard (overview only)
├── earnings/                           ← Gross salary, net salary, allowances
├── payroll/                            ← Salary batch info
├── payslips/                           ← Download historical payslips
├── expenses/                           ← Submit trip expenses
├── incentive/                          ← Sales incentives (if applicable)
├── sales/                              ← Sales performance (if Medical Rep/DSM)
├── brick-coverage/                     ← Brick visit coverage (if NSM)
├── team-expenses/                      ← Team expenses summary (if Manager)
├── team-performance/                   ← Team performance (if Manager/DSM)
├── coaching/                           ← Coaching reports & acknowledgments
├── probation/                          ← Probation status & evaluations
└── profile/                            ← ❌ EMPTY! Just redirects to #hr-contract
```

**Employee owns data (can see):**
- ✅ Own salary figures (payroll page)
- ✅ Own payslips (payslips page)
- ✅ Own expenses (expenses page)
- ✅ Own incentives (incentive page)
- ✅ Own sales data (sales page)
- ✅ Own coaching reports (coaching page)
- ✅ Own probation status (probation page)
- ❌ NO dedicated profile page to view/edit personal info
- ❌ NO page to see contact details
- ❌ NO page to see employment contract

---

### 👔 FOR HR ADMIN (Employee Management)

Data spread across **multiple pages & tabs:**

```
/employees/                             ← Main employee directory (LIST VIEW)
│
├── Employee List (Searchable table)
│   ├── Columns shown: HR_ID, Name, Job Title, Line, Area, Manager, Status
│   ├── Click to EDIT individual employee
│   │   └── Edit Form Modal (SINGLE EMPLOYEE EDIT):
│   │       ├── Personal Info Tab
│   │       │   ├── Full Name
│   │       │   ├── Name (Arabic)
│   │       │   ├── HR_ID
│   │       │   ├── Mobile Number
│   │       │   ├── Work Email
│   │       │   ├── CRM_ID
│   │       │   ├── CRM_Username
│   │       │   └── Education Level
│   │       │
│   │       ├── Employment Tab
│   │       │   ├── Job Title
│   │       │   ├── Employment Status (active/resigned/terminated)
│   │       │   ├── Hire Date
│   │       │   ├── Manager HR_ID
│   │       │   └── Salary Payment Mode (one_part/two_parts)
│   │       │
│   │       ├── Organization Tab
│   │       │   ├── Line (Dropdown)
│   │       │   ├── Area (Dropdown)
│   │       │   ├── Department (Dropdown)
│   │       │   └── Position (Dropdown)
│   │       │
│   │       ├── Location Tab (⚠️ EXTRA FIELDS!)
│   │       │   ├── Residence Address
│   │       │   ├── Residence City
│   │       │   └── Residence Area
│   │       │
│   │       └── Actions
│   │           ├── Save Changes
│   │           ├── Mark as Resigned
│   │           └── Cancel
│   │
│   ├── Bulk Import (Upload employee CSV)
│   │   └── Maps to same fields
│   │
│   └── Export (Download all employees)
│
├── OTHER PAGES FOR EMPLOYEE DATA:
│
├── /probation/                         ← View probation records
│   └── Can start/extend probation from here
│
├── /contracts/                         ← View contract renewals
│   └── Can request renewals from here
│
├── /offers/                            ← View job offers
│   └── Create/approve offers from here
│
├── /payroll/                           ← Payroll batches
│   └── View salary records, flags, expenses
│
├── /sales/                             ← Sales management
│   └── Import & validate sales data
│
├── /admin/payslips-center/             ← View historical payslips
│   └── Search employee & view payslip history
│
└── /admin/access/                      ← User access control
    └── Manage login IDs and roles
```

---

## 📋 FORM FIELDS AVAILABLE IN EMPLOYEE EDIT

### Currently Available Fields (in /employees page)
```typescript
EmployeeFormState = {
  hrId                 // Primary key - can't edit
  fullName            ✅ Editable
  nameAr              ✅ Editable (Arabic name)
  crmId               ✅ Editable
  crmUsername         ✅ Editable
  mobileNumber        ✅ Editable
  workEmail           ✅ Editable
  education           ✅ Editable
  
  jobTitle            ✅ Editable
  employmentStatus    ✅ Editable (active/resigned/terminated)
  hireDate            ✅ Editable
  managerHrId         ✅ Editable
  salaryPaymentMode   ✅ Editable (one_part/two_parts)
  
  lineId              ✅ Editable (via dropdown)
  areaId              ✅ Editable (via dropdown)
  departmentId        ✅ Editable (via dropdown)
  positionId          ✅ Editable (via dropdown)
  
  residenceAddress    ✅ Editable
  residenceCity       ✅ Editable
  residenceArea       ✅ Editable
}
```

### Completely Missing from Employee Edit Form
```
❌ Birth Date
❌ National ID Number
❌ ID Card Expiry
❌ Bank Account Number
❌ Bank Name
❌ IFSC Code
❌ Tax ID
❌ Personal Email
❌ Home Phone
❌ Emergency Contact
❌ Insurance Details
❌ Gratuity Information
❌ Employment Type (full-time vs contract)
```

---

## 🔄 COMPENSATION DATA (Separate Table)

**Location:** `/employee-portals/earnings/` + `/payroll/` pages

```
employee_compensation (separate table)
├── Gross Salary         ← View only (in /earnings page)
├── Net Salary           ← View only (in /earnings page)
├── Allowances           ← View only (in /earnings page)
├── Deductions           ← View only (in /earnings page)
├── Payment Mode         ← Editable in /employees form
└── (NO bank account fields!)
```

**Can EDIT compensation only via:**
- ❌ Not in employee form
- ✅ Payroll batch upload (Excel file)
- ✅ /payroll/upload page (for admins)

---

## 📊 COMPARISON: Current vs. Ideal

### Current Architecture (Scattered) ❌
```
EMPLOYEE PAGE (/employees)
└── Shows: Name, Job Title, Line, Area, Manager (LIST VIEW)
    └── Click to edit → Opens modal with 4 tabs
        ├── Personal Info (name, email, phone, CRM ID)
        ├── Employment (title, status, hire date, manager)
        ├── Organization (line, area, dept, position)
        └── Location (address fields)

SEPARATE PAGES for each workflow:
├── /payroll/                   → See salary info
├── /employee-portals/earnings/ → See earnings breakdown
├── /contracts/                 → See contract status
├── /probation/                 → See probation status
├── /offers/                    → See job offers
├── /sales/                     → See sales data
├── /admin/access/              → Manage login/role
└── /admin/payslips-center/    → View payslip history
```

**Problem:** To see complete employee picture, need to visit 8+ different pages!

### Ideal Architecture (Consolidated) ✅
```
EMPLOYEE MASTER PAGE (/employees/[hrId])
├── Overview Tab
│   ├── Profile photo
│   ├── HR_ID, Full Name, Job Title
│   ├── Current Status, Manager, Line, Area
│   └── Quick stats (tenure, payroll status, etc.)
│
├── Personal Info Tab
│   ├── Contact details (email, phone, address)
│   ├── ID info (national ID, passport, etc.)
│   ├── Birth date, education
│   └── Emergency contact
│
├── Employment Tab
│   ├── Hire date, employment type
│   ├── Current role, manager, department
│   ├── Probation status, contract status
│   └── Resignation status (if applicable)
│
├── Compensation Tab
│   ├── Salary structure (gross, net, allowances, deductions)
│   ├── Payment mode, bank account details
│   ├── Tax ID, insurance info
│   └── Historical salary records
│
├── Documents Tab
│   ├── Employment contract
│   ├── Job offer letter
│   ├── Probation evaluation
│   ├── Coaching records
│   └── Payslips
│
├── Sales Tab (if applicable)
│   ├── Sales history
│   ├── Territory assignment
│   ├── Incentives earned
│   └── Performance metrics
│
└── Audit Tab
    ├── Created date, updated date
    ├── Change history
    ├── Who made changes
    └── When changes were made
```

---

## 🚨 CURRENT ISSUES

### Issue 1: No Employee Master Page
```
❌ No single page showing all employee data
❌ Data scattered across 10+ pages
❌ HR admin must visit multiple pages to see complete picture
❌ Employee profile page exists but redirects to empty anchor
❌ No way to see all data for one employee at a glance
```

### Issue 2: Missing Form Fields
```
❌ Bank account details not in edit form (can only upload via Excel)
❌ National ID not tracked (required for many countries)
❌ Birth date missing (required for benefits, probation calculations)
❌ Tax ID missing (required for payroll compliance)
❌ Personal contact info missing
❌ Emergency contact missing
```

### Issue 3: Compensation Data in Separate Table
```
❌ employee_compensation is separate table, not editable in UI
❌ Can only be updated via payroll batch upload
❌ No form to manually edit compensation
❌ Creates disconnect between employee record and compensation
```

### Issue 4: Data Spread Across Workflows
```
❌ Probation data in /probation/ page
❌ Contract data in /contracts/ page
❌ Sales data in /sales/ page
❌ Payroll data in /payroll/ page
❌ Must navigate to multiple pages to manage one employee
```

---

## ✅ RECOMMENDATION: Create Employee Master Page

### Phase 1: Build Single Employee View Page
```
CREATE: /employees/[hrId]/page.tsx

SHOW:
✅ All personal information (consolidated)
✅ All employment information (consolidated)
✅ All compensation information (linked from table)
✅ Current status of all workflows (probation, contract, sales, etc.)
✅ Document history (offers, contracts, evaluations, payslips)
✅ Quick edit buttons (name, email, manager, etc.)
✅ Linked navigation to detailed pages

BENEFITS:
✅ Single source of truth for employee data
✅ HR admin can see complete picture in 10 seconds
✅ Faster employee management
✅ Better data quality (easier to spot missing info)
✅ Easy to add missing fields (birth date, bank account, etc.)
```

### Phase 2: Extend to Edit Page
```
CREATE: /employees/[hrId]/edit/page.tsx

ALLOW EDITING:
✅ All employee fields (personal, employment, org)
✅ Compensation fields (direct edit, not Excel)
✅ Bank account details
✅ Emergency contact
✅ All missing fields once added
✅ Save to database directly
```

### Phase 3: Add to Employee Portal
```
ENHANCE: /employee-portals/profile/page.tsx

SHOW FOR EMPLOYEES:
✅ Own complete profile
✅ Can edit: name (Arabic), email, phone, address
✅ Can't edit: HR_ID, hire date, manager, salary
✅ Links to all their data (payroll, expenses, etc.)
✅ Documents available for download
```

---

## 📝 IMPLEMENTATION PRIORITY

### Quick Win (Today)
```
1. Fix /employee-portals/profile/page.tsx
   - Instead of redirecting, show employee's own data
   - Read-only view of personal info
   - Link to edit email/phone/address
   - Link to payroll, expenses, coaching, etc.
   
2. Add missing fields to /employees edit form
   - Birth date
   - National ID
   - Bank account fields
   - Tax ID
   - Emergency contact
```

### High Priority (Week 1)
```
3. Create /employees/[hrId]/page.tsx (view)
   - Show all employee data in tabs
   - Links to all workflows
   - Document center (offers, contracts, payslips)
   
4. Create /employees/[hrId]/edit/page.tsx
   - Full edit form with all fields
   - Direct database saves
```

### Medium Priority (Week 2)
```
5. Create /employees/[hrId]/audit/page.tsx
   - Show change history
   - Who changed what, when
   - Before/after values
```

---

## 📊 FIELD LOCATION MAPPING

Where each field is currently stored/editable:

| Field | Currently Editable | Location | Problem |
|-------|-------------------|----------|---------|
| Full Name | Yes | /employees modal | ✅ OK |
| Email | Yes | /employees modal | ✅ OK |
| Mobile | Yes | /employees modal | ✅ OK |
| Job Title | Yes | /employees modal | ✅ OK |
| Manager | Yes | /employees modal | ✅ OK |
| Line | Yes | /employees modal | ✅ OK |
| Salary (Gross) | No | /payroll/upload (Excel) | ❌ Excel only |
| Salary (Net) | No | Read-only in UI | ❌ Can't edit |
| Bank Account | No | Nowhere! | ❌ Missing entirely |
| Birth Date | No | Nowhere! | ❌ Missing |
| National ID | No | Nowhere! | ❌ Missing |
| Tax ID | No | Nowhere! | ❌ Missing |
| Probation Status | No | /probation page | ⚠️ Different page |
| Contract Status | No | /contracts page | ⚠️ Different page |
| Sales Data | No | /sales page | ⚠️ Different page |

---

## 🎯 CONCLUSION

**Current State:** Data scattered across 10+ pages ❌  
**Ideal State:** Single employee master page ✅

**User Story:**
> As an HR Admin, I want to see all of an employee's data on one master page, so I can manage them efficiently without jumping between multiple pages.

**Acceptance Criteria:**
- ✅ All personal info visible in one place
- ✅ All employment info visible in one place
- ✅ Links to all related workflows (payroll, probation, sales, etc.)
- ✅ Quick edit for common fields
- ✅ Document center for contracts, offers, payslips
- ✅ Change history/audit trail
- ✅ Mobile responsive

**Estimate:** 40-60 hours development

---

**END OF CURRENT STATE ANALYSIS**
