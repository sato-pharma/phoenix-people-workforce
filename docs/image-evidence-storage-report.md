# Image and Evidence Storage Report

Generated on 2026-05-21 from code inspection and a live Supabase read using
`scripts/audit-image-evidence-storage.ts`.

## Executive Summary

The application does not have one unified image store yet. Evidence/image files
are split by business module:

| Area | Actual file storage | Database reference | Current live state |
| --- | --- | --- | --- |
| Vacation compensatory event photos | Supabase Storage bucket `leave-attachments` | `public.v2_vacation_requests.compensatory_attachment_*` | Bucket exists, 0 vacation rows/files |
| Sick leave attachments | Supabase Storage bucket `leave-attachments` | `public.v2_vacation_requests.sick_attachment_*` | Bucket exists, 0 vacation rows/files |
| Outstation car evidence | Supabase Storage bucket `outstation-evidence` | `public.outstation_expense_requests.car_evidence_image_path` | 4 `car/` objects |
| Medical rep ticket attachments | Supabase Storage bucket `outstation-evidence` | `public.outstation_expense_requests.ticket_attachment_paths` | 1 `tickets/` object |
| Marketing finance proof/invoices | Supabase Storage bucket `marketing-finance-evidence` | `public.marketing_request_finance_requirements.*_storage_path` | Bucket exists, 0 files |
| Marketing customer/pharmacy live photos | Currently metadata only | `public.marketing_customers.evidence_photo_name`, `public.marketing_pharmacies.evidence_photo_name` | 0 rows in live DB |
| Employee profile photos | Local app assets under `public/images/hr` | Hard-coded map in `src/lib/employees/profile-images.ts` | Local files, not Supabase |

Important gap: `public.marketing_evidence_files` exists and defaults to bucket
`marketing-evidence`, but the migration does not create a `marketing-evidence`
storage bucket, and the current validation UI does not upload the captured live
photo bytes to Supabase Storage. It only stores photo name/timestamp metadata.

## Live Supabase Counts

| Query | Result |
| --- | --- |
| Storage buckets found | `leave-attachments`, `marketing-finance-evidence`, `outstation-evidence` |
| Missing expected bucket | `marketing-evidence` |
| `outstation-evidence` objects | 5 total, 305,285 bytes |
| `outstation-evidence/car` | 4 objects, 213,627 bytes |
| `outstation-evidence/tickets` | 1 object, 91,658 bytes |
| `v2_vacation_requests` | 0 total, 0 compensatory photos, 0 sick attachments |
| `outstation_expense_requests` | 9 total, 4 car evidence images, 1 request with ticket attachments |
| `marketing_customers` | 0 total, 0 with photo metadata |
| `marketing_pharmacies` | 0 total, 0 with photo metadata |
| `marketing_evidence_files` | 0 rows |
| `marketing_request_finance_requirements` | 0 rows, 0 proofs/invoices |

## Storage Map

### Vacation and Compensatory Event Photos

Upload entrypoint:

- UI field: `compensatoryPhoto`
- API route: `app/api/vacations/requests/route.ts`
- Service: `src/lib/vacation/service.ts`

Storage:

- Bucket: `leave-attachments`
- Path pattern: `compensatory/{employeeHrId}/{requestId}/{fileName}`
- Accepted files: JPG, PNG, WEBP
- Max size: 10 MB

Database:

- Table: `public.v2_vacation_requests`
- Columns:
  - `compensatory_attachment_bucket`
  - `compensatory_attachment_object_path`
  - `compensatory_attachment_original_name`
  - `compensatory_attachment_content_type`
  - `compensatory_attachment_size_bytes`
  - `compensatory_attachment_uploaded_at`
  - `compensatory_event_name`
  - `compensatory_event_date`
  - `compensatory_event_location`
  - `compensatory_manager_1`
  - `compensatory_manager_2`

Current status:

- The flow is implemented.
- Live database currently has no `v2_vacation_requests` rows and no files in
  `leave-attachments`.

### Outstation Evidence

Upload service:

- `src/lib/outstation/car-evidence-storage.ts`
- `src/lib/outstation/service.ts`

Storage:

- Bucket: `outstation-evidence`
- Car image path pattern: `car/{employeeHrId}/{draftOrRequestId}.jpg`
- Ticket attachment path pattern:
  `tickets/{employeeHrId}/{draftId}/{index}-{fileName}`

Database:

- Table: `public.outstation_expense_requests`
- Car image columns:
  - `car_evidence_image_path`
  - `car_evidence_metadata`
- Ticket columns:
  - `ticket_attachment_paths`
  - `ticket_attachment_metadata`

Current status:

- This is the only evidence bucket with live files right now.
- Live database has 4 car evidence images and 1 ticket attachment group.

### Marketing Customer/Pharmacy Live Photos

Current UI behavior:

- The browser captures a stamped JPEG data URL.
- The preview is held in React state as `photoDataUrl`.
- Submit payload sends metadata only:
  - `evidencePhotoName`
  - `evidencePhotoCapturedAt`
  - GPS/location fields
  - timestamp status

Database:

- `public.marketing_customers.evidence_photo_name`
- `public.marketing_customers.evidence_photo_captured_at`
- `public.marketing_customers.evidence_has_timestamp`
- `public.marketing_customers.evidence_status`
- Same fields exist on `public.marketing_pharmacies`.

Designed but not wired:

- Table: `public.marketing_evidence_files`
- Columns:
  - `storage_bucket`
  - `storage_path`
  - `entity_type`
  - `entity_id`
  - `evidence_type`
  - location/timestamp fields
- Default bucket: `marketing-evidence`

Current status:

- `marketing_evidence_files` has no live rows.
- The `marketing-evidence` bucket is not present in live storage.
- Marketing live photos are not currently persisted as retrievable image files.

### Marketing Finance Proof and Invoices

Upload entrypoint:

- API route: `app/api/marketing-requests/finance-evidence/route.ts`
- Service: `src/lib/marketing-requests/service.ts`

Storage:

- Bucket: `marketing-finance-evidence`
- Path pattern: `{requestId}/{evidenceType}/{timestamp}-{fileName}`
- Accepted files: JPG, PNG, WEBP, PDF
- Max size: 5 MB

Database:

- Table: `public.marketing_request_finance_requirements`
- Money transfer columns:
  - `money_transfer_proof_storage_path`
  - `money_transfer_proof_original_file_name`
  - `money_transfer_proof_uploaded_by_hr_id`
  - `money_transfer_proof_uploaded_at`
- Invoice columns:
  - `invoice_storage_path`
  - `invoice_original_file_name`
  - `invoice_uploaded_by_hr_id`
  - `invoice_uploaded_at`

Current status:

- Bucket exists.
- Live database currently has 0 finance evidence rows and 0 files.

### Employee Profile Photos

Storage:

- Local static files: `public/images/hr`
- URL map: `src/lib/employees/profile-images.ts`

Current status:

- These are bundled app assets, not Supabase Storage objects.
- They are shown in the employee identity card by HR ID mapping.

## Recommended Fix

Create one reporting layer for all image/evidence assets without moving the
large files into account/user tables:

1. Create or repair the missing `marketing-evidence` private storage bucket.
2. Upload marketing live-photo bytes to Storage instead of storing only the
   generated photo name.
3. Insert a row into `public.marketing_evidence_files` for each customer and
   pharmacy photo.
4. Add a read/report service that returns a unified list:
   - module
   - business record id
   - employee/uploader HR ID
   - bucket
   - object path
   - content type
   - size
   - captured/uploaded date
   - signed URL when the current role can view it
5. Build an admin report page on top of that service so the app can answer
   "where is this image?" without browsing Supabase manually.

The best design is still: keep the account system light, keep large files in
Supabase Storage, and store only indexed metadata/path columns in Postgres.

## Audit Script

Run this to refresh the live counts:

```bash
node --experimental-strip-types --experimental-specifier-resolution=node scripts/audit-image-evidence-storage.ts
```
