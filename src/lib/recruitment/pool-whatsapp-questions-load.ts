// Recruitment / ATS — the server half of pool-whatsapp-columns.ts: the bot's questions and who each
// built-in one is asked to, read once per pool load.
//
// Both come from the loaders the bot and the WhatsApp Applicants page already use, so the pool's
// headers cannot disagree with what applicants were actually asked. The audiences cross into the client
// as a plain object, never the Map the loader returns.

import { loadSavedAudiences } from "@/lib/recruitment/inbound/whatsapp-classify-session";
import type { PoolWhatsAppQuestions } from "@/lib/recruitment/pool-whatsapp-columns";
import { listScreeningQuestionLabels } from "@/lib/recruitment/screening-question-labels";

export async function loadPoolWhatsAppQuestions(): Promise<PoolWhatsAppQuestions> {
  const [questions, audiences] = await Promise.all([listScreeningQuestionLabels(), loadSavedAudiences()]);
  return { audiences: Object.fromEntries(audiences), questions };
}
