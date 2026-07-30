"""
S1 Business Review — generates the ACCESS MAPPING TEMPLATE for the owner to populate.

Why a template instead of deriving scope automatically: the S1 datasets are keyed by DM
display name and area name; the portal identifies a user by HR_ID. Name-matching across
those two worlds is exactly what produced three separate defects during this build (one
DM under three different labels; "Mahmoud El Husseinin" vs "Mahmoud. ElHassanein";
"Sara Samir" vs "Sara Jacoub"). Because this mapping is a PERMISSION BOUNDARY — a wrong
row means one manager sees another manager's numbers — it is owner-confirmed, not guessed.

Everything derivable is pre-filled, and every pre-filled cell says where it came from so
the owner knows what to trust vs verify:
  - Manager HR IDs from the CRM double-visit exports' "Double HR ID" column.
  - Rep name + hiring date per area from each line's "Sales Vs Target" workbook
    ("Med. Rep. Name" / "Area" / "HiringDate").
  - Rep HR ID from the CRM visits exports, ONLY where the normalised name maps to exactly
    one Agent HR ID within that line. Verified zero collisions across all 87 agents, so no
    cell is filled from an ambiguous match. Unmatched cells are left blank rather than
    guessed — the whole point of the file is that guesses are not acceptable here.

RM SCOPE — changed 2026-07-30 after PR #1479 landed on main. That fix established that
"which areas may this manager see?" is answered by the organogram seat map and NEVER by a
region label: six live areas have an operational region different from their geographic
one, and region-based scoping had hidden 1,194 of one DM's own rows. So this template now
asks for an RM's **DM seats**, not a region list. Region is kept as read-only context only.
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
BAND    = "FFFFF7ED"   # warm tint = owner must fill / confirm
LOCKED  = "FFF8FAFC"   # cool tint = pre-filled reference, do not edit
PREFILL = "FFECFDF5"   # green tint = pre-filled FOR you, please just verify
WHITE   = "FFFFFFFF"

thin = Side(style="thin", color=SOFT)
BOX  = Border(left=thin, right=thin, top=thin, bottom=thin)

LINES = [("pedia", "Pedia"), ("cns", "CNS"), ("anti", "Anti-Infective")]
LINE_TAG = {"pedia": "Pedia", "cns": "CNS", "anti": "Anti Infective"}   # CRM "Line" values
REP_SRC = {
    "pedia": ("S1-2026 Ped-Line Sales Vs Taget .xlsx", "S1-2026 Ped-Line"),
    "cns":   ("S1-2026 CNS-Line Sales Vs Taget .xlsx", "S1-2026 CNS Line"),
    "anti":  ("S1-2026 Anti-Line Sales Vs Taget .xlsx", "S1 2026 Anti-Line"),
}
VISITS = {
    "pedia": (os.path.join(DL,  "phoenix-crm-visits-2026-07-29.xlsx"), 2),
    "cns":   (os.path.join(DL2, "FFcrm-visits-2026-07-29.xlsx"), 0),
    "anti":  (os.path.join(DL2, "Fcrm-visits-2026-07-29.xlsx"), 0),
}

ds = {}
for k, _l in LINES:
    with open(os.path.join(DATA_DIR, f"{k}-s1.json"), encoding="utf-8") as f:
        ds[k] = json.load(f)

def nm(x):
    x = str(x).lower(); x = re.sub(r"\(.*?\)", "", x); x = re.sub(r"[._\s]+", " ", x).strip(); return x
def ngeo(x): return re.sub(r"\s+", " ", str(x).strip().lower())

# ---------- rep name + hiring date per area, from each line's Sales-vs-Target ----------
rep_by_area = {}   # (line, ngeo(area)) -> (name, hiringDate)
for k, (f, sh) in REP_SRC.items():
    d = pd.read_excel(os.path.join(DL, f), sheet_name=sh, header=0)
    for _, r in d[["Med. Rep. Name", "Area", "HiringDate"]].dropna(how="all").iterrows():
        name = str(r["Med. Rep. Name"]).strip()
        if name in ("", "nan"): continue
        hd = r["HiringDate"]
        hd = "" if pd.isna(hd) else (hd.strftime("%d-%b-%Y") if hasattr(hd, "strftime") else str(hd))
        rep_by_area[(k, ngeo(r["Area"]))] = (name, hd)

# ---------- rep HR IDs, only where unambiguous within the line ----------
agent_id = {}      # (line, nm(name)) -> HR ID   (built only from 1:1 matches)
for k, (path, hdr) in VISITS.items():
    v = pd.read_excel(path, sheet_name="Visits", header=hdr).dropna(how="all")
    v = v[v["Line"].astype(str) == LINE_TAG[k]]
    seen = {}
    for n, i in v[["Agent Name", "Agent HR ID"]].drop_duplicates().itertuples(index=False):
        seen.setdefault(nm(n), set()).add(str(i).strip())
    for key, ids in seen.items():
        if len(ids) == 1:                       # never fill from an ambiguous name
            agent_id[(k, key)] = next(iter(ids))

# ---------- manager HR IDs from the double-visit exports ----------
DV = [("pedia", os.path.join(DL,  "phoenix-crm-double-visits-2026-07-29.xlsx"), 2),
      ("cns",   os.path.join(DL2, "Dcrm-double-visits-2026-07-29.xlsx"), 0),
      ("anti",  os.path.join(DL2, "DDcrm-double-visits-2026-07-29.xlsx"), 0)]
people = {}
for key, path, hdr in DV:
    dv = pd.read_excel(path, sheet_name="Double Visits", header=hdr).dropna(how="all")
    sub = dv[["Double Name", "Double HR ID"]].astype(str)
    sub = sub[~sub["Double HR ID"].isin(["—", "nan", "None", ""])].drop_duplicates()
    for name, hid in sub.itertuples(index=False):
        rec = people.setdefault((hid.strip(), nm(name)),
                                {"hrid": hid.strip(), "crmName": name.strip(), "lines": set()})
        rec["lines"].add(key)

seat_by_line = {k: {nm(d["dm"]): d for d in ds[k]["dms"]} for k, _l in LINES}
ALIAS = {"mahmoud elhassanein": "mahmoud el husseinin", "saad mohamed": "saad salama",
         "kareem gamal": "momen.abdelhady", "heba abdelbaset": "giza",
         "sara jacoub": "alex-bhr", "sara samir": "alex-bhr",
         "ahmed abdelazeem": "ahmed nashaat"}
def find_seat(line_key, name):
    n = nm(name)
    for cand in (n, ALIAS.get(n, "")):
        if not cand: continue
        for seat_n, seat in seat_by_line[line_key].items():
            if seat_n == cand or cand in seat_n:
                return seat
    return None

LINE_LABEL = dict(LINES)
ROLES  = ["National Sales Manager","Group Product Manager","Product Manager","Regional Manager",
          "District Manager","SFE Manager","Marketing Manager","Super Admin","CEO","(no access)"]
SCOPES = ["All company","Whole line","Listed DM seats","Own DM team","(no access)"]

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
        s = ws.cell(row=2, column=1, value=sub)
        s.font = Font(italic=True, color="FF475569", size=9)
        s.alignment = Alignment(horizontal="center", vertical="center")
        ws.row_dimensions[2].height = 18

def head_row(ws, r, labels):
    for i, lab in enumerate(labels, start=1):
        c = ws.cell(row=r, column=i, value=lab)
        c.fill = PatternFill("solid", fgColor=SLATE)
        c.font = Font(bold=True, color=WHITE, size=9)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = BOX
    ws.row_dimensions[r].height = 32
    ws.freeze_panes = ws.cell(row=r + 1, column=1)

def widths(ws, ws_widths):
    for i, w in enumerate(ws_widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

def write_row(ws, r, values, fills, wrap_cols=()):
    for i, v in enumerate(values, start=1):
        c = ws.cell(row=r, column=i, value=v)
        c.font = Font(size=10, color=SLATE, bold=(i == 1))
        c.border = BOX
        c.alignment = Alignment(vertical="center", wrap_text=(i in wrap_cols))
        c.fill = PatternFill("solid", fgColor=fills(i))

# ============================ 1. READ ME ============================
ws = wb.active; ws.title = "READ ME"
title_bar(ws, "PHOENIX · S1 2026 BUSINESS REVIEW — ACCESS MAPPING", 2)
rows = [
    ("Colour key", ""),
    ("  Green cells", "Pre-filled FOR you from real data. Please just glance and correct if wrong."),
    ("  Orange cells", "You fill these. Blank means I could not derive it safely."),
    ("  Grey cells", "Reference only — please don't edit."),
    ("", ""),
    ("MANAGERS sheet", "One row per person who should reach the module. Set Role + Access scope."),
    ("REPS sheet", "One row per area (129). Rep name and hiring date are already filled in."),
    ("", ""),
    ("Access scope meanings", ""),
    ("  All company", "All 3 lines consolidated + every line. SFE Manager, Super Admin, CEO, Marketing Manager."),
    ("  Whole line", "One entire line. National Sales Manager, Group Product Manager, Product Manager."),
    ("  Listed DM seats", "Only the DM seats named in the 'DM seats' column. Use this for a Regional Manager."),
    ("  Own DM team", "Only their own areas/reps. District Manager."),
    ("  (no access)", "Row ignored — cannot open the module. Medical Reps get no access."),
    ("", ""),
    ("Why DM seats, not regions", "A region label is NOT a safe way to scope a manager. Six live areas sit in an"),
    ("", "operational region different from their geographic one, and scoping by region label"),
    ("", "previously hid 1,194 of one DM's own sales rows (fixed in PR #1479). So a Regional"),
    ("", "Manager's scope is the list of DM seats under them. Region is shown for context only."),
    ("", ""),
    ("Why you fill this, not me", "This is a permission boundary — a wrong row lets one manager see another's numbers."),
    ("", "The sales workbooks and the CRM name the same people differently (one DM appeared"),
    ("", "under 3 labels), so I will not infer it."),
    ("", ""),
    ("Rules", "Use the dropdowns. Leave a cell blank rather than guessing. Multiple DM seats go in"),
    ("", "one cell separated by semicolons. Don't rename sheets or column headers."),
    ("", ""),
    ("When done", "Send it back and I'll wire the portal to it and role-test every scope."),
]
r = 3
for a, b in rows:
    ca = ws.cell(row=r, column=1, value=a); ca.font = Font(bold=True, color=SLATE, size=10)
    ca.alignment = Alignment(vertical="top", wrap_text=True)
    cb = ws.cell(row=r, column=2, value=b); cb.font = Font(color="FF334155", size=10)
    cb.alignment = Alignment(vertical="top", wrap_text=True)
    r += 1
widths(ws, [26, 104])

# ============================ 2. MANAGERS ============================
ws = wb.create_sheet("MANAGERS")
cols = ["HR ID", "Name (from CRM)", "Line seen in CRM", "ROLE  ← you", "ACCESS SCOPE  ← you",
        "DM seats — only if scope = Listed DM seats  ← you",
        "DM seat — only if scope = Own DM team", "Region (context only)", "Notes / who is this?"]
title_bar(ws, "MANAGERS — who can open the S1 Business Review, and what they see", len(cols),
          "Green = pre-filled from CRM/sales data · Orange = you fill · a Regional Manager is scoped by DM SEATS, not by region")
head_row(ws, 3, cols)
widths(ws, [11, 28, 16, 22, 22, 34, 24, 17, 42])

mrows = []
for rec in people.values():
    ln = sorted(rec["lines"])
    line_lbl = "ALL 3 LINES" if len(ln) == 3 else " + ".join(LINE_LABEL[x] for x in ln)
    seat = find_seat(ln[0], rec["crmName"]) if len(ln) == 1 else None
    role = scope = seat_name = region = ""
    note = ""
    if seat:
        seat_name = seat["dm"]; region = seat["region"]
        if seat["vacant"]:
            note = f"matches VACANT seat '{seat['dm']}' — confirm whether this person now holds it."
        else:
            role, scope = "District Manager", "Own DM team"
    if len(ln) == 3:
        note = "appears in all 3 lines — likely above line level (NSM / CEO?). Please confirm."
    elif not seat:
        note = "no matching DM seat in the S1 sales data — please identify."
    if "P.M" in rec["crmName"]:
        note = "CRM label says P.M (Product Manager). Confirm role + which line."
    mrows.append([rec["hrid"], rec["crmName"], line_lbl, role, scope, "", seat_name, region, note])

# Owner-confirmed 2026-07-30: Hany Saad is the Pedia RM over Alex-BHR + Delta (1) + Delta (2).
# Translated to DM seats per PR #1479 — the seats are the authoritative scope, not the labels.
HANY_REGIONS = {"alex-bhr", "delta (1)", "delta (2)"}
hany_seats = [d["dm"] for d in ds["pedia"]["dms"]
              if ngeo(d["region"]) in HANY_REGIONS and d["allProducts"]["target"] > 0]
for rw in mrows:
    if nm(rw[1]) == "hany saad":
        rw[3] = "Regional Manager"; rw[4] = "Listed DM seats"
        rw[5] = "; ".join(sorted(hany_seats)); rw[6] = ""
        rw[7] = "Alex-BHR / Delta (1) / Delta (2)"
        rw[8] = ("Owner-confirmed 2026-07-30 (Pedia RM). Regions translated to DM seats per PR #1479 — "
                 "please confirm this seat list is right.")
mrows.sort(key=lambda x: (x[2], x[1]))

r = 4
for rw in mrows:
    prefilled = bool(rw[3] or rw[5])
    write_row(ws, r, rw,
              lambda i, p=prefilled: (PREFILL if (p and i in (4, 5, 6)) else BAND) if i in (4, 5, 6) else LOCKED,
              wrap_cols=(6, 9))
    r += 1
last = r - 1
dvr = DataValidation(type="list", formula1='"' + ",".join(ROLES) + '"', allow_blank=True)
dvs = DataValidation(type="list", formula1='"' + ",".join(SCOPES) + '"', allow_blank=True)
ws.add_data_validation(dvr); dvr.add(f"D4:D{last}")
ws.add_data_validation(dvs); dvs.add(f"E4:E{last}")
ws.auto_filter.ref = f"A3:I{last}"

# ============================ 3. REPS ============================
ws = wb.create_sheet("REPS")
cols = ["Line", "Area", "DM seat", "Status", "REP NAME", "REP HR ID", "Hiring date",
        "Region (context only)", "Where this came from"]
title_bar(ws, "REPS — the medical rep behind each area", len(cols),
          "Green = pre-filled from the line's Sales-vs-Target + CRM visits · Orange = blank, please fill · nothing here was guessed")
head_row(ws, 3, cols)
widths(ws, [15, 32, 24, 10, 26, 12, 14, 17, 44])
r = 4
n_name = n_id = n_area = 0
for k, label in LINES:
    for a in sorted(ds[k]["areas"], key=lambda x: (x["region"], x["area"])):
        n_area += 1
        vacant = a["vacant"]
        name, hd = rep_by_area.get((k, ngeo(a["area"])), ("", ""))
        hrid = agent_id.get((k, nm(name)), "") if name else ""
        if name: n_name += 1
        if hrid: n_id += 1
        prov = []
        if name: prov.append("name+hire date: Sales-vs-Target")
        if hrid: prov.append("HR ID: CRM visits (unique match)")
        if not name: prov.append("no rep row in the Sales-vs-Target sheet — please fill")
        elif not hrid: prov.append("no unique CRM agent for this name — please fill HR ID")
        if vacant: prov.insert(0, "VACANT area")
        write_row(ws, r,
                  [label, a["area"], a["dm"], "VACANT" if vacant else "active",
                   name, hrid, hd, a["region"], " · ".join(prov)],
                  lambda i, hn=bool(name), hi=bool(hrid): (
                      (PREFILL if hn else BAND) if i == 5 else
                      (PREFILL if hi else BAND) if i == 6 else
                      (PREFILL if hd else BAND) if i == 7 else LOCKED),
                  wrap_cols=(9,))
        if vacant:
            ws.cell(row=r, column=4).font = Font(size=10, bold=True, color="FF94A3B8")
        r += 1
ws.auto_filter.ref = f"A3:I{r-1}"

# ============================ 4. DM SEATS ============================
ws = wb.create_sheet("DM SEATS")
title_bar(ws, "DM SEATS per line — exact names to use in the 'DM seats' column", 6)
head_row(ws, 3, ["Line", "DM seat", "Region (context)", "Status", "Areas", "Achievement %"])
widths(ws, [16, 26, 18, 10, 8, 14])
r = 4
for k, label in LINES:
    for d in ds[k]["dms"]:
        if d["allProducts"]["target"] <= 0: continue
        write_row(ws, r, [label, d["dm"], d["region"],
                          "VACANT" if d["vacant"] else "active", len(d["areas"]),
                          d["allProducts"]["ach"]],
                  lambda i: LOCKED)
        r += 1

# ============================ 5. REFERENCE ============================
ws = wb.create_sheet("REFERENCE")
title_bar(ws, "REFERENCE — exact values (do not edit)", 3)
head_row(ws, 3, ["Lines", "Roles", "Access scopes"])
widths(ws, [22, 32, 22])
mx = max(len(LINES), len(ROLES), len(SCOPES))
for i in range(mx):
    for col, src in enumerate([[l for _k, l in LINES], ROLES, SCOPES], start=1):
        c = ws.cell(row=4 + i, column=col, value=(src[i] if i < len(src) else None))
        c.font = Font(size=10, color=SLATE); c.border = BOX
        c.fill = PatternFill("solid", fgColor=LOCKED)

wb.save(OUT)
print("========= ACCESS MAPPING TEMPLATE =========")
print(f"MANAGERS : {len(mrows)} people, real HR IDs, {sum(1 for x in mrows if x[3])} roles pre-filled")
print(f"REPS     : {n_area} areas | rep NAME pre-filled {n_name}/{n_area} | rep HR ID {n_id}/{n_area}")
print(f"           blanks are genuine gaps, never guesses")
print(f"RM       : Hany Saad -> DM seats {sorted(hany_seats)} (was a region list; changed per PR #1479)")
print("WROTE", OUT)
