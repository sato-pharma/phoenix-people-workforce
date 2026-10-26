# Marketing Requests MVP

## Goal

Build a minimal, reliable request system for field marketing activities with validated customers, validated pharmacy/distributor codes, configurable approvals, and ROI tracking.

The first release should prioritize correct data capture and workflow integrity over dashboards.

## Confirmed Business Rules

- Requests start from a Medical Rep.
- Customer type is a configurable dropdown. Initial values: Doctor, Hospital, Clinic, Account, Other.
- Customer type is a classification field only for MVP; ROI math does not change by type.
- Location capture is evidence and address source, not a distance eligibility rule.
- Photo evidence with timestamp is required for customer/pharmacy validation.
- SFE performs human validation after system evidence checks.
- Pharmacy distributor codes must match known distributor-code reference data before they can be used for sales tracking.
- ROI threshold: estimated cost should be at most 10% of expected ROI.
- Required ROI value = estimated cost * 10.
- Expected ROI value = sum(request product quantity * product factory price).
- Product share is value-based, not unit-based.
- Finance can decide whether an invoice is required and set the invoice deadline.
- Dashboards and actual ROI analytics come after the database and workflow are stable.

## Existing Assets To Reuse

- `employees`, `lines`, `areas`, and `manager_hr_id` already exist.
- Existing auth has role and sales scope handling.
- Existing outstation module has browser GPS capture patterns.
- Existing storage patterns can be reused for timestamped evidence photos.
- Existing sales import model can inform future actual ROI tracking.

## Uploaded Workbook Findings

### `Phoenix Pharmacy Database.xlsx`

- Rows: 20,102.
- Columns: Pharmacy Code, Pharmacy Address, Region, Area, Distrbutor.
- Unique distributors: 11.
- There are duplicate `(distributor, pharmacy_code)` pairs, so importer must not assume strict uniqueness without review.
- This file is good as a validation source, not as the final clean pharmacy master.

### `phoenix products.xlsx`

- Products sheet has product, factory price, family, source, and line.
- Distributor sheet is only a distributor list; product data is sufficient for initial ROI calculations.

### Legacy request / outcome files

- Useful as process references only.
- Do not reuse formulas directly because the outcome workbook contains broken formula values.

## Proposed Tables

### Control Tables

- `marketing_request_types`
  - Editable request type list.
  - Initial values: Special request, Hospital Group Meeting, Deal, RTD, Conference, Other.

- `marketing_workflow_steps`
  - Configurable ordered approval steps.
  - Suggested default:
    1. Direct Manager / NSM
    2. SFE Validation
    3. Marketing Review
    4. Finance Review
    5. GM / CEO Final Approval

- `marketing_distributors`
  - Internal distributor master.
  - Stores distributor code, display name, normalized name, active flag.

- `marketing_products`
  - Internal product master.
  - Stores product code, product name, factory price, family, source, line, active flag.

### Master Data Tables

- `marketing_customers`
  - One row per validated customer/account/HCP place.
  - Stores generated customer code, type, name, area/line ownership, captured address/location, evidence status, validation status.

- `marketing_customer_contacts`
  - Optional doctors/contacts under a customer/account.
  - Keeps the MVP flexible for hospital/clinic/account structures.

- `marketing_pharmacies`
  - User-built pharmacy master.
  - Stores generated pharmacy code, name, captured address/location, area/line ownership, evidence status, validation status.

- `marketing_pharmacy_distributor_codes`
  - Links each internal pharmacy to one or more distributor pharmacy codes.
  - Stores distributor id, distributor pharmacy code, reference match status, reference row metadata.

- `marketing_pharmacy_code_references`
  - Imported validation source from `Phoenix Pharmacy Database.xlsx`.
  - Stores distributor, raw pharmacy code, raw address, region, area, source file, source row.

### Request Tables

- `marketing_requests`
  - Main request header.
  - Stores requester HR ID, manager HR ID, line/area, customer, request type, request/pay dates, duration months, estimated cost, required ROI, expected ROI, ROI coverage ratio, status.

- `marketing_request_products`
  - Products and forecast quantities for each request.
  - Stores product, quantity, factory price snapshot, expected value, value share.

- `marketing_request_pharmacies`
  - Pharmacies/distributor codes selected for ROI tracking on a request.
  - Stores pharmacy id, distributor code link id, tracking status.

- `marketing_request_approval_steps`
  - Runtime approval state generated from `marketing_workflow_steps`.
  - Stores assigned role/HR ID, sequence, status, decision actor, decision date, notes.

- `marketing_request_finance_requirements`
  - Finance invoice/receipt obligation.
  - Stores invoice required flag, deadline date, cleared flag, cleared date, hold status.

- `marketing_evidence_files`
  - Location/photo evidence metadata for customers and pharmacies.
  - Stores entity type, entity id, storage path, captured timestamp, GPS coordinates, accuracy, uploader HR ID.

### Future Tracking Tables

- `marketing_request_actual_sales`
  - Future table for monthly actual distributor sales by request/pharmacy/product.
  - Should link to imported distributor sales rows when the sales tracking phase starts.

## MVP Status Flow

- Draft
- Pending Validation
- Pending Approval
- Returned
- Rejected
- Approved
- Active
- ROI Tracking
- Closed
- Finance Hold

## Implementation Phases

1. Migration and seed tables.
2. Product/distributor/reference importer.
3. ROI calculation library and tests.
4. Server-side marketing request service and API routes.
5. Evidence capture support.
6. Minimal request creation UI.
7. Approval queue and workflow control UI.
8. Finance invoice requirement support.
9. Actual sales tracking integration.

## Prompt 2 Scope

Create the first database migration and TypeScript domain types for the MVP tables above.

Prompt 2 should not build the UI yet. It should include indexes, check constraints, RLS enabled, and enough seed data for request types and default workflow steps.

## Customer Validation picks the doctor from a Phoenix CRM list (2026-10-23)

The owner's words: "the district manager or the manager is no more able to add in the customer validation free type doctor name … he will choose the area … then cascading will appear the doctors in this area for the rep in his team", and "the area he will put by his hand, it will not replace the area of the GPS". On a doctor missing from the list: "allow typing, but flag, clearly flag in all approval steps."

- **Who sees which areas.** A Medical Rep picks from his own list, area fixed. A District, Regional or National Sales Manager chooses among the territories at and below him in the organogram (`territoriesInScope`). Product, Group Product, Marketing and SFE Managers, the CEO and the Super Admin choose any area in the company. Rules: `src/lib/marketing-requests/crm-doctor-pick.ts`; reads: `crm-doctor-pick-service.ts`; route: `GET /api/marketing-requests/crm-doctors`.
- **What the list holds.** One area can hold several rep seats (different lines share it), so choosing an area reads every rep list of that area. Only AM/PM doctors, status active or pending, never a test row; the pick never writes to Phoenix CRM.
- **The server decides the name.** `resolveCrmDoctorPick` re-reads the chosen doctor inside the viewer's reach and takes the name from the CRM row; the same doctor picked twice in one save is refused.
- **The area stays separate.** The chosen area is stored in `marketing_customers.chosen_area_seat_id` / `chosen_area_name`. `area_id` still comes from the owner and the GPS `extracted_area_name` is never overwritten.
- **The flag.** "Not on the list" opens a typed name, saved with `crm_list_status = 'not_on_list'` and shown by `NotOnCrmListFlag` on the inbox card, the approval window and the decision page. A save with nothing picked (an offline replay) is saved and flagged, never refused. NULL means a customer from before the rule and is not flagged.
- **One box, pick or type (2026-10-26).** The owner's words: "choose customer from rep list or free type outside of his list". The doctor field is a type-to-search box over the chosen area's list. A name typed that matches no row gets a top row, `Use "name" — not on the list`; pressing Enter takes the first listed match, so the typed row is clicked, or Enter when nothing matches. The name then travels behind `TYPED_CRM_DOCTOR_PREFIX` (`crm-doctor-pick.ts`), becomes `notOnCrmList: true` with the typed name, and is flagged exactly like "Not on the list". The server path is unchanged. The box is `SearchableSelect`'s opt-in `freeTextValue` prop; no other select changed.
- Migration `20261023181501_marketing_customer_crm_doctor_link.sql`; pinned by `tests/marketing-crm-doctor-pick.test.ts`.
