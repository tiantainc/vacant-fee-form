#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解析《恒泰公司项目2026年空置房费用-投资公司》Excel，生成填报工具所需 config.json。

输出结构：
{
  "meta": { "title": "...", "year": 2026, "estimateMonths": [10,11,12], "actualMonths": [1..9] },
  "projects": [
     {
       "id": 1, "name": "湿地公园TOD一期", "company": "...", "note": "...",
       "totalHouseholds": 922, "unsoldHouseholds": 102,
       "fees": {
          "物业费": [ { "sub":"住宅", "type":"住宅", "price":"5元/㎡",
                        "monthly":[12个数值, 1-9为实际, 10-12为预估],
                        "estimate":[10,11,12月预估值] } ],
          "公维金": [...],
          "公摊水电": [ {... "price25": 25年值(可选)} ]
       }
     }
  ]
}
月份列在三个明细表中恒为 H(8)..S(19)：1月..12月。
1-9月 = 列 8..16（实际），10-12月 = 列 17..19（预估）。
"""
import openpyxl, json, os

SRC = r"E:/1.安品部/7.财务管理/26年收缴率/空置房费用/恒泰公司项目2026年空置房费用-投资公司(1102).xlsx"
OUT = os.path.join(os.path.dirname(__file__), "data", "config.json")

wb = openpyxl.load_workbook(SRC, data_only=True)

def num(v):
    """把单元格值安全转为数值；公式字面量 =123 也兼容。"""
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return round(float(v), 4)
    s = str(v).strip()
    if s.startswith("="):
        s = s[1:].strip()
    try:
        return round(float(s), 4)
    except ValueError:
        return 0

# ---------- 1) 汇总表：项目元信息 ----------
ws_sum = wb["汇总表"]
projects_meta = []
for r in range(3, 9):  # 行3-8 = 6个项目
    name = ws_sum.cell(r, 2).value
    if name is None or not str(name).strip():
        continue
    projects_meta.append({
        "id": int(ws_sum.cell(r, 1).value),
        "name": str(name).strip(),
        "totalHouseholds": num(ws_sum.cell(r, 3).value),
        "unsoldHouseholds": num(ws_sum.cell(r, 4).value),
        "company": ws_sum.cell(r, 13).value,
        "note": ws_sum.cell(r, 12).value or "",
    })

PROJECT_NAMES = [p["name"] for p in projects_meta]

def match_project(line_name):
    """根据业态明细行名称前缀匹配所属大项目。"""
    s = str(line_name).strip()
    for n in PROJECT_NAMES:
        if s.startswith(n):
            return n
    return None

# ---------- 2) 明细表解析 ----------
def parse_fee_sheet(sheet_name, has_price25=False):
    """返回 { project_name: [line, ...] }。"""
    ws = wb[sheet_name]
    result = {n: [] for n in PROJECT_NAMES}
    r = 3
    maxr = ws.max_row
    while r <= maxr:
        a = ws.cell(r, 1).value
        # 明细行：A 为数字且不是 '小计：'/'合计：'
        if isinstance(a, (int, float)) and not str(ws.cell(r, 2).value).startswith("小计") \
           and not str(ws.cell(r, 2).value).startswith("合计"):
            line_name = ws.cell(r, 2).value
            proj = match_project(line_name)
            if proj is None:
                r += 1
                continue
            # 业态 / 单价 / 25年
            if has_price25:
                ftype = ws.cell(r, 6).value      # F=业态
                price = None
                price25 = ws.cell(r, 7).value    # G=25年
            else:
                price = ws.cell(r, 6).value      # F=单价
                ftype = ws.cell(r, 7).value      # G=业态
                price25 = None
            monthly = []
            for c in range(8, 20):  # H..S = 1月..12月
                monthly.append(num(ws.cell(r, c).value))
            estimate = monthly[9:12]  # 10,11,12月（索引9,10,11）
            line = {
                "sub": str(line_name).replace(proj, "").strip() or str(line_name),
                "type": str(ftype).strip() if ftype else "",
                "price": str(price).strip() if price else "",
                "monthly": monthly,
                "estimate": estimate,
            }
            if has_price25 and price25 is not None:
                line["price25"] = price25
            result[proj].append(line)
            r += 1
        else:
            r += 1
    return result

fee_wy = parse_fee_sheet("物业费", has_price25=False)
fee_gw = parse_fee_sheet("公维金", has_price25=False)
fee_sd = parse_fee_sheet("公摊水电", has_price25=True)

config = {
    "meta": {
        "title": "2026年度空置费用汇总表（投资公司）",
        "year": 2026,
        "actualMonths": list(range(1, 10)),   # 1-9月（实际/初始展示）
        "estimateMonths": [10, 11, 12],        # 10-12月（预估/在线填写）
        "feeTypes": ["物业费", "公维金", "公摊水电"],
        "generatedFrom": os.path.basename(SRC),
    },
    "projects": [],
}

for p in projects_meta:
    nm = p["name"]
    config["projects"].append({
        "id": p["id"],
        "name": nm,
        "company": p["company"],
        "note": p["note"],
        "totalHouseholds": p["totalHouseholds"],
        "unsoldHouseholds": p["unsoldHouseholds"],
        "fees": {
            "物业费": fee_wy.get(nm, []),
            "公维金": fee_gw.get(nm, []),
            "公摊水电": fee_sd.get(nm, []),
        },
    })

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(config, f, ensure_ascii=False, indent=2)

# 简要校验输出
print("输出文件:", OUT)
print("项目数:", len(config["projects"]))
for p in config["projects"]:
    print(f"  - {p['name']} | 总户={p['totalHouseholds']} 未售={p['unsoldHouseholds']} 公司={p['company']}")
    for ft, lines in p["fees"].items():
        nlines = len(lines)
        # 校验 公维金 南部新城应为空
        print(f"      {ft}: {nlines} 条明细")
print("OK")
