---
name: a-hardcoded-7zip-path-silently-skipped-every-archive
description: The mailbox harvest hard-coded C:/Program Files/7-Zip/7z.exe, which does not exist here, so all 21 archives never extracted and 2016 looked unrecoverable; use the scoop shim `7z`, and search bare-subject streams (012016, 13/02/2016) the sales-term index misses.
metadata:
  type: reference
---

On 2026-10-13 the Sato Historical Sales harvest reported "2016 unrecoverable" because `harvest.mjs` called `C:/Program Files/7-Zip/7z.exe` (absent); the working tool is the scoop shim `7z` (`/c/Users/satoh/scoop/shims/7z`). Every `.x` dir stayed empty with no error. Also, 2016 monthly data was forwarded under bare subjects (`012016`..`102016`, `13/02/2016`), which a "sales" term index never matches. Egydrug registers are cp1256 (decode with `TextDecoder("windows-1256")`), and vendor 844 is Marcyrl's wide basket, not Sato's own sales.

**Why:** a silent extractor failure hid a whole year. **How to apply:** after any archive harvest, assert extracted file counts > 0 and decode Arabic xls/txt as cp1256.
