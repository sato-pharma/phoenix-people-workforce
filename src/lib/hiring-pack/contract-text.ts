/**
 * The employment contract, in every version of it.
 *
 * This file used to BE the contract — one text, exported clause by clause. On 2026-08-30 the owner
 * replaced the contract and asked that the old one be archived rather than dropped, so the text
 * moved out to `contract-text-v1.ts` (archived) and `contract-text-v2.ts` (current), and what is
 * left here is the thing that knows about both.
 *
 * Which version is CURRENT is not decided here. It is decided once, in `template-registry.ts`,
 * alongside the same decision for Form 1, Form 6 and the two exit forms — because "which paper do
 * we print today" is one question about five documents, and answering it in five places is how the
 * answers drift apart.
 */

import type { ContractTemplate } from "./contract-template";
import { CONTRACT_TEMPLATE_V1 } from "./contract-text-v1";
import { CONTRACT_TEMPLATE_V2 } from "./contract-text-v2";
import { CONTRACT_TEMPLATE_V3 } from "./contract-text-v3";
import { currentTemplateVersion, resolveTemplateVersion } from "./template-registry";

export type { ContractTemplate, ContractToken } from "./contract-template";
export { fillContractTokens, CONTRACT_BLANK_RULE } from "./contract-template";

/**
 * Every version of the contract, oldest first.
 *
 * NOTHING IS EVER REMOVED FROM THIS LIST. An archived version is still imported, still typechecked
 * and still rendered by the same renderer as the current one, which is what stops it rotting: the
 * day somebody reprints a contract signed against version 1, that path has been exercised on every
 * build since.
 */
export const CONTRACT_TEMPLATES: readonly ContractTemplate[] = [
  CONTRACT_TEMPLATE_V1,
  CONTRACT_TEMPLATE_V2,
  CONTRACT_TEMPLATE_V3,
];

/** One version by id, or null when the id is not one of ours. */
export function contractTemplateById(id: string): ContractTemplate | null {
  return CONTRACT_TEMPLATES.find((template) => template.id === id) ?? null;
}

/**
 * The contract Phoenix prints today.
 *
 * Resolved through the registry rather than by taking the last element of the array, so the array's
 * order can never quietly decide what a new hire signs.
 */
export function currentContractTemplate(): ContractTemplate {
  const { id } = currentTemplateVersion("contract");
  const template = contractTemplateById(id);
  if (!template) {
    throw new Error(
      `The template registry says the current contract is "${id}", but no contract text with that ` +
        "id is registered. A version was archived or renamed without its text following it.",
    );
  }
  return template;
}

/**
 * Which contract text to print for one person.
 *
 * A signed contract reprints the version that was SIGNED, not today's. That is the reason the
 * archive exists at all: the alternative is a reprint that looks like a contract, is not the one in
 * the employee's file, and gives no sign of the difference. `reproducedFromSignature` says which
 * happened, so the page can label it.
 */
export function resolveContractTemplate(signedVersionId: string | null | undefined): {
  template: ContractTemplate;
  reproducedFromSignature: boolean;
} {
  const { version, reproducedFromSignature } = resolveTemplateVersion("contract", signedVersionId);
  const template = contractTemplateById(version.id);
  if (!template) return { template: currentContractTemplate(), reproducedFromSignature: false };
  return { template, reproducedFromSignature };
}
