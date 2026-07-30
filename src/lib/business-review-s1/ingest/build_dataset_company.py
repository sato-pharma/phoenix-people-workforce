"""
S1 Business Review (ALL COMPANY) — cross-line rollup. READ-ONLY module data.
Emits data/company-s1.json. Run AFTER the three per-line builders, since it consumes
their JSON output plus the raw visit files.

Why this is a real build step and not a sum done in TypeScript:
  - Sales / target / marketing / outstation / visits / double-visits ARE additive across
    lines, so those could have been summed in the UI.
  - DOCTORS ARE NOT. Each line's customersTotal counts distinct Contact CRM IDs *within
    that line*, and a doctor seen by a Pedia rep and a CNS rep is one doctor, not two.
    Summing the three per-line figures double-counts every shared doctor. The only way
    to get a truthful company number is to union the raw Contact CRM IDs across all
    three lines' visit exports, which is what this script does (and it reports the
    overlap it removed so the size of the correction is visible, not hidden).
  - Achievement is likewise never averaged: company ach = sum(sales) / sum(target).
"""
import sys, os, json
sys.stdout.reconfigure(encoding='utf-8')
import pandas as pd

DL  = r"C:\Users\satoh\Downloads"
DL2 = r"C:\Users\satoh\Downloads\New folder (2)"
OUT_DIR = r"F:\Phoenix Workforce\_wt-s1-review\src\lib\business-review-s1\data"
MO = ['Jan','Feb','Mar','Apr','May','Jun']

def r2(v):
    try: return round(float(v),2)
    except: return 0.0
def ach(s,t): return r2(100*s/t) if t else None
def slc(s,t): return dict(sales=r2(s), target=r2(t), ach=ach(s,t))

LINES = [('pedia','Pedia'), ('cns','CNS'), ('anti','Anti-Infective')]
ds = {}
for key,_label in LINES:
    with open(os.path.join(OUT_DIR, f"{key}-s1.json"), encoding='utf-8') as f:
        ds[key] = json.load(f)

# =================== TRUE cross-line unique doctors ===================
# Per-line visit exports. Pedia's is the 5-file union; CNS and Anti are single files.
# Each is filtered to its own Line tag exactly as its line builder does, so the three
# id sets are drawn from the same population and can be unioned safely.
def contact_ids_and_months(paths, line_tag, header):
    parts = []
    for p in paths:
        v = pd.read_excel(p, sheet_name="Visits", header=header).dropna(how="all")
        parts.append(v)
    V = pd.concat(parts, ignore_index=True).drop_duplicates(subset=['CRM Visit ID'])
    if 'Line' in V.columns:
        V = V[V['Line'].astype(str).eq(line_tag)]
    V['mon'] = pd.to_datetime(V['Visit Date'], errors='coerce').dt.strftime('%b')
    ids = set(V['Contact CRM ID'].dropna().astype(str))
    by_month = {m: set(V.loc[V['mon'].eq(m), 'Contact CRM ID'].dropna().astype(str)) for m in MO}
    return ids, by_month, int(len(V))

ped_paths = [os.path.join(DL, "phoenix-crm-visits-2026-07-29.xlsx")] + [
    os.path.join(DL, f"phoenix-crm-visits-2026-07-29({i}).xlsx") for i in range(1,5)]
ped_ids, ped_m, ped_n = contact_ids_and_months(ped_paths, 'Pedia', 2)
cns_ids, cns_m, cns_n = contact_ids_and_months([os.path.join(DL2,"FFcrm-visits-2026-07-29.xlsx")], 'CNS', 0)
ant_ids, ant_m, ant_n = contact_ids_and_months([os.path.join(DL2,"Fcrm-visits-2026-07-29.xlsx")], 'Anti Infective', 0)

union_ids = ped_ids | cns_ids | ant_ids
naive_sum = len(ped_ids) + len(cns_ids) + len(ant_ids)
overlap = naive_sum - len(union_ids)
customers_by_month = {m: len(ped_m[m] | cns_m[m] | ant_m[m]) for m in MO}

# =================== additive rollups ===================
line_rows, dm_rows = [], []
tot_s = tot_t = 0.0
tot_s_ev = tot_t_ev = 0.0
mkt = outn = vis = dbl = 0.0
reps = 0
by_month = {m: {'sales':0.0,'target':0.0} for m in MO}
areas_total = areas_vacant = 0

for key,label in LINES:
    d = ds[key]
    ap, ev = d['line']['allProducts'], d['line']['exVacant']['includeOnly']
    tot_s += ap['sales'];  tot_t += ap['target']
    tot_s_ev += ev['sales']; tot_t_ev += ev['target']
    mkt += d['line']['marketingCost']; outn += d['line']['outstationCost']
    vis += d['line']['visits'];  dbl  += d['line']['doubleVisits']
    reps += d['line'].get('reps', 0)
    for m in MO:
        mb = d['line']['byMonth'].get(m, {}).get('allProducts', {})
        by_month[m]['sales']  += mb.get('sales', 0) or 0
        by_month[m]['target'] += mb.get('target', 0) or 0
    vac = sum(1 for a in d['areas'] if a['vacant'])
    areas_total  += len(d['areas']); areas_vacant += vac
    graded = [a for a in d['areas'] if a['hasTarget'] and a['allProducts']['ach'] is not None]
    # Count only real DM seats: the per-line "Others" bucket carries no target and is a
    # catch-all for unmanaged areas, not a manager, so it must not inflate the seat
    # count. Same target>0 filter the cross-line DSM table below uses, so the two agree.
    seats = [x for x in d['dms'] if x['allProducts']['target'] > 0]
    line_rows.append(dict(
        id=key, label=label,
        allProducts=slc(ap['sales'], ap['target']),
        exVacant=slc(ev['sales'], ev['target']),
        marketingCost=d['line']['marketingCost'],
        outstationCost=d['line']['outstationCost'],
        visits=d['line']['visits'], visitsAvailable=d['visits']['available'],
        doubleVisits=d['line']['doubleVisits'],
        customersTotal=d['line']['customersTotal'],
        dms=sum(1 for x in seats if not x['vacant']),
        dmsVacant=sum(1 for x in seats if x['vacant']),
        areas=len(d['areas']), areasVacant=vac,
        earners=sum(1 for a in graded if not a['vacant'] and a['allProducts']['ach'] >= 90),
        repFails=sum(1 for a in graded if not a['vacant'] and a['allProducts']['ach'] < d['meta']['thresholds']['repFailBelow']),
    ))
    for x in d['dms']:
        if x['allProducts']['target'] <= 0: continue   # skip target-less buckets (Others)
        dm_rows.append(dict(dm=x['dm'], line=label, lineId=key, vacant=x['vacant'],
                            allProducts=x['allProducts'], marketingCost=x.get('marketingCost',0),
                            outstationCost=x.get('outstationCost',0),
                            visitsAvgPerMonth=x.get('visitsAvgPerMonth',0),
                            customersTotal=x.get('customersTotal',0),
                            doubleVisits=x.get('doubleVisits',0),
                            visitsAvailable=d['visits']['available']))

dm_rows.sort(key=lambda x: -(x['allProducts']['ach'] if x['allProducts']['ach'] is not None else -1))
line_rows.sort(key=lambda x: -(x['allProducts']['ach'] if x['allProducts']['ach'] is not None else -1))

company = dict(
    meta=dict(period="S1 2026 (Jan–Jun)", currency="EGP", months=MO,
              lines=[l for _k,l in LINES],
              doctorNote=(f"{len(union_ids):,} unique doctors company-wide. Summing the three lines' "
                          f"own counts gives {naive_sum:,}; {overlap:,} of those are the same doctor "
                          f"covered by more than one line, so they are counted once here."),
              generatedFrom=["pedia-s1.json","cns-s1.json","anti-s1.json",
                             "phoenix-crm-visits x5","FFcrm-visits","Fcrm-visits"]),
    total=dict(
        allProducts=slc(tot_s, tot_t),
        exVacant=slc(tot_s_ev, tot_t_ev),
        marketingCost=r2(mkt), outstationCost=r2(outn),
        visits=int(vis), doubleVisits=int(dbl), reps=int(reps),
        customersTotal=len(union_ids), customersByMonth=customers_by_month,
        customersNaiveSum=naive_sum, customersOverlap=overlap,
        areas=areas_total, areasVacant=areas_vacant,
        byMonth={m: slc(by_month[m]['sales'], by_month[m]['target']) for m in MO},
    ),
    lines=line_rows,
    dms=dm_rows,
)
with open(os.path.join(OUT_DIR,"company-s1.json"),"w",encoding="utf-8") as f:
    json.dump(company,f,ensure_ascii=False,indent=1)

# =================== RECONCILIATION ===================
T = company['total']
print("========= S1 ALL-COMPANY ROLLUP — RECONCILIATION =========")
print(f"COMPANY {T['allProducts']['sales']:,.0f}/{T['allProducts']['target']:,.0f} = {T['allProducts']['ach']}%")
print(f"        excl-vacant {T['exVacant']['sales']:,.0f}/{T['exVacant']['target']:,.0f} = {T['exVacant']['ach']}%")
print(f"        marketing {T['marketingCost']:,.0f} | outstation {T['outstationCost']:,.0f}")
print(f"        visits {T['visits']:,} ({ped_n:,} Pedia + {cns_n:,} CNS + {ant_n:,} Anti) | doubles {T['doubleVisits']:,} | reps {T['reps']}")
print(f"        doctors {T['customersTotal']:,} unique  (naive sum {naive_sum:,}, overlap removed {overlap:,})")
print(f"        areas {T['areas']} ({T['areasVacant']} vacant = {100*T['areasVacant']/T['areas']:.0f}%)")
print()
print("PER LINE:")
for L in line_rows:
    print(f"  {L['label']:<15} ach {str(L['allProducts']['ach']):>7}%  "
          f"sales {L['allProducts']['sales']:>12,.0f}  mkt {L['marketingCost']:>9,.0f}  "
          f"exp {L['outstationCost']:>7,.0f}  earners {L['earners']:>2}  "
          f"areas {L['areas']:>2} ({L['areasVacant']} vac)  DMs {L['dms']}+{L['dmsVacant']}vac")
print()
print("TOP 5 DSMs COMPANY-WIDE:")
for x in dm_rows[:5]:
    print(f"  {x['dm']:<22} {x['line']:<15} {x['allProducts']['ach']:>7}%")
print()
print("MONTHLY COMPANY ACHIEVEMENT:")
print("  " + "  ".join(f"{m}:{T['byMonth'][m]['ach']}%" for m in MO))
print("WROTE", os.path.join(OUT_DIR,"company-s1.json"))
