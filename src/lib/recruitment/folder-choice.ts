// Recruitment / ATS — which folders a send dialog offers for the chosen manager (pure).
//
// The owner, 2026-10-16: every manager holds an empty folder per area beneath him, and Talent
// Acquisition decides what goes into them. The server already files a CV by itself, so the choice is
// an override and never a required step. It applies only when exactly ONE manager is chosen and he
// holds folders: a head-office manager has none, and a CV going to several managers at once has no
// single shelf to choose from.

import { OTHER_CVS_FOLDER_LABEL } from "@/lib/recruitment/manager-cv-folders";

/** The value that means "let the system file it". */
export const AUTOMATIC_FOLDER = "";

/** The folders to offer for these chosen managers, or none when the choice does not apply. */
export function foldersToOffer(
  options: ReadonlyArray<{ hrId: string; folders?: string[] }>,
  chosenHrIds: readonly string[],
): string[] {
  if (chosenHrIds.length !== 1) return [];
  const manager = options.find((option) => option.hrId === chosenHrIds[0]);
  const folders = manager?.folders ?? [];
  return folders.length === 0 ? [] : [...folders, OTHER_CVS_FOLDER_LABEL];
}
