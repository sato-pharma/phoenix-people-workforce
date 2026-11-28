---
name: a-name-for-an-hr-id-is-read-never-guessed
description: "Every person's name written for an HR ID must be read from production in the same turn (hr-names.mjs / employees join); an invented name made the owner think the session was on staging."
metadata:
  node_type: memory
  type: feedback
  originSessionId: cfdda059-743b-4539-9c1c-f49859c94e56
  modified: 2026-11-27T15:46:11.854Z
---

Never write a person's name for an HR ID from memory or by guessing. On 27 Nov 2026 a session wrote "Ahmed Abdelaziz" for **AA**, who is **Anwar Gaweesh, the CEO**. The owner read it as proof the session was pointed at staging ("local dev always point to production"), and said it was "not the first time". His words: "Train yourself on all HRIDs and names ... make it a skill on you to recognize the employees with their HRIDs."

**Why:** a made-up name is a false fact about a real person. It also destroys his trust that the data shown is production's.

**How to apply:** collect every HR ID a reply will name and run `node ~/.claude/scripts/hr-names.mjs <ids>` once, in the same turn. It is read-only and refuses anything but production `ozucdzovmcqvepbozvqf`. Alternatively, join `employees` (`hr_id`, `full_name`, `job_title`, `employment_status`) into the production SQL you are already running. An ID it does not find is "not an employee on production", never a guessed name. B-10 is "you" (see [[b-10-is-the-owner-himself]]). Skill: `employee-names` in `~/.claude/skills/`.
