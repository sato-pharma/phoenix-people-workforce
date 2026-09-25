---
name: excel-rejects-a-workbook-libreoffice-calls-perfect
description: "LibreOffice validation cannot certify an openpyxl workbook for Excel - two constructs it renders happily make Excel refuse the whole file, and the way to find them is zip-surgery bisection"
metadata:
  type: reference
---

A workbook openpyxl wrote can pass every LibreOffice check and still make Excel show **"We found
a problem with some content. Do you want us to try to recover as much as we can?"** — which
*strips* content on Yes. Both faults below did exactly that on the FTP 2026 Scorecard Explorer
(2026-08-27), with LibreOffice reporting **540 formulas / 0 errors** the whole time.

**1. A `beginsWith` conditional-formatting rule must NOT be a `cellIs` rule.** This is the one
that refused the file outright:

    CellIsRule(operator="beginsWith", formula=['"No"'], ...)   # -> Excel refuses the WORKBOOK

Excel writes a text test as its own rule type carrying a `text=` attribute
(`<cfRule type="beginsWith" operator="beginsWith" text="No">`); as `<cfRule type="cellIs"
operator="beginsWith">` the part is malformed. `containsText`, `notContains` and `endsWith` are
the same shape and will behave the same way. Use `FormulaRule(formula=['LEFT($Q7,2)="No"'])` —
an expression rule says the same thing and both readers accept it. `equal` with a quoted string
literal (`formula=['"Revoked"']`) is fine and was proven innocent by the bisect.

**2. A stored data-validation formula carries NO leading `=`.** `DataValidation(formula1=
"=InternNames")` is stored verbatim, Excel reads it as `==InternNames`, and the repair **deletes
the drop-down** — the exact feature the sheet exists for. Write `formula1="InternNames"`; Excel's
own dialog adds the `=` back for display, and reading `Validation.Formula1` over COM correctly
returns `=InternNames`. This matters directly for the owner's standing rule that business-fact
questions go out as an XLSX with locked dropdown lists — see [[owner-asks-business-facts-as-xlsx]].

**How to find the next one: bisect the zip, do not guess.** The COM error is generic
(`Unable to get the Open property of the Workbooks class` — same message for every cause), so
establish that Excel opens *some other* xlsx first, then rebuild the file with one class of
content removed at a time and re-open each: drawings+charts, conditional formatting, data
validation, defined names, all formulas. Whichever removal makes it open is the offender; repeat
within that class, by rule kind and by sheet. Two independent cuts agreeing (the rule kind, and
the sheet that carries it) is the confirmation. Cheap structural sweeps worth running first, all
of which came back clean here and none of which found it: relationship targets resolve, `dxfId`
in range, merges disjoint, colours 8-digit, `CT_Worksheet`/`CT_CatAx` child order, chart `<c:f>`
sheet names.

**Excel COM will not answer while a modal dialog is up** anywhere in Excel — including the repair
prompt itself. Ask for it to be dismissed with **No** (No declines the open, writes nothing, loses
nothing; Yes overwrites with the stripped copy). Also kill your own orphaned invisible instances
between attempts (`Get-Process EXCEL | where MainWindowTitle -eq ""`), and set
`Application.Calculation` only **after** a workbook is open or it throws `0x800A03EC`.

Two more openpyxl-writes-it-wrong details found in the same pass: a 6-digit data-bar colour is
padded to alpha `00`, i.e. fully transparent — pass `"FF" + rgb`; and a `Paragraph` in a chart's
`<c:txPr>` defaults to one empty text run, so pass `r=[]`. Neither triggers the repair, but both
mean the file does not look like what you built. See [[libreoffice-cannot-evaluate-xlookup-family]].
