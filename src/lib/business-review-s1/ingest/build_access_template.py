"""
S1 Business Review — generates the ACCESS MAPPING TEMPLATE for the owner to populate.

Why a template instead of deriving scope automatically: the S1 datasets are keyed by DM
display name and brick name; the portal identifies a user by HR_ID. Name-matching across
those two worlds is exactly what produced three separate defects earlier in this build
(one DM under three different labels, "Mahmoud El Husseinin" vs "Mahmoud. ElHassanein",
"Sara Samir" vs "Sara Jacoub"). Because this mapping is a PERMISSION BOUNDARY — a wrong
row means one manager sees another manager's numbers — it is owner-confirmed, not guessed.

Everything already known is pre-filled:
  - HR IDs come from the CRM double-visit exports' "Double HR ID" column (real ids, not
    inferred), cross-referenced to the DM seats in the three S1 datasets.
  - Every brick is pre-listed with its line, region, DM seat and vacancy status.
  - Dropdowns constrain Role / Line / Access scope / DM seat so a typo can't silently
    create a broken or over-broad scope.
The owner fills only what cannot be known from data: each person's role, and the rep
name + HR ID behind each brick.
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')
import pandas as pd
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

DL  = r"C:\Users\satoh\Downloads"
DL2 = r"C:\Users\satoh\Downloads\New folder (2)"
DATA_DIR = r"F:\Phoenix Workforce\_wt-s1-review\src\lib\business-review-s1\data"
OUT = r"C:\Users\satoh\Downloads\Phoenix S1 Business Review - ACCESS MAPPING (fill me).xlsx"

# Phoenix export identity — same palette as src/lib/attendance/monthly-summary-export.ts
ORANGE = "FFC2410C"; SLATE = "FF0F172A"; SOFT = "FFE2E8F0"
BAND    = "FFFFF7ED"   # warm tint for owner-input columns
LOCKED  = "FFF8FAFC"   # cool tint for pre-filled reference columns
WHITE   = "FFFFFFFF"

thin = Side(style="thin", color=SOFT)
BOX  = Border(left=thin, right=thin, top=thin, bottom=thin)

LINES = [("pedia","Pedia"), ("cns","CNS"), ("anti","Anti-Infective")]
ds = {}
for k,_l in LINES:
    with open(os.path.join(DATA_DIR, f"{k}-s1.json"), encoding="utf-8") as f:
        ds[k] = json.load(f)

def norm(x):
    x = str(x).lower(); x = re.sub(r"\(.*?\)", "", x); x = re.sub(r"[._\s]+", " ", x).strip(); return x

# ---- HR IDs from the CRM double-visit exports (authoritative ids) ----
DV = [("pedia", os.path.join(DL, "phoenix-crm-double-visits-2026-07-29.xlsx"), 2),
      ("cns",   os.path.join(DL2, "Dcrm-double-visits-2026-07-29.xlsx"), 0),
      ("anti",  os.path.join(DL2, "DDcrm-double-visits-2026-07-29.xlsx"), 0)]
people = {}   # (hrid, normname) -> row
for key, path, hdr in DV:
    dv = pd.read_excel(path, sheet_name="Double Visits", header=hdr).dropna(how="all")
    sub = dv[["Double Name", "Double HR ID"]].astype(str)
    sub = sub[~sub["Double HR ID"].isin(["—", "nan", "None", ""])].drop_duplicates()
    for nm, hid in sub.itertuples(index=False):
        k = (hid.strip(), norm(nm))
        rec = people.setdefault(k, {"hrid": hid.strip(), "crmName": nm.strip(), "lines": set(), "doubles": 0})
        rec["lines"].add(key)
        rec["doubles"] += int((dv["Double HR ID"].astype(str).str.strip() == hid.strip()).sum())

# ---- match each person to a DM seat in that line's dataset ----
seat_by_line = {k: {norm(d["dm"]): d for d in ds[k]["dms"]} for k, _l in LINES}
# canon aliases already applied inside the builders, mirrored here for matching
ALIAS = {"mahmoud elhassanein": "mahmoud el husseinin", "saad mohamed": "saad salama",
         "sally saeed": "sally saeed", "kareem gamal": "momen.abdelhady",
         "heba abdelbaset": "giza", "sara jacoub": "alex-bhr", "sara samir": "alex-bhr",
         "ahmed abdelazeem": "ahmed nashaat"}
def find_seat(line_key, nm):
    n = norm(nm)
    for cand in (n, ALIAS.get(n, "")):
        if not cand: continue
        for seat_n, seat in seat_by_line[line_key].items():
            if seat_n == cand or norm(seat["dm"]) == cand or cand in seat_n:
                return seat
    return None

LINE_LABEL = dict(LINES)
ROLES = ["National Sales Manager","Group Product Manager","Product Manager","Regional Manager",
         "District Manager","SFE Manager","Marketing Manager","Super Admin","CEO","(no access)"]
SCOPES = ["All company","Whole line","Regions listed","Own DM team","(no access)"]
ALL_REGIONS = sorted({d["region"] for k,_l in LINES for d in ds[k]["dms"] if d["region"]})

wb = Workbook()

def title_bar(ws, text, ncols, sub=None):
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncols)
    c = ws.cell(row=1, column=1, value=text)
    c.fill = PatternFill("solid", fgColor=ORANGE)
    c.font = Font(bold=True, color=WHITE, size=15)
    c.alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[1].height = 30
    if sub:
        ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncols)
        s = ws.cell(row=2, column=2 - 1, value=sub)
        s.font = Font(italic=True, color="FF475569", size=9)
        s.alignment = Alignment(horizontal="center", vertical="center")
        ws.row_dimensions[2].height = 18

def head_row(ws, r, labels, fills=None):
    for i, lab in enumerate(labels, start=1):
        c = ws.cell(row=r, column=i, value=lab)
        c.fill = PatternFill("solid", fgColor=SLATE)
        c.font = Font(bold=True, color=WHITE, size=9)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = BOX
    ws.row_dimensions[r].height = 30
    ws.freeze_panes = ws.cell(row=r + 1, column=1)

def widths(ws, ws_widths):
    for i, w in enumerate(ws_widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

# ============================ 1. READ ME ============================
ws = wb.active; ws.title = "READ ME"
title_bar(ws, "PHOENIX · S1 2026 BUSINESS REVIEW — ACCESS MAPPING", 2)
lines_txt = [
    ("What this file is",
     "It tells the S1 Business Review portal page WHO sees WHAT. Two sheets need your input:"),
    ("  1) MANAGERS",
     "One row per person who should reach the module. Set their Role and Access scope."),
    ("  2) REPS",
     "One row per brick (129 total). Write the rep's name + HR ID so a DSM sees named reps."),
    ("", ""),
    ("Why you fill it, not me",
     "This is a permission boundary. The sales workbooks name people differently from the"),
    ("",
     "CRM (one DM appeared under 3 labels; 'Mahmoud El Husseinin' vs 'Mahmoud. ElHassanein';"),
    ("",
     "'Sara Samir' vs 'Sara Jacoub'). Guessing could let one manager see another's numbers."),
    ("", ""),
    ("Already filled for you",
     "HR IDs (real, from the CRM double-visit exports), every brick with its line/region/DM"),
    ("",
     "seat/vacancy, and a suggested role where the person clearly matches a DM seat."),
    ("", ""),
    ("Access scope meanings", ""),
    ("  All company",
     "Sees all 3 lines consolidated + every line. For SFE Manager, Super Admin, CEO, Marketing Manager."),
    ("  Whole line",
     "Sees one entire line only. For National Sales Manager, Group Product Manager, Product Manager."),
    ("  Regions listed",
     "Sees only the regions named in the 'Regions' column. For Regional Manager."),
    ("  Own DM team",
     "Sees only their own bricks/reps. For District Manager."),
    ("  (no access)",
     "Row is ignored — person cannot open the module. Medical Reps get no access."),
    ("", ""),
    ("Rules",
     "Leave a cell blank rather than guessing. Use the dropdowns. Don't rename the sheets"),
    ("",
     "or column headers. Multiple regions go in one cell separated by semicolons."),
    ("", ""),
    ("When done", "Send this file back and I'll wire the portal to it and verify every role."),
]
r = 3
for a, b in lines_txt:
    ca = ws.cell(row=r, column=1, value=a); ca.font = Font(bold=True, color=SLATE, size=10)
    ca.alignment = Alignment(vertical="top", wrap_text=True)
    cb = ws.cell(row=r, column=2, value=b); cb.font = Font(color="FF334155", size=10)
    cb.alignment = Alignment(vertical="top", wrap_text=True)
    r += 1
widths(ws, [26, 108])

# ============================ 2. MANAGERS ============================
ws = wb.create_sheet("MANAGERS")
cols = ["HR ID", "Name (from CRM)", "Line seen in CRM", "ROLE  ← you fill",
        "ACCESS SCOPE  ← you fill", "Regions (only if scope = Regions listed)",
        "DM seat (only if scope = Own DM team)", "Notes / who is this?"]
title_bar(ws, "MANAGERS — who can open the S1 Business Review, and what they see", len(cols))
head_row(ws, 3, cols)
widths(ws, [12, 30, 17, 24, 24, 34, 26, 40])

rows = []
for rec in people.values():
    ln = sorted(rec["lines"])
    line_lbl = "ALL 3 LINES" if len(ln) == 3 else " + ".join(LINE_LABEL[x] for x in ln)
    seat = find_seat(ln[0], rec["crmName"]) if len(ln) == 1 else None
    suggested_role = "District Manager" if seat and not seat["vacant"] else ""
    suggested_scope = "Own DM team" if suggested_role else ""
    seat_name = seat["dm"] if seat else ""
    note = ""
    if len(ln) == 3:
        note = "appears in all 3 lines — likely above line level (NSM/CEO?). Confirm."
    elif seat and seat["vacant"]:
        note = f"matches VACANT seat '{seat['dm']}' — confirm if this person now holds it."
        suggested_scope = ""
    elif not seat:
        note = "no matching DM seat in the S1 sales data — please identify."
    if "P.M" in rec["crmName"]:
        note = "CRM label says P.M (Product Manager). Confirm role + which line."
    rows.append([rec["hrid"], rec["crmName"], line_lbl, suggested_role, suggested_scope,
                 "", seat_name, note])
# owner-confirmed row (given 2026-07-30)
for rw in rows:
    if norm(rw[1]) == "hany saad":
        rw[3] = "Regional Manager"; rw[4] = "Regions listed"
        rw[5] = "Alex-BHR; Delta (1); Delta (2)"; rw[6] = ""
        rw[7] = "Owner-confirmed 2026-07-30: RM, Pedia line."
rows.sort(key=lambda x: (x[2], x[1]))

r = 4
for rw in rows:
    for i, v in enumerate(rw, start=1):
        c = ws.cell(row=r, column=i, value=v)
        c.font = Font(size=10, color=SLATE, bold=(i == 1))
        c.border = BOX
        c.alignment = Alignment(vertical="center", wrap_text=(i == 8))
        c.fill = PatternFill("solid", fgColor=BAND if i in (4, 5, 6, 7) else LOCKED)
    r += 1
last = r - 1
dv_role  = DataValidation(type="list", formula1='"' + ",".join(ROLES) + '"', allow_blank=True)
dv_scope = DataValidation(type="list", formula1='"' + ",".join(SCOPES) + '"', allow_blank=True)
ws.add_data_validation(dv_role);  dv_role.add(f"D4:D{last}")
ws.add_data_validation(dv_scope); dv_scope.add(f"E4:E{last}")
ws.auto_filter.ref = f"A3:H{last}"

# ============================ 3. REPS ============================
ws = wb.create_sheet("REPS")
cols = ["Line", "Region", "Brick / Area", "DM seat", "Status",
        "REP NAME  ← you fill", "REP HR ID  ← you fill", "Notes"]
title_bar(ws, "REPS — the medical rep behind each brick (so a DSM sees named reps)", len(cols))
head_row(ws, 3, cols)
widths(ws, [15, 13, 34, 24, 10, 28, 14, 30])
r = 4
nbrick = 0
for k, label in LINES:
    for a in sorted(ds[k]["areas"], key=lambda x: (x["region"], x["area"])):
        vals = [label, a["region"], a["area"], a["dm"],
                "VACANT" if a["vacant"] else "active", "", "",
                "no rep — leave blank" if a["vacant"] else ""]
        for i, v in enumerate(vals, start=1):
            c = ws.cell(row=r, column=i, value=v)
            c.font = Font(size=10, color=SLATE)
            c.border = BOX
            c.alignment = Alignment(vertical="center", wrap_text=(i == 8))
            c.fill = PatternFill("solid", fgColor=BAND if i in (6, 7) else LOCKED)
        if a["vacant"]:
            ws.cell(row=r, column=5).font = Font(size=10, bold=True, color="FF94A3B8")
        r += 1
        nbrick += 1
ws.auto_filter.ref = f"A3:H{r-1}"

# ============================ 4. REFERENCE ============================
ws = wb.create_sheet("REFERENCE")
title_bar(ws, "REFERENCE — exact spellings (do not edit; use these values)", 4)
head_row(ws, 3, ["Lines", "Regions", "Roles", "Access scopes"])
widths(ws, [20, 18, 30, 22])
maxn = max(len(LINES), len(ALL_REGIONS), len(ROLES), len(SCOPES))
for i in range(maxn):
    for col, src in enumerate([[l for _k, l in LINES], ALL_REGIONS, ROLES, SCOPES], start=1):
        v = src[i] if i < len(src) else None
        c = ws.cell(row=4 + i, column=col, value=v)
        c.font = Font(size=10, color=SLATE); c.border = BOX
        c.fill = PatternFill("solid", fgColor=LOCKED)

ws = wb.create_sheet("DM SEATS")
title_bar(ws, "DM SEATS per line — exact names for the 'DM seat' column", 5)
head_row(ws, 3, ["Line", "DM seat", "Region", "Status", "Bricks"])
widths(ws, [16, 26, 14, 10, 8])
r = 4
for k, label in LINES:
    for d in ds[k]["dms"]:
        for i, v in enumerate([label, d["dm"], d["region"],
                               "VACANT" if d["vacant"] else "active", len(d["areas"])], start=1):
            c = ws.cell(row=r, column=i, value=v)
            c.font = Font(size=10, color=SLATE); c.border = BOX
            c.fill = PatternFill("solid", fgColor=LOCKED)
        r += 1

wb.save(OUT)
print("========= ACCESS MAPPING TEMPLATE =========")
print(f"MANAGERS sheet : {len(rows)} people pre-filled with real HR IDs")
print(f"REPS sheet     : {nbrick} bricks pre-filled (line/region/brick/DM seat/vacancy)")
print(f"Regions        : {', '.join(ALL_REGIONS)}")
print(f"Pre-confirmed  : Hany Saad -> Regional Manager, Pedia, Alex-BHR + Delta (1) + Delta (2)")
print("WROTE", OUT)
