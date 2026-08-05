from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", required=True, type=Path)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--template-regular", required=True, type=Path)
    parser.add_argument("--template-aml", required=True, type=Path)
    parser.add_argument("--template-turnover", required=True, type=Path)
    args = parser.parse_args()
    jobs = json.loads(args.jobs.read_text(encoding="utf-8"))
    templates = {
        "regular": args.template_regular,
        "aml": args.template_aml,
        "turnover": args.template_turnover,
    }
    scripts = Path(__file__).parent
    args.output_root.mkdir(parents=True, exist_ok=True)
    summary: list[dict[str, Any]] = []
    for job in jobs:
        case_id = job["caseId"]
        case_dir = args.run_root / case_id
        draft = case_dir / "structured-draft.json"
        dataset = case_dir / "normalized-source-snapshot.json"
        rubric = case_dir / "rubric-score.json"
        if not draft.exists() or not dataset.exists() or not rubric.exists():
            summary.append(
                {
                    "caseId": case_id,
                    "reportType": job["reportType"],
                    "status": "failed",
                    "reason": "生成阶段未产出完整的草稿、数据快照或评分文件",
                }
            )
            continue
        human_path = Path(job["humanReportPath"])
        output_docx = args.output_root / f"{case_id}-{human_path.stem}-智能体生成.docx"
        subprocess.run(
            [
                sys.executable,
                str(scripts / "render_report_docx.py"),
                "--template",
                str(templates[job["reportType"]]),
                "--draft",
                str(draft),
                "--output",
                str(output_docx),
            ],
            check=True,
        )
        comparison_json = case_dir / "human-comparison.json"
        comparison_md = case_dir / "human-comparison.md"
        subprocess.run(
            [
                sys.executable,
                str(scripts / "compare_human_report.py"),
                "--human",
                str(human_path),
                "--generated",
                str(output_docx),
                "--dataset",
                str(dataset),
                "--draft",
                str(draft),
                "--output-json",
                str(comparison_json),
                "--output-md",
                str(comparison_md),
            ],
            check=True,
        )
        rubric_result = json.loads(rubric.read_text(encoding="utf-8"))
        comparison = json.loads(comparison_json.read_text(encoding="utf-8"))
        summary.append(
            {
                "caseId": case_id,
                "reportType": job["reportType"],
                "organization": json.loads(dataset.read_text(encoding="utf-8"))["organization"]["fullName"],
                "humanReport": str(human_path),
                "generatedReport": str(output_docx),
                "status": "completed",
                "rubricPassed": rubric_result["passedCount"],
                "rubricApplicable": rubric_result["applicableCount"],
                "rubricPassRate": rubric_result["passRate"],
                "completionScore": comparison["completionScore"],
                "textSimilarity": comparison["textSimilarityReferenceOnly"],
            }
        )
    completed = [item for item in summary if item["status"] == "completed"]
    aggregate = {
        "total": len(summary),
        "completed": len(completed),
        "failed": len(summary) - len(completed),
        "averageRubricPassRate": round(
            sum(item["rubricPassRate"] for item in completed) / max(len(completed), 1),
            2,
        ),
        "averageCompletionScore": round(
            sum(item["completionScore"] for item in completed) / max(len(completed), 1),
            2,
        ),
        "averageTextSimilarity": round(
            sum(item["textSimilarity"] for item in completed) / max(len(completed), 1),
            2,
        ),
    }
    result = {"aggregate": aggregate, "cases": summary}
    (args.output_root / "批量生成与评估汇总.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    rows = [
        "| 案例 | 类型 | 营业部 | Rubric | 完成度 | 相似度 | 状态 |",
        "|---|---|---|---:|---:|---:|---|",
    ]
    for item in summary:
        if item["status"] == "completed":
            rows.append(
                f"| {item['caseId']} | {item['reportType']} | {item['organization']} | "
                f"{item['rubricPassed']}/{item['rubricApplicable']} ({item['rubricPassRate']:.2f}%) | "
                f"{item['completionScore']:.2f} | {item['textSimilarity']:.2f} | 完成 |"
            )
        else:
            rows.append(
                f"| {item['caseId']} | {item['reportType']} | - | - | - | - | 失败：{item['reason']} |"
            )
    markdown = f"""# 审计报告智能体批量生成与评估汇总

## 总体结果

- 报告总数：{aggregate['total']}
- 成功生成：{aggregate['completed']}
- 失败：{aggregate['failed']}
- 平均 Rubric 通过率：{aggregate['averageRubricPassRate']:.2f}%
- 平均人工报告完成度：{aggregate['averageCompletionScore']:.2f}
- 平均全文相似度：{aggregate['averageTextSimilarity']:.2f}%（仅供措辞接近度参考）

## 分报告结果

{chr(10).join(rows)}

## 评估边界

本批次属于历史报告回放：人工报告只在运行前用于构造模拟系统接口数据和经营 Excel，并在运行后用于对比；智能体生成阶段只读取 HTTP 系统接口与 Excel，不读取人工报告正文。该结果证明生成链路对历史事实和报告结构的恢复能力，不等同于未见过新营业部数据的盲测效果。
"""
    (args.output_root / "批量生成与评估汇总.md").write_text(markdown, encoding="utf-8")
    print(json.dumps(aggregate, ensure_ascii=False))


if __name__ == "__main__":
    main()
