/**
 * Shadowed twin — the real implementation lives in `lib/utils.ts` at the repo root.
 *
 * tsconfig maps `"@/*": ["./*", "./src/*"]` and tries `./` FIRST, so every
 * `import { cn } from "@/lib/utils"` in the codebase resolves to `lib/utils.ts`,
 * never to this file. For a long time both files held byte-identical copies of
 * `cn` and `formatEmployeeDisplayName`, which made the shadowing invisible: the
 * app behaved correctly, so nothing pointed at the duplication.
 *
 * It stopped being invisible the moment a fix was written here — a tailwind-merge
 * configuration repairing ~4,800 stripped font-size classes — and the running app
 * did not change at all, because this file is not loaded. Re-exporting instead of
 * duplicating means the two can never disagree again: there is now exactly one
 * implementation, and editing either path reaches it.
 *
 * Do not restore a second copy of these functions here.
 */
export { cn, formatEmployeeDisplayName, PHX_FONT_SIZE_NAMES } from "../../lib/utils.ts";
