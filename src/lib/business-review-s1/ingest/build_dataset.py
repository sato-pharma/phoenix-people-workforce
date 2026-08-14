"""
S1 Business Review (Pedia) — dataset ingestion / accuracy gate.  READ-ONLY module data.
Reads owner-provided S1 files from ~/Downloads and emits data/pedia-s1.json.
Re-run when the owner uploads new files. No Phoenix DB, no migration.

AS OF THE RULE #1 MIGRATION (2026-08): sales, target and achievement figures in the emitted
JSON are NO LONGER READ by the app. src/lib/business-review-s1/canonical.ts builds those
live from SoS Monthly Closing (au.f_monthly_achievement) instead, so the review can no
longer disagree with the rest of Phoenix about what was sold. This script's continuing job
is the fields canonical has no equivalent for: marketing spend, outstation spend, CRM
visits/double-visits and unique-doctor counts. See canonical.ts's header for the full split.

Owner rulings baked in:
  - Include products (count for achievement): Ivyronc, Guamusin, Lacto Advanced 1/2.
  - 20,000-unit Ivyronc Feb order = exception @14 (=280,000): excl rep/DM, incl line/NSM.
  - Marketing: Req jan june s1.xlsx, Status=="Approved by GM" only (committed spend),
    5 Pedia DMs. Supersedes the old DoctorRequest_(3).xls all-status sum (932,080 — was
    wrong, counted Pending/Declined as spend); corrected total is 277,450.
  - Cairo DSM (Haitham Abdelkarim) RESIGNED -> Cairo territory flagged vacant (mergeable/excludable).
  - Thresholds: rep-area fail < 20%, DSM fail < 50%.
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')
import pandas as pd

DL = r"C:\Users\satoh\Downloads"
# Always this repo's own data/ dir, wherever this checkout or worktree happens to live.
# Used to hardcode a sibling worktree path (_wt-s1-review) that only existed on the
# owner's machine, so nobody else could reproduce the output.
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
os.makedirs(OUT_DIR, exist_ok=True)
MO = ['Jan','Feb','Mar','Apr','May','Jun']
INCLUDE = ['Guamusin','Ivyronc','Lacto Advanced 1','Lacto Advanced 2']
SHORT = {'Guamusin':'Guamusin','Ivyronc':'Ivyronc','Lacto Advanced 1':'Lacto Advanced 1','Lacto Advanced 2':'Lacto Advanced 2'}
EXC_VALUE = 20000 * 14.0
VACANT_DM = 'Cairo (vacant)'
# Rep-area (area) vacancies in the Pedia line — owner-provided 2026-07-29, plus
# 'Dokki - Mohandseen - Bolak' added 2026-07-30. These areas have no assigned rep;
# vacancy never changes an achievement number, it only reclassifies the area out of
# rep-failure lists and into "uncovered territory" (and lets the toggle hide it).
VACANT_AREAS = [
    'Assiut 1','Bani suef','Alex Center 1','Nasr City','Cairo East 2','Kafr El-Sheikh',
    'heliopolis','Cairo East 1','Ismailia-Suez','Cairo West','Imbaba - Imbaba Centers',
    'Down town','Helwan-Maadi','Dakahlia 2','Sharkia 1','Sharkia 2','Sharkia 3','Assiut 2',
    'Others','Cairo Others','Dokki - Mohandseen - Bolak',
]
DM_CANON = {
    'Yehia Kamal':'Yehya Kamal','Nermin Salah':'Nermeen Salah','Taha.Mohamed':'Taha Mohamed',
    'Ahmed Hekal':'Ahmed Hekal','Ahmed Abdallah':'Ahmed Abdallah',
    'Cairo DM':VACANT_DM,'Haitham Abdelkarim':VACANT_DM,
}
PED_DM_ORDER = ['Nermeen Salah','Ahmed Hekal','Yehya Kamal','Ahmed Abdallah','Taha Mohamed',VACANT_DM,'Others']
def cdm(x): return DM_CANON.get(str(x).strip(), str(x).strip())
def norm(x):
    x=str(x).lower(); x=re.sub(r'\(.*?\)','',x); x=re.sub(r'[._\s]+',' ',x).strip(); return x
def ngeo(x): return re.sub(r'\s+',' ', str(x).strip().lower())
def r2(v):
    try: return round(float(v),2)
    except: return 0.0
def ach(s,t): return r2(100*s/t) if t else None
def slc(s,t): return dict(sales=r2(s), target=r2(t), ach=ach(s,t))

# =================== SALES (TOTAL) ===================
t = pd.read_excel(os.path.join(DL,"S1-2026 Ped Line.xlsx"), sheet_name="TOTAL")
t.columns=[str(c).strip() for c in t.columns]
t['sv']=pd.to_numeric(t['Sales Value'],errors='coerce').fillna(0)
t['tv']=pd.to_numeric(t['Target Value'],errors='coerce').fillna(0)
t['inc']=t['Column1'].astype(str).eq('Include')
t['dm']=t['DM'].apply(cdm)
VAC_NORM={ngeo(x) for x in VACANT_AREAS}
def is_vac(area): return ngeo(area) in VAC_NORM
t['vac']=t['Med RepArea'].apply(is_vac)
ti=t[t['inc']]
tia=ti[~ti['vac']]  # include products, active (non-vacant) areas

def agg(df):
    inc=df[df['inc']]
    return inc['sv'].sum(), inc['tv'].sum(), df['sv'].sum(), df['tv'].sum()

# ---- areas ----
aps=ti.pivot_table(index='Med RepArea',columns='PRODUCT',values='sv',aggfunc='sum',fill_value=0)
apt=ti.pivot_table(index='Med RepArea',columns='PRODUCT',values='tv',aggfunc='sum',fill_value=0)
amo=ti.pivot_table(index='Med RepArea',columns='Month',values='sv',aggfunc='sum',fill_value=0).reindex(columns=MO,fill_value=0)
areas=[]
for area,g in t.groupby('Med RepArea'):
    if str(area) in ('#N/A','nan','None',''): continue
    dm=cdm(g['DM'].mode().iat[0] if not g['DM'].mode().empty else g['DM'].iloc[0])
    incS,incT,allS,allT=agg(g)
    prod={}
    for p in INCLUDE:
        s=aps.loc[area,p] if (area in aps.index and p in aps.columns) else 0
        tt=apt.loc[area,p] if (area in apt.index and p in apt.columns) else 0
        prod[p]=slc(s,tt)
    trend=[r2(amo.loc[area,m]) if area in amo.index else 0 for m in MO]
    reg=str(g['DM Region'].mode().iat[0]).strip() if not g['DM Region'].mode().empty else ''
    areas.append(dict(area=str(area), dm=dm, region=reg, vacant=is_vac(area),
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
    dmreg=str(g['DM Region'].mode().iat[0]).strip() if not g['DM Region'].mode().empty else ''
    dms.append(dict(dm=dm, region=dmreg, vacant=bool(g['vac'].all()),
        areas=sorted(set(map(str,g['Med RepArea'].unique()))),
        activeAreas=sorted(set(map(str,ga['Med RepArea'].unique()))),
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
for q,g in t.groupby('Column2'):
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

# =================== MARKETING (Req jan june s1.xlsx — GM-approved only, 5 Pedia DMs) ===================
# Supersedes the old DoctorRequest_(3).xls pipeline (2026-07-30): that summed ALL
# statuses (Pending/Declined/interim-approval stages included), inflating Pedia cost
# to 932,080. This file is pre-filtered to Status=="Approved by GM" (the only stage
# that represents committed spend) — 277,450 verified two independent ways against
# Book1sss.xlsx's Sheet4 (all-status master, GM-only subset) and its own "Requests DB"
# tab (byte-identical to this file). Owner-provided 2026-07-30.
d=pd.read_excel(os.path.join(DL,"Req jan june s1.xlsx"),sheet_name="Sheet1",header=0)
d['spec']=d['Specialist'].astype(str).str.replace('Specialist : ','',regex=False).str.strip()
d['cost']=pd.to_numeric(d['Estimated Cost'],errors='coerce').fillna(0)
MKT_PMAP={'Ahmed.Abdallah':'Ahmed Abdallah','Ahmed.Hekal':'Ahmed Hekal','Nermeen.Salah':'Nermeen Salah','Taha.Mohamed':'Taha Mohamed','Yehya.Kamal':'Yehya Kamal'}
d['pdm']=d['spec'].map(MKT_PMAP)
ped=d[d['pdm'].notna() & (d['Status']=='Approved by GM')].copy()
def mkt_date(v):
    s=str(v).strip()
    m=re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})',s)
    if m:
        dd,mo,y=int(m.group(1)),int(m.group(2)),int(m.group(3))
        try: return pd.Timestamp(year=y,month=mo,day=dd)
        except Exception: return pd.NaT
    # Some cells are ISO-shaped text (e.g. "2026-09-04 00:00:00") from a different
    # source system with month/day swapped vs the day-first cells above — validated by
    # forcing chronological Code order per DM (every ambiguous cell then lands inside
    # Jan-Jun 2026 in Code sequence; unswapped, several land in Aug/Sep/Dec — impossible
    # for an S1 file). Swap recovers the intended day-first date.
    m2=re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})',s)
    if m2:
        y,a,b=int(m2.group(1)),int(m2.group(2)),int(m2.group(3))
        try: return pd.Timestamp(year=y,month=b,day=a)
        except Exception:
            try: return pd.Timestamp(year=y,month=a,day=b)
            except Exception: return pd.NaT
    return pd.to_datetime(v,errors='coerce')
ped['mon']=ped['Date'].apply(mkt_date).dt.strftime('%b')
mkt_by_dm={}
for dm,g in ped.groupby('pdm'):
    mkt_by_dm[dm]=dict(cost=r2(g['cost'].sum()), requests=int(len(g)), months=int(g['mon'].nunique()),
                       byMonth={m:r2(g[g['mon']==m]['cost'].sum()) for m in MO if len(g[g['mon']==m])})
marketing=dict(pediaCost=r2(ped['cost'].sum()), byDM=mkt_by_dm,
               note="Approved by GM only (committed spend), 5 Pedia DMs — Req jan june s1.xlsx, owner-verified 2026-07-30.")

# =================== OUTSTATION (Pedia, per DM per month) ===================
area2dm={ngeo(r['Med RepArea']):cdm(r['DM']) for _,r in t.iterrows()}
reg2dm={}
for dm,g in t.groupby('dm'):
    rr=g['DM Region'].mode()
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
otp=ots[ots['Line'].astype(str).str.contains('Ped',case=False,na=False)].copy()
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
                status="Rejected excluded; rest mostly 'Pending' historical upload. No January rows.")

# =================== VISITS (union+dedupe, per month, per DM) ===================
vfiles=["phoenix-crm-visits-2026-07-29.xlsx"]+[f"phoenix-crm-visits-2026-07-29({i}).xlsx" for i in range(1,5)]
raw_rows=0; parts=[]
for f in vfiles:
    vv=pd.read_excel(os.path.join(DL,f),sheet_name="Visits",header=2).dropna(how="all"); raw_rows+=len(vv); parts.append(vv)
V=pd.concat(parts,ignore_index=True).drop_duplicates(subset=['CRM Visit ID'])
# Defensive: this export happens to be 100% Line=="Pedia" today (verified 2026-07-30),
# but filter explicitly rather than relying on that — every row already carries its
# own Line tag, matching the same direct-filter approach used for the CNS line.
if 'Line' in V.columns: V=V[V['Line'].astype(str).eq('Pedia')]
V['mon']=pd.to_datetime(V['Visit Date'],errors='coerce').dt.strftime('%b')
dv=pd.read_excel(os.path.join(DL,"phoenix-crm-double-visits-2026-07-29.xlsx"),sheet_name="Double Visits",header=2).dropna(how="all")
# rep -> DM via most-common double-visit manager
PED_DMS=['Ahmed Abdallah','Yehya Kamal','Nermeen Salah','Taha Mohamed','Ahmed Hekal']
pedia_norm={norm(x) for x in PED_DMS}
PMAP={norm(x):x for x in PED_DMS}
rep2dm={}
for aid,g in dv.groupby('Agent HR ID'):
    m=g['Double Name'].mode()
    if len(m) and norm(m.iat[0]) in pedia_norm:
        rep2dm[str(aid)]=PMAP.get(norm(m.iat[0]))
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
    if norm(mgr) in pedia_norm: dbl_by_dm[PMAP[norm(mgr)]]=dbl_by_dm.get(PMAP[norm(mgr)],0)+int(len(g))
for D_ in dms:
    mk=mkt_by_dm.get(D_['dm'],{}); ot=out_by_dm.get(D_['dm'],{}); vi=vis_by_dm.get(D_['dm'],{})
    D_['marketingCost']=mk.get('cost',0); D_['marketingMonths']=mk.get('months',0); D_['marketingByMonth']=mk.get('byMonth',{})
    D_['outstationCost']=ot.get('cost',0); D_['outstationMonths']=ot.get('months',0); D_['outstationByMonth']=ot.get('byMonth',{})
    D_['doubleVisits']=dbl_by_dm.get(D_['dm'],0)
    D_['visits']=vi.get('visits',0); D_['visitsAvgPerMonth']=vi.get('avgPerMonth',0); D_['visitsByMonth']=vi.get('byMonth',{})
    D_['customersTotal']=vi.get('customersTotal',0); D_['customersByMonth']=vi.get('customersByMonth',{})
dms.sort(key=lambda x: PED_DM_ORDER.index(x['dm']) if x['dm'] in PED_DM_ORDER else 99)

line.update(marketingCost=marketing['pediaCost'], outstationCost=outstation['pediaTotal'],
            visits=visits['totalDeduped'], doubleVisits=doubles['total'],
            visitsAvgPerRepPerMonth=visits['avgPerRepPerMonth'], reps=nrep,
            customersTotal=visits['customersTotal'], customersByMonth=visits['customersByMonth'])

dataset=dict(
    meta=dict(line="Pedia", period="S1 2026 (Jan–Jun)", currency="EGP", months=MO,
              generatedFrom=["S1-2026 Ped Line.xlsx","Req jan june s1.xlsx","outstation-expense-command","crm-visits x5","crm-double-visits"],
              thresholds=dict(repFailBelow=20, dsmFailBelow=50),
              rulings=dict(includeProducts=INCLUDE, exception="20,000 Ivyronc @14 = 280,000; excl rep/DM, incl line/NSM",
                           marketing="Approved by GM only (committed spend), 5 Pedia DMs", vacant="Cairo DSM resigned — territory vacant")),
    line=line, products=products, dms=dms, areas=areas,
    marketing=marketing, outstation=outstation, visits=visits, doubleVisits=doubles)
with open(os.path.join(OUT_DIR,"pedia-s1.json"),"w",encoding="utf-8") as f:
    json.dump(dataset,f,ensure_ascii=False,indent=1)

# =================== RECONCILIATION ===================
print("========= S1 PEDIA DATASET (v2) — RECONCILIATION =========")
print(f"LINE include {line['includeOnly']['sales']:,.0f}/{line['includeOnly']['target']:,.0f} = {line['includeOnly']['ach']}%")
print(f"     excl-vacant {line['exVacant']['includeOnly']['sales']:,.0f}/{line['exVacant']['includeOnly']['target']:,.0f} = {line['exVacant']['includeOnly']['ach']}%   (toggle ON)")
print(f"     all+exception {line['withException']['allProducts']['ach']}%")
print("PRODUCT x MONTH achievement (include ★):")
for p in products:
    if p['total']['target']==0 and p['total']['sales']==0: continue
    star='★' if p['include'] else ' '
    print(f"  {star}{p['product']:<20} "+" ".join(f"{m}:{(str(p['byMonth'][m]['ach'])+'%').rjust(7) if p['byMonth'][m]['ach'] is not None else '   —   '}" for m in MO)+f"  | TOT {p['total']['ach']}%")
print("DMs (vacant flagged):")
for D_ in dms:
    tag=' [VACANT]' if D_['vacant'] else ''
    print(f"  {D_['dm']:<28}{tag:9} ach {str(D_['includeOnly']['ach']):>7}%  mkt {D_.get('marketingCost',0):>8,.0f}({D_.get('marketingMonths',0)}mo)  exp {D_.get('outstationCost',0):>7,.0f}  vis/mo {D_.get('visitsAvgPerMonth',0):>5}  dbl {D_.get('doubleVisits',0)}")
print(f"VISITS {visits['totalDeduped']:,} | {visits['avgPerRepPerMonth']} /rep/mo | rep→DM {visits['repToDmCoverage']}%")
print(f"AREAS {len(areas)} | fails<20% {sum(1 for a in areas if a['hasTarget'] and a['includeOnly']['ach'] is not None and a['includeOnly']['ach']<20)} | ungradeable {sum(1 for a in areas if a['ungradeable'])} | vacant {sum(1 for a in areas if a['vacant'])}")
print("WROTE", os.path.join(OUT_DIR,"pedia-s1.json"))
