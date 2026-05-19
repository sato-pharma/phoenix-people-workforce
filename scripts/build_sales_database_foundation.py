from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import re

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKBOOK_DIR = REPO_ROOT / "sato 4-2026"
OUTPUT_PATH = WORKBOOK_DIR / "sales_database_foundation.xlsx"


@dataclass(frozen=True)
class SourceMap:
    distributor_group: str
    source_segment: str
    qty: int | None
    value: int | None
    product: int | None
    customer: int | None = None
    customer_source_code: int | None = None
    address: int | None = None
    date: int | None = None
    branch: int | None = None
    branch_source_code: int | None = None
    product_source_code: int | None = None
    area: int | None = None
    region: int | None = None
    brick: int | None = None
    territory: int | None = None


def mapping_for(path: Path) -> SourceMap:
    name = path.name.lower()
    original = path.name

    if name == "chimipharm 4.xlsx":
        return SourceMap("chimipharm", "regular", 1, 1, 4, area=0)
    if name == "egd 1002 branch.xlsx":
        return SourceMap("egd", "branch_transfer", 1, 9, 4, customer=7, customer_source_code=6, date=11, branch=8, branch_source_code=15, product_source_code=12, region=16)
    if name == "egd 4.xlsx":
        return SourceMap("egd", "regular", 1, 9, 4, customer=6, customer_source_code=5, address=7, date=12, branch=0, branch_source_code=31, product_source_code=13, region=33, area=35)
    if name == "epda 4.xlsx":
        return SourceMap("epda", "regular", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=12, branch=11, branch_source_code=10, product_source_code=13, area=0)
    if name == "ibnsina 4.xlsx":
        return SourceMap("ibnsina", "regular", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=11, branch=13, branch_source_code=12, product_source_code=16, region=18, area=19, brick=20)
    if name == "mec 4.xlsx":
        return SourceMap("mec", "regular", 1, 9, 10, customer=7, customer_source_code=6, address=8, date=27, branch=12, product_source_code=4, area=14, brick=0)
    if name == "overseas 4.xlsx":
        return SourceMap("overseas", "regular", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=19, branch=11, branch_source_code=10, product_source_code=21, area=15, region=16, territory=17, brick=0)
    if name == "ramco 4.xlsx":
        return SourceMap("ramco", "regular", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=26, branch=10, branch_source_code=11, product_source_code=14, area=0)
    if name == "sofico 4.xlsx":
        return SourceMap("sofico", "regular", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=30, branch=14, branch_source_code=13, product_source_code=15, region=25, area=27, brick=0)
    if name == "tender ibnsina 4.xlsx":
        return SourceMap("ibnsina", "tender", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=10, branch=12, branch_source_code=11, product_source_code=15, region=17, area=18, brick=19)
    if name == "tender overseas 4.xlsx":
        return SourceMap("overseas", "tender", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=17, branch=19, branch_source_code=18, product_source_code=14)
    if name == "tender ramco 4.xlsx":
        return SourceMap("ramco", "tender", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=28, branch=11, branch_source_code=10, product_source_code=16, area=13)
    if name == "tender sofico 4.xlsx":
        return SourceMap("sofico", "tender", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=30, branch=14, branch_source_code=13, product_source_code=15, region=25, area=27, brick=0)
    if "مركز" in original:
        return SourceMap("egd", "hospital_supply_center", 1, 9, 4, customer=7, customer_source_code=6, address=8, date=13, branch=33, branch_source_code=32, product_source_code=14, region=35, area=37)

    raise RuntimeError(f"No source mapping for {path.name}")


ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
DIACRITICS_RE = re.compile(r"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]")


def cell_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    return str(value).replace("\xa0", " ").strip()


def normalize_text(value: object) -> str:
    text = cell_text(value).translate(ARABIC_DIGITS).lower()
    text = DIACRITICS_RE.sub("", text)
    replacements = {
        "إ": "ا",
        "أ": "ا",
        "آ": "ا",
        "ٱ": "ا",
        "ى": "ي",
        "ئ": "ي",
        "ؤ": "و",
        "ة": "ه",
        "ـ": "",
        "ﻻ": "لا",
        "ﻷ": "لا",
        "ﻹ": "لا",
        "ﻵ": "لا",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = re.sub(r"(?<=\d)(?=[a-z\u0600-\u06ff])", " ", text)
    text = re.sub(r"(?<=[a-z\u0600-\u06ff])(?=\d)", " ", text)
    text = re.sub(r"[^0-9a-z\u0600-\u06ff%]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def compact_key(value: object) -> str:
    return normalize_text(value).replace(" ", "")


CUSTOMER_STOP_WORDS = {
    "صيدليه",
    "صيدلية",
    "pharmacy",
    "pharm",
    "dr",
    "doctor",
    "د",
    "دكتور",
    "دكتوره",
    "الدكتور",
    "م",
    "كاش",
    "cash",
    "نقدي",
    "نقدى",
    "نقدانقديه",
    "شركه",
    "شركة",
    "مؤسسه",
    "مؤسسة",
    "فرع",
    "branch",
}


def normalized_customer_key(raw_customer: object, address: object, fallback: object, source_label: str) -> tuple[str, str]:
    raw = normalize_text(raw_customer)
    if not raw:
        fallback_key = normalize_text(fallback) or normalize_text(address) or "unknown"
        return f"unspecified::{normalize_text(source_label)}::{fallback_key}", "Yes"

    tokens = [token for token in raw.split() if token not in CUSTOMER_STOP_WORDS]
    key = " ".join(tokens).strip()
    if not key:
        key = raw

    return key, "No"


AREA_ALIASES = [
    ("Sohag", "Upper Egypt", ["سوهاج", "sohag", "طما", "طهطا"]),
    ("Assiut", "Upper Egypt", ["اسيوط", "اسيو", "assiut", "asyut", "وسط الصعيد", "ديروط"]),
    ("Minya", "Upper Egypt", ["المنيا", "منيا", "minya", "menya", "el menya", "ملوي", "ملوى", "بني مزار", "بنى مزار", "beni mazar", "مطاي"]),
    ("Beni Suef", "Upper Egypt", ["بني سويف", "بنى سويف", "بنىسويف", "beni suef", "bani suef", "الفشن", "باروط"]),
    ("Fayoum", "Upper Egypt", ["الفيوم", "فيوم", "fayoum"]),
    ("Qena", "Upper Egypt", ["قنا", "qena"]),
    ("Luxor", "Upper Egypt", ["الاقصر", "اقصر", "luxor", "ارمنت"]),
    ("Aswan", "Upper Egypt", ["اسوان", "aswan"]),
    ("New Valley", "Upper Egypt", ["الوادي الجديد", "وادى جديد", "new valley", "الخارجه"]),
    ("Cairo", "Greater Cairo", ["القاهره", "القاهرة", "cairo", "nasr city", "مدينه نصر", "مدينة نصر", "النصر", "مصر الجديده", "مصر الجديدة", "الحجاز", "المعادي", "المعادى", "الحلميه", "الحلمية", "رمسيس", "helwan", "حلوان", "15th of may", "15 مايو", "وادي حوف", "وادى حوف", "جاردن سيتي", "المنيل", "شبرا مصر", "abbasia", "عباسيه", "العباسيه", "العباسية", "wayli", "الظاهر", "حدائق القبه", "حدائق القبة", "hadayek elkobbah", "kobbah", "مدينه السلام", "مدينة السلام", "ain shams", "عين شمس", "النزهه", "النزهة", "nozha", "elnozha", "الشروق", "shorouk", "روكسي", "روكسى", "مكرم عبيد", "الحى السابع", "الحي السابع", "الحى العاشر", "الحي العاشر", "التجمع الخامس", "التجمع الاول", "البساتين", "الزمالك", "الميرغني", "الميرغنى", "ارض الجولف", "الموسكي", "الموسكى", "العتبه", "العتبة", "عابدين", "دار السلام", "السيده زينب", "السيدة زينب", "طره البلد", "طرة البلد", "مساكن شيراتون", "sheraton"]),
    ("Giza", "Greater Cairo", ["الجيزه", "الجيزة", "giza", "اكتوبر", "6 اكتوبر", "الهرم", "فيصل", "الدقي", "الدقى", "المهندسين", "امبابه", "امبابة", "imbaba", "الوراق", "حدائق الاهرام", "الشيخ زايد", "ارض اللواء", "ard ellewaa", "العمرانيه", "العمرانية", "omrania", "بشتيل", "bashteel", "bashtel", "صفط اللبن", "كرداسه", "كرداسة", "kerdasa", "ناهيا", "كفر طهرمس", "اطفيح", "etfih"]),
    ("Qalyubia", "Greater Cairo", ["القليوبيه", "القليوبية", "قليوبيه", "قليوبية", "بنها", "شبرا الخيمه", "شبرا الخيمة", "qalyubia", "qalubia", "kalubia", "kaliub", "kalioub", "tookh", "طوخ", "قليوب", "ميت كنانه", "ميت كنانة", "shobra khemah", "shobra elkhemah", "الخصوص", "الخانكه", "الخانكة", "مدينة العبور", "مدينه العبور", "العبور"]),
    ("Alexandria", "Alex Coast", ["الاسكندريه", "الاسكندرية", "اسكندريه", "اسكندرية", "alexandria", "alex", "alx", "العصافره", "المعموره", "المعمورة", "العامريه", "العامرية", "ابيس", "لوران"]),
    ("Matrouh", "Alex Coast", ["مطروح", "matrouh"]),
    ("Sharqia", "Delta", ["الشرقيه", "الشرقية", "شرقيه", "شرقية", "الزقازيق", "زقازيق", "zagazig", "zag", "sharkia", "sharkeia", "fakous", "فاقوس", "بلبيس", "العاشر من رمضان", "ابو كبير", "الحسينيه", "الحسينية"]),
    ("Dakahlia", "Delta", ["الدقهليه", "الدقهلية", "دقهليه", "دقهلية", "المنصوره", "المنصورة", "mansoura", "dakahlia", "dakah", "meet ghamr", "ميت غمر", "اجا", "المنزله", "المنزلة", "المطريه", "المطرية", "الجماليه", "الجمالية", "طلخا", "بلقاس", "نبروه"]),
    ("Gharbia", "Delta", ["الغربيه", "الغربية", "غربيه", "غربية", "طنطا", "المحله", "المحلة", "سمنود", "tanta", "mahalla", "gharbia", "zefta", "زفتي", "زفتى", "elsanta", "السنطه", "السنطة", "katour", "قطور", "كفر الزيات", "كفرالزيات", "بسيون"]),
    ("Monofia", "Delta", ["المنوفيه", "المنوفية", "منوفيه", "منوفية", "شبين الكوم", "shebin", "menofia", "monofia", "monof", "menouf", "اشمون", "الباجور", "بركه السبع", "بركة السبع", "الشهداء", "قويسنا", "منوف", "تلا"]),
    ("Beheira", "Delta", ["البحيره", "البحيرة", "بحيره", "بحيرة", "دمنهور", "كفر الدوار", "ابو حمص", "beheira", "كوم حماده", "كوم حمادة", "kom hamada", "مديرية التحرير"]),
    ("Kafr El Sheikh", "Delta", ["كفر الشيخ", "kafr el sheikh", "دسوق"]),
    ("Damietta", "Delta", ["دمياط", "damietta", "domiat", "domyat", "عزبه البرج", "عزبة البرج", "كفر سعد", "الزرقا", "كفر البطيخ", "فارسكور"]),
    ("Suez", "Canal", ["السويس", "سويس", "suez"]),
    ("Ismailia", "Canal", ["الاسماعيليه", "الاسماعيلية", "اسماعيليه", "اسماعيلية", "ismailia"]),
    ("Port Said", "Canal", ["بورسعيد", "بور سعيد", "port said"]),
    ("North Sinai", "Canal", ["شمال سيناء", "العريش", "north sinai"]),
    ("South Sinai", "Canal", ["جنوب سيناء", "شرم الشيخ", "south sinai"]),
    ("Red Sea", "Canal", ["البحر الاحمر", "الغردقه", "الغردقة", "red sea"]),
]


def canonical_area(raw_area: object, raw_region: object, branch: object, address: object, customer: object) -> dict[str, str]:
    search_text = normalize_text(" ".join(cell_text(v) for v in [raw_area, raw_region, branch, address, customer] if cell_text(v)))

    for canonical_name, region_name, aliases in AREA_ALIASES:
        for alias in aliases:
            if normalize_text(alias) and normalize_text(alias) in search_text:
                return {
                    "area_key": canonical_name.upper().replace(" ", "_"),
                    "canonical_area_name": canonical_name,
                    "region_key": region_name.upper().replace(" ", "_"),
                    "canonical_region_name": region_name,
                    "needs_review": "No",
                }

    raw = normalize_text(raw_area) or normalize_text(raw_region) or normalize_text(branch) or normalize_text(address) or "unknown"
    readable = cell_text(raw_area) or cell_text(raw_region) or cell_text(branch) or "Unmapped Area"
    return {
        "area_key": f"RAW::{raw}",
        "canonical_area_name": readable,
        "region_key": "REVIEW",
        "canonical_region_name": "Review",
        "needs_review": "Yes",
    }


def first_mg(text: str) -> str:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:mg|m g|mgm|مجم|مليجرام)", text)
    if not match:
        return ""
    value = match.group(1)
    if "." in value:
        value = value.rstrip("0").rstrip(".")
    return f"{value}MG"


def pack_count(text: str) -> str:
    match = re.search(r"(\d+)\s*(?:tab|tabs|tablet|tablets|قرص|اقراص|قرصه|كبسوله|كبسولات)", text)
    return match.group(1) if match else ""


def volume_ml(text: str) -> str:
    match = re.search(r"(\d+)\s*(?:ml|m l|مل|مللي|ملي)", text)
    return f"{match.group(1)}ML" if match else ""


def has_any(text: str, aliases: list[str]) -> bool:
    return any(normalize_text(alias) in text for alias in aliases)


def has_token(text: str, aliases: list[str]) -> bool:
    for alias in aliases:
        token = normalize_text(alias)
        if token and re.search(rf"(^|\s){re.escape(token)}(\s|$)", text):
            return True
    return False


def parse_product(raw_product: object) -> dict[str, str]:
    original = cell_text(raw_product)
    text = normalize_text(original)
    pack = pack_count(text)
    volume = volume_ml(text)
    strength = first_mg(text)
    form = "TAB" if pack else ""
    review = "No"

    if has_any(text, ["tebofortin", "tebofrtin", "تيبوفورتين", "تيبو فورتين"]):
        family = "TEBOFORTIN"
        form = "DROPS" if has_any(text, ["نقط", "drops", "drop"]) else "TAB"
        if has_any(text, ["max"]):
            strength = "240MG"
        elif has_any(text, ["intens", "intense"]):
            strength = "120MG"
        elif has_token(text, ["forte", "fort", "فورت"]) and strength != "40MG":
            strength = "80MG"
        elif not strength and form == "DROPS":
            strength = "40MG"
        elif not strength:
            strength = "40MG"
        if not pack and form == "TAB":
            pack = "30"
    elif has_any(text, ["conviban", "كونفيبان"]):
        family = "CONVIBAN"
        form = "ORAL_SOLUTION" if volume else "TAB"
        if not pack and form == "TAB":
            pack = "30"
    elif has_any(text, ["rispadex", "رسبادكس", "ريسبادكس", "ريسباديكس", "رسباديكس"]):
        family = "RISPADEX"
        if has_any(text, ["syp", "syrup", "شراب"]) or volume:
            form = "SYP"
            if not volume:
                volume = "100ML"
            if not strength:
                strength = "1MG"
        else:
            form = "TAB"
        if not pack and form == "TAB":
            pack = "30"
    elif has_any(text, ["dopaminect", "دوبامينكت", "دوبامينيكت"]):
        family = "DOPAMINECT"
        form = "TAB"
        if not strength:
            strength = "1MG"
        if not pack:
            pack = "20"
    elif has_any(text, ["dolabactin", "دولاباكتين"]):
        family = "DOLABACTIN"
        form = "TAB"
        if not strength:
            strength = "400MG"
        if not pack:
            pack = "5"
    elif has_any(text, ["trencedia", "ترانسيديا", "ترينسيديا"]):
        family = "TRENCEDIA"
        form = "TAB"
        if not strength and "550" in text:
            strength = "550MG"
        if not strength and "200" in text:
            strength = "200MG"
        if not pack:
            pack = "30"
    elif has_any(text, ["vonopep", "فونوبيب"]):
        family = "VONOPEP"
        form = "TAB"
        if not pack:
            pack = "20"
    elif has_any(text, ["anoxicam", "انوكسيكام", "انوكسكام"]):
        family = "ANOXICAM"
        form = "TAB"
        if not strength:
            strength = "20MG"
        if not pack:
            pack = "20"
    elif has_any(text, ["fortrostep", "فورتروستيب"]):
        family = "FORTROSTEP"
        form = "TAB"
        if not strength:
            strength = "60MG"
    else:
        family = f"REVIEW_{compact_key(text)[:40] or 'UNKNOWN'}"
        if not form:
            form = "UNKNOWN_FORM"
        review = "Yes"

    strength_part = strength or "NO_STRENGTH"
    pack_part = f"{pack}TAB" if pack and form == "TAB" else (volume or "NO_PACK")
    product_key = "|".join([family, strength_part, form or "UNKNOWN_FORM", pack_part])
    label_parts = [family.replace("REVIEW_", "REVIEW "), strength if strength else "", form, pack_part if pack_part != "NO_PACK" else ""]
    canonical_name = " ".join(part for part in label_parts if part).strip()

    return {
        "product_key": product_key,
        "product_family": family,
        "strength": strength,
        "dosage_form": form,
        "pack_or_volume": pack_part,
        "canonical_product_name": canonical_name,
        "product_needs_review": review,
    }


def parse_product_variant(raw_product: object, source_segment: str, product_key: str) -> dict[str, str]:
    original = cell_text(raw_product)
    lower = original.lower().replace("\xa0", " ")
    text = normalize_text(original)

    is_tender = (
        source_segment in {"tender", "hospital_supply_center"}
        or bool(re.search(r"\btn\b", lower))
        or "(t)" in lower
        or "مناقصات" in text
    )
    is_old = "old price" in lower or "س ق" in text or "سعر قديم" in text
    is_new = "س ج" in text or "سعر جديد" in text or "new price" in lower
    discount_match = re.search(r"(\d+)\s*%", text)

    if is_tender and is_old:
        variant_class = "TENDER_OLD_PRICE"
    elif is_tender and is_new:
        variant_class = "TENDER_NEW_PRICE"
    elif is_tender:
        variant_class = "TENDER"
    elif is_old:
        variant_class = "OLD_PRICE"
    elif is_new:
        variant_class = "NEW_PRICE"
    elif discount_match:
        variant_class = f"DISCOUNT_{discount_match.group(1)}PCT"
    else:
        variant_class = "CURRENT_PRICE"

    return {
        "variant_key": f"{product_key}::{variant_class}",
        "variant_class": variant_class,
    }


def value_at(row: tuple[object, ...], index: int | None) -> object:
    if index is None or index >= len(row):
        return None
    return row[index]


def numeric_value(value: object) -> float | int | str | None:
    if value is None or isinstance(value, (int, float)):
        return value
    text = cell_text(value).replace(",", "")
    try:
        return float(text)
    except ValueError:
        return cell_text(value)


def source_files() -> list[Path]:
    files: list[Path] = []
    for path in sorted(WORKBOOK_DIR.glob("*.xlsx"), key=lambda item: item.name.lower()):
        lower = path.name.lower()
        if lower.startswith("~$"):
            continue
        if lower.startswith("sato_") or lower.startswith("sales_database"):
            continue
        if lower == "office 4.xlsx":
            continue
        files.append(path)
    return files


def make_code(prefix: str, index: int, width: int) -> str:
    return f"{prefix}{index:0{width}d}"


def add_unique(target: dict[str, set[str]], key: str, value: object) -> None:
    text = cell_text(value)
    if text:
        target[key].add(text)


def compact_join(values: set[str], limit: int = 20) -> str:
    ordered = sorted(values, key=lambda item: normalize_text(item))
    if len(ordered) <= limit:
        return " | ".join(ordered)
    return " | ".join(ordered[:limit]) + f" | ... (+{len(ordered) - limit} more)"


def build_records() -> tuple[list[dict[str, object]], list[dict[str, str]]]:
    files = source_files()
    distributor_rows: list[dict[str, str]] = []
    distributor_by_file: dict[str, dict[str, str]] = {}

    for index, path in enumerate(files, start=1):
        mapping = mapping_for(path)
        row = {
            "distributor_code": make_code("DST", index, 4),
            "source_distributor_name": path.stem,
            "source_file": path.name,
            "distributor_group": mapping.distributor_group,
            "source_segment": mapping.source_segment,
        }
        distributor_rows.append(row)
        distributor_by_file[path.name] = row

    records: list[dict[str, object]] = []
    for path in files:
        mapping = mapping_for(path)
        distributor = distributor_by_file[path.name]
        workbook = load_workbook(path, read_only=True, data_only=True)
        worksheet = workbook[workbook.sheetnames[0]]

        for excel_row, row in enumerate(worksheet.iter_rows(min_row=2, values_only=True), start=2):
            raw_product = value_at(row, mapping.product)
            raw_customer = value_at(row, mapping.customer)
            raw_address = value_at(row, mapping.address)
            raw_area = value_at(row, mapping.area)
            raw_region = value_at(row, mapping.region)
            raw_branch = value_at(row, mapping.branch)
            raw_brick = value_at(row, mapping.brick)
            raw_territory = value_at(row, mapping.territory)

            if not any(cell_text(value) for value in [raw_product, raw_customer, raw_area, raw_branch, value_at(row, mapping.qty), value_at(row, mapping.value)]):
                continue

            product = parse_product(raw_product)
            variant = parse_product_variant(raw_product, mapping.source_segment, product["product_key"])
            area = canonical_area(raw_area or raw_brick or raw_territory, raw_region, raw_branch, raw_address, raw_customer)
            customer_key, customer_needs_review = normalized_customer_key(raw_customer, raw_address, raw_area or raw_branch or raw_region, distributor["source_distributor_name"])

            branch_name = cell_text(raw_branch) or f"Unspecified Branch - {distributor['source_distributor_name']}"
            branch_key = f"{distributor['distributor_code']}::{normalize_text(branch_name) or 'unspecified'}"

            records.append(
                {
                    "row_lookup_key": f"{path.name}||{excel_row}",
                    "source_file": path.name,
                    "source_sheet": worksheet.title,
                    "source_row": excel_row,
                    "distributor_code": distributor["distributor_code"],
                    "source_distributor_name": distributor["source_distributor_name"],
                    "distributor_group": distributor["distributor_group"],
                    "source_segment": distributor["source_segment"],
                    "transaction_date": value_at(row, mapping.date),
                    "quantity": numeric_value(value_at(row, mapping.qty)),
                    "net_value": numeric_value(value_at(row, mapping.value)),
                    "raw_customer_source_code": value_at(row, mapping.customer_source_code),
                    "raw_product_source_code": value_at(row, mapping.product_source_code),
                    "raw_branch_source_code": value_at(row, mapping.branch_source_code),
                    "raw_customer_name": cell_text(raw_customer),
                    "raw_customer_address": cell_text(raw_address),
                    "raw_area_value": cell_text(raw_area),
                    "raw_region_value": cell_text(raw_region),
                    "raw_branch_name": branch_name,
                    "raw_product_name": cell_text(raw_product),
                    "normalized_raw_customer": normalize_text(raw_customer) or customer_key,
                    "normalized_raw_product": normalize_text(raw_product),
                    "customer_key": customer_key,
                    "customer_needs_review": customer_needs_review,
                    "area_key": area["area_key"],
                    "canonical_area_name": area["canonical_area_name"],
                    "region_key": area["region_key"],
                    "canonical_region_name": area["canonical_region_name"],
                    "area_needs_review": area["needs_review"],
                    "branch_key": branch_key,
                    **product,
                    **variant,
                }
            )

        workbook.close()

    return records, distributor_rows


def assign_codes(records: list[dict[str, object]]) -> dict[str, dict[str, str]]:
    customer_keys = sorted({str(record["customer_key"]) for record in records})
    area_keys = sorted({str(record["area_key"]) for record in records})
    region_keys = sorted({str(record["region_key"]) for record in records})
    branch_keys = sorted({str(record["branch_key"]) for record in records})
    product_keys = sorted({str(record["product_key"]) for record in records})
    variant_keys = sorted({str(record["variant_key"]) for record in records})

    code_maps = {
        "customer": {key: make_code("CUS", index, 6) for index, key in enumerate(customer_keys, start=1)},
        "area": {key: make_code("AREA", index, 5) for index, key in enumerate(area_keys, start=1)},
        "region": {key: make_code("REG", index, 4) for index, key in enumerate(region_keys, start=1)},
        "branch": {key: make_code("BR", index, 5) for index, key in enumerate(branch_keys, start=1)},
        "product": {key: make_code("PRD", index, 4) for index, key in enumerate(product_keys, start=1)},
        "variant": {key: make_code("VAR", index, 4) for index, key in enumerate(variant_keys, start=1)},
    }

    for record in records:
        record["customer_code"] = code_maps["customer"][str(record["customer_key"])]
        record["area_code"] = code_maps["area"][str(record["area_key"])]
        record["region_code"] = code_maps["region"][str(record["region_key"])]
        record["branch_code"] = code_maps["branch"][str(record["branch_key"])]
        record["product_code"] = code_maps["product"][str(record["product_key"])]
        record["product_variant_code"] = code_maps["variant"][str(record["variant_key"])]

    return code_maps


def build_master_rows(records: list[dict[str, object]], distributor_rows: list[dict[str, str]]) -> dict[str, list[dict[str, object]]]:
    distributor_by_code = {row["distributor_code"]: row for row in distributor_rows}

    customers: dict[str, dict[str, object]] = {}
    customer_raws: dict[str, set[str]] = defaultdict(set)
    customer_addresses: dict[str, set[str]] = defaultdict(set)
    customer_distributors: dict[str, set[str]] = defaultdict(set)

    areas: dict[str, dict[str, object]] = {}
    area_raws: dict[str, set[str]] = defaultdict(set)
    area_distributors: dict[str, set[str]] = defaultdict(set)

    regions: dict[str, dict[str, object]] = {}
    branches: dict[str, dict[str, object]] = {}
    branch_raws: dict[str, set[str]] = defaultdict(set)

    products: dict[str, dict[str, object]] = {}
    product_raws: dict[str, set[str]] = defaultdict(set)
    product_distributors: dict[str, set[str]] = defaultdict(set)

    variants: dict[str, dict[str, object]] = {}
    variant_raws: dict[str, set[str]] = defaultdict(set)
    variant_distributors: dict[str, set[str]] = defaultdict(set)

    for record in records:
        customer_code = str(record["customer_code"])
        customers.setdefault(
            customer_code,
            {
                "customer_code": customer_code,
                "customer_match_key": record["customer_key"],
                "canonical_customer_name": cell_text(record["raw_customer_name"]) or "Unspecified Customer",
                "needs_review": record["customer_needs_review"],
            },
        )
        add_unique(customer_raws, customer_code, record["raw_customer_name"])
        add_unique(customer_addresses, customer_code, record["raw_customer_address"])
        customer_distributors[customer_code].add(str(record["source_distributor_name"]))

        area_code = str(record["area_code"])
        areas.setdefault(
            area_code,
            {
                "area_code": area_code,
                "area_match_key": record["area_key"],
                "canonical_area_name": record["canonical_area_name"],
                "region_code": record["region_code"],
                "canonical_region_name": record["canonical_region_name"],
                "needs_review": record["area_needs_review"],
            },
        )
        for value in [record["raw_area_value"], record["raw_region_value"], record["raw_branch_name"], record["raw_customer_address"]]:
            add_unique(area_raws, area_code, value)
        area_distributors[area_code].add(str(record["source_distributor_name"]))

        region_code = str(record["region_code"])
        regions.setdefault(
            region_code,
            {
                "region_code": region_code,
                "region_match_key": record["region_key"],
                "canonical_region_name": record["canonical_region_name"],
            },
        )

        branch_code = str(record["branch_code"])
        branches.setdefault(
            branch_code,
            {
                "branch_code": branch_code,
                "branch_match_key": record["branch_key"],
                "distributor_code": record["distributor_code"],
                "source_distributor_name": distributor_by_code[str(record["distributor_code"])]["source_distributor_name"],
                "canonical_branch_name": record["raw_branch_name"],
                "raw_branch_source_code": record["raw_branch_source_code"],
                "area_code": record["area_code"],
                "region_code": record["region_code"],
            },
        )
        add_unique(branch_raws, branch_code, record["raw_branch_name"])

        product_code = str(record["product_code"])
        products.setdefault(
            product_code,
            {
                "product_code": product_code,
                "product_match_key": record["product_key"],
                "canonical_product_name": record["canonical_product_name"],
                "product_family": record["product_family"],
                "strength": record["strength"],
                "dosage_form": record["dosage_form"],
                "pack_or_volume": record["pack_or_volume"],
                "needs_review": record["product_needs_review"],
            },
        )
        add_unique(product_raws, product_code, record["raw_product_name"])
        product_distributors[product_code].add(str(record["source_distributor_name"]))

        variant_code = str(record["product_variant_code"])
        variants.setdefault(
            variant_code,
            {
                "product_variant_code": variant_code,
                "variant_match_key": record["variant_key"],
                "product_code": product_code,
                "canonical_product_name": record["canonical_product_name"],
                "variant_class": record["variant_class"],
                "needs_review": record["product_needs_review"],
            },
        )
        add_unique(variant_raws, variant_code, record["raw_product_name"])
        variant_distributors[variant_code].add(str(record["source_distributor_name"]))

    customer_rows = []
    for code, row in customers.items():
        row = dict(row)
        row["raw_customer_names"] = compact_join(customer_raws[code])
        row["raw_addresses"] = compact_join(customer_addresses[code])
        row["source_distributors"] = compact_join(customer_distributors[code])
        customer_rows.append(row)

    area_rows = []
    for code, row in areas.items():
        row = dict(row)
        row["raw_area_values"] = compact_join(area_raws[code])
        row["source_distributors"] = compact_join(area_distributors[code])
        area_rows.append(row)

    branch_rows = []
    for code, row in branches.items():
        row = dict(row)
        row["raw_branch_names"] = compact_join(branch_raws[code])
        branch_rows.append(row)

    product_rows = []
    for code, row in products.items():
        row = dict(row)
        row["raw_product_names"] = compact_join(product_raws[code])
        row["source_distributors"] = compact_join(product_distributors[code])
        product_rows.append(row)

    variant_rows = []
    for code, row in variants.items():
        row = dict(row)
        row["raw_product_names"] = compact_join(variant_raws[code])
        row["source_distributors"] = compact_join(variant_distributors[code])
        variant_rows.append(row)

    return {
        "customers": sorted(customer_rows, key=lambda row: row["customer_code"]),
        "areas": sorted(area_rows, key=lambda row: row["area_code"]),
        "regions": sorted(regions.values(), key=lambda row: row["region_code"]),
        "branches": sorted(branch_rows, key=lambda row: row["branch_code"]),
        "products": sorted(product_rows, key=lambda row: row["product_code"]),
        "variants": sorted(variant_rows, key=lambda row: row["product_variant_code"]),
    }


def write_rows(ws, headers: list[str], rows: list[dict[str, object]]) -> None:
    ws.append(headers)
    for row in rows:
        ws.append([row.get(header, "") for header in headers])
    style_sheet(ws)


def style_sheet(ws) -> None:
    header_fill = PatternFill("solid", fgColor="1F4E78")
    header_font = Font(color="FFFFFF", bold=True)
    for cell in ws[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    sample_max_row = min(ws.max_row, 200)
    for column_cells in ws.iter_cols(min_row=1, max_row=sample_max_row):
        column_letter = get_column_letter(column_cells[0].column)
        values = [cell_text(cell.value) for cell in column_cells]
        width = min(max([len(value) for value in values] + [10]) + 2, 45)
        ws.column_dimensions[column_letter].width = width


def build_matrix(records: list[dict[str, object]], row_code: str, row_name: str, raw_value: str, distributor_rows: list[dict[str, str]]) -> tuple[list[str], list[dict[str, object]]]:
    distributors = [row["source_distributor_name"] for row in distributor_rows]
    matrix: dict[str, dict[str, object]] = {}
    buckets: dict[tuple[str, str], set[str]] = defaultdict(set)

    for record in records:
        code = str(record[row_code])
        if code not in matrix:
            matrix[code] = {row_code: code, row_name: record.get(row_name, "")}
        raw = cell_text(record.get(raw_value))
        if raw:
            buckets[(code, str(record["source_distributor_name"]))].add(raw)

    rows: list[dict[str, object]] = []
    for code in sorted(matrix):
        row = dict(matrix[code])
        for distributor in distributors:
            row[distributor] = compact_join(buckets[(code, distributor)], limit=12)
        rows.append(row)

    return [row_code, row_name, *distributors], rows


def grouped_code_conflicts(records: list[dict[str, object]], key_field: str, code_field: str) -> int:
    grouped: dict[str, set[str]] = defaultdict(set)
    for record in records:
        grouped[str(record[key_field])].add(str(record[code_field]))
    return sum(1 for codes in grouped.values() if len(codes) > 1)


def blank_count(records: list[dict[str, object]], field: str) -> int:
    return sum(1 for record in records if not cell_text(record.get(field)))


def specific_product_checks(records: list[dict[str, object]]) -> list[dict[str, object]]:
    def family_records(family: str, **filters: str) -> list[dict[str, object]]:
        matches = [record for record in records if record["product_family"] == family]
        for key, expected in filters.items():
            matches = [record for record in matches if record.get(key) == expected]
        return matches

    checks: list[dict[str, object]] = []

    teb_40 = {record["product_code"] for record in family_records("TEBOFORTIN", strength="40MG", dosage_form="TAB")}
    teb_80 = {record["product_code"] for record in family_records("TEBOFORTIN", strength="80MG", dosage_form="TAB")}
    checks.append({"check": "TEBOFORTIN 40MG and FORTE 80MG have different product codes", "result": "PASS" if teb_40 and teb_80 and teb_40.isdisjoint(teb_80) else "FAIL"})

    risp_current = {record["product_variant_code"] for record in family_records("RISPADEX", dosage_form="SYP", variant_class="CURRENT_PRICE")}
    risp_old = {record["product_variant_code"] for record in family_records("RISPADEX", dosage_form="SYP", variant_class="OLD_PRICE")}
    risp_products = {record["product_code"] for record in family_records("RISPADEX", dosage_form="SYP")}
    checks.append({"check": "RISPADEX 100ML syrup current and old price are separate variants under one product", "result": "PASS" if risp_current and risp_old and len(risp_products) == 1 and risp_current.isdisjoint(risp_old) else "FAIL"})

    vono_10 = {record["product_code"] for record in family_records("VONOPEP", strength="10MG")}
    vono_20 = {record["product_code"] for record in family_records("VONOPEP", strength="20MG")}
    checks.append({"check": "VONOPEP 10MG and 20MG have different product codes", "result": "PASS" if vono_10 and vono_20 and vono_10.isdisjoint(vono_20) else "NOT_FOUND" if not (vono_10 or vono_20) else "FAIL"})

    return checks


def quality_rows(records: list[dict[str, object]], distributor_rows: list[dict[str, str]], masters: dict[str, list[dict[str, object]]]) -> list[dict[str, object]]:
    quality = [
        {"check": "source_workbooks_processed", "result": len(distributor_rows)},
        {"check": "distributor_columns_available", "result": len(distributor_rows)},
        {"check": "office_workbook_excluded", "result": "PASS" if all(row["source_file"].lower() != "office 4.xlsx" for row in distributor_rows) else "FAIL"},
        {"check": "sales_fact_rows", "result": len(records)},
        {"check": "unique_row_lookup_keys", "result": len({record["row_lookup_key"] for record in records})},
        {"check": "blank_distributor_codes", "result": blank_count(records, "distributor_code")},
        {"check": "blank_customer_codes", "result": blank_count(records, "customer_code")},
        {"check": "blank_area_codes", "result": blank_count(records, "area_code")},
        {"check": "blank_region_codes", "result": blank_count(records, "region_code")},
        {"check": "blank_branch_codes", "result": blank_count(records, "branch_code")},
        {"check": "blank_product_codes", "result": blank_count(records, "product_code")},
        {"check": "blank_product_variant_codes", "result": blank_count(records, "product_variant_code")},
        {"check": "customer_match_key_conflicts", "result": grouped_code_conflicts(records, "customer_key", "customer_code")},
        {"check": "area_match_key_conflicts", "result": grouped_code_conflicts(records, "area_key", "area_code")},
        {"check": "product_match_key_conflicts", "result": grouped_code_conflicts(records, "product_key", "product_code")},
        {"check": "variant_match_key_conflicts", "result": grouped_code_conflicts(records, "variant_key", "product_variant_code")},
        {"check": "normalized_raw_product_code_conflicts", "result": grouped_code_conflicts(records, "normalized_raw_product", "product_code")},
        {"check": "normalized_raw_customer_code_conflicts", "result": grouped_code_conflicts(records, "normalized_raw_customer", "customer_code")},
        {"check": "customer_count", "result": len(masters["customers"])},
        {"check": "area_count", "result": len(masters["areas"])},
        {"check": "region_count", "result": len(masters["regions"])},
        {"check": "branch_count", "result": len(masters["branches"])},
        {"check": "product_count", "result": len(masters["products"])},
        {"check": "product_variant_count", "result": len(masters["variants"])},
        {"check": "product_rows_needing_review", "result": sum(1 for record in records if record["product_needs_review"] == "Yes")},
        {"check": "area_rows_needing_review", "result": sum(1 for record in records if record["area_needs_review"] == "Yes")},
        {"check": "customer_rows_needing_review", "result": sum(1 for record in records if record["customer_needs_review"] == "Yes")},
    ]
    quality.extend(specific_product_checks(records))
    return quality


def create_workbook(records: list[dict[str, object]], distributor_rows: list[dict[str, str]], masters: dict[str, list[dict[str, object]]]) -> None:
    workbook = Workbook()
    workbook.remove(workbook.active)

    readme = workbook.create_sheet("README")
    readme_rows = [
        {"field": "Purpose", "value": "Database foundation for April 2026 distributor sales. Every source row receives internal codes for distributor, customer, area, region, branch, product, and product variant."},
        {"field": "Lookup key", "value": "row_lookup_key = source_file || source Excel row number. Example: egd 4.xlsx||2. Use this for zero-error row-level VLOOKUP/XLOOKUP from source workbooks."},
        {"field": "Product logic", "value": "product_code identifies the physical product/SKU. product_variant_code separates tender/current/new price/old price/discount variants."},
        {"field": "Strength rule", "value": "Strengths are part of product_code, so 40MG, 80MG, 10MG, and 20MG products cannot be merged."},
        {"field": "Distributor headers", "value": "Matrix sheets use all 14 included source workbooks as distributor/source columns. office 4.xlsx is excluded."},
    ]
    write_rows(readme, ["field", "value"], readme_rows)

    sales_headers = [
        "row_lookup_key",
        "source_file",
        "source_sheet",
        "source_row",
        "distributor_code",
        "source_distributor_name",
        "distributor_group",
        "source_segment",
        "transaction_date",
        "customer_code",
        "area_code",
        "region_code",
        "branch_code",
        "product_code",
        "product_variant_code",
        "quantity",
        "net_value",
        "raw_customer_source_code",
        "raw_product_source_code",
        "raw_branch_source_code",
        "raw_customer_name",
        "raw_customer_address",
        "raw_area_value",
        "raw_region_value",
        "raw_branch_name",
        "raw_product_name",
    ]
    write_rows(workbook.create_sheet("Sales_Fact"), sales_headers, records)

    write_rows(workbook.create_sheet("Distributor_Master"), ["distributor_code", "source_distributor_name", "source_file", "distributor_group", "source_segment"], distributor_rows)
    write_rows(workbook.create_sheet("Customer_Master"), ["customer_code", "canonical_customer_name", "customer_match_key", "source_distributors", "raw_customer_names", "raw_addresses", "needs_review"], masters["customers"])
    write_rows(workbook.create_sheet("Area_Master"), ["area_code", "canonical_area_name", "area_match_key", "region_code", "canonical_region_name", "source_distributors", "raw_area_values", "needs_review"], masters["areas"])
    write_rows(workbook.create_sheet("Region_Master"), ["region_code", "canonical_region_name", "region_match_key"], masters["regions"])
    write_rows(workbook.create_sheet("Branch_Master"), ["branch_code", "canonical_branch_name", "branch_match_key", "distributor_code", "source_distributor_name", "raw_branch_source_code", "area_code", "region_code", "raw_branch_names"], masters["branches"])
    write_rows(workbook.create_sheet("Product_Master"), ["product_code", "canonical_product_name", "product_match_key", "product_family", "strength", "dosage_form", "pack_or_volume", "source_distributors", "raw_product_names", "needs_review"], masters["products"])
    write_rows(workbook.create_sheet("Product_Variant_Master"), ["product_variant_code", "product_code", "canonical_product_name", "variant_class", "variant_match_key", "source_distributors", "raw_product_names", "needs_review"], masters["variants"])

    lookup_headers = ["row_lookup_key", "source_file", "source_row", "source_distributor_name"]
    write_rows(workbook.create_sheet("Customer_Raw_Lookup"), lookup_headers + ["raw_customer_name", "raw_customer_address", "normalized_raw_customer", "customer_code", "area_code", "region_code", "branch_code"], records)
    write_rows(workbook.create_sheet("Area_Raw_Lookup"), lookup_headers + ["raw_area_value", "raw_region_value", "raw_customer_address", "canonical_area_name", "area_code", "region_code"], records)
    write_rows(workbook.create_sheet("Branch_Raw_Lookup"), lookup_headers + ["raw_branch_name", "raw_branch_source_code", "branch_code", "area_code", "region_code"], records)
    write_rows(workbook.create_sheet("Product_Raw_Lookup"), lookup_headers + ["raw_product_name", "normalized_raw_product", "product_code", "product_variant_code", "variant_class"], records)

    headers, rows = build_matrix(records, "product_variant_code", "canonical_product_name", "raw_product_name", distributor_rows)
    write_rows(workbook.create_sheet("Product_Variant_Matrix"), headers, rows)
    headers, rows = build_matrix(records, "customer_code", "raw_customer_name", "raw_customer_name", distributor_rows)
    write_rows(workbook.create_sheet("Customer_Matrix"), headers, rows)
    headers, rows = build_matrix(records, "area_code", "canonical_area_name", "raw_area_value", distributor_rows)
    write_rows(workbook.create_sheet("Area_Matrix"), headers, rows)

    write_rows(workbook.create_sheet("Quality_Checks"), ["check", "result"], quality_rows(records, distributor_rows, masters))

    workbook.save(OUTPUT_PATH)


def main() -> None:
    records, distributor_rows = build_records()
    assign_codes(records)
    masters = build_master_rows(records, distributor_rows)
    create_workbook(records, distributor_rows, masters)
    print(f"Wrote {OUTPUT_PATH}")
    print(f"Source workbooks: {len(distributor_rows)}")
    print(f"Sales fact rows: {len(records)}")


if __name__ == "__main__":
    main()
