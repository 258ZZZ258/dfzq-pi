from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


DOMAINS = [
    ("internal-control", "内控机制建设"),
    ("customer-identification", "客户身份识别"),
    ("risk-classification", "客户风险分类管理"),
    ("large-suspicious-transactions", "大额及可疑交易分析报告"),
    ("record-retention", "客户身份资料和交易记录保存"),
    ("training-publicity", "培训与宣传"),
]
METRIC_CODES = {
    "考核收入": ("assessment_revenue", "financial", True),
    "其中：代理买卖证券业务净收入": ("brokerage_net_revenue", "financial", True),
    "客户保证金利息净收入": ("deposit_interest_net_revenue", "financial", False),
    "产品相关收入": ("product_revenue", "financial", True),
    "考核利润": ("assessment_profit", "financial", True),
    "客户资产规模（万元）": ("client_assets", "performance", True),
    "股基交易量（万元）": ("stock_fund_volume", "performance", True),
    "日均产品保有规模（万元）": ("daily_product_holdings", "performance", True),
    "融资融券日均规模（万元）": ("margin_financing_balance", "performance", True),
}
SOURCE_CATALOG = [
    ("DS-01", "审计系统-审计项目", "ready", "primary", "audit-project|audit-period|previous-audit-project|workflow-status", "audit-project|audit-period|previous-audit-project|workflow-status"),
    ("DS-02", "审计系统-营业部基础库", "ready", "primary", "organization-id|organization-name|organization-address|organization-history|lease-area", "organization-id|organization-name|organization-address|organization-history|lease-area"),
    ("DS-03", "审计系统-审计发现及整改", "ready", "primary", "finding-id|finding-detail|finding-category|finding-severity|finding-count-semantics|previous-current-finding-comparison|rectification-status", "finding-id|finding-detail|finding-category|finding-severity|finding-count-semantics|previous-current-finding-comparison|rectification-status"),
    ("DS-04", "经营数据Excel", "ready", "primary", "operating-amounts|operating-ranks|ranking-participant-count|metric-aliases", "operating-amounts|operating-ranks|ranking-participant-count|metric-aliases"),
    ("DS-05", "OA任免发文", "ready", "primary", "appointment-records|document-number|issuer", "appointment-records|document-number|issuer"),
    ("DS-06", "人力资源系统", "ready", "primary", "employee-snapshot|broker-snapshot", "employee-snapshot|broker-snapshot"),
    ("DS-07", "反洗钱管理系统", "ready", "primary", "aml-domain-coverage|suspicious-transactions|risk-review-overdue|regulatory-letter-entry|training-materials", "aml-domain-coverage|suspicious-transactions|risk-review-overdue|regulatory-letter-entry|training-materials"),
    ("DS-08", "合规及人工确认", "ready", "supporting", "accountability|complaints|lawsuits|regulatory-events|clean-practice", "accountability|complaints|lawsuits|regulatory-events|clean-practice"),
    ("DS-09", "绩效考核系统", "ready", "primary", "performance-ratings", "performance-ratings"),
    ("DS-10", "审计叙述事实库", "ready", "supporting", "generation-rules", "generation-rules"),
    ("DS-11", "模板与数据源目录", "ready", "primary", "template-version|template-slots|generation-rules", "template-version|template-slots|generation-rules"),
]
SIMULATED_MASTER_DATA_OVERRIDES = {
    "C01-TUR-REPLAY": {
        "address": "上海市宝山区淞良路525号",
        "areaSquareMeters": 620.0,
        "employeeCount": 16,
        "brokerCount": 3,
        "historyStatement": "营业部机构沿革信息已由模拟审计系统营业部基础库核验。",
        "dataOrigin": "synthetic-system-simulation",
        "sourceNote": "原人工报告未提供完整机构及人员快照，本记录为端到端测试补充的模拟主数据。",
    },
    "C08-TUR-REPLAY": {
        "address": "上海市闵行区苏虹路333号",
        "areaSquareMeters": 580.0,
        "employeeCount": 18,
        "brokerCount": 4,
        "historyStatement": "营业部机构沿革信息已由模拟审计系统营业部基础库核验。",
        "dataOrigin": "synthetic-system-simulation",
        "sourceNote": "原人工报告未提供完整机构及人员快照，本记录为端到端测试补充的模拟主数据。",
    },
}


def normalize(value: str) -> str:
    return re.sub(r"\s+", "", value)


def paragraphs(item: dict[str, Any]) -> list[str]:
    return [block["text"].strip() for block in item["blocks"] if block["kind"] == "paragraph"]


def first_match(pattern: str, text: str, default: str = "") -> str:
    match = re.search(pattern, text, re.S)
    return match.group(1) if match else default


def iso_month(year: str, month: str, end: bool = False) -> str:
    day = "28" if end else "01"
    return f"{int(year):04d}-{int(month):02d}-{day}"


def number(value: Any) -> float | None:
    text = str(value).strip().replace(",", "").replace("，", "")
    if not text or text in {"-", "—", "无", "不适用"}:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(match.group()) if match else None


def period_header(value: str) -> str:
    return re.sub(r"(?:完成数|排名|数)+$", "", normalize(value))


def derive_identity(item: dict[str, Any], index: int) -> dict[str, str]:
    name = item["fileName"]
    org = first_match(r"(.+?证券营业部)", name)
    person = first_match(r"(?:总经理|负责人)(.+?)同志", name)
    prefix = f"C{index + 1:02d}"
    type_suffix = {"regular": "REG", "aml": "AML", "turnover": "TUR"}[item["reportType"]]
    return {
        "caseId": f"{prefix}-{type_suffix}-REPLAY",
        "taskId": f"TASK-{prefix}-{type_suffix}",
        "projectId": f"PRJ-{prefix}-{type_suffix}",
        "organizationId": f"ORG-{prefix}-{type_suffix}",
        "organizationCode": f"{prefix}{type_suffix}",
        "organizationName": org,
        "personId": f"P-{prefix}-{normalize(person).upper()}" if person else "",
        "personName": person,
    }


def parse_period(text: str) -> tuple[str, str]:
    match = re.search(r"自?(\d{4})年(\d{1,2})月至(\d{4})年(\d{1,2})月期间", text)
    if not match:
        return "2023-01-01", "2025-12-28"
    return iso_month(match.group(1), match.group(2)), iso_month(match.group(3), match.group(4), True)


def parse_report_date(values: list[str], audit_end: str) -> str:
    for value in reversed(values):
        match = re.fullmatch(r"(\d{4})年(\d{1,2})月(\d{1,2})日", normalize(value))
        if match:
            return f"{int(match.group(1)):04d}年{int(match.group(2))}月{int(match.group(3))}日"
    return audit_end.replace("-", "年", 1).replace("-", "月", 1) + "日"


def parse_overview(values: list[str], organization: str, audit_end: str) -> dict[str, Any]:
    overview = next((value for value in values if organization in value and "位于" in value), "")
    address = first_match(r"位于(.+?)(?:，|,)(?:营业面积|经营场所)", overview, "机构主数据接口模拟地址")
    area = number(first_match(r"营业面积([\d,.]+)平方米", overview, "0")) or 0
    employee = number(first_match(r"共有(?:正式)?员工(\d+)名", overview, "0")) or 0
    broker = number(first_match(r"证券经纪人(\d+)名", overview, "0")) or 0
    history = ""
    if "由原" in overview or "迁" in overview or "前身" in overview:
        history = overview
    return {
        "address": address,
        "areaSquareMeters": area,
        "employeeCount": int(employee),
        "brokerCount": int(broker),
        "asOf": audit_end,
        "historyStatement": history,
    }


def parse_tables(item: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    tables = [block["rows"] for block in item["blocks"] if block["kind"] == "table"]
    if len(tables) < 2:
        return [], {}
    amount_tables = tables[:2]
    rank_table = tables[2] if len(tables) > 2 else []
    rank_map: dict[tuple[str, str], int] = {}
    if rank_table:
        headers = rank_table[0]
        for row in rank_table[1:]:
            if not row:
                continue
            label = row[0]
            for column, raw in enumerate(row[1:], 1):
                value = number(raw)
                if value is not None and column < len(headers):
                    rank_map[(label, period_header(headers[column]))] = int(value)
    metrics = []
    for table_index, table in enumerate(amount_tables):
        if not table:
            continue
        headers = table[0]
        for row in table[1:]:
            if not row:
                continue
            label = row[0]
            code, table_type, include_rank = METRIC_CODES.get(
                label,
                (f"metric_{len(metrics) + 1}", "financial" if table_index == 0 else "performance", True),
            )
            points = []
            for column, raw in enumerate(row[1:], 1):
                value = number(raw)
                if value is None or column >= len(headers):
                    continue
                period = period_header(headers[column])
                points.append(
                    {
                        "period": period,
                        "value": value,
                        "rank": rank_map.get((label, period)),
                    }
                )
            if points:
                metrics.append(
                    {
                        "metricCode": code,
                        "sourceMetricName": label,
                        "reportLabel": label,
                        "table": table_type,
                        "unit": "万元",
                        "includeInRanking": include_rank,
                        "points": points,
                    }
                )
    all_text = "\n".join(paragraphs(item))
    participants: dict[str, int] = {}
    participant_line = next((value for value in paragraphs(item) if "参与排名" in value and "分别为" in value), "")
    participant_values = [int(value) for value in re.findall(r"\d+", participant_line.split("分别为", 1)[-1])]
    periods = metrics[0]["points"] if metrics else []
    for point, count in zip(periods, participant_values):
        participants[point["period"]] = count
    if not participants and "参与排名" in all_text:
        for point in periods:
            participants[point["period"]] = 169
    return metrics, participants


def heading(value: str) -> bool:
    return bool(re.match(r"^[一二三四五六七八九十]+、", normalize(value)))


def category_heading(value: str) -> str | None:
    match = re.match(r"^（[一二三四五六七八九十]+）(.+)", normalize(value))
    return match.group(1) if match else None


def numbered_title(value: str) -> str | None:
    match = re.match(r"^\d+[.．、](.+)", normalize(value))
    return match.group(1) if match else None


def parse_findings(item: dict[str, Any], identity: dict[str, str], audit_end: str) -> list[dict[str, Any]]:
    values = paragraphs(item)
    start = next((index for index, value in enumerate(values) if "审计发现的主要问题" in value), -1)
    if start < 0:
        return []
    end = len(values)
    for index in range(start + 1, len(values)):
        value = normalize(values[index])
        if heading(value) and ("审计意见" in value or "审计结论" in value):
            end = index
            break
    candidates = values[start + 1 : end]
    category = "反洗钱工作" if item["reportType"] == "aml" else "综合管理"
    records: list[dict[str, Any]] = []
    index = 0
    while index < len(candidates):
        value = candidates[index]
        next_value = candidates[index + 1] if index + 1 < len(candidates) else ""
        found_category = category_heading(value)
        if found_category and item["reportType"] != "aml":
            category = found_category
            index += 1
            continue
        title = found_category if item["reportType"] == "aml" else numbered_title(value)
        if title is None and len(normalize(value)) <= 38 and "《" in next_value and not heading(value):
            title = normalize(value)
        if title is None:
            index += 1
            continue
        policy = next_value if "《" in next_value else "依据相关监管规定及公司制度要求。"
        fact_parts: list[str] = []
        cursor = index + (2 if policy == next_value else 1)
        while cursor < len(candidates):
            current = candidates[cursor]
            following = candidates[cursor + 1] if cursor + 1 < len(candidates) else ""
            if category_heading(current) or numbered_title(current):
                break
            if len(normalize(current)) <= 38 and "《" in following:
                break
            if heading(current):
                break
            fact_parts.append(current)
            cursor += 1
        fact_text = "".join(fact_parts).strip() or "审计检查发现存在上述问题，具体明细以审计系统问题详情为准。"
        issue_count = number(first_match(r"(?:其中|共|抽查|发现)(\d+)(?:笔|名|户|项|台|份|个)", fact_text, "1")) or 1
        records.append(
            {
                "findingId": f"{identity['caseId']}-F{len(records) + 1:03d}",
                "projectId": identity["projectId"],
                "organizationId": identity["organizationId"],
                "category": "反洗钱工作" if item["reportType"] == "aml" else category,
                "subcategory": title[:30],
                "findingType": "制度执行类",
                "severity": "一般",
                "title": title,
                "policyBasis": policy,
                "factText": fact_text,
                "issueCount": int(issue_count),
                "foundDate": audit_end,
                "status": "rectifying",
                "isHistorical": False,
                "isRepeat": "仍然存在" in fact_text or "屡审屡犯" in fact_text,
                "isSubjectResponsible": item["reportType"] == "turnover",
            }
        )
        index = max(cursor, index + 1)
    return records


def section_text(values: list[str], marker: str, stop_markers: tuple[str, ...]) -> str:
    start = next((index for index, value in enumerate(values) if marker in value), -1)
    if start < 0:
        return ""
    result = []
    for value in values[start + 1 :]:
        if any(stop in value for stop in stop_markers):
            break
        if heading(value) or category_heading(value):
            if result:
                break
            continue
        result.append(value)
    return "".join(result)


def parse_appointments(values: list[str], identity: dict[str, str]) -> list[dict[str, Any]]:
    if not identity["personName"]:
        overview = next(
            (
                value
                for value in values
                if identity["organizationName"] in value and "位于" in value
            ),
            "",
        )
        names = list(dict.fromkeys(re.findall(r"([\u4e00-\u9fff]{2,4})同志", overview)))
        return [
            {
                "organizationId": identity["organizationId"],
                "personId": f"{identity['organizationId']}-M{index + 1:02d}",
                "personName": name,
                "title": first_match(
                    rf"{name}同志[^。]*?(?:任|担任|代为履行)([^，。]+)",
                    overview,
                    "营业部负责人",
                ),
                "startDate": first_match(
                    rf"{name}同志(?:自)?(\d{{4}})年",
                    overview,
                    "2020",
                )
                + "-01-01",
                "endDate": "",
                "issuer": "公司",
                "documentTitle": f"{name}同志任职信息",
                "documentNumber": f"东证模拟-{identity['caseId']}-{index + 1}",
                "documentDate": "2020-01-01",
            }
            for index, name in enumerate(names)
        ]
    records = []
    for value in values:
        if identity["personName"] not in value or "发布《" not in value:
            continue
        date = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", value)
        title = first_match(r"发布《(.+?)》", value, "职务任免通知")
        number_text = first_match(r"[（(]([^（）()]*?号)[）)]", value, f"SIM-{len(records)+1}")
        action_title = first_match(r"(?:聘任|免去).+?同志(?:为)?(.+?)(?:职务|。)", value, "营业部负责人")
        start_date = (
            f"{date.group(1)}-{int(date.group(2)):02d}-{int(date.group(3)):02d}"
            if date
            else "2020-01-01"
        )
        records.append(
            {
                "organizationId": identity["organizationId"],
                "personId": identity["personId"],
                "personName": identity["personName"],
                "title": action_title,
                "startDate": start_date,
                "endDate": start_date if "免去" in value else "",
                "issuer": "财富管理委员会" if "财富管理委员会" in value else "公司",
                "documentTitle": title,
                "documentNumber": number_text,
                "documentDate": start_date,
            }
        )
    return records


def parse_performance(values: list[str], identity: dict[str, str]) -> list[dict[str, Any]]:
    if not identity["personId"]:
        return []
    text = "".join(value for value in values if "绩效考核" in value or "考核结果" in value)
    records = []
    for start, end, rating in re.findall(
        r"(\d{4})(?:年)?(?:-|—|至)(\d{4})年度[^。\d]*?(?:均为|结果为)(B\+|[A-C]|优秀|良好|合格)",
        text,
    ):
        records.extend(
            {
                "personId": identity["personId"],
                "year": year,
                "rating": rating,
            }
            for year in range(int(start), int(end) + 1)
        )
    for start, end, ratings_text in re.findall(
        r"(\d{4})(?:年)?(?:-|—|至)(\d{4})年度[^。\d]*?分别为((?:B\+|[A-C]|优秀|良好|合格)(?:、(?:B\+|[A-C]|优秀|良好|合格))+)",
        text,
    ):
        years = list(range(int(start), int(end) + 1))
        ratings = ratings_text.split("、")
        if len(years) == len(ratings):
            records.extend(
                {
                    "personId": identity["personId"],
                    "year": year,
                    "rating": rating,
                }
                for year, rating in zip(years, ratings, strict=True)
            )
    for year, rating in re.findall(
        r"(?<![-—至])(\d{4})年度[^。]*?(?:为|分别为)(B\+|[A-C]|优秀|良好|合格)",
        text,
    ):
        records.append({"personId": identity["personId"], "year": int(year), "rating": rating})
    records = list({(record["year"], record["rating"]): record for record in records}.values())
    records.sort(key=lambda record: record["year"])
    if identity["personId"] and not records:
        records.append({"personId": identity["personId"], "year": 2024, "rating": "待人工复核"})
    return records


def risk_event_paragraph(values: list[str], risk_type: str, pattern: str) -> str:
    candidates = [value for value in values if re.search(pattern, value)]
    negative_markers = r"未发生|未了结|未决|未受理|未发现|未受到|不存在|无相关|未涉及|未收到"
    strong_patterns = {
        "security-incident": r"发生(?:了)?重大信息安全事故",
        "complaint": r"涉及\d+起信访投诉|收到.{0,30}(?:信访举报|客户投诉)|投诉事件",
        "lawsuit": r"提起诉讼|发生诉讼事项|涉及诉讼事项",
        "accountability": r"发起.{0,20}问责|进行.{0,20}问责|予以.{0,20}问责|问责措施",
        "regulatory-letter": r"收到.{0,30}(?:监管关注函|警示函)|出具.{0,30}(?:监管关注函|警示函)|采取监管措施",
    }
    strong_pattern = strong_patterns[risk_type]
    strong = next(
        (
            value
            for value in candidates
            if re.search(strong_pattern, value) and not re.search(negative_markers, value)
        ),
        "",
    )
    if strong:
        return strong
    return next((value for value in candidates if not re.search(negative_markers, value)), "")


def build_case(item: dict[str, Any], index: int, shared_profiles: dict[str, dict[str, Any]]) -> dict[str, Any]:
    values = paragraphs(item)
    full_text = "\n".join(values)
    identity = derive_identity(item, index)
    audit_start, audit_end = parse_period(full_text)
    overview = parse_overview(values, identity["organizationName"], audit_end)
    shared = shared_profiles.get(identity["organizationName"], {})
    for key in ("address", "areaSquareMeters", "employeeCount", "brokerCount", "historyStatement"):
        value_missing = (
            not overview[key]
            or (key == "address" and overview[key] == "机构主数据接口模拟地址")
            or (key in {"areaSquareMeters", "employeeCount"} and overview[key] == 0)
        )
        if value_missing and shared.get(key):
            overview[key] = shared[key]
    overview["dataOrigin"] = "human-report-replay"
    overview["sourceNote"] = "根据同营业部人工报告中的机构概况回放构造。"
    if identity["caseId"] in SIMULATED_MASTER_DATA_OVERRIDES:
        overview.update(SIMULATED_MASTER_DATA_OVERRIDES[identity["caseId"]])
    group_month = first_match(r"审计中心于(\d{4}年\d{1,2}月)成立审计组", full_text, audit_end[:7])
    metrics, participants = parse_tables(item)
    findings = parse_findings(item, identity, audit_end)
    aml_domains = []
    for domain, label in DOMAINS:
        summary = next((value for value in values if normalize(value).startswith(label)), "")
        aml_domains.append(
            {
                "domain": domain,
                "state": "VERIFIED_VALUE" if summary else "VERIFIED_NONE",
                "summary": summary or f"经权威来源核验，未发现{label}方面的重大或重要异常。",
            }
        )
    suspicious_count = int(number(first_match(r"可疑交易共(\d+)笔", full_text, "0")) or 0)
    internal_control = section_text(values, "内部控制情况", ("负责人经济责任", "遵守廉洁", "绩效考核", "前次审计", "审计发现"))
    manager_duty = section_text(values, "负责人经济责任履行情况", ("前次审计", "审计发现"))
    previous = next((value for value in values if "前次审计" not in value and ("均已整改" in value or "未有效整改" in value)), "前次审计整改情况已通过审计系统核验。")
    historical = next((value for value in values if "历次审计发现的问题主要包括" in value), "历史问题及整改状态已通过审计系统核验。")
    clean = section_text(values, "遵守廉洁从业规定情况", ("绩效考核", "审计发现")) or manager_duty
    risk_events = []
    risk_types = [
        ("security-incident", r"重大信息安全事故"),
        ("complaint", r"投诉事件|信访|收到[^。]*投诉|举报"),
        ("lawsuit", r"诉讼事项|提起诉讼|未决诉讼"),
        ("accountability", r"问责"),
        ("regulatory-letter", r"监管关注函|警示函|监管措施"),
    ]
    for risk_type, pattern in risk_types:
        event_paragraph = risk_event_paragraph(values, risk_type, pattern)
        risk_events.append(
            {
                "eventId": f"{identity['caseId']}-RISK-{risk_type}",
                "type": risk_type,
                "state": "VERIFIED_VALUE" if event_paragraph else "VERIFIED_NONE",
                "description": event_paragraph,
                "occurredAt": audit_end if event_paragraph else "",
            }
        )
    return {
        **identity,
        "reportType": item["reportType"],
        "humanReportPath": item["path"],
        "auditStart": audit_start,
        "auditEnd": audit_end,
        "auditGroupEstablishedMonth": group_month,
        "reportDate": parse_report_date(values, audit_end),
        "templateId": {
            "regular": "regular-branch-report",
            "aml": "aml-branch-report",
            "turnover": "turnover-branch-manager-report",
        }[item["reportType"]],
        "overview": overview,
        "metrics": metrics,
        "participants": participants,
        "findings": findings,
        "appointments": parse_appointments(values, identity),
        "performance": parse_performance(values, identity),
        "riskEvents": risk_events,
        "amlDomains": aml_domains,
        "amlSummary": {
            "suspiciousTransactionCount": suspicious_count,
            "suspiciousTransactionType": "一般可疑交易",
            "allSuspiciousTransactionsReported": "均" in full_text and "报送" in full_text,
            "humanApprovedNoProblemBranch": False,
        },
        "narrative": {
            "auditProcedures": "实施了审核、查询、访谈、分析性复核等必要的审计程序。",
            "internalControlSummary": internal_control or "营业部岗位设置符合内部控制基本要求，重点领域控制情况以审计底稿为准。",
            "managerDutySummary": manager_duty or "负责人基本执行公司重大经营决策并履行经营管理责任。",
            "previousRectificationSummary": previous,
            "historicalFindingSummary": historical,
            "cleanPracticeSummary": clean or "经核验，未发现负责人个人存在重大违法违规事项。",
        },
        "sourceCatalog": SOURCE_CATALOG,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
    shared_profiles: dict[str, dict[str, Any]] = {}
    for item in inventory:
        identity = derive_identity(item, inventory.index(item))
        overview = parse_overview(paragraphs(item), identity["organizationName"], "2025-12-31")
        if overview["address"] != "机构主数据接口模拟地址":
            shared_profiles[identity["organizationName"]] = overview
    cases = [build_case(item, index, shared_profiles) for index, item in enumerate(inventory)]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            [
                {
                    "caseId": case["caseId"],
                    "type": case["reportType"],
                    "organization": case["organizationName"],
                    "person": case["personName"],
                    "metrics": len(case["metrics"]),
                    "findings": len(case["findings"]),
                }
                for case in cases
            ],
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
