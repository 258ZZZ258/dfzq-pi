"""T4 get_clause_detail 的判别性测试。

T4 是 agent 取正文的**唯一途径**(三个 retrieve* 的 text 恒 null),
也是 per-run 白名单的**执行点** —— 越权向量都打在这里。
"""

from dataclasses import dataclass

import pytest

from query.mcp.scope import AuthScope, ScopeError
from query.mcp.session import RunRegistry
from query.mcp.tools import get_clause_detail


@dataclass
class FakeCitation:
    """镜像 query.generate.contract.Citation 的字段(探针实测的 10 个)。"""

    clause_id: str
    doc_title: str | None = "北京证券交易所股票上市规则"
    doc_no: str | None = None
    clause_path: str | None = "11.2"
    page_start: int | None = None
    page_end: int | None = None
    version: str | None = None
    status: str | None = "effective"
    source_code: str | None = "SRC-1"
    source_doc_id: str | None = "DOC-1"


class FakePg:
    """记录被查了哪些 id,并可分别配置 anchors / texts / parent_text 的返回。"""

    def __init__(self, anchors=None, texts=None, parent_texts=None):
        self.anchors = anchors or {}
        self.texts = texts or {}
        self.parent_texts = parent_texts or {}
        self.asked_anchors = None
        self.asked_texts = None


def _fake_fetchers(pg):
    def fetch_anchors(_pg, ids):
        pg.asked_anchors = list(ids)
        return {i: pg.anchors[i] for i in ids if i in pg.anchors}

    def fetch_texts(_pg, ids):
        pg.asked_texts = list(ids)
        return {i: pg.texts[i] for i in ids if i in pg.texts}

    def fetch_parent_text(_pg, cid):
        return pg.parent_texts.get(cid)

    return {
        "fetch_anchors": fetch_anchors,
        "fetch_texts": fetch_texts,
        "fetch_parent_text": fetch_parent_text,
    }


def _deps(pg, registry):
    return {"pg": pg, "registry": registry, **_fake_fetchers(pg)}


AUTH = AuthScope(["P1"], ["external"], "r-1")


def test_returns_anchor_and_text_for_an_allowed_id():
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    pg = FakePg(anchors={"a": FakeCitation("a")}, texts={"a": "第十六条 对于上市公司……"})
    out = get_clause_detail.call(AUTH, {"clause_ids": ["a"]}, _deps(pg, reg))

    assert out["rejected"] == []
    assert out["not_found"] == []
    item = out["items"][0]
    assert item["clause_id"] == "a"
    assert item["text"] == "第十六条 对于上市公司……"
    assert item["status"] == "effective"
    # A2 的回查键
    assert item["source_code"] == "SRC-1"
    assert item["source_doc_id"] == "DOC-1"


def test_text_comes_from_fetch_texts_not_fetch_parent_text():
    # 探针实测:全库 chunks_with_parent = 0,fetch_parent_text 恒 None(规格 §3.2.1)。
    # 主规格 §2.2 的 T4 写的是 fetch_parent_text —— 照它实现,这条会拿到 None。
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    pg = FakePg(
        anchors={"a": FakeCitation("a")},
        texts={"a": "块自身正文"},
        parent_texts={},  # 全库零父块的真实情况
    )
    out = get_clause_detail.call(AUTH, {"clause_ids": ["a"]}, _deps(pg, reg))
    assert out["items"][0]["text"] == "块自身正文"


def test_rejects_ids_outside_this_run_without_erroring():
    # 规格 §6-1:「部分成功」必须以 isError:false 返回。超集 id 进 rejected 数组,
    # 不抛错、不静默丢弃 —— 抛错会让模型看不到已经取到的那一半。
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    pg = FakePg(anchors={"a": FakeCitation("a")}, texts={"a": "正文"})
    out = get_clause_detail.call(AUTH, {"clause_ids": ["a", "NEVER-SEARCHED"]}, _deps(pg, reg))

    assert out["rejected"] == ["NEVER-SEARCHED"]
    assert [i["clause_id"] for i in out["items"]] == ["a"]


def test_another_runs_ids_are_rejected():
    # 与上一条不同:这个 id **真实存在于 PG**,只是属于另一个 run。
    # 这是 S3 池化后的越权向量,不是无效输入 —— 若白名单退化成全局桶,这条会返回正文。
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    reg.record("r-2", ["secret"])
    pg = FakePg(
        anchors={"a": FakeCitation("a"), "secret": FakeCitation("secret")},
        texts={"a": "正文", "secret": "别的 run 的机密条款正文"},
    )
    out = get_clause_detail.call(AUTH, {"clause_ids": ["secret"]}, _deps(pg, reg))

    assert out["rejected"] == ["secret"]
    assert out["items"] == []


def test_rejected_ids_are_never_queried_against_pg():
    # 纵深:不该只是「查了但不返回」。越权 id 根本不该到达 PG ——
    # 否则一次慢查询的时序差就能被用来探测 id 是否存在。
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    pg = FakePg(anchors={"a": FakeCitation("a")}, texts={"a": "正文"})
    get_clause_detail.call(AUTH, {"clause_ids": ["a", "secret"]}, _deps(pg, reg))
    assert pg.asked_anchors == ["a"]
    assert "secret" not in (pg.asked_texts or [])


def test_pg_misses_go_to_not_found_not_to_an_error():
    # 在白名单内但 PG 查不到 —— 数据不一致,不是权限问题,两者必须分开报。
    reg = RunRegistry()
    reg.record("r-1", ["ghost"])
    pg = FakePg(anchors={}, texts={})
    out = get_clause_detail.call(AUTH, {"clause_ids": ["ghost"]}, _deps(pg, reg))

    assert out["not_found"] == ["ghost"]
    assert out["rejected"] == []
    assert out["items"] == []


def test_null_version_and_pages_are_not_failures():
    # 探针实测:真数据上 version / page_start / page_end 8/8 为 null(规格 §0.3-C)。
    # 据此判失败会让每一次真实调用都失败。
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    pg = FakePg(
        anchors={"a": FakeCitation("a", version=None, page_start=None, page_end=None, doc_no=None)},
        texts={"a": "正文"},
    )
    out = get_clause_detail.call(AUTH, {"clause_ids": ["a"]}, _deps(pg, reg))
    item = out["items"][0]
    assert item["version"] is None
    assert item["page_start"] is None
    # status 是 A3 时效性检查的权威来源,它有值
    assert item["status"] == "effective"


def test_missing_text_is_null_not_an_error():
    reg = RunRegistry()
    reg.record("r-1", ["a"])
    pg = FakePg(anchors={"a": FakeCitation("a")}, texts={})
    out = get_clause_detail.call(AUTH, {"clause_ids": ["a"]}, _deps(pg, reg))
    assert out["items"][0]["text"] is None


def test_empty_clause_ids_is_a_param_error():
    reg = RunRegistry()
    with pytest.raises(ScopeError) as e:
        get_clause_detail.call(AUTH, {"clause_ids": []}, _deps(FakePg(), reg))
    assert e.value.code == -32602


def test_missing_clause_ids_is_a_param_error():
    reg = RunRegistry()
    with pytest.raises(ScopeError) as e:
        get_clause_detail.call(AUTH, {}, _deps(FakePg(), reg))
    assert e.value.code == -32602
    assert "clause_ids" in e.value.message


def test_duplicate_ids_are_deduped_preserving_order():
    reg = RunRegistry()
    reg.record("r-1", ["a", "b"])
    pg = FakePg(
        anchors={"a": FakeCitation("a"), "b": FakeCitation("b")},
        texts={"a": "A", "b": "B"},
    )
    out = get_clause_detail.call(AUTH, {"clause_ids": ["a", "b", "a"]}, _deps(pg, reg))
    assert [i["clause_id"] for i in out["items"]] == ["a", "b"]


def test_tool_schema_hides_the_authorization_layer():
    props = get_clause_detail.TOOL.input_schema["properties"]
    for forbidden in ("perm_tags", "corpus_types", "run_id"):
        assert forbidden not in props


def test_tool_description_says_ids_must_come_from_search():
    # 模型臆造 id 会静默进 rejected;description 不说清,它会以为是检索没覆盖到。
    assert "search_policy" in get_clause_detail.TOOL.description


def test_successful_fetch_is_recorded_for_sufficiency_tracking():
    # T7 的取证完整性判定依赖这条记录。
    reg = RunRegistry()
    reg.record("r-1", ["a", "b"])
    pg = FakePg(anchors={"a": FakeCitation("a")}, texts={"a": "正文"})
    get_clause_detail.call(AUTH, {"clause_ids": ["a"]}, _deps(pg, reg))
    assert reg.unfetched("r-1") == ["b"]


def test_not_found_ids_are_not_marked_as_fetched():
    # 「查了但库里没有」不等于「取过正文」—— 标了会让 T7 少报缺口。
    reg = RunRegistry()
    reg.record("r-1", ["ghost"])
    pg = FakePg(anchors={}, texts={})
    get_clause_detail.call(AUTH, {"clause_ids": ["ghost"]}, _deps(pg, reg))
    assert reg.unfetched("r-1") == ["ghost"]
