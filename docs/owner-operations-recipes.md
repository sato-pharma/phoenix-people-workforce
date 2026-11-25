# Owner operations — the recipes

When the owner says "validate X", "link X", "merge the copies" or "fix that record", Claude does it
itself, from the code, against production. It never does it in his Chrome, never by clicking through
a screen, and never by handing him click-by-click steps unless his message asks for steps (memory note
`when-he-says-do-it-claude-does-it-from-the-code`, 25 Nov 2026).

This file exists so that the next session starts from the recipe instead of re-reading the domain
code. **Every time an operation is done for him for the first time, add its recipe here**: the
function or route, the input shape, the ids it needs, and the read that proves it landed. Every
session reaches this file through that memory note, which the always-loaded `MEMORY.md` names.

Each recipe uses the app's own domain code (the same path a screen takes), so its checks still apply.
That means no hand `insert`/`update` for anything a route can do.

## Marketing

### Link a doctor's pharmacies to an employee (Super Admin desk entry)

- **Route:** `POST /api/marketing-requests/validation`, signed in as B-10 (Super Admin). It runs
  `createMarketingValidationRecord` in `src/lib/marketing-requests/service.ts`, the same path a rep's
  capture takes.
- **Body:**

  ```json
  {
    "onBehalfOfHrId": "<the employee, e.g. PD-0028 Sahar ElGallad>",
    "customers": [{
      "customerType": "doctor",
      "displayName": "<doctor, Arabic as on the CRM list>",
      "speciality": "Paediatrics",
      "crmAreaSeatId": "<seat, e.g. SEAT-PED-REP-D26>",
      "crmCustomerId": "<the Phoenix CRM customer uuid>",
      "extractedAreaName": "<area, e.g. Port said - Domiat>",
      "extractedGovernorateName": "<governorate>",
      "pharmacies": [
        { "existingPharmacyId": "<uuid>" },
        { "displayName": "<pharmacy>", "venueType": "pharmacy", "capturedAddress": "<street address>",
          "extractedAreaName": "<area>", "extractedGovernorateName": "<governorate>",
          "vendorCodes": [{ "distributorId": 17, "distributorPharmacyCode": "<code>" }] }
      ]
    }]
  }
  ```

- **Distributor ids:** read `marketing_distributors` (25 Nov 2026: Ibn Sina 17, Overseas 19, Sofico 21).
- **Refusal "that pharmacy is not one you can attach":** the `existingPharmacyId` belongs to another
  seat. Send it as a new venue with its codes, then merge the old copy into it (below).
- **Proof:** `GET /api/marketing-requests/drafts` signed in as the employee (`x-phoenix-hr-id`) lists
  the doctor, and `pharmaciesByCustomer[<customer id>]` holds every pharmacy.
- First done for Dr Othman El Shewehy / Sahar ElGallad, 25 Nov 2026 (session 6c7fe3eb).

### Merge duplicate pharmacy copies

- **Route:** `POST /api/marketing-requests/venue-merge` with
  `{ "survivorId": "<kept>", "loserId": "<copy>", "reason": "<why: same shop, same codes>" }`. Make
  one call per copy, as B-10. It moves links and requests to the survivor, switches the copy off and
  records the reason.

### Put a map pin on a pharmacy already saved

- Set `marketing_pharmacies.captured_latitude` / `captured_longitude` / `captured_at` with
  `evidence_status = 'pending'` (the desk-entry rule for a pin without a shop photo). Validation and
  links are untouched. Read the links back after.

### How these were run, and the weak spot

On 25 Nov these routes were called on the SPARE laptop's dev server with dev-auth headers
(`x-phoenix-role: Super Admin`, `x-phoenix-hr-id: B-10`, `Origin: http://localhost:3000`) through
`~/.claude/scripts/spare.ps1`. That breaks whenever the spare's Wi-Fi drops; it did at 22:44 that
night. The durable form is a committed `scripts/` runner that calls the same functions directly.
A scratch script that fabricates a Super Admin viewer was refused by Claude Code's safety check on
9 Oct 2026, so it has to be a reviewed, committed one.
