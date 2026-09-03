from __future__ import annotations

from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

_engine = None
_SessionLocal: sessionmaker | None = None


def get_engine():
    global _engine, _SessionLocal
    if _engine is None:
        settings = get_settings()
        url = settings.db_url
        kwargs = {}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
        _engine = create_engine(url, future=True, **kwargs)
        if url.startswith("sqlite"):
            @event.listens_for(_engine, "connect")
            def _set_sqlite_pragma(dbapi_conn, _):
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


def session_factory() -> sessionmaker:
    get_engine()
    assert _SessionLocal is not None
    return _SessionLocal


@contextmanager
def session_scope() -> Session:
    s = session_factory()()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def init_db() -> None:
    from . import models  # noqa: F401  (register tables)
    models.Base.metadata.create_all(get_engine())
    migrate_db()


#: Columns renamed since a shipped release: (table, old name, new name, type).
#: The old column is left in place so a rollback still reads its data; the new
#: one is added and filled once, on boot.
RENAMES = [("shots", "radio", "narration", "TEXT")]

#: Columns added since a shipped release: (table, name, sqltype, default_sql).
#: Same story as RENAMES — additive and idempotent — for a column that has no
#: old name to migrate from.
ADDED_COLUMNS: list[tuple[str, str, str, str]] = [
    ("projects", "film_changes", "JSON", "'[]'"),
]


def migrate_db() -> None:
    """Bring an existing database up to the current model.

    `create_all` only ever creates missing tables, so a column added after a
    release would silently be absent on every database that already exists.
    This is the whole migration story: additive, idempotent, and cheap enough
    to run on every boot.
    """
    from sqlalchemy import inspect, text

    engine = get_engine()
    with engine.begin() as conn:
        insp = inspect(conn)
        tables = set(insp.get_table_names())
        for table, old, new, coltype in RENAMES:
            if table not in tables:
                continue
            cols = {c["name"] for c in insp.get_columns(table)}
            if new not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {new} {coltype}"))
                cols.add(new)
            if old in cols:
                conn.execute(text(
                    f"UPDATE {table} SET {new} = {old} "
                    f"WHERE {new} IS NULL AND {old} IS NOT NULL"))
        for table, name, coltype, default in ADDED_COLUMNS:
            if table not in tables:
                continue
            cols = {c["name"] for c in insp.get_columns(table)}
            if name not in cols:
                conn.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN {name} {coltype} "
                    f"DEFAULT {default}"))


def reset_db() -> None:
    """Test hook — drop cached engine so a new data dir takes effect."""
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None
