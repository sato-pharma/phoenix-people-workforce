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
- **Every run ends with a proof read** — for the marketing jobs the employee's draft workspace
  (`getMarketingRequestDraftWorkspace`, the read behind `GET /api/marketing-requests/drafts`); a job
  whose change no workspace shows reads its own rows back instead (the two merged customer rows, a
  tablet's agent trail) and says so. Exit 2 = bad arguments; 1 = refused by
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
      "customerType": "clinic",
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

- 🔴 **A doctor the employee ALREADY holds is never saved twice.** Since #784 the desk save joins a
  doctor she holds under the same `crmCustomerId`, and only his pharmacies are written. The runner
  announces that join. A doctor of the same NAME held under no CRM id, or under another one, is still
  minted again by the app, so the runner refuses that body. Send it with `existingCustomerId` instead.
  This is how Dr Othman El Shewehy was saved twice for Sahar ElGallad on 25 Nov 2026 (22:49 and 23:12
  Cairo). The 23:12 copy is merged into the original since then (below).
- **`existingCustomerId` with no capture of the doctor only adds pharmacies** (`isDeskAttachEntry`,
  since 26 Nov 2026): his row, validation and contacts are left as they stand. Before that fix it
  "completed" him instead: it re-stamped his validation and added one more copy of his contact on
  every save. That is how Dr Othman got a third identical contact when Salah El Hol was linked at
  00:06; the two copies were switched off (audit rows), and one contact stands.
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

### Merge a duplicate customer (a doctor saved twice)

- **Run:** `owner-ops.ts merge-customers --survivor <kept customer id> --retired <copy id> --reason "<why: same doctor, same mobile, same pharmacy>"`
  — a dry run first (the merge runs inside a rolled-back transaction and prints what it would move),
  then the same line with `--apply`. It acts as the owner through a real session, so
  `assertRealSessionForDecision` passes the way it does on his screen; never through the spare.
- **Order:** since 26 Nov 2026 the merge folds the same distributor code on a second venue copy by
  itself (`linksFoldedByCode`), so the pharmacy copies no longer have to be merged first for the
  customer to hold each shop once. The duplicate VENUE stays on file until `merge-venues` folds it.
- **Function:** `mergeMarketingCustomers` in `src/lib/marketing-requests/customer-merge.ts` (route
  `POST /api/marketing-requests/customer-merge`, body
  `{ "survivorId": "<kept>", "retiredId": "<copy>", "carryEvidence": false, "reason": "<why>" }`).
- 🔴 **It refuses a dev-preview session** (`assertRealSessionForDecision`: "A dev-preview session
  cannot merge two customers"). The spare's dev-auth headers are a preview session, so the spare route
  answers 403. Never work around that guard; the runner above is a real session, not a way round it.
- 🔴 **The screen's button cannot be pressed from the app's browser pane.** It asks "are you sure?"
  in a browser OK box, and the pane closes that box unanswered, so no request is sent: pressed twice
  on 26 Nov 2026 (رضا سليمان), production unchanged both times. Use the runner.
- **Done this way first:** رضا سليمان (Anti Infective hospital, Alex East, Nahed Tarek Hattab), the copy
  9D1B5FFF into D3B1021F, 26 Nov 2026 02:12 Cairo: 1 link folded by code, 1 contact and 1 Direct Orders
  venue moved, the 2 requests already on the row that stays.
- **Proof:** the copy's `marketing_customers.merged_into_customer_id` names the survivor and its
  `active` is false; the survivor's live links are unchanged.
- First needed for Dr Othman El Shewehy / Sahar ElGallad, 25 Nov 2026: the four pharmacy copies merged
  from the spare (HTTP 200 each); the doctor merge was refused (403) and left for the owner.
- 🔴 **Two customers of different kinds never merge** ("These two are different kinds of customer"):
  the screen's OK box appears, then the database refuses. Read both `customer_type`s first. The
  25 Nov desk entry was typed `doctor` (legacy, no new customer gets it) and the form's copy `clinic`,
  so the original was set to `clinic` (audit row) before the merge. A desk entry uses one of the
  form's four kinds: `hospital`, `clinic`, `account`, `other`.

### Take a pharmacy off a customer (one shop held twice)

- **Run:** `owner-ops.ts remove-customer-pharmacy --customer <customer id> --pharmacy <the copy's pharmacy id> --reason "<why it comes off>"`
  — a dry run first, then the same line with `--apply`. One pharmacy per run.
- **What it calls:** `removePharmacyFromMarketingCustomer` in `src/lib/marketing-requests/customer-edit.ts`,
  the Customer Check page's "Remove". Every live link from that customer to that pharmacy is switched
  off (never deleted), the reason goes into the link's notes and one audit row. Adding the pharmacy back
  switches the same row on again. A request already raised on it keeps its target.
- **Finding the customers that hold one shop twice:** two live links on one customer, on two different
  venue copies, whose codes are the same code at the same distributor
  (`phx_marketing_code_match_key`). Keep the copy with the shop photo and the higher validation; take the other off.
- **Done this way first, 26 Nov 2026 02:53 Cairo:** six customers, seven links (احمد محمد عبدالفتاح,
  د.مصطفي شلش twice, ربى خضير, سيد البلاصي, صدر امبابة, ياسر جمعة المصري). The duplicate venues
  themselves are still on file; folding them is `merge-venues`.
- 🔴 **Same code, different name is NOT a copy.** د.سيد البلاصي holds "جميلة" and "ريهام" under one Ibn Sina
  code (348325), and جميلة's code row was already switched off: a code typed against the wrong shop,
  left for the owner.
- **Proof:** the run reads the customer's live pharmacies back; the link's `active` is false.

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

## Medical insurance

### Fill the Employee Master from the medical insurance register ("sync insurance to the master")

First run 27 Nov 2026, on the owner's "synchronize from medical insurance module to employee master
the needed data". It filled 4 records: three Libano-Suisse card numbers and one mobile number. The
same day, on "cost in module in cost and invoices", it also wrote the monthly cost into 10 records.

- **Run:** `owner-ops.ts sync-insurance-master` (no flags: it reads the whole register).
- **Function:** `syncEmployeeMasterFromMedicalInsurance` (`src/lib/medical-insurance/service.ts`). The
  rule is `planEmployeeMasterSync` (`master-sync.ts`). The cost rule is `planMedicalInsuranceAmounts`. It asserts
  `medical_insurance` read, `medical_insurance_invoices` read and `employees` update.
- **What it writes:** "Medical Insurance Card Number" from the person's own employee row on the register.
  A blank number is filled. One that differs (the cancelled MetLife policy's 2 to 4 digits) is replaced.
  National ID, birth date, gender (M/F → male/female) and mobile (the insurer's 10 digits → 01…) are
  written ONLY where the master is blank. "Medical Insurance" takes the module's monthly cost — what the
  employee pays for the payroll month on the Cost and Invoices tabs (`getPayrollMedicalInsuranceCharges`),
  December 2026 or the current month after it. An active employee the module charges nothing holds 0; a
  leaver keeps the figure history holds; a row the module cannot price is printed, never guessed. Payroll
  reads the module itself from December 2026, so this figure cannot charge twice. Each update is guarded on the value it read. It is audited and
  names B-10 to `employee_change_log` through the actor headers, so it is not unattributed.
- **What it never writes:** "Card Received (Yes-No)" and its date (the register cannot know the employee
  holds the card). A value present on both sides that differs is printed under "Differ on
  both sides" for a person to settle.
- **Proof:** the run reads the changed `employees` rows back. `employee_change_log` names `actor_login_id`
  B-10 for each one.

### End a leaver's cover ("end the resigned employees' insurance")

First run 27 Nov 2026, on the owner's "End the three resigned employees' insurance cover". It ended three
employees the Add/Remove screen listed to remove; none had family on the policy.

- **Run:** `owner-ops.ts end-insurance-cover --employee <HR id[,HR id…]>` (up to 20; dry run first, then
  `--apply`).
- **Function:** `updateMedicalInsuranceMember(owner, memberId, { action: "end", coverageEnd, endReason })`
  (`src/lib/medical-insurance/service.ts`), the same call the Add/Remove screen's "End cover" makes. It
  asserts `medical_insurance` update.
- **What it writes:** the end day and reason come from the screen's own removal row
  (`getMedicalInsuranceView().actions`, kind `remove`): `effectiveOn` and `reason`, never a typed date. Someone
  who left before their cover started is ended on its first day ("voided from its first day"). Their spouse
  and children end with them. An HR id the screen does not list to remove is refused, and nothing is ended.
- **What it never does:** delete a row, send the insurer anything, or touch a bill. The member file still goes
  to Libano-Suisse by a person's hand.
- **Proof:** the run reads back each person's register row and their family's rows (`coverage_ends_on`,
  `end_reason`); the audit log (`writeRequiredAuditLog`) holds one row per end, by B-10.
- 🔴 **Send the deletion to Libano-Suisse FIRST, then end the cover.** The To remove list shows only people whose
  cover is still open in Phoenix, so ending it takes them off the list and out of the Send. On 27 Nov 2026 the
  three were ended at 11:10 before any real deletion went, and Salim Gomaa was then missing from To remove.

### Put an ended cover back ("bring them back on To remove")

First run 27 Nov 2026, on the owner's answer "Only bring back these three" (Salim Gomaa, Aya Tarek, Abdelrahman
El-Shemy), so their deletion could be sent from the Add/Remove screen.

- **Run:** `owner-ops.ts reinstate-insurance-cover --employee <HR id[,HR id…]>` (dry run first, then `--apply`).
- **Function:** `updateMedicalInsuranceMember(owner, memberId, { action: "reinstate" })`, the register's own
  "Put back": the row reopens, a live Exclude is revoked, and the family that end took with them comes back.
- **What it refuses:** an HR id with no ended employee row on the policy in force, or with more than one; every
  name is settled before anything is written.
- **After the Send:** end them again with `end-insurance-cover`; the screen gives the same day and reason.

## Rep tablets

### Make a tablet that already carries Phoenix Position actually start it

- 🔴 **AN APK HEADWIND HAS INSTALLED IS NOT AN APP THAT HAS RUN, AND THIS IS THE APP WHERE THAT IS THE
  WHOLE DIFFERENCE.** Measured on production 26 Nov 2026: Phoenix Position 1.0.0 was installed on
  PHX-TAB-0007 and PHX-TAB-0008, both of which had checked in that morning, and
  `device_position_agents` held **zero rows**. The app shows the rep nothing — no icon, no
  notification, no screen — so nobody can open it, and Android keeps an app that has never run in the
  **stopped** state, where not even `BOOT_COMPLETED` reaches it. Until something starts it once it
  mints no install id, says no hello and schedules no rounds.
- **The cause was one false field, and it is now true.** The application row's own `runAfterInstall`
  (application 98) was `false`, so Headwind installed the APK and ran nothing.
  `setHeadwindAppRunAfterInstall({ applicationId, runAfterInstall: true }, "B-10")` turns it on — it
  reads the whole app row and sends it back with that one field changed. 🔴 **It governs the NEXT
  install only**: Headwind acts on it at install time, so it does nothing for a tablet already holding
  the app.
- **For a tablet already holding it:** `owner-ops.ts start-tablet-agent --tablet PHX-TAB-0007` —
  `startPositionAgentOnTablet` in `src/lib/devices/positions/start.ts`, Headwind's own `runApp` push,
  which the launcher turns into a `startActivity` on that package. An explicit start by another app is
  what lifts the stopped state. Run it with `railway run` (the credentials are production-only, as
  below), and it is audited as `tablet_position_agent`.
- **It refuses a tablet that has not got the app**, and says "could not be read" rather than "has not
  got it" for a tablet whose app list is empty — the push answers 200 whatever package it names, so
  without that read a tablet the app never reached would look exactly like one that just started it.
- 🔴 **START THEM ONE AT A TIME.** Two identical Lenovos give identical introductions, so the only
  certain way to know whose install is whose is to push to one tablet, wait for exactly one new row,
  bind it, then push to the next. A wrong bind puts one rep's movements on another's tablet.
- **Proof:** `owner-ops.ts tablet-agents`, or
  `select install_id, device_number, first_seen_at from device_position_agents order by first_seen_at desc`.
  The hello arrives as soon as the tablet receives the push; a tablet that is off the network gets it
  at its next check-in.

### Say which tablet a Phoenix Position install is (and read its trail)

- **Why it needs doing at all.** The rep tablets' own Phoenix Position app enrols ITSELF: it says hello
  with an install id it minted, Phoenix answers a token once, and from then on it posts its fixes with
  that token. Nothing in that exchange says which tablet it is — the app is deliberately silent on the
  tablet (`rep-tablet-never-shows-tracking-golden-rule`), so nobody types a number into it. The install
  arrives UNBOUND, its fixes are kept with no tablet number, and a person says whose they are.
- **List them:** `owner-ops.ts tablet-agents` — every install that has ever said hello, which tablet each
  is bound to, when it last called, how many fixes it has sent, and whether it is out of service. A read;
  `--apply` means nothing here.
- **Bind one:** `owner-ops.ts bind-tablet-agent --install <install id> --tablet PHX-TAB-0008` — a dry run
  first, then the same line with `--apply`. It calls `bindPositionAgent` in
  `src/lib/devices/positions/agents.ts` and 🔴 **stamps the fixes that install already sent with that
  tablet too** — without it the week before the bind would read as a tablet that reported nothing.
- **Take one out of service:** `owner-ops.ts revoke-tablet-agent --install <id> --reason "<why>"` — the
  install is refused from its next call (403) and the tablet is free to bind a new one. Do this when a
  tablet is factory reset, re-issued or lost: a reset tablet comes back as a NEW install id, and the old
  row would otherwise keep the tablet's number.
- **Which install belongs to which tablet.** The listing prints the manufacturer, model and Android
  version the install reported, and its first hello's time. Match those against the tablet in Headwind
  (its own model and the hour it was set up); where two are alike, bind one and read its trail — a fix
  near the rep's own area settles it. Never guess: a wrong bind puts one rep's movements on another's
  tablet.
- **What it refuses:** an install id no hello has used (404), one already out of service (409), and a
  tablet that is already reporting through a different live install (409, naming it) — one live install
  per tablet, pinned by a partial unique index in the database.
- **Proof:** the run reads that tablet's agent trail back the way the Tablet Dashboard reads it
  (`listAgentFixes`), newest first. Both the bind and the revoke write an audit row under entity type
  `tablet_position_agent`.
- **Permission:** the same `company_devices / approve` check every Headwind route makes.

### Put an app on every rep tablet ("push it to the tablets")

- **Nothing is pushed.** An app reaches a rep tablet because it is listed on that tablet's Headwind set of
  rules; the tablet installs it on its next run. So "push X to the tablets" means: register the APK on the
  tablet server and link it to **all three** rep sets — `Rep tablets` (3), `— Anti Infective` (4),
  `— Pedia` (5). Two lines silently miss an app put on only one.
- **Run it from the code:** `uploadHeadwindApp({ file, rules: "rep", showIcon }, "B-10")` in
  `src/lib/devices/headwind/uploads.ts` — one upload, one link per set, one audit row per set, and it
  moves the registered link onto `https://` itself. `showIcon: false` for an app the rep must not see.
- 🔴 **The Headwind credentials exist ONLY in Railway production** — `HEADWIND_MDM_BASE_URL`, the two
  `_ACCESS_CLIENT_*` values, `_LOGIN` and `_PASSWORD` are in no local env file, so the script is run with
  `railway run --service phoenix-people-workforce -- node --experimental-strip-types
  --experimental-specifier-resolution=node --import ./tests/register-alias-loader.mjs <script>`.
- 🔴 **THEN CHECK EVERY INSTALL LINK, OR THE APP CAN SIT ON THE RULES AND NEVER ARRIVE** —
  `checkHeadwindInstallLinks("rep")` prints each set's broken count. One dead link stops that tablet's
  whole update run at that app, so a link nobody checked keeps the new app off the fleet. Measured
  26 Nov 2026: Phoenix Position was correctly on all three sets (one link each, 200) while **Telegram's
  own `https://telegram.org/dl/android/apk` had rotted into a 302** — one broken of 12, 13 and 13.
- **A publisher's URL rots into a redirect, and the cure is the file the server already holds.** Probe
  `https://mdm.satopharma.com/files/<name>` with a HEAD first: the big third-party apps are already on the
  46 GB volume at `/usr/local/tomcat/work/files` (Telegram, WhatsApp, WPS). Then edit that app's version
  row **in place** — `PUT /rest/private/applications/versions` with its `id` kept, never a configuration
  PUT (§8.14) — so the download becomes that address, which answers 200 by itself.
- 🔴 **THE ROW'S `version` AND `versionCode` MUST MATCH THE FILE ON THE DISK, or every tablet
  re-downloads it hourly for ever** — the launcher compares an app row by `versionCode`. **Do not type
  the pair in by hand any more:** `owner-ops.ts match-app-version --app <app number>` reads the real
  `versionCode`/`versionName` out of the APK's own binary manifest and puts the row back level with it.
  It reads the file by **ranged requests off the server** — about 100 KB over four reads of an 81 MB
  APK — refuses when the file turns out to be a different package (that would hand the fleet another
  app under this app's name), keeps the row's own `id` so no second row appears beside it, and reads the
  row back afterwards, because this endpoint has answered OK while storing nothing before. Dry run
  first, then `--apply`. A typed number is what put the fleet in the loop twice: 26 Nov 2026 the row
  claimed 13.1.0 / 72299 while the file under it had become **13.3.1 / 73469**.
- 🔴 **A BIG APK CANNOT BE UPLOADED FROM THE LAPTOP — CLOUDFLARE CUTS IT AT HTTP 524.** `mdm-console` sits
  behind Cloudflare Access, whose origin wait is about 100 seconds, and 81,653,599 bytes of Telegram 13.3.1
  died there (`uploadBytes`, 26 Nov 2026) having registered nothing. A file that big reaches the disk only
  from the server's own side: `phoenix-entrypoint.sh` fetches the three everyday apps at every start and,
  since 26 Nov 2026, re-fetches a floating source whose publisher is serving a different `content-length`.
- 🔴 **A REFRESHED FILE ON THE DISK STILL REACHES NO TABLET THAT HOLDS THE OLD BUILD — THE VERSION ROW IS
  THE TRIGGER.** The launcher compares what is installed against the row's `versionCode`, so bumping the
  row to the file's real pair is the hand step that actually ships an update to the fleet.
- **Proof:** read the sets back (`readHeadwindConfigurationApplications`) — one link per set, `action 1`,
  `remove false`, the version you sent — and then the link report showing **0 broken on all three**
  (measured 26 Nov 2026: 0 of 12, 0 of 13, 0 of 13).

### Stop a rep turning the tablet's protections off ("protect the tablet")

Owner, 26 Nov 2026: *"want to make sure he can't turn the location off. He can't turn the mobile network
or the Wi-Fi off. He can't reset the tablet. He can't be developer mode. He can't install apps … but
without irritating the usage."*

- **Run:** `owner-ops.ts lock-rep-tablets` (dry run), then `--apply`. One job, all three rep sets of
  rules; it prints every lock with **what it costs a rep** before it sends anything, and it only ever
  ADDS — nothing is taken off, so a routine save can never quietly unlock a tablet.
- 🔴 **THE VOCABULARY IS ANDROID'S, NOT HEADWIND'S.** The launcher splits a configuration's
  `restrictions` string on commas and calls `DevicePolicyManager.addUserRestriction` for each piece
  (`Utils.lockUserRestrictions`), so a token Android does not know is **silently ignored**: the lock
  reads as applied on the server and holds nothing on the tablet. `src/lib/devices/headwind/restrictions.ts`
  carries the vetted list with each token's Android version, and refuses anything else by name.
- **Already carried before this:** `no_factory_reset`, `no_safe_boot`, `no_debugging_features`,
  `no_add_user`, `no_config_location`, `no_uninstall_apps` — so factory reset, developer mode and the
  location switch were his three that were already answered.
- **Added 26 Nov 2026:** `no_change_wifi_state` (Wi-Fi cannot be switched off; joining and switching
  networks still works), `no_airplane_mode` (the one tap that kills Wi-Fi and data together),
  `no_config_mobile_networks`, `no_network_reset`, `no_install_unknown_sources` (nothing side-loads; the
  agent still installs everything Phoenix sends, as the device owner) and `no_control_apps` (Settings >
  Apps can no longer force-stop an app or clear its data — this is what stops the position agent being
  stopped by hand).
- 🔴 **THE TWO THAT MUST NEVER GO ON, BOTH OF WHICH READ LIKE EXACTLY WHAT WAS ASKED FOR.**
  `no_install_apps` — AOSP: *"This user restriction also prevents device owners and profile owners
  installing apps"* — would stop every app, launcher and Phoenix update ever reaching the fleet again;
  `no_install_unknown_sources` is the one that was wanted. `no_config_wifi` stops the rep joining or
  switching a network at all, not just turning Wi-Fi off; `no_change_wifi_state` is the one that was
  wanted. Both are refused by name with the reason.
- 🔴 **AND THE ONE THING NO ANDROID LOCK CAN DO: the mobile-data switch.** There is no `DISALLOW_*` for
  it — `no_config_mobile_networks` covers only the network's settings — so a rep can still turn mobile
  data off in quick settings. Only a launcher that turns it back on closes that, and that is a launcher
  build (`Omar-3-xx/hmdm-android`, `patch-launcher.yml`), not a rules change. Say this plainly rather
  than reporting "he cannot turn the network off".
- 🔴 **The launcher never lifts the four protective blocks** (factory reset, safe boot, debugging, add
  user) even if they are taken off the rules, so leave them in — see `.claude/rules/devices.md`.
- **Proof:** every rep set of rules read back off the server with all twelve locks on it. Each tablet
  picks them up at its next check-in; Android enforces them, not a screen.

## Phoenix CRM

### Put doctors on a rep's list for her to validate (and their hours)

- **Run:** `owner-ops.ts load-crm-list --seat <territory seat id> --body <file.json>`
- **What it calls:** the SFE's own list-template path. `buildListTemplateFor` builds the territory's
  template (the download, seat marker included), the runner writes the body's rows into it, and
  `importListTemplate` uploads it. That is the function behind `POST /api/phoenix-crm/list/template/import`.
  The route's gate (`assertPermission(…, "phoenix_crm", "approve")`) and its audit line run as well.
  Every check of the upload applies: the seat marker, the row rules, and the database's skip for a name
  already on the list.
- **Body file:** rows in the template's own column keys.

  ```json
  {
    "customers": [
      { "listType": "PM", "name": "<doctor, Arabic as he is known>", "speciality": "Chest",
        "daysAndHours": "Tue 6:00 PM - 7:00 PM", "whereToFind": "<hospital — town, clinic, day>",
        "note": "<a line for the rep>" }
    ],
    "hours": [
      { "listType": "PM", "name": "<a customer already waiting to be validated>", "daysAndHours": "Tue 7:30 PM - 8:30 PM" }
    ]
  }
  ```

- **What lands:** each `customers` row is a `pending` customer (origin `new`) under the rep's
  **To validate**. That is how she is asked: no notice goes to a rep from here, and Phoenix CRM sends
  no email. She validates him at the door, seating him in the building within 300 m. The place is
  never a column. `hours` sets the days and hours on a customer still pending and placeless, and
  nothing else about him.
- **The seat:** the rep's territory seat (`SEAT-…`), read from `au_v_org_tree` by her name. It is never her HR id.
- **AM or PM at a hospital follows the seating** (the place's `session`), never the list. No app door
  moves an existing customer between AM and PM.
- **Proof:** the runner reads the territory's rows for every name in the body (status, origin, hours, where to find them).
- 🔴 **Until 26 Nov 2026 the first sheet's hours never landed**: the payload sent `intake_timings`
  and the loader reads `timings`. That affected 1,667 customers, 6 Oct to 26 Nov. After the fix a new
  customer's hours land with him. For the 26 Nov rows they were set afterwards through `hours`.
- First done for Nora Kamal (Pedia, Menoufia 1, `SEAT-PED-REP-D12`), 26 Nov 2026. The owner sent the
  Tuesday timetable of مستشفى الشروق الخاصة. Three doctors were added: محمد محروس (Chest), محمد أنور (ENT)
  and احمد الجوهري (Chest). احمد توفيق was already waiting and got his hours.

### Let a rep log one place as AM and as PM ("make it AM or PM")

- **Run:** the same `load-crm-list` job, with **two `customers` rows of the same name, one `"listType": "AM"`
  and one `"listType": "PM"`**. Dry run first, then `--apply`.
- **Why two rows:** a customer holds exactly one list (`phoenix_crm_customers_list_type`: AM, PM or
  Pharmacy), and no app door moves one between AM and PM. The loader's `already_on_the_list` skip
  compares the folded name **within the same list type only**, so the AM and the PM row are both
  accepted. A building seating cannot do it either: `phoenix_crm_insert_place` refuses a second seating
  of one customer in one building (`already_seated`), so one customer gets one session there.
- **What lands:** two `pending` customers under the rep's **To validate**. He validates each one at
  the door, and then plans and logs the morning visit on the AM row and the evening visit on the PM
  row. The AM and PM figures stay apart, as the golden rule requires.
- **Proof:** the runner's own read, then `phoenix_crm_customers` by seat and name: two rows, `AM` and
  `PM`, `pending`, `origin = new`.
- First done for Ahmed Shaaban (Anti-Infective, Giza 5, `SEAT-AIF-REP-GZ5`), 26 Nov 2026:
  مسجد الميدان الخيرى, AM `a8ff2daa-af40-4ed9-aea2-291e419d3e27` and PM `a518a129-1981-41e8-aa1c-0516e4ccf4a6`.

### Validate waiting doctors from a building's timetable

- **Run:** `owner-ops.ts seat-in-building --seat <territory seat id> --building <shared place id> --customers <id,id,…> --reason "<why, 10 to 500 characters>"`
- **What it calls:** `seatWaitingCustomersInVenue` in `src/lib/phoenix-crm/server/place-move.ts` (Super Admin only), which
  calls `phoenix_crm_seat_waiting_customers_in_venue`. It seats each customer at the building's own point, with the
  building's timetable as his photograph, exactly as the move into a building does. It never validates anybody.
  `settleVenueTimetable` then reads the board for each of them, and the database validates only a customer the board
  names (`match`) with no review waiting. A board that does not name him leaves him waiting.
- **What it refuses:** a building that is retired, still waiting for the Super Admin, or has no timetable on file; a
  customer who is not on the seat, is a pharmacy, is not waiting, already has a place (the move is his door), or has
  no hours yet (set them first with `load-crm-list`'s `hours`). The runner reads all of this first and fails with
  the same refusals before anything is written.
- **The ids:** the building from `phoenix_crm_shared_places` by seat and name; the customers from
  `phoenix_crm_customers` by seat and name, `status = 'pending'`.
- **Proof:** each customer's status, `validated_at`, his new place and the board's verdict for him.
- First done for Nora Kamal (`SEAT-PED-REP-D12`), 26 Nov 2026: the four doctors on the Tuesday timetable of مستشفي الشروق.

### How these were run before the runner

On 25 Nov these routes were called on the SPARE laptop's dev server with dev-auth headers
(`x-phoenix-role: Super Admin`, `x-phoenix-hr-id: B-10`, `Origin: http://localhost:3000`) through
`~/.claude/scripts/spare.ps1`. That broke whenever the spare's Wi-Fi dropped, which it did at 22:44
that night. A scratch script that fabricates a Super Admin viewer was refused by Claude Code's safety
check on 9 Oct 2026. `scripts/owner-ops.ts` is the reviewed, committed form: it reads B-10's real
login row instead of fabricating one. A new desk job becomes a new subcommand there, with its recipe here.

## Phoenix CRM

### Approve a rejected validation after all ("Approve it after all")

- **What it calls:** `restoreValidation(viewer, { reviewId, note })` in `src/lib/phoenix-crm/server/validation-reviews.ts`,
  the same path `POST /api/phoenix-crm/validation-reviews/restore` takes. The viewer is
  `resolvePhoenixCrmViewer(createAccessContext({ hrId: "B-10", loginId, role, source: "session" }))`, built
  from his one active, non-test `app_auth_users` row (as `liveAccessContext` in `scripts/owner-ops.ts` does).
  There is no runner job for it yet. On 26 Nov 2026 it ran from a throwaway file in the worktree with the
  alias loader and `--env-file-if-exists=.env.local`, one call per review id.
- **Ids:** the place's ONE `phoenix_crm_validation_reviews` row (`place_id` is unique). A customer with two
  places has two reviews. The second answers `validated: false` once the first has validated him, which is
  correct.
- **Proof:** the customer is `active` with `validated_at`, the place is `active`, the review is `approved` by `B-10`.

### A one-time location-only exception (no photo kept)

- **Only on his word for the named cases.** The standing rule is "no customer is validated without a photo"
  (`.claude/rules/phoenix-crm-place-checks.md`). On 26 Nov 2026 he allowed it once, for Hadeer Abdelnaser
  (B-95) and the doctors with no signboard naming them: Siham Sobhy, Hisham Samih Ismail, Wael Abu El Kheir,
  and Hisham Khodeir (both clinics). His words: "exception only for this time, for this rep, location only, no photo".
  Ahmed Eid was left alone, because he has no capture and so no location.
- **How:** back up the places, reviews and customers first (`phoenix_crm_backup_20261126.paper_exception_*`).
  Then `photo_path = null` with `trusted_basis = { kind: "owner_exception_location_only", decided_by_hr_id,
  decided_on, reason, removed_photo_path }`. The `phoenix_crm_places_photo_or_trusted` CHECK needs one of the
  two. The stored file stays in storage, and its path stays in `removed_photo_path`. Only after that comes
  the take-back above, so the line copies are made without the photo. The point stays the photo's own reading.
