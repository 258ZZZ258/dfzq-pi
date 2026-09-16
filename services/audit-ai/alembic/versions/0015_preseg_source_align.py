"""preseg source-schema alignment (CP-010 内网 8 表对齐)

真实内网库(ZNFG_IAM_LAW_* 8 表)到手后的对齐 add-only 迁移。三列均可空、无回填,
对既有行安全:

- chunks.source_code    —— 源条款锚 ``ZNFG_IAM_LAW_CONTENT.CODE``,案例桥接由 fuzzy
                            title 对齐升级为 CASE_PUNISH.LAW_CONTENT_CODE **精确直连**的落点
- doc_versions.invalid_date  —— 失效日期 ``LAW_BASIC.INVALID_DATE``(与既有 effective_date
                            成对;abolished 判定)
- doc_versions.source_law_id —— 源法规版本链 ``LAW_BASIC.SOURCE_LAW_ID``(supersedes 自动生成来源)

Revision ID: 0015_preseg_source_align
Revises: 0014_preseg_entity_types
Create Date: 2026-07-14 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015_preseg_source_align"
down_revision: str | None = "0014_preseg_entity_types"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 列宽直接按真实源(探查:LAW_CONTENT.CODE=VARCHAR(256)、SOURCE_LAW_ID=VARCHAR(256))创建,
    # add-only 一步到位(不再事后 alter_column,守 schema add-only 硬契约;Codex 二轮 F1)。
    op.add_column("chunks", sa.Column("source_code", sa.String(length=256), nullable=True))
    op.create_index(op.f("ix_chunks_source_code"), "chunks", ["source_code"], unique=False)
    op.add_column("doc_versions", sa.Column("invalid_date", sa.Date(), nullable=True))
    op.add_column("doc_versions", sa.Column("source_law_id", sa.String(length=256), nullable=True))
    op.create_index(
        op.f("ix_doc_versions_source_law_id"), "doc_versions", ["source_law_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_doc_versions_source_law_id"), table_name="doc_versions")
    op.drop_column("doc_versions", "source_law_id")
    op.drop_column("doc_versions", "invalid_date")
    op.drop_index(op.f("ix_chunks_source_code"), table_name="chunks")
    op.drop_column("chunks", "source_code")
