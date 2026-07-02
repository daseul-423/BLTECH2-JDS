# 업체정보/OEM정보 엑셀 → db.json masters.companies 로 병합 정리.
#   실행: py scripts/import-companies.py
#   - OEM정보(인박스/아웃박스/파우치·라벨 → NEAL/무지/전용) + 업체정보(나라/컬러/수지/기재/토너/특이사항) 병합
#   - specType: 포장이 모두 NEAL이면 NEAL, 아니면 OEM
#   - masters.customers/customerTypes 동기화
import pandas as pd, json, re, os

XL = r"C:\Users\lg\Downloads\업체정보 및 OEM정보.xlsx"
DB = os.path.join(os.getcwd(), "test1", "data", "db.json")

def clean(v):
    if v is None or (isinstance(v, float) and pd.isna(v)): return None
    s = re.sub(r"\s+", " ", str(v).replace("\n", " ")).strip()
    return s or None

def norm_keys(name):
    # 괄호 안 영문명까지 각각 키로 (벨써지컬 / BELL SUGICAL 처럼 시트별 표기 차이 병합용)
    s = str(name).replace("\n", " ").strip().lower()
    chunks = [re.sub(r"\s+", "", ch) for ch in re.split(r"[()]", s)]
    return [c for c in chunks if c and len(c) >= 2]

keymap = {}  # normalized key -> company dict
def get_company(name):
    disp = clean(name)
    ks = norm_keys(name)
    comp = None
    for k in ks:
        if k in keymap: comp = keymap[k]; break
    if comp is None: comp = {"name": disp}
    for k in ks: keymap[k] = comp
    return comp

xl = pd.ExcelFile(XL)
oem = xl.parse("OEM정보", header=None).where(lambda d: pd.notnull(d), None)
biz = xl.parse("업체정보", header=None).where(lambda d: pd.notnull(d), None)

# OEM정보: [업체이름, 나라, 인박스, 아웃박스, 파우치/라벨]
for i in range(1, len(oem)):
    name = clean(oem.iloc[i, 0])
    if not name: continue
    c = get_company(oem.iloc[i, 0])
    if not c.get("country"): c["country"] = clean(oem.iloc[i, 1])
    c["packInBox"] = clean(oem.iloc[i, 2])
    c["packOutBox"] = clean(oem.iloc[i, 3])
    c["packLabel"] = clean(oem.iloc[i, 4])
    vals = [c["packInBox"], c["packOutBox"], c["packLabel"]]
    present = [v for v in vals if v]
    # 포장정보가 하나라도 NEAL이 아니면 OEM, 모두 NEAL이거나 정보없음이면 NEAL
    c["specType"] = "OEM" if (present and not all(v.strip().upper() == "NEAL" for v in present)) else "NEAL"

# 업체정보: 타이틀(0)·헤더(1) 이후. [나라, 업체명, 컬러, 수지, 기재/길이, 토너, 특이사항, 등록일]
last_country = None
for i in range(2, len(biz)):
    nm = clean(biz.iloc[i, 1])
    if not nm: continue
    ctry = clean(biz.iloc[i, 0])
    if ctry: last_country = ctry
    c = get_company(biz.iloc[i, 1])
    if not c.get("country"): c["country"] = ctry or last_country
    c["colors"] = clean(biz.iloc[i, 2])
    c["resin"] = clean(biz.iloc[i, 3])
    c["baseLength"] = clean(biz.iloc[i, 4])
    c["toner"] = clean(biz.iloc[i, 5])
    c["notes"] = clean(biz.iloc[i, 6])
    c.setdefault("specType", "NEAL")

seen_ids = {}
for c in keymap.values(): seen_ids[id(c)] = c
companies = sorted(seen_ids.values(), key=lambda c: c.get("name") or "")
for idx, c in enumerate(companies, 1):
    c["id"] = idx
    for f in ["country", "colors", "resin", "baseLength", "toner", "notes", "packInBox", "packOutBox", "packLabel"]:
        c.setdefault(f, None)
    c.setdefault("specType", "NEAL")

# db.json 반영 — companies는 참조용 별도 보관.
# 고객사 드롭다운/타입(customers/customerTypes)은 custspecs 기준으로 깔끔하게 재계산(반복 실행에도 오염 없음).
db = json.load(open(DB, encoding="utf-8"))
db.setdefault("masters", {})
db["masters"]["companies"] = companies

core = set(x.get("customer") for x in db.get("custspecs", []) if x.get("customer"))
core |= {"OSSUR", "SIGMAX", "내수", "하치코"}
db["masters"]["customers"] = sorted(core)
db["masters"]["customerTypes"] = {x["customer"]: "OEM" for x in db.get("custspecs", [])
                                  if x.get("customer") and x.get("specType") == "OEM"}

json.dump(db, open(DB, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
oem_n = sum(1 for c in companies if c["specType"] == "OEM")
print(f"companies={len(companies)} (OEM={oem_n}, NEAL={len(companies)-oem_n})")
print("customers(정리):", db["masters"]["customers"])
print("customerTypes:", db["masters"]["customerTypes"])
