"""
S1 Business Review (CNS) — dataset ingestion / accuracy gate.  READ-ONLY module data.
Reads owner-provided S1 files from ~/Downloads and emits data/cns-s1.json.
Re-run when the owner uploads new files. No Phoenix DB, no migration.
Mirrors build_dataset.py (Pedia); see that file for the shared JSON schema.

Owner rulings baked in (2026-07-30, deep audit — see conversation, no exception order
found: DATA vs TOTAL reconcile to within 1 unit of 559,016 total):
  - Include products: ALL 15 CNS SKUs count (unlike Pedia, which excludes 4 of these
    exact products as cross-line noise — for CNS itself they are the core line).
    includeOnly == allProducts numerically for CNS; both fields kept for schema parity
    with the shared S1Dataset type (dashboard already reads allProducts exclusively).
  - DM roster: 6 real DMs, canonicalized from a 3-label mid-semester rename for one
    person — 'Dakahlia DM' (Jan placeholder) -> 'Sally.Saeed' (Feb-Mar) -> 'Sally Saeed'
    (Apr-Jun) all resolve to ONE person at >=97% purity per area per month once merged.
  - Vacant flag is per-BRICK (not a vacant DM-seat like Pedia's Cairo/Haitham): 4 areas
    flagged vacant in the source file's own status column, all under otherwise-active
    DMs. "Others" bucket (Bani suef, Fayoum, Ismailia-Suez, Main Store, no named DM) is
    itself marked ACTIVE in source data — trusted as-is, not treated as vacant.
  - Marketing name mapping (Req jan june s1.xlsx specialist codes -> sales DM names):
    Amgad.Ibrahim->Amgad Ibrahim, Mahmoud. ElHassanein->Mahmoud El Husseinin,
    Mina.Farouk->Mina Farouk, Saad.Mohamed->Saad Salama, Sameh.Shaaban->Sameh Shaaban.
    Confirmed via outstation-expense Employee column literally spelling out "Saad
    Mohamed Saad Salama" (his full name) alongside "Saad.Mohamed" for the identical
    48-row Alex-BHR region, and "Mahmoud. ElHassanein" appearing verbatim there too.
    Sally Saeed has no marketing-legend entry at all -> her marketing cost is 0
    (undercounting is safer than misattributing).
  - Thresholds: rep-area fail < 20%, DSM fail < 50% (same as Pedia).
  - Visits (2026-07-30 update): FFcrm-visits-2026-07-29.xlsx (in "New folder (2)") is
    a complete, single-file, pre-deduplicated CNS visits export (25,058 rows, Jan 6 -
    Jun 30, 0 internal dup CRM Visit IDs) — verified by unioning it against 3 other
    same-folder files that looked like separate date-range chunks; the union deduped
    down to exactly FFcrm-visits' own row count, proving those 3 are redundant subsets
    already contained within it. Dcrm-double-visits-2026-07-29.xlsx (same folder) has
    Double Name values matching all 6 canonical CNS DMs, used for rep->DM attribution
    exactly like Pedia's double-visits file.
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')
import pandas as pd

DL = r"C:\Users\satoh\Downloads"
DL2 = r"C:\Users\satoh\Downloads\New folder (2)"
OUT_DIR = r"F:\Phoenix Workforce\_wt-s1-review\src\lib\business-review-s1\data"
os.makedirs(OUT_DIR, exist_ok=True)
MO = ['Jan','Feb','Mar','Apr','May','Jun']
INCLUDE = ['Conviban 100 mg','Conviban 25 mg','Conviban 25mg/ml Syp','Conviban 50 mg',
           'Dolabactin','Dopaminect 1mg','Dopaminict 1mg UPA','Rispadex 1mg Syp',
           'Rispadex 3 mg','Rispadex 3 mg UPA','Tebofortin 120 mg Intens',
           'Tebofortin 240 mg max','Tebofortine 40 mg','Tebofortine Forte 80','Tebofrtin drops']
EXC_VALUE = 0.0  # no exception order found (DATA vs TOTAL reconcile to within 1 unit)
CNS_DM_CANON = {'Dakahlia DM':'Sally Saeed','Sally.Saeed':'Sally Saeed',
                 # Double-visits' "Double Name" column uses the marketing-legend dotted
                 # spelling for these two, which differs from the sales TOTAL tab's own
                 # spelling even after norm() (Husseinin vs ElHassanein, Salama vs
                 # Mohamed are genuinely different letter sequences, not just punctuation)
                 # — same two people MKT_PMAP_CNS already resolves for marketing costs.
                 'Mahmoud. ElHassanein':'Mahmoud El Husseinin','Saad.Mohamed':'Saad Salama'}
CNS_DM_ORDER = ['Amgad Ibrahim','Mahmoud El Husseinin','Mina Farouk','Saad Salama','Sally Saeed','Sameh Shaaban','Others']
def cdm(x): return CNS_DM_CANON.get(str(x).strip(), str(x).strip())
def norm(x):
    x=str(x).lower(); x=re.sub(r'\(.*?\)','',x); x=re.sub(r'[._\s]+',' ',x).strip(); return x
def ngeo(x): return re.sub(r'\s+',' ', str(x).strip().lower())
def r2(v):
    try: return round(float(v),2)
    except: return 0.0
def ach(s,t): return r2(100*s/t) if t else None
def slc(s,t): return dict(sales=r2(s), target=r2(t), ach=ach(s,t))

# =================== VACANT STATUS (Sheet1's own clean Area/status reference) ===================
s1ref = pd.read_excel(os.path.join(DL,"S1-2026 CNS-Line.xlsx"), sheet_name="Sheet1", header=None)
AREA_STATUS = {ngeo(a): str(s).strip().lower() for a, s in s1ref.iloc[1:, [13,14]].dropna(how="all").itertuples(index=False)}
# Owner correction 2026-07-30: Sheet1 marks "Down town" (Sameh Shaaban) active, but the
# owner says it's actually vacant — it was also the line's only >=90% earner (121.9%),
# consistent with a vacant brick still carrying residual pharmacy-stock sales with no
# rep driving it. Achievement number is untouched; this only changes display/filtering.
AREA_STATUS[ngeo('Down town')] = 'vacant'
def is_vac(area): return AREA_STATUS.get(ngeo(area)) == 'vacant'

# =================== SALES (TOTAL) ===================
t = pd.read_excel(os.path.join(DL,"S1-2026 CNS-Line.xlsx"), sheet_name="TOTAL")
t.columns=[str(c).strip() for c in t.columns]
t['sv']=pd.to_numeric(t['Sales Value'],errors='coerce').fillna(0)
t['tv']=pd.to_numeric(t['Target Value'],errors='coerce').fillna(0)

# Data artifact (2026-07-30 audit): "Dopaminict 1mg UPA" x Mar has the exact same
# Sales Units/Value (128.025 / 4570.4925) duplicated identically across all 41 areas —
# impossible for organic per-area sales, almost certainly a broadcast/fill-down error
# in the source TOTAL tab (a single national figure copied onto every row instead of
# staying as one row). Isolated to this one (product,month) — confirmed by scanning
# every other combo for the same pattern, none found. Zeroed rather than guessing
# which single area it "really" belongs to.
_dopa_bug = (t['product']=='Dopaminict 1mg UPA') & (t['Month']=='Mar') & (t['sv'].round(4)==4570.4925)
assert _dopa_bug.sum() == 41, f"expected 41 duplicated rows, found {_dopa_bug.sum()} — re-verify before zeroing"
t.loc[_dopa_bug, ['sv']] = 0
if 'Sales Units' in t.columns:
    t.loc[_dopa_bug, 'Sales Units'] = 0

t['inc']=True  # all 15 CNS products count — no include/exclude split for CNS's own line
t['dm']=t['D.M.'].apply(cdm)
t['vac']=t['Sys'].apply(is_vac)
t['Quarter']=t['Month'].map({m:('Q1' if MO.index(m)<3 else 'Q2') for m in MO})
ti=t[t['inc']]
tia=ti[~ti['vac']]  # all products (=include here), active (non-vacant) bricks

def agg(df):
    inc=df[df['inc']]
    return inc['sv'].sum(), inc['tv'].sum(), df['sv'].sum(), df['tv'].sum()

# ---- areas ----
aps=ti.pivot_table(index='Sys',columns='product',values='sv',aggfunc='sum',fill_value=0)
apt=ti.pivot_table(index='Sys',columns='product',values='tv',aggfunc='sum',fill_value=0)
amo=ti.pivot_table(index='Sys',columns='Month',values='sv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
areas=[]
for area,g in t.groupby('Sys'):
    area_disp = str(area).strip()
    if area_disp in ('#N/A','nan','None',''): continue
    dm=cdm(g['D.M.'].mode().iat[0] if not g['D.M.'].mode().empty else g['D.M.'].iloc[0])
    incS,incT,allS,allT=agg(g)
    prod={}
    for p in INCLUDE:
        s=aps.loc[area,p] if (area in aps.index and p in aps.columns) else 0
        tt=apt.loc[area,p] if (area in apt.index and p in apt.columns) else 0
        prod[p]=slc(s,tt)
    trend=[r2(amo.loc[area,m]) if area in amo.index else 0 for m in MO]
    reg=str(g['Column1'].mode().iat[0]).strip() if not g['Column1'].mode().empty else ''
    areas.append(dict(area=area_disp, dm=dm, region=reg, vacant=is_vac(area),
        includeOnly=slc(incS,incT), allProducts=slc(allS,allT),
        hasTarget=bool(incT>0), ungradeable=bool(incT==0 and allS!=0),
        hasReturns=any(v<0 for v in trend), products=prod, trend=trend))

# ---- DMs ----
dmm=ti.pivot_table(index='dm',columns='Month',values='sv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
dmmt=ti.pivot_table(index='dm',columns='Month',values='tv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
dmm_a=tia.pivot_table(index='dm',columns='Month',values='sv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
dmmt_a=tia.pivot_table(index='dm',columns='Month',values='tv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
dps=ti.pivot_table(index='dm',columns='product',values='sv',aggfunc='sum',fill_value=0)
dpt=ti.pivot_table(index='dm',columns='product',values='tv',aggfunc='sum',fill_value=0)
FAMILIES=sorted(set(ti['Family']))
dfs=ti.pivot_table(index='dm',columns='Family',values='sv',aggfunc='sum',fill_value=0)
dft=ti.pivot_table(index='dm',columns='Family',values='tv',aggfunc='sum',fill_value=0)
dms=[]
for dm,g in t.groupby('dm'):
    incS,incT,allS,allT=agg(g)
    ga=g[~g['vac']]; incSa,incTa,_,_=agg(ga)
    prod={p: slc(dps.loc[dm,p] if p in dps.columns else 0, dpt.loc[dm,p] if p in dpt.columns else 0) for p in INCLUDE}
    fam={f: ach(dfs.loc[dm,f] if (dm in dfs.index and f in dfs.columns) else 0, dft.loc[dm,f] if (dm in dft.index and f in dft.columns) else 0) for f in FAMILIES}
    dmreg=str(g['Column1'].mode().iat[0]).strip() if not g['Column1'].mode().empty else ''
    dms.append(dict(dm=dm, region=dmreg, vacant=bool(g['vac'].all()),
        areas=sorted(set(map(lambda x: str(x).strip(), g['Sys'].unique()))),
        activeAreas=sorted(set(map(lambda x: str(x).strip(), ga['Sys'].unique()))),
        includeOnly=slc(incS,incT), activeIncludeOnly=slc(incSa,incTa), allProducts=slc(allS,allT),
        productAch={p:prod[p]['ach'] for p in INCLUDE}, familyAch=fam,
        trend=[r2(dmm.loc[dm,m]) if dm in dmm.index else 0 for m in MO],
        achByMonth={m: ach(dmm.loc[dm,m] if dm in dmm.index else 0, dmmt.loc[dm,m] if dm in dmmt.index else 0) for m in MO},
        achByMonthActive={m: ach(dmm_a.loc[dm,m] if dm in dmm_a.index else 0, dmmt_a.loc[dm,m] if dm in dmmt_a.index else 0) for m in MO}))

# ---- line, quarters, product x month (achievement + totals) ----
incS,incT,allS,allT=agg(t)
nonvac=t[~t['vac']]
vincS,vincT,_,_=agg(nonvac)
line=dict(
    includeOnly=slc(incS,incT), allProducts=slc(allS,allT),
    withException=dict(includeOnly=slc(incS+EXC_VALUE,incT), allProducts=slc(allS+EXC_VALUE,allT)),
    exVacant=dict(includeOnly=slc(vincS,vincT)),
    exceptionValue=EXC_VALUE,
    quarters={}, byMonth={})
for q,g in t.groupby('Quarter'):
    qi,qit,qa,qat=agg(g); line['quarters'][str(q)]=dict(includeOnly=slc(qi,qit),allProducts=slc(qa,qat))
for m in MO:
    gm=t[t['Month']==m]; mi,mit,ma,mat=agg(gm)
    line['byMonth'][m]=dict(includeOnly=slc(mi,mit),allProducts=slc(ma,mat))

pS=t.pivot_table(index=['Family','product'],columns='Month',values='sv',aggfunc='sum',fill_value=0)
pT=t.pivot_table(index=['Family','product'],columns='Month',values='tv',aggfunc='sum',fill_value=0)
products=[]
for (fam,prod) in pS.index:
    byM={m: slc(pS.loc[(fam,prod),m] if m in pS.columns else 0, pT.loc[(fam,prod),m] if m in pT.columns else 0) for m in MO}
    tot=slc(sum(byM[m]['sales'] for m in MO), sum(byM[m]['target'] for m in MO))
    products.append(dict(product=str(prod), family=str(fam), include=(str(prod) in INCLUDE), byMonth=byM, total=tot))
products.sort(key=lambda p:-p['total']['sales'])

# =================== MARKETING (Req jan june s1.xlsx — GM-approved only, 6 CNS DMs) ===================
d=pd.read_excel(os.path.join(DL,"Req jan june s1.xlsx"),sheet_name="Sheet1",header=0)
d['spec']=d['Specialist'].astype(str).str.replace('Specialist : ','',regex=False).str.strip()
d['cost']=pd.to_numeric(d['Estimated Cost'],errors='coerce').fillna(0)
MKT_PMAP_CNS={'Amgad.Ibrahim':'Amgad Ibrahim','Mahmoud. ElHassanein':'Mahmoud El Husseinin',
              'Mina.Farouk':'Mina Farouk','Saad.Mohamed':'Saad Salama','Sameh.Shaaban':'Sameh Shaaban'}
d['pdm']=d['spec'].map(MKT_PMAP_CNS)
cns_req=d[d['pdm'].notna() & (d['Status']=='Approved by GM')].copy()
def mkt_date(v):
    s=str(v).strip()
    m=re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})',s)
    if m:
        dd,mo,y=int(m.group(1)),int(m.group(2)),int(m.group(3))
        try: return pd.Timestamp(year=y,month=mo,day=dd)
        except Exception: return pd.NaT
    m2=re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})',s)
    if m2:
        y,a,b=int(m2.group(1)),int(m2.group(2)),int(m2.group(3))
        try: return pd.Timestamp(year=y,month=b,day=a)
        except Exception:
            try: return pd.Timestamp(year=y,month=a,day=b)
            except Exception: return pd.NaT
    return pd.to_datetime(v,errors='coerce')
cns_req['mon']=cns_req['Date'].apply(mkt_date).dt.strftime('%b')
mkt_by_dm={}
for dm,g in cns_req.groupby('pdm'):
    mkt_by_dm[dm]=dict(cost=r2(g['cost'].sum()), requests=int(len(g)), months=int(g['mon'].nunique()),
                       byMonth={m:r2(g[g['mon']==m]['cost'].sum()) for m in MO if len(g[g['mon']==m])})
marketing=dict(pediaCost=r2(cns_req['cost'].sum()), byDM=mkt_by_dm,
               note="Approved by GM only (committed spend), 5 of 6 CNS DMs mapped (Sally Saeed absent from marketing legend, cost=0) — Req jan june s1.xlsx, owner-verified 2026-07-30.")

# =================== OUTSTATION (CNS, per DM per month) ===================
area2dm={ngeo(r['Sys']):cdm(r['D.M.']) for _,r in t.iterrows()}
reg2dm={}
for dm,g in t.groupby('dm'):
    rr=g['Column1'].mode()
    if len(rr): reg2dm[ngeo(rr.iat[0])]=dm
def region_to_dm(x):
    n=ngeo(x)
    if n in area2dm: return area2dm[n]
    if n in reg2dm: return reg2dm[n]
    if n=='upper egypt' and 'ue' in reg2dm: return reg2dm['ue']
    return None
ots=pd.read_excel(os.path.join(DL,"outstation-expense-command-2026-07-29.xlsx"),sheet_name="Outstation Expenses",header=3).dropna(how="all")
for c in ['Travel Cost','Meeting Amount','Allowance','Other','Total']: ots[c]=pd.to_numeric(ots[c],errors='coerce').fillna(0)
ots=ots[ots['Status'].astype(str).str.lower()!='rejected']
otp=ots[ots['Line'].astype(str).str.contains('CNS',case=False,na=False)].copy()
otp['dm']=otp['Region'].apply(region_to_dm)
otp['mon']=pd.to_datetime(otp['Date'],format='%d %b %Y',errors='coerce').dt.strftime('%b')
out_by_dm={}
for dm,g in otp.groupby(otp['dm'].fillna('Unmapped')):
    out_by_dm[str(dm)]=dict(cost=r2(g['Total'].sum()), rows=int(len(g)), months=int(g['mon'].nunique()),
                            byMonth={m:r2(g[g['mon']==m]['Total'].sum()) for m in MO if len(g[g['mon']==m])})
outstation=dict(pediaTotal=r2(otp['Total'].sum()), rows=int(len(otp)), byDM=out_by_dm,
                monthsCovered=sorted(set(otp['mon'].dropna()), key=lambda m:MO.index(m) if m in MO else 9),
                components=dict(travel=r2(otp['Travel Cost'].sum()),meeting=r2(otp['Meeting Amount'].sum()),
                                allowance=r2(otp['Allowance'].sum()),other=r2(otp['Other'].sum())),
                status="Rejected excluded; rest Pending/Approved. Region-based DM attribution — 'Alex Center' (abbreviated, 2 rows) falls to Unmapped.")

# =================== VISITS (FFcrm-visits + Dcrm-double-visits, "New folder (2)") ===================
V=pd.read_excel(os.path.join(DL2,"FFcrm-visits-2026-07-29.xlsx"),sheet_name="Visits",header=0).dropna(how="all")
raw_rows=int(len(V))
V=V[V['Line'].astype(str).eq('CNS')].drop_duplicates(subset=['CRM Visit ID'])
V['mon']=pd.to_datetime(V['Visit Date'],errors='coerce').dt.strftime('%b')
dv=pd.read_excel(os.path.join(DL2,"Dcrm-double-visits-2026-07-29.xlsx"),sheet_name="Double Visits",header=0).dropna(how="all")
CNS_DMS=['Amgad Ibrahim','Mahmoud El Husseinin','Mina Farouk','Saad Salama','Sally Saeed','Sameh Shaaban']
def norm_c(x): return norm(cdm(x))
cns_norm={norm_c(x) for x in CNS_DMS}
PMAP={norm_c(x):x for x in CNS_DMS}
rep2dm={}
for aid,g in dv.groupby('Agent HR ID'):
    m=g['Double Name'].mode()
    if len(m) and norm_c(m.iat[0]) in cns_norm:
        rep2dm[str(aid)]=PMAP.get(norm_c(m.iat[0]))
V['dm']=V['Agent HR ID'].astype(str).map(rep2dm)
nrep=V['Agent HR ID'].nunique()
per_rep=[]
for hid,g in V.groupby('Agent HR ID'):
    hd=str(g['Hiring Date'].iloc[0])
    per_rep.append(dict(agentHrId=str(hid), name=str(g['Agent Name'].iloc[0]),
                        hiringDate=(None if hd in ('nan','NaT','None') else hd),
                        visits=int(len(g)), activeMonths=int(g['mon'].nunique()),
                        avgPerMonth=r2(len(g)/max(1,g['mon'].nunique())), customers=int(g['Contact CRM ID'].nunique()),
                        dm=rep2dm.get(str(hid))))
vis_by_dm={}
for dm,g in V[V['dm'].notna()].groupby('dm'):
    vis_by_dm[dm]=dict(visits=int(len(g)), avgPerMonth=r2(len(g)/6),
                       byMonth={m:int((g['mon']==m).sum()) for m in MO},
                       customersTotal=int(g['Contact CRM ID'].nunique()),
                       customersByMonth={m:int(g[g['mon']==m]['Contact CRM ID'].nunique()) for m in MO})
visits=dict(available=True, totalDeduped=int(len(V)), rawRowsAcross5=raw_rows, dropped=raw_rows-int(len(V)), reps=nrep,
            avgPerRepPerMonth=r2(len(V)/6/max(1,nrep)), byMonth={m:int((V['mon']==m).sum()) for m in MO},
            customersTotal=int(V['Contact CRM ID'].nunique()),
            customersByMonth={m:int(V[V['mon']==m]['Contact CRM ID'].nunique()) for m in MO},
            byDM=vis_by_dm, repToDmCoverage=r2(100*V['dm'].notna().mean()), perRep=per_rep)
doubles=dict(total=int(len(dv)), byManager={str(k):int(len(g)) for k,g in dv.groupby('Double Name')})

# ---- enrich DM records ----
dbl_by_dm={}
for mgr,g in dv.groupby('Double Name'):
    if norm_c(mgr) in cns_norm: dbl_by_dm[PMAP[norm_c(mgr)]]=dbl_by_dm.get(PMAP[norm_c(mgr)],0)+int(len(g))
for D_ in dms:
    mk=mkt_by_dm.get(D_['dm'],{}); ot=out_by_dm.get(D_['dm'],{}); vi=vis_by_dm.get(D_['dm'],{})
    D_['marketingCost']=mk.get('cost',0); D_['marketingMonths']=mk.get('months',0); D_['marketingByMonth']=mk.get('byMonth',{})
    D_['outstationCost']=ot.get('cost',0); D_['outstationMonths']=ot.get('months',0); D_['outstationByMonth']=ot.get('byMonth',{})
    D_['doubleVisits']=dbl_by_dm.get(D_['dm'],0)
    D_['visits']=vi.get('visits',0); D_['visitsAvgPerMonth']=vi.get('avgPerMonth',0); D_['visitsByMonth']=vi.get('byMonth',{})
    D_['customersTotal']=vi.get('customersTotal',0); D_['customersByMonth']=vi.get('customersByMonth',{})
dms.sort(key=lambda x: CNS_DM_ORDER.index(x['dm']) if x['dm'] in CNS_DM_ORDER else 99)

line.update(marketingCost=marketing['pediaCost'], outstationCost=outstation['pediaTotal'],
            visits=visits['totalDeduped'], doubleVisits=doubles['total'],
            visitsAvgPerRepPerMonth=visits['avgPerRepPerMonth'], reps=nrep,
            customersTotal=visits['customersTotal'], customersByMonth=visits['customersByMonth'])

dataset=dict(
    meta=dict(line="CNS", period="S1 2026 (Jan–Jun)", currency="EGP", months=MO,
              generatedFrom=["S1-2026 CNS-Line.xlsx","Req jan june s1.xlsx","outstation-expense-command","FFcrm-visits-2026-07-29.xlsx","Dcrm-double-visits-2026-07-29.xlsx"],
              thresholds=dict(repFailBelow=20, dsmFailBelow=50),
              rulings=dict(includeProducts=INCLUDE, exception="none found — DATA vs TOTAL reconcile to within 1 unit of 559,016",
                           marketing="Approved by GM only (committed spend), 5 of 6 CNS DMs mapped",
                           vacant="4 bricks vacant per source status column; DMs all active; 'Others' bucket active but unmanaged")),
    line=line, products=products, dms=dms, areas=areas,
    marketing=marketing, outstation=outstation, visits=visits, doubleVisits=doubles)
with open(os.path.join(OUT_DIR,"cns-s1.json"),"w",encoding="utf-8") as f:
    json.dump(dataset,f,ensure_ascii=False,indent=1)

# =================== RECONCILIATION ===================
print("========= S1 CNS DATASET — RECONCILIATION =========")
print(f"LINE {line['allProducts']['sales']:,.0f}/{line['allProducts']['target']:,.0f} = {line['allProducts']['ach']}%")
print(f"     excl-vacant {line['exVacant']['includeOnly']['sales']:,.0f}/{line['exVacant']['includeOnly']['target']:,.0f} = {line['exVacant']['includeOnly']['ach']}%   (toggle ON)")
print("PRODUCT x MONTH achievement:")
for p in products:
    if p['total']['target']==0 and p['total']['sales']==0: continue
    print(f"  {p['product']:<26} "+" ".join(f"{m}:{(str(p['byMonth'][m]['ach'])+'%').rjust(7) if p['byMonth'][m]['ach'] is not None else '   —   '}" for m in MO)+f"  | TOT {p['total']['ach']}%")
print("DMs (vacant flagged):")
for D_ in dms:
    tag=' [VACANT]' if D_['vacant'] else ''
    print(f"  {D_['dm']:<22}{tag:9} ach {str(D_['allProducts']['ach']):>7}%  mkt {D_.get('marketingCost',0):>8,.0f}({D_.get('marketingMonths',0)}mo)  exp {D_.get('outstationCost',0):>7,.0f}  vis/mo {D_.get('visitsAvgPerMonth',0):>5}  dbl {D_.get('doubleVisits',0)}")
print(f"VISITS {visits['totalDeduped']:,} | {visits['avgPerRepPerMonth']} /rep/mo | rep→DM {visits['repToDmCoverage']}%")
print(f"AREAS {len(areas)} | fails<20% {sum(1 for a in areas if a['hasTarget'] and a['allProducts']['ach'] is not None and a['allProducts']['ach']<20)} | ungradeable {sum(1 for a in areas if a['ungradeable'])} | vacant {sum(1 for a in areas if a['vacant'])}")
print("WROTE", os.path.join(OUT_DIR,"cns-s1.json"))
