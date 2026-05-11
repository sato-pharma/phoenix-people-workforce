# Employee Data Requirements & Dependency Map

**Purpose:** Complete map of all employee data needed across workflows, where it comes from, and who needs access

**Last Updated:** May 11, 2026

---

## 📊 CORE EMPLOYEE TABLE SCHEMA

```sql
employees (hr_id text PRIMARY KEY)
  ├── PERSONAL IDENTIFIERS
  │   ├── hr_id ← PRIMARY KEY (e.g., "PH-0001", "AI-0234")
  │   ├── full_name
  │   ├── name_ar (Arabic name - optional)
  │   ├── crm_id (CRM system identifier)
  │   ├── crm_username
  │   └── mobile_number
  │
  ├── CONTACT INFORMATION
  │   ├── work_email (e.g., john@phoenix.com)
  │   ├── region_name (geographic region)
  │   └── (MISSING: home_address, personal_email, home_phone)
  │
  ├── IDENTIFICATION DOCUMENTS
  │   ├── (MISSING: national_id_number)
  │   ├── (MISSING: id_card_expiry_date)
  │   ├── (MISSING: passport_number)
  │   └── education (highest qualification)
  │
  ├── EMPLOYMENT DETAILS
  │   ├── job_title
  │   ├── employment_status (active, resigned, probation, etc.)
  │   ├── hire_date
  │   ├── birth_date
  │   └── (MISSING: employee_type - full-time, contract, etc.)
  │
  ├── ORGANIZATIONAL HIERARCHY
  │   ├── manager_hr_id (FK to employees)
  │   ├── line_id (FK to lines) [Line = business unit]
  │   ├── area_id (FK to areas) [Area = geographic region]
  │   ├── department_id (FK to departments)
  │   ├── position_id (FK to positions)
  │   └── team_id (FK to teams)
  │
  └── AUDIT FIELDS
      ├── created_at
      └── updated_at
```

---

## 📋 COMPLETE EMPLOYEE DATA REQUIREMENTS BY WORKFLOW

### 1️⃣ PAYROLL & COMPENSATION WORKFLOW

**Data Needed:**
| Field | Source | Frequency | Critical | Role Access |
|-------|--------|-----------|----------|------------|
| hr_id | Employee import or manual | Once (immutable) | ✅ YES | Finance, HR |
| full_name | Employee import, ID card | Quarterly update | ✅ YES | Finance, HR |
| job_title | Employee import, HR update | As changes | ✅ YES | Finance, HR |
| line | Employee import, org structure | Quarterly | ✅ YES | Finance, HR |
| area | Employee import, org structure | Quarterly | ✅ YES | Finance, HR |
| employment_status | HR action (resign, hire, etc.) | Real-time | ✅ YES | Finance, HR |
| **COMPENSATION FIELDS** | | | | |
| gross_salary | Payroll file upload | Monthly | ✅ YES | Finance |
| basic_salary | Payroll file upload | Monthly | ✅ YES | Finance |
| allowances (fuel, housing, etc.) | Payroll file upload | Monthly | ✅ YES | Finance |
| deductions (tax, insurance, etc.) | Payroll file upload | Monthly | ✅ YES | Finance |
| net_salary | Calculated from above | Monthly | ✅ YES | Finance, Employee (self) |
| payment_mode | Policy file | Monthly | ✅ YES | Finance |
| payment_account (⚠️ MISSING) | Bank details form | Once | ✅ YES | Finance |

**Workflows Depending on This:**
- Payroll batch creation ← needs all compensation fields
- Salary slip generation ← needs personal + compensation fields
- Expense approvals ← needs hr_id, full_name, line, area
- Payroll reconciliation ← needs employment_status, hr_id

**Who Needs Access:**
- 👤 **Finance Admin:** Read + write all fields
- 👤 **HR Admin:** Read all, write name/status/line/area
- 👤 **Employee (self):** Read net_salary, payment_mode
- 👤 **Manager:** Read team member compensation (hierarchy-based)

---

### 2️⃣ EXPENSE CLAIM & REIMBURSEMENT WORKFLOW

**Data Needed:**
| Field | Source | Frequency | Critical | Role Access |
|-------|--------|-----------|----------|------------|
| hr_id | Employee import | Once | ✅ YES | Finance, Employee |
| full_name | Employee import | Quarterly | ✅ YES | Finance, Employee |
| line | Org structure | Quarterly | ✅ YES | Finance, Employee |
| area | Org structure | Quarterly | ✅ YES | Finance, Employee |
| manager_hr_id | Org structure | Quarterly | ✅ YES | Finance, Manager |
| **EXPENSE DATA** | | | | |
| trip_from_address (⚠️ MISSING) | Form input by employee | Per trip | ✅ YES | Employee, Finance |
| trip_to_address (⚠️ MISSING) | Form input by employee | Per trip | ✅ YES | Employee, Finance |
| trip_distance_km | Calculated from addresses | Per trip | ✅ YES | Finance |
| trip_cost | Employee input or calculated | Per trip | ✅ YES | Finance |
| trip_date | Employee input | Per trip | ✅ YES | Finance |
| **OUTSTATION ALLOWANCE** | | | | |
| from_city | Form input | Per request | ✅ YES | Employee, Finance |
| to_city | Form input | Per request | ✅ YES | Employee, Finance |
| departure_date | Form input | Per request | ✅ YES | Employee, Finance |
| return_date | Form input | Per request | ✅ YES | Employee, Finance |
| eligible_days (calculated) | Policy rules | Per request | ✅ YES | Finance |
| allowance_amount (calculated) | Policy × eligible_days | Per request | ✅ YES | Finance |

**Workflows Depending on This:**
- Trip expense submission ← needs hr_id, addresses (from employee)
- Geo-validation ← checks trip against brick coverage
- Expense approval ← needs full chain (manager → area head → finance)
- Fraud detection ← analyzes patterns by line, area, frequency

**Who Needs Access:**
- 👤 **Employee:** Write own expenses, read own reimbursements
- 👤 **Manager:** Read + approve team member expenses
- 👤 **Finance Admin:** Read + approve all, mark paid
- 👤 **NSM/DSM:** View team aggregate expenses

**⚠️ CRITICAL MISSING DATA FOR EXPENSES:**
- Address on employee record (home address from ID card)
- Bank account details (for direct reimbursement)
- Tax ID/GST number (if applicable for India/Egypt)

---

### 3️⃣ RECRUITMENT & JOB OFFERS WORKFLOW

**Data Needed:**
| Field | Source | Frequency | Critical | Role Access |
|-------|--------|-----------|----------|------------|
| hr_id | Generated on hire | Once | ✅ YES | HR, Manager, Finance |
| full_name | Candidate → Offer creation | Once | ✅ YES | HR, Manager |
| job_title | Position → Offer | Once | ✅ YES | HR, Manager |
| line | Position → Offer | Once | ✅ YES | HR, Manager |
| area | Position → Offer | Once | ✅ YES | HR, Manager |
| department_id | Position → Offer | Once | ✅ YES | HR, Manager |
| position_id | Position → Offer | Once | ✅ YES | HR, Manager |
| manager_hr_id | Manager selection → Offer | Once | ✅ YES | HR, Manager |
| **CANDIDATE DATA** | | | | |
| candidate_email | External form input | Once | ✅ YES | HR, Candidate |
| candidate_phone (⚠️ MISSING) | External form input | Once | ✅ YES | HR, Candidate |
| candidate_name | External form input | Once | ✅ YES | HR, Candidate |
| desired_salary (⚠️ MISSING) | Negotiation | Per offer | ⚠️ MAYBE | HR, Manager |
| offer_expiry_date | Calculated (e.g., +15 days) | Once | ✅ YES | HR, Candidate |

**Workflows Depending on This:**
- Offer creation ← needs position, manager, candidate data
- Offer approval ← manager reviews offer details
- Offer email ← sends to candidate_email with secure link
- Offer acceptance ← candidate clicks link, enters password
- Onboarding ← creates employee record from accepted offer
- Offer expiration ← auto-expires after offer_expiry_date

**Who Needs Access:**
- 👤 **HR Admin:** Create, approve, manage offers
- 👤 **Manager:** Review + approve offers for their team
- 👤 **Candidate:** Accept/reject via secure link (public)
- 👤 **Employee (after hire):** View own hiring offer (read)

---

### 4️⃣ PROBATION TRACKING WORKFLOW

**Data Needed:**
| Field | Source | Frequency | Critical | Role Access |
|-------|--------|-----------|----------|------------|
| hr_id | New hire | Once | ✅ YES | HR, Manager |
| full_name | Employee record | Once | ✅ YES | HR, Manager |
| hire_date | Employee record | Once | ✅ YES | HR, Manager |
| job_title | Employee record | Quarterly | ✅ YES | HR, Manager |
| manager_hr_id | Org structure | Quarterly | ✅ YES | HR, Manager |
| **PROBATION FIELDS** | | | | |
| probation_start_date | Hire date | Once | ✅ YES | HR, Manager |
| probation_end_date | Calculated (hire + 6 months) | Once | ✅ YES | HR, Manager |
| probation_status | HR action | As changes | ✅ YES | HR, Manager |
| probation_outcome | Manager evaluation | At end date | ✅ YES | Manager, HR |
| **EVALUATION DATA** | | | | |
| evaluation_date | Manager submission | At probation end | ✅ YES | HR, Manager |
| rating (⚠️ MISSING) | Manager input | At probation end | ✅ YES | Manager, HR |
| performance_notes (⚠️ MISSING) | Manager input | At probation end | ✅ YES | Manager, HR |
| recommendation (pass/extend/terminate) | Manager decision | At probation end | ✅ YES | Manager, HR |

**Workflows Depending on This:**
- Probation alert ← email at 90-day mark
- Probation evaluation ← manager submits evaluation form
- Probation extension ← if recommended to extend
- Probation completion ← pass → move to permanent contract
- Contract renewal ← linked to probation completion
- Termination ← if failed probation

**Who Needs Access:**
- 👤 **Manager:** Create + update evaluations
- 👤 **HR Admin:** Review + approve outcomes
- 👤 **Employee (self):** View own probation status (read)

---

### 5️⃣ SALES PERFORMANCE TRACKING WORKFLOW

**Data Needed:**
| Field | Source | Frequency | Critical | Role Access |
|-------|--------|-----------|----------|------------|
| hr_id | Employee import | Once | ✅ YES | Sales, Finance |
| full_name | Employee import | Quarterly | ✅ YES | Sales, Finance |
| line | Org structure | Quarterly | ✅ YES | Sales, Finance |
| manager_hr_id | Org structure | Monthly | ✅ YES | Sales Manager |
| **SALES METRICS** | | | | |
| sales_amount | Sales import file | Monthly | ✅ YES | Sales |
| units_sold | Sales import file | Monthly | ✅ YES | Sales |
| territory | Sales import file | Monthly | ✅ YES | Sales |
| sales_type | Sales import file | Monthly | ✅ YES | Sales |
| product_family | Sales import file | Monthly | ✅ YES | Sales |
| closing_sheet_data | Excel upload | Monthly | ✅ YES | Sales |
| **INCENTIVE CALCULATION** | | | | |
| incentive_tier (⚠️ MISSING) | Policy mapping | Monthly | ✅ YES | Finance |
| incentive_percentage (⚠️ MISSING) | Policy × tier | Monthly | ✅ YES | Finance |
| incentive_amount (calculated) | Sales × percentage | Monthly | ✅ YES | Finance, Employee |

**Workflows Depending on This:**
- Sales import ← upload monthly closing sheets
- Sales dashboard ← show team performance
- Incentive calculation ← monthly incentive payout
- Territory management ← align employees to territories
- Performance ranking ← rank by sales amount/performance
- Sales queue ← track pending/unlinked records

**Who Needs Access:**
- 👤 **Medical Rep:** View own sales, incentives
- 👤 **Sales Manager (DSM/NSM):** View team sales, approve imports
- 👤 **Finance Admin:** Calculate + approve incentives
- 👤 **HR Admin:** View organizational sales metrics

---

### 6️⃣ CONTRACT RENEWAL WORKFLOW

**Data Needed:**
| Field | Source | Frequency | Critical | Role Access |
|-------|--------|-----------|----------|------------|
| hr_id | Employee record | Once | ✅ YES | HR, Manager |
| full_name | Employee record | Once | ✅ YES | HR, Manager |
| employment_status | HR action | As changes | ✅ YES | HR, Manager |
| hire_date | Employee record | Once | ✅ YES | HR, Manager |
| **CONTRACT FIELDS** | | | | |
| contract_start_date | Offer acceptance | Once | ✅ YES | HR, Manager |
| contract_end_date | Next renewal date | Annually | ✅ YES | HR, Manager |
| contract_status | HR action | As changes | ✅ YES | HR, Manager |
| contract_type (⚠️ MISSING) | Policy | Once | ✅ YES | HR, Manager |
| renewal_requested_by (⚠️ MISSING) | Manager input | Per renewal | ✅ YES | Manager, HR |
| renewal_terms (⚠️ MISSING) | HR negotiation | Per renewal | ✅ YES | HR, Manager |
| renewal_approval_date (⚠️ MISSING) | HR approval | Per renewal | ✅ YES | HR |

**Workflows Depending on This:**
- Contract renewal alert ← 90 days before expiry
- Renewal request ← manager initiates renewal
- Renewal approval ← HR approves new terms
- Contract archival ← old contracts preserved
- Resignation impact ← check contract status

**Who Needs Access:**
- 👤 **Manager:** View contract end date, request renewals
- 👤 **HR Admin:** Create, approve, renew contracts
- 👤 **Employee (self):** View own contract dates (read)

---

### 7️⃣ RESIGNATION & OFFBOARDING WORKFLOW

**Data Needed:**
| Field | Source | Frequency | Critical | Role Access |
|-------|--------|-----------|----------|------------|
| hr_id | Employee record | Once | ✅ YES | HR, Manager |
| full_name | Employee record | Once | ✅ YES | HR, Manager |
| employment_status | HR action | Real-time | ✅ YES | HR, Manager |
| manager_hr_id | Org structure | Once | ✅ YES | HR, Manager |
| hire_date | Employee record | Once | ✅ YES | Finance |
| **RESIGNATION FIELDS** | | | | |
| resignation_date | Employee submission | Real-time | ✅ YES | HR, Manager |
| resignation_reason (⚠️ MISSING) | Employee form | Real-time | ⚠️ MAYBE | HR |
| last_working_date | Calculated (notice period) | Real-time | ✅ YES | HR, Manager |
| **FINAL COMPENSATION** | | | | |
| final_salary_amount | Payroll calculation | At exit | ✅ YES | Finance |
| settlement_amount (⚠️ MISSING) | Payroll + gratuity calc | At exit | ✅ YES | Finance |
| pending_reimbursements (⚠️ MISSING) | Finance check | At exit | ⚠️ MAYBE | Finance |
| equipment_return_status (⚠️ MISSING) | Inventory check | At exit | ⚠️ MAYBE | Admin |
| knowledge_handoff_status (⚠️ MISSING) | Manager input | At exit | ⚠️ MAYBE | Manager |
| **VACANCY CREATION** | | | | |
| vacancy_created | Auto-generated | At resignation | ✅ YES | HR |
| position_id | From employee | At resignation | ✅ YES | HR |

**Workflows Depending on This:**
- Resignation notification ← employee submits resignation
- Manager notification ← manager notified of resignation
- Final salary calculation ← includes accrued benefits
- Settlement calculation ← gratuity, pending dues
- Vacancy posting ← new position opened for hire
- Equipment recovery ← ensure company property returned
- Access revocation ← disable email, systems access
- Archive employee data ← preserve for 7 years

**Who Needs Access:**
- 👤 **Employee:** Submit own resignation (write)
- 👤 **Manager:** View team resignations, approve leave
- 👤 **HR Admin:** Manage resignation workflow + final settlement
- 👤 **Finance Admin:** Calculate final compensation + settlement

---

### 8️⃣ COACHING & PERFORMANCE WORKFLOW

**Data Needed:**
| Field | Source | Frequency | Critical | Role Access |
|-------|--------|-----------|----------|------------|
| hr_id | Employee record | Once | ✅ YES | Manager, HR |
| full_name | Employee record | Once | ✅ YES | Manager, HR |
| line | Org structure | Quarterly | ✅ YES | Manager, HR |
| manager_hr_id | Org structure | Quarterly | ✅ YES | Manager |
| **COACHING FIELDS** | | | | |
| coaching_date | Manager submission | Monthly | ✅ YES | Manager, HR |
| coaching_topic | Manager input | Monthly | ✅ YES | Manager, HR |
| coaching_summary (⚠️ MISSING) | Manager input | Monthly | ✅ YES | Manager, HR |
| coaching_rating (⚠️ MISSING) | Manager rating | Monthly | ✅ YES | Manager, HR |
| follow_up_date (⚠️ MISSING) | Manager decision | Monthly | ⚠️ MAYBE | Manager |
| coaching_status | Workflow (submitted/acknowledged) | Monthly | ✅ YES | Manager, HR |

**Workflows Depending on This:**
- Coaching report submission ← manager submits monthly
- Coaching acknowledgment ← employee acknowledges report
- Coaching trends ← aggregate coaching history
- Performance improvement plans ← if repeated issues
- Promotion assessment ← coaching records help assess

**Who Needs Access:**
- 👤 **Manager:** Create + submit coaching reports
- 👤 **Employee (self):** Acknowledge coaching (read)
- 👤 **HR Admin:** View aggregate coaching trends

---

## 🔑 CRITICAL MISSING DATA FIELDS

### High Priority (Blocks Workflows)
```
COMPENSATION & BANKING:
  ❌ bank_account_number - Required for salary transfer
  ❌ bank_name - Required for salary transfer
  ❌ ifsc_code - Required for India salary transfer
  ❌ tax_id_number - Required for payroll compliance
  ❌ pan_number - Required for India

IDENTIFICATION:
  ❌ national_id_number - From ID card
  ❌ id_card_expiry_date - From ID card
  ❌ address_per_id_card - From ID card (for expenses)
  ❌ date_of_birth - From ID card
  ❌ passport_number - For international travel/outstation

CONTACT:
  ❌ personal_email - For notifications
  ❌ home_phone_number - Backup contact
  ❌ home_address - For address-based expenses/compliance
  ❌ emergency_contact_name - HR required
  ❌ emergency_contact_phone - HR required

EMPLOYMENT:
  ❌ employee_type - Full-time, contract, freelance, etc.
  ❌ employment_contract_location - HR required
  ❌ insurance_premium_amount - Payroll deduction
  ❌ insurance_provider - HR tracking
```

### Medium Priority (Nice to Have)
```
COMPENSATION:
  ❌ desired_salary_range - For offers, discussions
  ❌ last_salary - History tracking

PERFORMANCE:
  ❌ performance_rating - For reviews
  ❌ skills_tags - For succession planning
  ❌ certifications - For compliance, development

SALES:
  ❌ sales_territory - For sales dashboard
  ❌ incentive_tier - For incentive calculation
  ❌ bonus_percentage - For bonus calculation

WORKFLOW:
  ❌ probation_rating - For evaluations
  ❌ resignation_reason - For exit surveys
  ❌ coaching_summary - For performance tracking
```

---

## 👥 DATA ACCESS BY ROLE

### Super Admin
```
✅ READ:   All employee data, all tables
✅ WRITE:  All employee data, all tables
✅ DELETE: Any employee record
⚠️  ACTION: Full system control
```

### HR Admin
```
✅ READ:   All employee data for own line/area
✅ WRITE:  Personal info, contact, employment status, dates
✅ WRITE:  HR-specific fields (probation, contracts, offers)
❌ WRITE:  Compensation, payroll fields
⚠️  ACTION: Hire, resign, onboard employees
```

### Finance Admin
```
✅ READ:   Employee ID, name, line, area, job title
✅ READ:   All compensation fields
✅ READ:   All payroll fields
✅ WRITE:  Compensation, payroll, salary flags
❌ WRITE:  Personal info, employment status
⚠️  ACTION: Approve payroll, expenses, settlements
```

### Manager
```
✅ READ:   Own profile + direct subordinates data
✅ WRITE:  Team member coaching, evaluations
✅ WRITE:  Probation evaluations, feedback
❌ READ:   Compensation details
❌ WRITE:  Employment status, dates
⚠️  ACTION: Approve team expenses, submit coaching reports
```

### Employee (Self)
```
✅ READ:   Own employment details, net salary, payslips
✅ READ:   Own coaching records (acknowledge)
✅ WRITE:  Own contact info (phone, email - ⚠️ if allowed)
✅ WRITE:  Own expenses, outstation requests
✅ WRITE:  Own resignation submission
❌ READ:   Compensation components (gross, deductions)
❌ READ:   Team member data
```

### Sales Manager (DSM/NSM)
```
✅ READ:   Team member sales, performance metrics
✅ READ:   Team member line, area, manager
✅ WRITE:  Sales data approvals
✅ READ:   Team incentives (aggregate)
❌ READ:   Personal compensation
❌ WRITE:  Employee records
```

---

## 🔗 DATA DEPENDENCY CHAINS

### Payroll Chain
```
Employee Import
    ↓ (creates employees, compensation)
Employee Record
    ↓
Manager Assignment (org structure)
    ↓
Payroll Upload
    ↓ (creates salary_records, salary_flags)
Salary Validation
    ↓
Salary Approval
    ↓
Payslip Generation
    ↓
Salary Payment
    ↓
Payment Confirmation
```

### Expense Chain
```
Employee Hire
    ↓ (employee record created)
Employee Record
    ↓ (with line, area, manager)
Employee Submits Expense
    ↓ (trip from/to, cost, date)
Geo Validation
    ↓ (check brick coverage)
Manager Approval
    ↓ (line manager reviews)
Area Approval
    ↓ (area head approves)
Finance Approval
    ↓ (finance checks compliance)
Reimbursement
    ↓
Bank Transfer (via bank_account_number ⚠️ MISSING)
```

### Recruitment Chain
```
Job Creation & Vacancy
    ↓
Offer Creation
    ↓ (manager_hr_id, position, line, area, department)
Offer Approval
    ↓ (manager reviews)
Offer Email Send
    ↓ (to candidate_email)
Candidate Accepts
    ↓ (via secure link)
Employee Record Created
    ↓ (from offer data)
Compensation Setup
    ↓ (job title, line, area, manager)
Onboarding
    ↓
Password Setup Email
    ↓
First Payroll
```

---

## 📝 IMPLEMENTATION ROADMAP

### Phase 1: Critical Missing Fields (Immediate - blocks workflows)
```
1. Bank Account Fields
   - bank_account_number
   - bank_name
   - ifsc_code
   - account_holder_name
   
2. Identification Fields
   - national_id_number
   - id_card_expiry_date
   - address_from_id_card
   
3. Contact Fields
   - personal_email
   - home_phone
   - emergency_contact_name
   - emergency_contact_phone
```

### Phase 2: Employment & HR Fields (Week 1)
```
4. Employment Fields
   - employee_type (full-time, contract, etc.)
   - employment_contract_file (URL/storage)
   
5. Compensation Fields
   - insurance_premium_amount
   - insurance_provider
   - gratuity_calculation_base
```

### Phase 3: Performance & Sales Fields (Week 2)
```
6. Performance Fields
   - probation_rating
   - last_performance_rating
   - skills_tags (JSON array)
   
7. Sales Fields
   - sales_territory
   - incentive_tier
   - bonus_percentage
```

### Phase 4: Workflow Fields (Week 3)
```
8. Offer Fields
   - candidate_phone
   - desired_salary_range
   
9. Resignation Fields
   - resignation_reason
   - final_settlement_amount
   - knowledge_handoff_status
   
10. Coaching Fields
    - coaching_summary
    - coaching_rating_scale
```

---

## ✅ VERIFICATION CHECKLIST

### For Payroll Workflow
- [ ] All employee data imported correctly
- [ ] Bank account numbers collected before first payment
- [ ] Tax ID numbers validated for compliance
- [ ] Compensation linked to correct employees
- [ ] Manager hierarchy set up correctly

### For Expense Workflow
- [ ] Address data collected from ID card
- [ ] Bank accounts set for direct reimbursement
- [ ] Brick coverage data loaded
- [ ] Approval chain configured (manager → area → finance)

### For Recruitment Workflow
- [ ] Offer creation includes all required fields
- [ ] Candidate email addresses verified
- [ ] Manager assignments correct
- [ ] Position mappings accurate
- [ ] Onboarding checklist created

### For Probation Workflow
- [ ] All new hires have probation end date
- [ ] Manager assignments correct
- [ ] 90-day email alerts configured
- [ ] Evaluation form created

### For Resignation Workflow
- [ ] Resignation form captures all required data
- [ ] Final compensation calculation verified
- [ ] Equipment return process defined
- [ ] Access revocation automated

---

## 🎯 NEXT STEPS

**For Development Team:**
1. Create database migration to add missing fields
2. Update employee import template with new fields
3. Create forms for manual data entry (addresses, bank details)
4. Update API validation for required vs optional fields
5. Create employee onboarding wizard to collect missing data
6. Audit existing employees for missing critical data

**For HR Team:**
1. Prepare address data from employee ID cards
2. Collect bank account details for all employees
3. Collect emergency contact information
4. Prepare employee type classification
5. Create retention reminders for missing data

**For Finance Team:**
1. Set up bank account verification process
2. Validate tax ID numbers for compliance
3. Prepare gratuity calculation methodology
4. Set up insurance premium tracking

---

**END OF EMPLOYEE DATA REQUIREMENTS MAP**
