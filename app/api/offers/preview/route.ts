import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { deriveOfferPay } from "@/lib/offers/pay";
import { offerJsonError } from "@/lib/offers/http";
import { renderOfferDocument } from "@/lib/offers/render";
import { renderOfferEmail } from "@/lib/offers/render-email";
import { isOfferTemplateVariant } from "@/lib/offers/builtin-templates";
import { satoLogoDataUri, satoLogoReverseDataUri, satoLogoUrl, satoSealDataUri, satoSignatureDataUri } from "@/lib/offers/brand";
import { systemDeployment } from "@/config/system-settings";
import { sanitizeTemplateBlocks, sanitizeTheme } from "@/lib/offers/service";
import {
  OFFER_DEFAULT_FONT,
  OFFER_DEFAULT_FONT_SIZE_PT,
} from "@/lib/offers/default-template";
import type { OfferFields } from "@/lib/offers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Render an UNSAVED design.
 *
 * This is what makes the editor live: the browser posts whatever blocks are currently on screen
 * and gets back the exact HTML the letter would produce, from the same renderer that produces the
 * real thing. A separate client-side preview would be a second implementation of the layout, and
 * the day it drifted the preview would start lying about a document people sign.
 *
 * It is a POST because it carries a body, not because it changes anything — nothing here touches
 * the database. It still takes the CSRF check and the `offers` permission, because the response
 * contains a rendered salary table.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = (body.fields ?? {}) as Record<string, unknown>;
    const text = (key: string) => String(raw[key] ?? "").trim();

    const fields: OfferFields = {
      candidateEmail: text("candidateEmail"),
      candidateName: text("candidateName") || "Candidate Name",
      contractTerm: text("contractTerm"),
      costOfLiving: Number(raw.costOfLiving ?? 0) || 0,
      dateOfIssue: text("dateOfIssue"),
      reference: text("reference"),
      reportsTo: text("reportsTo"),
      roleSummary: text("roleSummary"),
      salutationName: text("salutationName"),
      startDate: text("startDate"),
      territory: text("territory"),
      title: text("title") || "Job Title",
      totalMonthly: Number(raw.totalMonthly ?? 0) || 0,
      validUntil: text("validUntil"),
    };

    const template = {
      blocks: sanitizeTemplateBlocks(body.blocks),
      fontFamily: String(body.fontFamily || OFFER_DEFAULT_FONT),
      fontSizePt: Number(body.fontSizePt) || OFFER_DEFAULT_FONT_SIZE_PT,
      theme: sanitizeTheme(body.theme),
      variant: isOfferTemplateVariant(body.variant) ? body.variant : ("classic" as const),
    };

    // The preview has to show the same mark the recipient will get, or the designer is lying about
    // what it produces: the data URI for the document, as the PDF renderer uses.
    //
    // The email preview keeps the absolute public URL even though a real send now carries the mark
    // as a `cid:` part (2026-09-17). The two are the same PNG, and a browser cannot resolve a
    // `cid:` at all — putting one here would leave the designer staring at the broken placeholder
    // this change exists to remove.
    const logoUrl = typeof body.logoUrl === "string" ? body.logoUrl : undefined;

    if (body.mode === "email") {
      const { html, text: plain } = renderOfferEmail(template, fields, {
        logoUrl: logoUrl ?? satoLogoUrl(systemDeployment.productionUrl),
      });
      return NextResponse.json({ html, success: true, text: plain });
    }

    const rendered = renderOfferDocument(template, fields, {
      logoUrl: logoUrl ?? satoLogoDataUri() ?? undefined,
      // The reverse (white-on-navy) mark, so the Sato corporate design's navy masthead shows its
      // mark in the on-screen preview and not just in the PDF. Only that variant draws on navy.
      logoReverseUrl: template.variant === "sato" ? (satoLogoReverseDataUri() ?? undefined) : undefined,
      // The designer has to show the signature the PDF will actually carry. Without this the
      // preview would render an unsigned letter and the signed one would only ever appear in the
      // candidate's inbox — the one place nobody checks it before it is too late.
      sealUrl: satoSealDataUri() ?? undefined,
      signatureUrl: satoSignatureDataUri() ?? undefined,
    });
    return NextResponse.json({
      body: rendered.body,
      css: rendered.css,
      html: rendered.html,
      // The derived figures come back alongside the HTML so the form can show them beside the
      // inputs — one typed total, and HR sees basic and transport before anything is saved.
      pay: deriveOfferPay({ costOfLiving: fields.costOfLiving, totalMonthly: fields.totalMonthly }),
      success: true,
    });
  } catch (error) {
    return offerJsonError(error, "Failed to render the offer preview.");
  }
}
