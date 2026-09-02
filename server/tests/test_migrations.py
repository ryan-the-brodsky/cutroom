"""The boot migration: a database written before a column was renamed still
reads. Cutroom ships as one process against one SQLite file, so `init_db` is
the only migration hook there is and it has to be safe to run on every boot.
"""
from sqlalchemy import text

from cutroom import db, models


def old_shots_ddl(engine) -> str:
    """The shots table as it shipped before the rename: every column it has
    today except `narration`, plus the `radio` it was called then."""
    cols = []
    for c in models.Shot.__table__.columns:
        if c.name == "narration":
            continue
        decl = f"{c.name} {c.type.compile(engine.dialect)}"
        if c.primary_key:
            decl += " PRIMARY KEY"
        cols.append(decl)
    cols.append("radio TEXT")
    return f"CREATE TABLE shots ({', '.join(cols)})"


def make_pre_rename_db(narration_line: str) -> None:
    engine = db.get_engine()
    models.Base.metadata.create_all(engine)
    with engine.begin() as c:
        c.execute(text("INSERT INTO projects (id, label, created_at, paused, "
                       "settings) VALUES ('p1', 'P', 0, 0, '{}')"))
        c.execute(text("DROP TABLE shots"))
        c.execute(text(old_shots_ddl(engine)))
        c.execute(text(
            "INSERT INTO shots (id, project_id, sid, beat, act, type, seconds,"
            " register, image_prompt, negative, order_idx, radio) "
            "VALUES (1, 'p1', 'B01-S1', 'B01', 1, 'STILL', 6.0, '', "
            "'a Paris street', '', 0, :line)"), {"line": narration_line})


def read_shot():
    with db.session_scope() as s:
        return s.query(models.Shot).filter_by(sid="B01-S1").one()


LINE = "The bread ran out on a Tuesday."


def test_pre_rename_rows_read_back_as_narration(data_dir):
    make_pre_rename_db(LINE)
    db.init_db()
    assert read_shot().narration == LINE


def test_migration_is_idempotent_and_keeps_the_new_column(data_dir):
    make_pre_rename_db(LINE)
    db.init_db()
    with db.session_scope() as s:
        s.query(models.Shot).filter_by(sid="B01-S1").one().narration = "rewritten"
    # a second boot must not copy the stale `radio` back over the new value
    db.init_db()
    db.init_db()
    assert read_shot().narration == "rewritten"


def test_a_fresh_database_needs_no_migration(data_dir):
    db.init_db()
    with db.session_scope() as s:
        s.add(models.Project(id="p1", label="P"))
        s.add(models.Shot(project_id="p1", sid="B01-S1", narration=LINE))
    assert read_shot().narration == LINE
