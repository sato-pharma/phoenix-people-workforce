import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  createSourceOfSalesUpload,
  createSourceOfSalesUploadFromBuffer,
} from "@/lib/sales/monthly-distributor-import";
import { buildCodedBuffer } from "@/lib/sales/normalizer/service";

// Single upload entry point for the "Upload Sales" screen. It accepts, for EVERY distributor,
// both a coded/hybrid sheet (the distributor's own template, or a raw export with hand-added
// coded columns) AND a plain raw export — so EGD/Ramco/Sofico/MEC/Chimipharm no longer get
// rejected for lacking a dedicated template.
//
// Flow:
//  1. Try the coded/hybrid path (createSourceOfSalesUpload). This path already gets the
//     customer-map brick auto-fill, so a hybrid sheet whose Brick/Area/Region come out blank or
//     #N/A still validates whenever the customer is mapped.
//  2. If the workbook matches NO coded template, parseDistributorSalesWorkbookBuffer throws
//     `unsupported_distributor_template` BEFORE any DB write (so there is no orphan batch). We then
//     fall back to the Normalizer: convert the raw export to a coded buffer (bricks resolved from
//     the customer map) and run it through the SAME validator + insert. persistOnlyIfValidated is
//     false so a blocked raw sheet behaves exactly as today (blocked batch + rejected rows surface).
//  3. If the raw layout also does not match, re-throw a clean 400 (never a 500).
//
// This module is the ONLY place that imports both the coded importer and the normalizer, which
// keeps the import graph acyclic (the normalizer already depends on monthly-distributor-import, so
// that file must not import the normalizer back).
export async function importSourceOfSalesFile(input: {
  distributorCode: string;
  file: File;
  uploadedBy: string;
  periodOverride?: string;
}) {
  try {
    return await createSourceOfSalesUpload(input);
  } catch (error) {
    if (!(error instanceof SalesWorkflowError) || error.code !== "unsupported_distributor_template") {
      throw error;
    }

    let buffer: ArrayBuffer;
    try {
      const coded = await buildCodedBuffer(input.distributorCode, input.file);
      buffer = coded.buffer as ArrayBuffer;
    } catch {
      // Neither a coded template nor the raw layout matched — surface a clean 400, not a 500.
      throw new SalesWorkflowError(
        "unsupported_distributor_template",
        "This workbook matches neither a coded template nor the distributor's raw layout. Map the distributor's products/bricks first, then upload its raw export or a coded sheet.",
        400,
      );
    }

    return createSourceOfSalesUploadFromBuffer({
      buffer,
      distributorCode: input.distributorCode,
      fileName: input.file.name,
      persistOnlyIfValidated: false,
      uploadedBy: input.uploadedBy,
      periodOverride: input.periodOverride,
    });
  }
}
