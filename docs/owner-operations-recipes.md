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

## How to run them: `scripts/owner-ops.ts`

Every recipe below is a subcommand of one committed runner. It acts as B-10 the way a route handler
builds the caller (his login row, the lifecycle gate, `createAccessContext`), and calls the same
domain function the route calls. It never goes through a screen, his browser or the spare laptop.

```bash
node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
  --import ./tests/register-alias-loader.mjs scripts/owner-ops.ts <job> <flags>
```

- **It is a dry run unless `--apply` is on the command line.** A dry run goes through every check
  and refusal the real save has. The app's own test-account fence (`src/lib/auth/test-dry-run.ts`)
  answers each write without sending it, and the runner lists what it would have written.
  `--apply=yes`, `--aply` and a bare `apply` never write: each one is refused.
- **`--apply` refuses a tree that is behind `origin/main`.** Run it from a fresh checkout.
- 🔴 **Run `--apply` on production only when the owner's own message orders that specific job.**
  The dry run is always allowed, so run it first and read its list.
- **Every run ends with a proof read:** the employee's draft workspace (`getMarketingRequestDraftWorkspace`,
  the read behind `GET /api/marketing-requests/drafts`). Exit 2 = bad arguments; 1 = refused by
  the app; 3 = written but the proof could not be read (do not re-run: the write happened).
- `--help` lists the jobs. Pinned by `tests/owner-ops-runner.test.ts`.

## Marketing

### Link a doctor's pharmacies to an employee (Super Admin desk entry)

- **Run:** `owner-ops.ts link-doctor --body <file.json>`
- **What it calls:** `createMarketingValidationRecord` in `src/lib/marketing-requests/service.ts`. This is
  the same path `POST /api/marketing-requests/validation` and a rep's capture take.
- **Body file:** the route's exact body:

  ```json
  {
    "onBehalfOfHrId": "<the employee, e.g. PD-0028 Sahar ElGallad>",
    "customers": [{
      "customerType": "doctor",
      "existingCustomerId": "<the doctor's marketing customer id, when the employee already holds them>",
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

- 🔴 **A doctor the employee ALREADY holds needs `existingCustomerId`, or the app saves a second
  copy of the doctor.** `createMarketingValidationRecord` does not look for one, so the runner
  refuses such a body itself. It checks for the same CRM id or the same name, with no
  `existingCustomerId`. Found 25 Nov 2026: Dr Othman El Shewehy is held TWICE by Sahar ElGallad
  (`2911d0e4-9a97-4017-ae48-415ccca258a9` at 22:49 Cairo, `6fcee6cf-5d95-4188-99fb-64e17a16dbd0` at
  23:12), both active. The app gap is still open, and folding the two doctors is a separate job.
- **Distributor ids:** read `marketing_distributors` (25 Nov 2026: Ibn Sina 17, Overseas 19, Sofico 21).
- **Refusal "that pharmacy is not one you can attach":** the `existingPharmacyId` belongs to another
  seat. Send it as a new venue with its codes, then merge the old copy into it (below).
- **Proof:** the employee's workspace lists the doctor, and `pharmaciesByCustomer[<customer id>]`
  holds every pharmacy.
- First done for Dr Othman El Shewehy / Sahar ElGallad, 25 Nov 2026 (session 6c7fe3eb).

### Merge duplicate pharmacy copies

- **Run:** `owner-ops.ts merge-venues --survivor <kept id> --loser <copy id> --reason "<why: same shop, same codes>" [--employee <hr id>]`
- **What it calls:** `mergeMarketingVenue({ survivorId, loserId, reason })`, the function behind
  `POST /api/marketing-requests/venue-merge`. It moves links and requests to the survivor, switches
  the copy off and records the reason. Run it once per copy.
- **Refusal `[conflict]`:** the copy is already merged or inactive. Nothing is left to do.
- **Proof:** the workspace of every employee holding a doctor linked to either pharmacy, or of
  `--employee` if given.

### Put a map pin on a pharmacy already saved

- **Run:** `owner-ops.ts pin-pharmacy --pharmacy <id> --lat <latitude> --lng <longitude> [--employee <hr id>]`
- **What it writes:** `marketing_pharmacies.captured_latitude` / `captured_longitude` / `captured_at`, with
  `evidence_status = 'pending'`. That is the desk-entry rule for a pin without a shop photo.
  Validation and links are untouched.
- **What it refuses:** a merged, inactive or already-pinned pharmacy, and a point outside Egypt.
  The update itself only matches a pharmacy whose latitude is still empty. Egypt's latitude and
  longitude ranges overlap, so a swapped Cairo or Delta pin still passes the Egypt check: read the
  printed pin row.
- **Proof:** the pin row, then the linked employees' workspaces.

### How these were run before the runner

On 25 Nov these routes were called on the SPARE laptop's dev server with dev-auth headers
(`x-phoenix-role: Super Admin`, `x-phoenix-hr-id: B-10`, `Origin: http://localhost:3000`) through
`~/.claude/scripts/spare.ps1`. That broke whenever the spare's Wi-Fi dropped, which it did at 22:44
that night. A scratch script that fabricates a Super Admin viewer was refused by Claude Code's safety
check on 9 Oct 2026. `scripts/owner-ops.ts` is the reviewed, committed form: it reads B-10's real
login row instead of fabricating one. A new desk job becomes a new subcommand there, with its recipe here.
