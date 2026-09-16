"""add PostgreSQL task-runtime history tables.

Revision ID: 0017_task_runtime_history
Revises: 0016_doc_version_meta
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0017_task_runtime_history"
down_revision: str | None = "0016_doc_version_meta"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "task_runs",
        sa.Column("run_id", sa.String(length=64), primary_key=True),
        sa.Column("client_request_id", sa.String(length=128), nullable=False, unique=True),
        sa.Column("request_id", sa.String(length=128)),
        sa.Column("spec_id", sa.String(length=128), nullable=False),
        sa.Column("task_kind", sa.String(length=128), nullable=False),
        sa.Column("session_id", sa.String(length=128), nullable=False),
        sa.Column("filters_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("options_json", postgresql.JSONB(astext_type=sa.Text())),
        sa.Column("payload_json", postgresql.JSONB(astext_type=sa.Text())),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("input", sa.Text(), nullable=False),
        sa.Column("output", sa.Text()),
        sa.Column("error_message", sa.Text()),
        sa.Column("stop_reason", sa.String(length=64)),
        sa.Column("limit_hit", sa.String(length=64)),
        sa.Column("usage_json", postgresql.JSONB(astext_type=sa.Text())),
        sa.Column("turns", sa.Integer()),
        sa.Column("source_details_json", postgresql.JSONB(astext_type=sa.Text())),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("created_by", sa.String(length=64)),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("updated_by", sa.String(length=64)),
    )
    for name, columns in (
        ("ix_task_runs_client_request_id", ["client_request_id"]),
        ("ix_task_runs_request_id", ["request_id"]),
        ("ix_task_runs_spec_id", ["spec_id"]),
        ("ix_task_runs_task_kind", ["task_kind"]),
        ("ix_task_runs_session_id", ["session_id"]),
        ("ix_task_runs_status", ["status"]),
    ):
        op.create_index(name, "task_runs", columns)

    op.create_table(
        "task_run_events",
        sa.Column(
            "run_id",
            sa.String(length=64),
            sa.ForeignKey("task_runs.run_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("seq", sa.Integer(), primary_key=True),
        sa.Column("event_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    )
    op.create_index("ix_task_run_events_event_ts", "task_run_events", ["event_ts"])


def downgrade() -> None:
    op.drop_index("ix_task_run_events_event_ts", table_name="task_run_events")
    op.drop_table("task_run_events")
    for name in (
        "ix_task_runs_status",
        "ix_task_runs_session_id",
        "ix_task_runs_task_kind",
        "ix_task_runs_spec_id",
        "ix_task_runs_request_id",
        "ix_task_runs_client_request_id",
    ):
        op.drop_index(name, table_name="task_runs")
    op.drop_table("task_runs")
