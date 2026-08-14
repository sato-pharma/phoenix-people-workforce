"""
S1 Business Review (Anti-Infective) — dataset ingestion / accuracy gate. READ-ONLY data.
Emits data/anti-s1.json. Re-run when the owner uploads new files. No Phoenix DB.
Mirrors build_dataset.py (Pedia) / build_dataset_cns.py (CNS); same JSON schema.

Audit findings baked in (2026-07-30):
  - Source workbook is an EMAIL ATTACHMENT, not in ~/Downloads. Path below is the
    resolved target of the owner-provided .lnk shortcut.
  - Column names differ from the CNS workbook and are NOT interchangeable:
      DATA  -> Area | Column2=status | DM2=DM | Column1=region | ... | Product
      TOTAL -> Column1=DM | Column2=region | Sys=area | Family | PRODUCT
    (Column1 means REGION in DATA but DM in TOTAL — do not copy CNS's accessors.)
  - Only TWO products line-wide: 'Royafloxacin 500mg tab' and 'Sagenkgo'. Both count
    (no include/exclude split), so includeOnly == allProducts numerically; both fields
    are kept for schema parity with the shared S1Dataset type.
  - FAMILY COLUMN BUG: 'Royafloxacin 500mg tab' is tagged Family='Dolabactin' (N=7) in
    Jan+Feb but Family='Royafloxacin' (N=2) in Mar-Jun — 174 vs 348 rows. Confirmed a
    cosmetic mislabel, NOT a different product: Factory Price is identically 60.70 in
    every one of Jan/Feb/Mar/Apr/May. So family is derived from PRODUCT here, and the
    spurious 'Dolabactin' family (a real product on the OTHER lines) is never emitted.
  - 'Discount' Type of Sales exists only in June and carries real discounted unit
    prices (Royafloxacin 46.00-60.70, Sagenkgo 54.28-111.15) with zero target — exactly
    like the Stores channel in other months (Stores is absent in June; Discount has the
    same 43-row-per-month shape). Treated as real revenue and included, consistent with
    Retail+Stores being included on the other two lines.
  - DM seats: 5 real DMs + 2 VACANT DM SEATS (unlike CNS, where only areas were
    vacant). Sheet1's DM->DM2 map resolves 2 handovers and 2 spelling variants:
      Kareem.Gamal    -> Momen.Abdelhady   (Cairo, handover)
      Ahmed Abdelazeem-> Ahmed Nashaat     (UE-2, handover)
      Ahmed.Nashaat   -> Ahmed Nashaat     (spelling)
      Sara Samir      -> Alex-BHR          (seat VACANT, falls back to region label)
      Heba Abdelbaset -> Giza              (seat VACANT, falls back to region label)
    Vacant seats are surfaced as '<Region> (vacant)' the same way Pedia shows
    'Cairo (vacant)' — no resigned employee's name is displayed.
  - 24 of 44 areas are vacant (Sheet1 Area/status block, which also lists 2 areas with
    no sales rows at all — harmless, and 2 whitespace-duplicate rows that normalize away).
  - Marketing: 6 Anti requesters in Req jan june s1.xlsx, all attributed by person name.
    Validation: 277,450 (Pedia) + 68,681 (CNS) + 150,640 (Anti) = 496,771 = the file's
    entire GM-approved total, so the 3-line split is exhaustive with nothing
    double-counted or dropped.
  - Outstation/marketing attribution is BY EMPLOYEE NAME, not by Region. The outstation
    file's Region column disagrees with the sales workbook for two DMs (it places
    Dina.Fadel in Delta (1) and Salim.Gomaa in Delta (2); the sales Sheet1 has them the
    other way round), so region-based logic silently SWAPPED 13,251 vs 6,214 between
    them. Names are unambiguous, so they win; Region is a fallback only.
  - Thresholds: rep-area fail < 20%, DSM fail < 50% (same as the other two lines).
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')
import pandas as pd

DL = r"C:\Users\satoh\Downloads"
DL2 = r"C:\Users\satoh\Downloads\New folder (2)"
SRC = (r"C:\Users\satoh\AppData\Local\Microsoft\Olk\Attachments"
       r"\ooa-726337bc-3526-4ed1-b7ee-b1aae0a06981"
       r"\f63970581aa125a97b2ce2a7f69a604cbff9642bb8a98aa849d88cedb291979b"
       r"\S1-2026 Anti-Line.xlsx")
# Always this repo's own data/ dir, wherever this checkout or worktree happens to live.
# Used to hardcode a sibling worktree path (_wt-s1-review) that only existed on the
# owner's machine, so nobody else could reproduce the output.
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
os.makedirs(OUT_DIR, exist_ok=True)
MO = ['Jan','Feb','Mar','Apr','May','Jun']

# Family is derived from PRODUCT, overriding the buggy Family column (see docstring).
PRODUCT_FAMILY = {'Royafloxacin 500mg tab': 'Royafloxacin', 'Sagenkgo': 'Saginko'}
INCLUDE = ['Royafloxacin 500mg tab', 'Sagenkgo']
EXC_VALUE = 0.0  # no exception order (DATA vs TOTAL agree to 14 of 64,846 units)

VACANT_SEAT_LABEL = {'Alex-BHR': 'Alex-BHR (vacant)', 'Giza': 'Giza (vacant)'}
ANTI_DM_CANON = {
    'Kareem.Gamal': 'Momen.Abdelhady', 'Cairo DM': 'Momen.Abdelhady',
    'Ahmed Abdelazeem': 'Ahmed Nashaat', 'Ahmed.Nashaat': 'Ahmed Nashaat',
    'Sara Samir': 'Alex-BHR', 'Alex-BHR DM': 'Alex-BHR',
    'Heba Abdelbaset': 'Giza',
}
ANTI_DM_ORDER = ['Nosiba Salah','Momen.Abdelhady','Ahmed Nashaat','Dina Fadel','Salim Gomaa',
                 'Alex-BHR (vacant)','Giza (vacant)','Others']

# Person-name -> DM seat, keyed on norm() (lowercased, dots/underscores collapsed,
# "( Minia 1 / E )"-style suffixes stripped). Used for outstation + marketing, where
# the source files identify people by name rather than by the sales workbook's DM
# label. 'Sara Jacoub' resolves to the Alex-BHR seat: she appears under Region
# ALEX-BHR in outstation, as an Anti marketing requester, and in Anti double-visits —
# three independent files agreeing. NOTE FOR OWNER: the sales workbook still shows
# that seat's holder as 'Sara Samir' with the seat vacant, so her activity is
# attributed to the seat while the seat keeps the workbook's vacant flag.
EMP_TO_DM = {
    'nosiba salah': 'Nosiba Salah',
    'momen abdelhady': 'Momen.Abdelhady',
    'kareem gamal': 'Momen.Abdelhady',
    'ahmed nashaat': 'Ahmed Nashaat',
    'ahmed abdelazeem': 'Ahmed Nashaat',
    'dina fadel': 'Dina Fadel',
    'salim gomaa': 'Salim Gomaa',
    'sara jacoub': 'Alex-BHR (vacant)',
    'sara samir': 'Alex-BHR (vacant)',
    'heba abdelbaset': 'Giza (vacant)',
}

def cdm(x):
    s = re.sub(r'\s+', ' ', str(x).strip())
    s = ANTI_DM_CANON.get(s, s)
    return VACANT_SEAT_LABEL.get(s, s)
def norm(x):
    x=str(x).lower(); x=re.sub(r'\(.*?\)','',x); x=re.sub(r'[._\s]+',' ',x).strip(); return x
def ngeo(x): return re.sub(r'\s+',' ', str(x).strip().lower())
def r2(v):
    try: return round(float(v),2)
    except: return 0.0
def ach(s,t): return r2(100*s/t) if t else None
def slc(s,t): return dict(sales=r2(s), target=r2(t), ach=ach(s,t))

# =================== VACANT STATUS (Sheet1 Area/status block) ===================
s1ref = pd.read_excel(SRC, sheet_name="Sheet1", header=None)
AREA_STATUS = {ngeo(a): str(s).strip().lower()
               for a, s in s1ref.iloc[1:, [6,7]].dropna(how="all").itertuples(index=False)}
def is_vac(area): return AREA_STATUS.get(ngeo(area)) == 'vacant'
VACANT_SEATS = set(VACANT_SEAT_LABEL.values())

# =================== SALES (TOTAL) ===================
t = pd.read_excel(SRC, sheet_name="TOTAL")
t.columns=[str(c).strip() for c in t.columns]
t['sv']=pd.to_numeric(t['Sales Value'],errors='coerce').fillna(0)
t['tv']=pd.to_numeric(t['Target Value'],errors='coerce').fillna(0)
t['inc']=True                                        # both products count
t['dm']=t['Column1'].apply(cdm)                      # NB: Column1 == DM in TOTAL
t['Family']=t['PRODUCT'].map(PRODUCT_FAMILY)         # override buggy Family col
assert t['Family'].notna().all(), "unmapped PRODUCT -> add it to PRODUCT_FAMILY"
t['vac']=t['Sys'].apply(is_vac)
t['Quarter']=t['Month'].map({m:('Q1' if MO.index(m)<3 else 'Q2') for m in MO})
ti=t[t['inc']]
tia=ti[~ti['vac']]

def agg(df):
    inc=df[df['inc']]
    return inc['sv'].sum(), inc['tv'].sum(), df['sv'].sum(), df['tv'].sum()

# ---- areas ----
aps=ti.pivot_table(index='Sys',columns='PRODUCT',values='sv',aggfunc='sum',fill_value=0)
apt=ti.pivot_table(index='Sys',columns='PRODUCT',values='tv',aggfunc='sum',fill_value=0)
amo=ti.pivot_table(index='Sys',columns='Month',values='sv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
areas=[]
for area,g in t.groupby('Sys'):
    area_disp=re.sub(r'\s+',' ',str(area).strip())
    if area_disp in ('#N/A','nan','None',''): continue
    dm=cdm(g['Column1'].mode().iat[0] if not g['Column1'].mode().empty else g['Column1'].iloc[0])
    incS,incT,allS,allT=agg(g)
    prod={}
    for p in INCLUDE:
        s=aps.loc[area,p] if (area in aps.index and p in aps.columns) else 0
        tt=apt.loc[area,p] if (area in apt.index and p in apt.columns) else 0
        prod[p]=slc(s,tt)
    trend=[r2(amo.loc[area,m]) if area in amo.index else 0 for m in MO]
    reg=str(g['Column2'].mode().iat[0]).strip() if not g['Column2'].mode().empty else ''
    areas.append(dict(area=area_disp, dm=dm, region=reg, vacant=is_vac(area),
        includeOnly=slc(incS,incT), allProducts=slc(allS,allT),
        hasTarget=bool(incT>0), ungradeable=bool(incT==0 and allS!=0),
        hasReturns=any(v<0 for v in trend), products=prod, trend=trend))

# ---- DMs ----
dmm=ti.pivot_table(index='dm',columns='Month',values='sv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
dmmt=ti.pivot_table(index='dm',columns='Month',values='tv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
dmm_a=tia.pivot_table(index='dm',columns='Month',values='sv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
dmmt_a=tia.pivot_table(index='dm',columns='Month',values='tv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
dps=ti.pivot_table(index='dm',columns='PRODUCT',values='sv',aggfunc='sum',fill_value=0)
dpt=ti.pivot_table(index='dm',columns='PRODUCT',values='tv',aggfunc='sum',fill_value=0)
FAMILIES=sorted(set(ti['Family']))
dfs=ti.pivot_table(index='dm',columns='Family',values='sv',aggfunc='sum',fill_value=0)
dft=ti.pivot_table(index='dm',columns='Family',values='tv',aggfunc='sum',fill_value=0)
dms=[]
for dm,g in t.groupby('dm'):
    incS,incT,allS,allT=agg(g)
    ga=g[~g['vac']]; incSa,incTa,_,_=agg(ga)
    prod={p: slc(dps.loc[dm,p] if p in dps.columns else 0, dpt.loc[dm,p] if p in dpt.columns else 0) for p in INCLUDE}
    fam={f: ach(dfs.loc[dm,f] if (dm in dfs.index and f in dfs.columns) else 0, dft.loc[dm,f] if (dm in dft.index and f in dft.columns) else 0) for f in FAMILIES}
    # A DM is vacant if the SEAT itself is vacant, or every one of its areas is.
    dmreg=str(g['Column2'].mode().iat[0]).strip() if not g['Column2'].mode().empty else ''
    dms.append(dict(dm=dm, region=dmreg, vacant=bool(dm in VACANT_SEATS or g['vac'].all()),
        areas=sorted(set(re.sub(r'\s+',' ',str(x).strip()) for x in g['Sys'].unique())),
        activeAreas=sorted(set(re.sub(r'\s+',' ',str(x).strip()) for x in ga['Sys'].unique())),
        includeOnly=slc(incS,incT), activeIncludeOnly=slc(incSa,incTa), allProducts=slc(allS,allT),
        productAch={p:prod[p]['ach'] for p in INCLUDE}, familyAch=fam,
        trend=[r2(dmm.loc[dm,m]) if dm in dmm.index else 0 for m in MO],
        achByMonth={m: ach(dmm.loc[dm,m] if dm in dmm.index else 0, dmmt.loc[dm,m] if dm in dmmt.index else 0) for m in MO},
        achByMonthActive={m: ach(dmm_a.loc[dm,m] if dm in dmm_a.index else 0, dmmt_a.loc[dm,m] if dm in dmmt_a.index else 0) for m in MO}))

# ---- line, quarters, product x month ----
incS,incT,allS,allT=agg(t)
nonvac=t[~t['vac']]
vincS,vincT,_,_=agg(nonvac)
line=dict(
    includeOnly=slc(incS,incT), allProducts=slc(allS,allT),
    withException=dict(includeOnly=slc(incS+EXC_VALUE,incT), allProducts=slc(allS+EXC_VALUE,allT)),
    exVacant=dict(includeOnly=slc(vincS,vincT)),
    exceptionValue=EXC_VALUE, quarters={}, byMonth={})
for q,g in t.groupby('Quarter'):
    qi,qit,qa,qat=agg(g); line['quarters'][str(q)]=dict(includeOnly=slc(qi,qit),allProducts=slc(qa,qat))
for m in MO:
    gm=t[t['Month']==m]; mi,mit,ma,mat=agg(gm)
    line['byMonth'][m]=dict(includeOnly=slc(mi,mit),allProducts=slc(ma,mat))

pS=t.pivot_table(index=['Family','PRODUCT'],columns='Month',values='sv',aggfunc='sum',fill_value=0)
pT=t.pivot_table(index=['Family','PRODUCT'],columns='Month',values='tv',aggfunc='sum',fill_value=0)
products=[]
for (fam,prod) in pS.index:
    byM={m: slc(pS.loc[(fam,prod),m] if m in pS.columns else 0, pT.loc[(fam,prod),m] if m in pT.columns else 0) for m in MO}
    tot=slc(sum(byM[m]['sales'] for m in MO), sum(byM[m]['target'] for m in MO))
    products.append(dict(product=str(prod), family=str(fam), include=(str(prod) in INCLUDE), byMonth=byM, total=tot))
products.sort(key=lambda p:-p['total']['sales'])

# =================== MARKETING (GM-approved only) ===================
d=pd.read_excel(os.path.join(DL,"Req jan june s1.xlsx"),sheet_name="Sheet1",header=0)
d['spec']=d['Specialist'].astype(str).str.replace('Specialist : ','',regex=False).str.strip()
d['cost']=pd.to_numeric(d['Estimated Cost'],errors='coerce').fillna(0)
# All six Anti requesters resolve to a DM seat via EMP_TO_DM (name-keyed), including
# Sara.Jacoub -> Alex-BHR seat, established from the outstation file's Region column.
ANTI_SPECS=['Ahmed.Nashaat','Dina.Fadel','Momen.Abdelhady','Nosiba.Salah ( Minia 1 / E )',
            'Salim.Gomaa','Sara.Jacoub']
anti_req=d[d['spec'].isin(ANTI_SPECS) & (d['Status']=='Approved by GM')].copy()
anti_req['pdm']=anti_req['spec'].apply(lambda s: EMP_TO_DM.get(norm(s)))
assert anti_req['pdm'].notna().all(), (
    "unmapped Anti marketing requester: " + str(sorted(set(anti_req.loc[anti_req['pdm'].isna(),'spec']))))
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
anti_req['mon']=anti_req['Date'].apply(mkt_date).dt.strftime('%b')
mkt_by_dm={}
for dm,g in anti_req[anti_req['pdm'].notna()].groupby('pdm'):
    mkt_by_dm[dm]=dict(cost=r2(g['cost'].sum()), requests=int(len(g)), months=int(g['mon'].nunique()),
                       byMonth={m:r2(g[g['mon']==m]['cost'].sum()) for m in MO if len(g[g['mon']==m])})
unattr=r2(anti_req[anti_req['pdm'].isna()]['cost'].sum())
marketing=dict(pediaCost=r2(anti_req['cost'].sum()), byDM=mkt_by_dm,
               note=("Approved by GM only (committed spend). All 6 Anti requesters attributed by person "
                     "name; Sara.Jacoub maps to the Alex-BHR seat (confirmed via the outstation file's "
                     "ALEX-BHR region). Req jan june s1.xlsx, owner-verified 2026-07-30."))

# =================== OUTSTATION (Anti, per DM per month) ===================
# Attribute by EMPLOYEE NAME, not Region. The outstation file's Region column
# contradicts the sales workbook for two DMs — it puts Dina.Fadel in Delta (1) and
# Salim.Gomaa in Delta (2), while the sales Sheet1 has Dina Fadel = Delta (2) and
# Salim Gomaa = Delta (1). Region-based attribution therefore SWAPPED their expenses
# (verified: 13,251 vs 6,214 landed on the wrong DM). The Employee column names the
# actual person, so it is authoritative; Region is only a fallback for rows whose
# employee can't be resolved. Name-matching also recovers the 9,131 "Upper Egypt"
# rows (all Ahmed.Nashaat) that region logic had to leave unmapped, because Anti
# splits UE into UE-1/UE-2 and the region label alone can't distinguish them.
area2dm={ngeo(r['Sys']):cdm(r['Column1']) for _,r in t.iterrows()}
reg2dm={}
for dm,g in t.groupby('dm'):
    rr=g['Column2'].mode()
    if len(rr): reg2dm[ngeo(rr.iat[0])]=dm
def region_to_dm(x):
    n=ngeo(x)
    if n in area2dm: return area2dm[n]
    if n in reg2dm: return reg2dm[n]
    return None
ots=pd.read_excel(os.path.join(DL,"outstation-expense-command-2026-07-29.xlsx"),sheet_name="Outstation Expenses",header=3).dropna(how="all")
for c in ['Travel Cost','Meeting Amount','Allowance','Other','Total']: ots[c]=pd.to_numeric(ots[c],errors='coerce').fillna(0)
ots=ots[ots['Status'].astype(str).str.lower()!='rejected']
otp=ots[ots['Line'].astype(str).str.contains('Anti',case=False,na=False)].copy()
def employee_to_dm(x):
    n=norm(x)                      # strips dots and "( Minia 1 / E )"-style suffixes
    return EMP_TO_DM.get(n)
otp['dm']=otp['Employee'].apply(employee_to_dm)
_unresolved=otp['dm'].isna()
if _unresolved.any():              # fall back to region only for unnamed employees
    otp.loc[_unresolved,'dm']=otp.loc[_unresolved,'Region'].apply(region_to_dm)
otp['mon']=pd.to_datetime(otp['Date'],format='%d %b %Y',errors='coerce').dt.strftime('%b')
out_by_dm={}
for dm,g in otp.groupby(otp['dm'].fillna('Unmapped')):
    out_by_dm[str(dm)]=dict(cost=r2(g['Total'].sum()), rows=int(len(g)), months=int(g['mon'].nunique()),
                            byMonth={m:r2(g[g['mon']==m]['Total'].sum()) for m in MO if len(g[g['mon']==m])})
outstation=dict(pediaTotal=r2(otp['Total'].sum()), rows=int(len(otp)), byDM=out_by_dm,
                monthsCovered=sorted(set(otp['mon'].dropna()), key=lambda m:MO.index(m) if m in MO else 9),
                components=dict(travel=r2(otp['Travel Cost'].sum()),meeting=r2(otp['Meeting Amount'].sum()),
                                allowance=r2(otp['Allowance'].sum()),other=r2(otp['Other'].sum())),
                status="Rejected excluded. Region-based DM attribution; 'Upper Egypt' rows stay Unmapped because Anti splits UE into UE-1/UE-2.")

# =================== VISITS (Fcrm-visits + DDcrm-double-visits) ===================
V=pd.read_excel(os.path.join(DL2,"Fcrm-visits-2026-07-29.xlsx"),sheet_name="Visits",header=0).dropna(how="all")
raw_rows=int(len(V))
V=V[V['Line'].astype(str).eq('Anti Infective')].drop_duplicates(subset=['CRM Visit ID'])
V['mon']=pd.to_datetime(V['Visit Date'],errors='coerce').dt.strftime('%b')
dv=pd.read_excel(os.path.join(DL2,"DDcrm-double-visits-2026-07-29.xlsx"),sheet_name="Double Visits",header=0).dropna(how="all")
ANTI_DMS=['Nosiba Salah','Momen.Abdelhady','Ahmed Nashaat','Dina Fadel','Salim Gomaa',
          'Alex-BHR (vacant)','Giza (vacant)']
def norm_c(x): return norm(cdm(x))
anti_norm={norm_c(x) for x in ANTI_DMS}
PMAP={norm_c(x):x for x in ANTI_DMS}
rep2dm={}
for aid,g in dv.groupby('Agent HR ID'):
    m=g['Double Name'].mode()
    if len(m) and norm_c(m.iat[0]) in anti_norm:
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
    if norm_c(mgr) in anti_norm: dbl_by_dm[PMAP[norm_c(mgr)]]=dbl_by_dm.get(PMAP[norm_c(mgr)],0)+int(len(g))
for D_ in dms:
    mk=mkt_by_dm.get(D_['dm'],{}); ot=out_by_dm.get(D_['dm'],{}); vi=vis_by_dm.get(D_['dm'],{})
    D_['marketingCost']=mk.get('cost',0); D_['marketingMonths']=mk.get('months',0); D_['marketingByMonth']=mk.get('byMonth',{})
    D_['outstationCost']=ot.get('cost',0); D_['outstationMonths']=ot.get('months',0); D_['outstationByMonth']=ot.get('byMonth',{})
    D_['doubleVisits']=dbl_by_dm.get(D_['dm'],0)
    D_['visits']=vi.get('visits',0); D_['visitsAvgPerMonth']=vi.get('avgPerMonth',0); D_['visitsByMonth']=vi.get('byMonth',{})
    D_['customersTotal']=vi.get('customersTotal',0); D_['customersByMonth']=vi.get('customersByMonth',{})
dms.sort(key=lambda x: ANTI_DM_ORDER.index(x['dm']) if x['dm'] in ANTI_DM_ORDER else 99)

line.update(marketingCost=marketing['pediaCost'], outstationCost=outstation['pediaTotal'],
            visits=visits['totalDeduped'], doubleVisits=doubles['total'],
            visitsAvgPerRepPerMonth=visits['avgPerRepPerMonth'], reps=nrep,
            customersTotal=visits['customersTotal'], customersByMonth=visits['customersByMonth'])

dataset=dict(
    meta=dict(line="Anti-Infective", period="S1 2026 (Jan–Jun)", currency="EGP", months=MO,
              generatedFrom=["S1-2026 Anti-Line.xlsx (email attachment)","Req jan june s1.xlsx",
                             "outstation-expense-command","Fcrm-visits-2026-07-29.xlsx",
                             "DDcrm-double-visits-2026-07-29.xlsx"],
              thresholds=dict(repFailBelow=20, dsmFailBelow=50),
              rulings=dict(includeProducts=INCLUDE,
                           exception="none — DATA vs TOTAL agree to 14 of 64,846 units",
                           family="derived from PRODUCT; source Family col mislabels Royafloxacin as 'Dolabactin' in Jan+Feb",
                           discount="June 'Discount' channel included — real discounted-price revenue, zero-target like Stores",
                           marketing="Approved by GM only; 5 of 6 Anti requesters map to seats",
                           vacant="2 vacant DM seats (Alex-BHR, Giza) + 24 of 44 areas vacant")),
    line=line, products=products, dms=dms, areas=areas,
    marketing=marketing, outstation=outstation, visits=visits, doubleVisits=doubles)
with open(os.path.join(OUT_DIR,"anti-s1.json"),"w",encoding="utf-8") as f:
    json.dump(dataset,f,ensure_ascii=False,indent=1)

# =================== RECONCILIATION ===================
print("========= S1 ANTI-INFECTIVE DATASET — RECONCILIATION =========")
print(f"LINE {line['allProducts']['sales']:,.0f}/{line['allProducts']['target']:,.0f} = {line['allProducts']['ach']}%")
print(f"     excl-vacant {line['exVacant']['includeOnly']['sales']:,.0f}/{line['exVacant']['includeOnly']['target']:,.0f} = {line['exVacant']['includeOnly']['ach']}%   (toggle ON)")
print("PRODUCT x MONTH achievement:")
for p in products:
    if p['total']['target']==0 and p['total']['sales']==0: continue
    print(f"  {p['product']:<24} [{p['family']:<13}] "+" ".join(f"{m}:{(str(p['byMonth'][m]['ach'])+'%').rjust(8) if p['byMonth'][m]['ach'] is not None else '   —    '}" for m in MO)+f"  | TOT {p['total']['ach']}%")
print("DMs (vacant flagged):")
for D_ in dms:
    tag=' [VACANT]' if D_['vacant'] else ''
    print(f"  {D_['dm']:<20}{tag:9} ach {str(D_['allProducts']['ach']):>8}%  mkt {D_.get('marketingCost',0):>8,.0f}({D_.get('marketingMonths',0)}mo)  exp {D_.get('outstationCost',0):>7,.0f}  vis/mo {D_.get('visitsAvgPerMonth',0):>7}  dbl {D_.get('doubleVisits',0)}")
print(f"MARKETING line {marketing['pediaCost']:,.0f} (attributed {sum(v['cost'] for v in mkt_by_dm.values()):,.0f} + unattributed {unattr:,.0f})")
print(f"OUTSTATION {outstation['pediaTotal']:,.0f} over {len(outstation['monthsCovered'])} mo; byDM keys={list(out_by_dm)}")
print(f"VISITS {visits['totalDeduped']:,} | {visits['avgPerRepPerMonth']} /rep/mo | reps {nrep} | rep→DM {visits['repToDmCoverage']}%")
print(f"AREAS {len(areas)} | fails<20% {sum(1 for a in areas if a['hasTarget'] and a['allProducts']['ach'] is not None and a['allProducts']['ach']<20 and not a['vacant'])} | ungradeable {sum(1 for a in areas if a['ungradeable'])} | vacant {sum(1 for a in areas if a['vacant'])}")
print("WROTE", os.path.join(OUT_DIR,"anti-s1.json"))
