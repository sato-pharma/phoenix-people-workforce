import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { pvTrainingSheetFileName } from "@/lib/pv-training/training-sheets";

/**
 * One scanned page as a data URL. Read from `assets/` (traced into the standalone build by
 * next.config.ts), never served from `public/`: every page carries real signatures.
 */
export async function readPvTrainingSheetImage(page: number): Promise<string> {
  const bytes = await readFile(join(process.cwd(), "assets", "pv-training-sheets", pvTrainingSheetFileName(page)));
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
