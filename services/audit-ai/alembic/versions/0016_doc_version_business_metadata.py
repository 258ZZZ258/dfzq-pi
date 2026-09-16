"""doc_versions business version metadata for intranet migrations.

The old schema only had the technical import id plus issue/effective dates, so
different revisions in the same year were indistinguishable in every client.
This is additive and backfills neutral ``历史导入版本`` values for legacy rows;
new source adapters can provide their official code/display name directly.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0016_doc_version_meta"
down_revision: str | None = "0015_preseg_source_align"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("doc_versions", sa.Column("version_code", sa.String(length=64), nullable=True))
    op.add_column(
        "doc_versions", sa.Column("version_display_name", sa.String(length=128), nullable=True)
    )
    op.add_column("doc_versions", sa.Column("revision_no", sa.Integer(), nullable=True))
    op.create_index(
        op.f("ix_doc_versions_logical_revision"),
        "doc_versions",
        ["logical_id", "revision_no"],
        unique=True,
    )
    # 历史数据没有业务版号：按明确的替代链补一个稳定的迁移序号，不冒充源系统正式版本号。
    op.execute(
        """
        WITH RECURSIVE version_chain AS (
            SELECT doc_version_id, logical_id, 1 AS revision_no
            FROM doc_versions
            WHERE supersedes_version_id IS NULL
            UNION ALL
            SELECT child.doc_version_id, child.logical_id, parent.revision_no + 1
            FROM doc_versions child
            JOIN version_chain parent ON child.supersedes_version_id = parent.doc_version_id
        )
        UPDATE doc_versions dv
        SET revision_no = version_chain.revision_no,
            version_code = COALESCE(dv.version_code, 'LEGACY-' || LPAD(version_chain.revision_no::text, 4, '0')),
            version_display_name = COALESCE(dv.version_display_name, '历史导入版本 ' || version_chain.revision_no::text)
        FROM version_chain
        WHERE dv.doc_version_id = version_chain.doc_version_id
        """
    )
    op.execute(
        """
        UPDATE doc_versions
        SET revision_no = COALESCE(revision_no, 1),
            version_code = COALESCE(version_code, 'LEGACY-0001'),
            version_display_name = COALESCE(version_display_name, '历史导入版本 1')
        """
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_doc_versions_logical_revision"), table_name="doc_versions")
    op.drop_column("doc_versions", "revision_no")
    op.drop_column("doc_versions", "version_display_name")
    op.drop_column("doc_versions", "version_code")
