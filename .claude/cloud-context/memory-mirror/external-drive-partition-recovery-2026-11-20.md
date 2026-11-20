---
name: external-drive-partition-recovery-2026-11-20
description: "20 Nov 2026 the Windows USB maker wiped the partition list of his 500 GB external drive (J:/H:, one held his >200 GB data); read-only scan state, what was found, nothing written, he said STOP and wait for the word 'complete'"
metadata:
  node_type: memory
  type: project
  originSessionId: 323777ba-1988-474a-b861-0cf5e09e2db4
  modified: 2026-11-20T11:12:26.202Z
---

Owner, 20 Nov 2026 ~11:45 Cairo: he made a Windows install USB for the spare laptop from one of the two drives (J: and H:) on his "Generic External" 500 GB USB disk (Windows disk 1, MBR now, serial S3P1CB0M). The other held his data (**over 200 GB, his answer**). Windows then shows only G: "ESD-USB" (32 GB FAT32, 1 MiB to 32 GiB) and, since ~12:55, an H: that is a RAW logical partition 32 GiB to the end (not made by Claude; shows 0 GB, no filesystem). **Do not format H: or G:, never click "Scan and fix".**

**Nothing was ever written to the drive by Claude** — every step was a read-only raw read (`\\.\PhysicalDrive1`, GENERIC_READ, one UAC prompt each). He CANCELLED the last UAC prompt (the map-disk run) and then said: "Save what you did, stop for now, and when I tell you complete, you complete."

What the reads found (offsets from disk start):
- Old GPT leftovers (primary + backup, both intact) list ONLY a 16 MB Microsoft-reserved partition (LBA 34-32767) — no entry for the data partition. Disk GUID 143bde07-ed59-4f65-88e8-02b881e40654. Raw copies of the first 34 and last 33 sectors saved (before and after H: appeared).
- Tail scan (last 16 MiB, every sector): NTFS backup boot at LBA 976771071 = 0.53 GiB volume at 465.23 GiB, MFT valid (a Windows recovery partition); NTFS backup boot at LBA 976771119 = 12.5 GiB, MFT unreadable, overlaps the first (stale).
- Full scan (every 1 MiB, read-only, started 11:53) found, up to 420 GiB of 466 at 13:07: (a) **139.67 GiB NTFS volume 235.553 GiB to 375.22 GiB** (backup boot at 375.22 GiB, hidden-sectors field confirms start 252,922,822,656, serial EC741FD1741F9D80) — but the bytes at its start, MFT (lcn 24380416) and MFT mirror (lcn 1120) and the sector before its start all read RANDOM (encrypted or overwritten), no FILE records in its first 6 GiB; (b) **48.47 GiB NTFS volume 416.76 GiB to 465.23 GiB, intact** (primary boot sector, MFT and mirror both read 'FILE'), serial 7C6CD1B76CD16C80, probably an old Windows layout, contents NOT yet looked at. Nothing found 32-235 GiB or 375-417 GiB.
- Scan log final state is in the log file below (the elevated scan process kept running after the monitor was stopped; it only reads and ends itself near 466 GiB).

Files (durable copy): `C:\Users\satoh\.claude\docs\external-drive-recovery-2026-11-20\` — scan-lost-partition.ps1/.log, read-old-gpt.ps1, scan-tail.ps1, inspect-candidate.ps1, map-disk.ps1 (written, never run), the sector backups `disk1-*.bin`. Original scratchpad: `C:\Users\satoh\AppData\Local\Temp\claude\36d20435d4e19dda\323777ba-1988-474a-b861-0cf5e09e2db4\scratchpad\` (re-copy the log from there when resuming).

**Why:** the Windows tool rewrote the partition list and the first 32 GiB; the data partition's start (16 MiB, after the MSR) was inside that area, so its own boot sector is gone and Windows cannot see it. Free space here: C: 80 GB, E: 36 GB, D: 19 GB — over 200 GB of recovered files will not fit, so a second external drive of 500 GB or more is needed if files must be copied off.

**How to apply:** when he says "complete": (1) re-read the scan log (`DONE` line, everything past 420 GiB); (2) with his OK at each UAC, run map-disk.ps1 (classifies every GiB as empty / random-looking / structured) and read the top-level folder names of the intact 48 GB volume by parsing its MFT (read-only); (3) decide: rewrite a partition entry ONLY if a volume's start, size and file index are confirmed intact (saved sector backups make it undoable), otherwise copy files out by MFT or file signature onto a second drive he supplies. Ask whether the drive was ever BitLocker/VeraCrypt-encrypted (random bytes at the 140 GiB volume). Never write to the drive before that.

Related: [[the-spare-laptop-was-reinstalled-2026-11-20]].
