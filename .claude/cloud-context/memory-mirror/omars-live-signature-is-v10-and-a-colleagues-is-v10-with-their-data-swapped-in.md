---
name: omars-live-signature-is-v10-and-a-colleagues-is-v10-with-their-data-swapped-in
description: "Omar's own email signature is the tightened v10 table (animated GIF Phoenix emblem), kept in Downloads, not in the repo; the Email Signature page is the SIMPLE one-picture design for everyone else. When he asks for 'the admin's signature' for a colleague, take v10 and swap only that person's register data - the register has no WhatsApp or LinkedIn, so those two lines are dropped, not invented."
metadata:
  node_type: memory
  type: reference
  originSessionId: f256fb41-209b-4dfb-b955-0d7407989b43
  modified: 2026-10-18T13:41:28.529Z
---

Omar's live signature is **v10**, the 265 px table with the glowing GIF emblem. Files, in `C:\Users\satoh\Downloads`: `omar-signature-code-v10.html` (the paste code, hosted pictures) and `omar-gawish-email-signature-v10.html` (page with Copy buttons, a reply signature and plain text). The pictures it loads are `public/assets/branding/phoenix-hr-signature-glow.gif` and `sato-pharma-signature-logo*.png`, live on phoenix-hr.satopharma.com. None of the HTML is in the repo. The `/employee-portals/email-signature` page is the other design: one picture drawn by next/og, "the simple one", for every employee ([[an-email-signatures-animated-picture-must-be-a-gif-never-an-animated-png]]).

**Why:** on 2026-10-17 he rejected a banner redesign ("awful ... keep the signature already merged"), then asked for the simple one-picture maker for everyone else so nobody can delete a part of it. On 2026-10-18 he asked for Khaled Bedair's (HR id A-2, SFE Manager) "exactly as the one of the admin with Khaled data, not the simple one".

**How to apply:** build a colleague's by exact string substitution on v10, never a redraw: name (first name light, last name bold), title, mobile (`tel:` link and text), email, and the footer line (department · line, from the register). Read the row from production (`employees` joined to `departments`, `lines`, `areas`). Drop the WHATSAPP row and the LinkedIn link, because the register holds neither; add them only if he supplies the number or address. Drop the "How it reads" screenshots, which are Omar's. Then diff the paste code against Omar's at tag level, so only the data lines differ. Done so far, files in Downloads: Khaled Bedair (SFE Manager; `khaled-bedair-*`) and Magdy El Senosey (National Sales Manager; `magdy-el-senosey-*`, spelled "Senosey" as his record has it). The footer is department · line from the register, so Magdy's reads SALES · ANTI INFECTIVE. Keep Omar's markup byte for byte (ordinary spaces in the title, non-breaking spaces in the footer), and confirm the width stays 333 px; Magdy's long title still fits.
