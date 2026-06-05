"""Incremental download state: track fetched URLs to avoid re-downloading."""
import os
import sqlite3
import tempfile
from pathlib import Path


def _default_db_path() -> Path:
    override = os.environ.get("BPC_FETCH_HISTORY_DB")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA")
        if root:
            return Path(root) / "bpc-fetch" / "history.db"
        return Path.home() / "AppData/Local/bpc-fetch/history.db"
    return Path.home() / ".local/share/bpc-fetch/history.db"


DEFAULT_DB = _default_db_path()


def get_db(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or DEFAULT_DB
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        path = Path(tempfile.gettempdir()) / "bpc-fetch" / "history.db"
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("""CREATE TABLE IF NOT EXISTS fetched (
        url TEXT PRIMARY KEY,
        domain TEXT,
        title TEXT,
        fetched_at TEXT DEFAULT (datetime('now')),
        path TEXT
    )""")
    conn.commit()
    return conn


def is_fetched(url: str, db_path: Path | None = None) -> bool:
    conn = get_db(db_path)
    row = conn.execute("SELECT 1 FROM fetched WHERE url = ?", (url,)).fetchone()
    conn.close()
    return row is not None


def get_fetched(url: str, db_path: Path | None = None) -> dict | None:
    conn = get_db(db_path)
    row = conn.execute(
        "SELECT url, domain, title, fetched_at, path FROM fetched WHERE url = ?",
        (url,)
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return {"url": row[0], "domain": row[1], "title": row[2], "fetched_at": row[3], "path": row[4]}


def mark_fetched(url: str, domain: str, title: str, path: str, db_path: Path | None = None):
    conn = get_db(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO fetched (url, domain, title, path) VALUES (?, ?, ?, ?)",
        (url, domain, title, path)
    )
    conn.commit()
    conn.close()


def get_history(domain: str | None = None, limit: int = 50, db_path: Path | None = None) -> list[dict]:
    conn = get_db(db_path)
    if domain:
        rows = conn.execute(
            "SELECT url, domain, title, fetched_at, path FROM fetched WHERE domain = ? ORDER BY fetched_at DESC LIMIT ?",
            (domain, limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT url, domain, title, fetched_at, path FROM fetched ORDER BY fetched_at DESC LIMIT ?",
            (limit,)
        ).fetchall()
    conn.close()
    return [{"url": r[0], "domain": r[1], "title": r[2], "fetched_at": r[3], "path": r[4]} for r in rows]
