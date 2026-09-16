"""Deterministic checks for internal-policy references to superseded external rules."""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from query.change.reference_version_check import (
    ExplicitReference,
    InternalClause,
    build_reference_version_result,
)


class ReferenceVersionCheckTest(TestCase):
    def setUp(self) -> None:
        self.reference = ExplicitReference(
            reference_id="R4-1",
            internal_clause=InternalClause("INT-C1", "第五条", "根据《测试外规》第二条制定本条。"),
            surface_text="《测试外规》第二条",
            resolution_status="resolved",
            cited_doc_version_id="EXT-2024",
            cited_clause_path_norm="第二条",
        )
        self.cited = SimpleNamespace(
            doc_version_id="EXT-2024",
            logical_id="EXT-L1",
            title="测试外规",
            doc_number="测试〔2024〕1号",
            issue_date=date(2024, 1, 1),
            effective_date=date(2024, 2, 1),
        )
        self.current = SimpleNamespace(
            doc_version_id="EXT-2026",
            logical_id="EXT-L1",
            title="测试外规",
            doc_number="测试〔2026〕1号",
            issue_date=date(2026, 1, 1),
            effective_date=date(2026, 2, 1),
        )

    @patch("query.change.reference_version_check._clause_text")
    @patch("query.change.reference_version_check._current_external_version")
    @patch("query.change.reference_version_check._document_is_external")
    def test_reports_changed_external_clause_when_internal_rule_cites_old_version(
        self,
        document_is_external,
        current_external_version,
        clause_text,
    ) -> None:
        document_is_external.return_value = (SimpleNamespace(corpus_type="P-EXT"), self.cited)
        current_external_version.return_value = self.current
        clause_text.side_effect = lambda _pg, version_id, _path: {
            "EXT-2024": "第二条 旧版要求。",
            "EXT-2026": "第二条 新版要求并新增报告时限。",
        }[version_id]

        result = build_reference_version_result(object(), [self.reference], ["内部"])

        self.assertEqual(result["compareType"], "internal_to_external")
        self.assertEqual(result["metrics"]["checked"], 1)
        self.assertEqual(result["metrics"]["conflict"], 1)
        self.assertEqual(result["metrics"]["covered"], 0)
        self.assertEqual(result["rows"][0]["conflictType"], "引用条款已变更")
        self.assertEqual(result["rows"][0]["externalClause"], "第二条 新版要求并新增报告时限。")
        self.assertEqual(result["rows"][0]["basis"]["citedDocVersionId"], "EXT-2024")
        self.assertEqual(result["rows"][0]["basis"]["currentDocVersionId"], "EXT-2026")
        self.assertEqual(result["rows"][0]["basis"]["changeKind"], "clause_changed")

    @patch("query.change.reference_version_check._current_external_version")
    @patch("query.change.reference_version_check._document_is_external")
    def test_counts_reference_as_covered_when_cited_version_is_current(
        self,
        document_is_external,
        current_external_version,
    ) -> None:
        document_is_external.return_value = (SimpleNamespace(corpus_type="P-EXT"), self.cited)
        current_external_version.return_value = self.cited

        result = build_reference_version_result(object(), [self.reference], ["内部"])

        self.assertEqual(result["metrics"]["covered"], 1)
        self.assertEqual(result["metrics"]["conflict"], 0)
        self.assertEqual(result["rows"], [])
