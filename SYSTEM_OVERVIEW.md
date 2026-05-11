# Phoenix Workforce - Complete System Overview

**305 TypeScript/TSX files | 63 API routes | 15+ major modules**

---

## 1. AUTHENTICATION & AUTHORIZATION

### Authentication System
- **Login Flow**: Email/password authentication via Supabase
- **Session Management**: JWT-based sessions with auth users table
- **Password Setup**: Tokenized password setup flow for new users
- **Logout**: Session termination and cleanup

### Permission & Access Control
- **Role-Based Access Control (RBAC)**: 15 Phoenix Roles defined
  - Employee, Medical Rep, District Manager, Regional Manager, National Sales Manager
  - Product Manager, Group Product Manager, SFE Manager, Training Manager
  - Marketing Manager, Finance Manager, HR Specialist, Manager, CEO, Super Admin
  
- **Permission Resources** (23 types):
  - admin, overview, admin_access, imports, sales, payroll, expenses
  - employees, team, offers, probation, resignations, contracts, coaching
  - user_admin, permission_admin, employee_documents, employee_profile
  - vacancies, organogram, hr_calendar, payslips, geo_intelligence, outstation

- **Permission Actions**: read, create, update, delete, approve, export, import

- **Access Scopes**:
  - `self`: Only own data
  - `team`: Team members only
  - `hierarchy`: All subordinates
  - `line`: Same business line
  - `company`: All company data
  - `none`: No access
  - `system`: Full system access

### Key Functions
- `getPhoenixAdminStats()` - Dashboard stats (employees, payroll, sales, vacancies)
- `getAdminMonitoringStats()` - Auth/notification monitoring
- `resolvePayrollAccessFilter()` - Determines payroll visibility by role/scope
- `buildManagerMap()` - Creates manager-subordinate relationships
- `collectPayrollHierarchy()` - Recursively maps reporting structure

---

## 2. PAYROLL MANAGEMENT

### Salary Batch Processing
**Workflow**: Upload → Validate → Review → Approve → Lock → Export

- `createSalaryBatch()` - Import salary records from file
- `replaceSalaryBatch()` - Re-upload batch data
- `runPayrollWorkflow()` - State transitions (mark_review, approve, lock, reject, reopen)
- `getSalaryBatchExport()` - Export batch with access control
- `deleteSalaryBatch()` - Remove batch

### Salary Records
- Tracks: gross salary, net salary, additions, deductions
- Fields: HR_ID, employee code, full name, job title, line, area
- Deductions: social insurance, income tax, CRM, fingerprint, medical insurance, loans
- Additions: incentive, overtime, bonus, fuel allowance, cost of living, expenses

### Payroll Dashboard
- `getPayrollDashboard()` - Retrieves salary records with:
  - Anomaly detection (>2.25x average net salary)
  - Readiness rate calculation
  - Total gross/net/additions/government deductions
  - Access-controlled record visibility

### Data Validation
- `mapRecord()` - Normalizes salary record data types
- `verifySalaryRecordPayloads()` - Ensures data persists correctly
- Salary flags system for validation warnings

### Access Control
- Role-based payroll visibility
- Manager hierarchy filtering
- Line-based employee grouping
- Normalized HR_ID matching (handles variations)

---

## 3. EMPLOYEE MANAGEMENT

### Employee Directory
- `getEmployeeDirectory()` - Full employee hierarchy
- Tracks: HR_ID, full name, email, job title, manager HR_ID, hire date
- Supports Arabic name field

### HR_ID Generation
- `generateNextHrIdForLine()` - Auto-generate unique HR_IDs
- Prefix system by business line: PH, AI, PD, CN, OF
- Format: `PREFIX-NNNN` (e.g., PH-0001)
- Race condition handling with retries

### Employee Bulk Operations
- Bulk import employees
- Bulk update/delete
- Setup link generation for new users
- Resignation processing

---

## 4. ADMIN DASHBOARD & MONITORING

### Statistics & Reporting
- **Total Employees**: Count of all employees
- **Active Employees**: Current org chart count
- **Payroll Eligible**: Employees in payroll scope
- **Salary Records**: Total salary records
- **Sales Records**: Sales team records
- **Expenses Count**: Payroll expenses
- **Salary Flags**: Data quality issues
- **Data Health Issues**: Linkage problems
- **Vacancies**: Open positions
- **Job Offers**: In-flight offers

### Monitoring
- Auth bridge coverage rate
- Broken accounts (missing access profiles)
- Failed login attempts (24h)
- Locked accounts & forced password resets
- Notification delivery stats (sent/failed/pending)
- Audit log tracking

### Data Health
- Employee linkage health
- Sales employee linkage
- Orphan audit records
- Health rate percentage

---

## 5. COMMUNICATIONS & NOTIFICATIONS

### Email System
- Email notification dispatch
- Notification delivery logs
- Notification event queue
- Birthday notifications
- Phoenix HR reply template system

### Notification Management
- Notification events creation
- Status tracking (pending, sent, failed)
- Retry logic
- 24-hour statistics

---

## 6. BUSINESS OPERATIONS

### Sales Management
- Sales records import
- Sales employee linkage
- Product assignment
- Sales performance tracking

### Geographic Intelligence
- Location tracking
- Territory mapping
- Expense route analysis
- Anomaly detection
- Trip validation with Google Maps
- Brick/location import
- Outstation management

### Organogram (Organization Chart)
- Active employee hierarchy
- Reporting structure
- Department organization

### HR Calendar
- Holiday scheduling
- Leave periods
- HR events

### Outstation Management
- Request tracking
- Heatmap analysis
- Policy enforcement
- Request approval workflow

---

## 7. EMPLOYEE SELF-SERVICE

### Employee Portal
- View personal profile & documents
- Access payslips
- Request leave/outstation
- View contracts
- Career progression

### Payslip Access
- Period-based access (current/previous)
- Salary record export
- PDF generation

### Documents
- Store employee documents
- Verification tracking
- Document versioning

---

## 8. HIRING & RECRUITMENT

### Job Offers
- Create offers
- Track offer status
- Acceptance/rejection workflow
- Offer letter generation

### Vacancies
- Create position vacancies
- Track applications
- Publish openings

### Probation Management
- Track probation periods
- Performance reviews
- Completion/extension workflow

---

## 9. EMPLOYEE LIFECYCLE

### Resignations
- Resignation requests
- Exit interviews
- Final settlement
- Clearance tracking

### Contracts
- Contract storage
- Renewal tracking
- Workflow management

---

## 10. IMPORTS & DATA MANAGEMENT

### Bulk Import System
- Employees: Import from CSV/Excel
- Bricks: Location data import
- Expenses: Expense data import
- Payroll: Salary data import

### Dry-Run & Validation
- `dry-run` - Preview without saving
- `confirm` - Save validated data
- Validation warning capture
- Error reporting

---

## 11. API ROUTES (63 Total)

### Authentication (4 routes)
```
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/heartbeat
POST /api/auth/password-setup/[token]
```

### Admin (18 routes)
```
GET /api/admin/profile
GET /api/admin/email-notifications
POST /api/admin/email-notifications
POST /api/admin/email-reply/send
GET /api/admin/logs
GET /api/admin/monitoring
GET /api/admin/permissions
PATCH /api/admin/permissions
GET/POST /api/admin/users
GET/POST /api/admin/users/bulk
POST /api/admin/users/bulk-action
POST /api/admin/users/setup-link
GET/PATCH/DELETE /api/admin/users/[id]
GET/POST /api/admin/salary-flags
GET/POST /api/admin/outstation/requests
GET/POST /api/admin/outstation/heatmaps
GET/PATCH/DELETE /api/admin/outstation/[id]
```

### Payroll (3 routes)
```
GET /api/payroll/dashboard
GET /api/payroll/export
POST /api/payroll/batch
```

### Employees (3 routes)
```
GET /api/employees
POST /api/employees
GET/POST /api/employees/template
POST /api/employees/[hrId]/resign
```

### Sales (1 route)
```
GET /api/sales/dashboard
```

### Geo & Location (6 routes)
```
GET /api/geo/dashboard
POST /api/geo/geocode
POST /api/geo/validate-trip
POST /api/geo/import-bricks
POST /api/geo/import-expenses
```

### Imports (6 routes)
```
POST /api/imports/employees/dry-run
POST /api/imports/employees/confirm
POST /api/imports/bricks/dry-run
POST /api/imports/bricks/confirm
```

### Notifications (2 routes)
```
POST /api/notifications/birthdays
POST /api/notifications/process
```

### Contracts (2 routes)
```
GET /api/contracts
POST /api/contracts/[id]/workflow
```

---

## 12. DATABASE SCHEMA

### Core Tables
- **employees**: All employees with HR_ID, names, dates
- **organogram**: Active employee hierarchy
- **user_access_profiles**: Role & permission mapping
- **app_auth_users**: Authentication user records
- **auth_login_attempts**: Login attempt tracking

### Payroll
- **salary_batches**: Batch metadata (status, dates)
- **salary_records**: Individual salary records
- **salary_flags**: Data quality warnings
- **payroll_expenses**: Expense tracking

### Business Data
- **salary_records**: Salary records with all deductions/additions
- **sales_records**: Sales transaction records
- **position_vacancies**: Open positions
- **job_offers**: Offer tracking
- **employee_linkage_health**: Data quality metrics

### Notifications
- **notification_events**: Event queue
- **notification_delivery_logs**: Delivery tracking

### Audit & Logs
- **audit_logs**: All system actions (create/update/delete/auth)
- **auth_login_attempts**: Failed login tracking

---

## 13. KEY WORKFLOWS

### Payroll Workflow
1. Upload file → Create batch
2. Validate records → Generate flags
3. Mark for review
4. Review & approve
5. Lock for finalization
6. Export to accounting

### Employee Onboarding
1. Create employee record
2. Assign to organogram
3. Generate HR_ID
4. Create access profile
5. Send password setup link
6. New hire confirmed

### Resignation Workflow
1. Submit resignation
2. Generate exit interview
3. Final settlement calculation
4. Clearance checklist
5. Data archival

### Import Workflow
1. Select file (CSV/Excel)
2. Run dry-run validation
3. Review warnings/errors
4. Confirm import
5. Verify data persistence

---

## 14. UTILITIES & HELPERS

### ID Normalization
- `normalizeHrId()` - Standardizes HR_ID format
- `normalizeHrIdForAccess()` - Creates canonical form for matching
- `normalizeLineName()` - Business line name normalization

### Data Mapping
- `mapBatch()` - Salary batch data normalization
- `mapRecord()` - Salary record normalization
- `mapFlag()` - Salary flag normalization

### Query Building
- `buildPayrollIdentityOrClause()` - Dynamic OR filter generation
- `filterPayrollQueryByAllowedHrIds()` - Apply access control
- `filterPayrollRowsByAccess()` - Post-query filtering

### Error Handling
- `isPayrollSchemaMissing()` - Detect missing schema
- `isMissingColumnError()` - Detect missing columns
- `payrollErrorMessage()` - Error message extraction

---

## 15. INTERNATIONALIZATION

### Supported Languages
- English (en)
- Arabic (ar)
- Multi-language support in UI

### Locale-Aware Features
- Employee names in Arabic (name_ar field)
- Currency formatting
- Date formatting
- Number formatting

---

## 16. SECURITY & COMPLIANCE

### Access Control
- Row-Level Security (RLS) via Supabase
- Admin-only endpoints
- Role-based resource access
- Action-level permissions

### Audit Trail
- All modifications logged
- User attribution
- Timestamp tracking
- Entity change history

### Data Protection
- Password hashing (Supabase Auth)
- Secure token generation
- Session expiration
- Rate limiting (via Supabase)

---

## 17. DEVELOPMENT SETUP

### Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL`: Database URL
- `SUPABASE_SERVICE_ROLE_KEY`: Admin API key
- Database query timeout: 8 seconds

### Key Dependencies
- Next.js (app router)
- Supabase (PostgreSQL + Auth)
- TypeScript
- React
- TailwindCSS (styling)

### Testing
5 test suites covering:
- Email notifications
- i18n config
- Incentive schemes
- Payroll sheet mapping
- Phoenix HR reply templates

---

## 18. PAGES & UI STRUCTURE

### Admin Pages
- `/admin` - Dashboard
- `/admin/profile` - Admin profile
- `/admin/access` - Access control
- `/admin/data-health` - Data quality
- `/admin/email-notifications` - Email management
- `/admin/email-reply-composer` - Email composer
- `/admin/logs` - System logs
- `/admin/monitoring` - Monitoring dashboard
- `/admin/payslips-center` - Payslip management
- `/admin/outstation/requests` - Outstation requests
- `/admin/outstation/heatmaps` - Location heatmaps
- `/admin/outstation/policy` - Policy settings
- `/admin/geo-intelligence/*` - Geographic features
- `/admin/geo-intelligence/territory-map` - Territory mapping
- `/admin/geo-intelligence/expense-routes` - Route analysis
- `/admin/geo-intelligence/anomalies` - Anomaly detection

### Employee Pages
- `/employee-portals` - Portal home
- `/employees` - Employee directory
- `/payslips` - Payslip access
- `/contracts` - Contract management
- `/probation` - Probation tracking
- `/resignations` - Resignation management
- `/offers` - Job offers
- `/hr-calendar` - Calendar
- `/organogram` - Organization chart
- `/overview` - Dashboard
- `/reports` - Reporting
- `/sales` - Sales data

---

## Testing Areas Before Production

1. **Authentication**: Login, logout, session management
2. **Payroll**: Batch upload, validation, approval workflow
3. **Access Control**: Role-based visibility, data filtering
4. **Employee Management**: Bulk import, HR_ID generation
5. **Notifications**: Email delivery, event processing
6. **Imports**: CSV/Excel validation, dry-run accuracy
7. **Admin Functions**: Monitoring, audit logs, data health
8. **Employee Portal**: Payslip access, personal data visibility
9. **Integrations**: Google Maps, email system
10. **Data Integrity**: Linkage health, orphan detection

