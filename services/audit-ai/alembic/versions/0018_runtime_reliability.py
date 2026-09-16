"""Task runtime actor ownership, delivery receipt and CAS state; no feedback subsystem."""
from alembic import op

revision = "0018_runtime_reliability"
down_revision = "0017_task_runtime_history"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent for installations that already applied task-runtime's standalone SQL.
    op.execute("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS session_id_explicit BOOLEAN")
    op.execute("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS delivery_json JSONB")
    op.execute("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS principal_json JSONB")
    op.execute("ALTER TABLE task_runs ALTER COLUMN session_id TYPE VARCHAR(256)")
    op.execute("CREATE TABLE IF NOT EXISTS agent_state (state_key TEXT PRIMARY KEY, revision BIGINT NOT NULL CHECK (revision > 0), value_json JSONB NOT NULL)")


def downgrade() -> None:
    raise RuntimeError("Runtime state is retained deliberately; use a reviewed data-preserving rollback procedure")
