#!/usr/bin/env python3
"""Dependency-free local retrieval for Orbit using SQLite FTS5."""
from __future__ import annotations

import json, os, re, sqlite3, sys
from dataclasses import asdict, dataclass
from pathlib import Path
from time import time

TEXT_EXTENSIONS = {".md", ".txt", ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".csv"}
MAX_FILE_BYTES, MAX_FILES = 1_500_000, 2_000

@dataclass
class SearchHit:
    path: str
    title: str
    excerpt: str
    score: float
    modified_at: float

class RetrievalIndex:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(db_path)
        self.connection.execute("CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(path UNINDEXED, title, body, modified_at UNINDEXED)")

    def index_roots(self, roots: list[str]) -> dict[str, int]:
        indexed = skipped = 0
        self.connection.execute("DELETE FROM documents")
        for root_value in roots:
            root = Path(root_value).expanduser().resolve()
            if not root.is_dir():
                skipped += 1
                continue
            for current, directories, files in os.walk(root):
                directories[:] = [n for n in directories if not n.startswith(".") and n not in {"node_modules", "dist", "build", "venv"}]
                for name in files:
                    if indexed >= MAX_FILES: break
                    path = Path(current, name)
                    try:
                        if path.suffix.lower() not in TEXT_EXTENSIONS or path.stat().st_size > MAX_FILE_BYTES:
                            skipped += 1; continue
                        body = path.read_text(encoding="utf-8", errors="ignore")
                        if not body.strip(): skipped += 1; continue
                        self.connection.execute("INSERT INTO documents(path,title,body,modified_at) VALUES(?,?,?,?)", (str(path), path.name, body, path.stat().st_mtime))
                        indexed += 1
                    except (OSError, UnicodeError): skipped += 1
        self.connection.commit()
        return {"indexed": indexed, "skipped": skipped}

    def search(self, query: str, limit: int = 8) -> list[SearchHit]:
        tokens = re.findall(r"[A-Za-z0-9_]{2,}", query)[:12]
        if not tokens: return []
        rows = self.connection.execute("""SELECT path,title,snippet(documents,2,'⟦','⟧',' … ',28),bm25(documents,2.0,1.0),CAST(modified_at AS REAL) FROM documents WHERE documents MATCH ? ORDER BY bm25(documents,2.0,1.0) LIMIT ?""", (" OR ".join(f'"{t}"' for t in tokens), max(1, min(limit, 20)))).fetchall()
        now, hits = time(), []
        for path, title, excerpt, rank, modified_at in rows:
            recency = max(0.0, 1.0 - ((now - modified_at) / (180 * 86400)))
            relevance = 1.0 / (1.0 + abs(float(rank)))
            hits.append(SearchHit(path, title, " ".join(excerpt.split()), round(.9 * relevance + .1 * recency, 4), modified_at))
        return sorted(hits, key=lambda hit: hit.score, reverse=True)

def main() -> None:
    request = json.load(sys.stdin)
    index = RetrievalIndex(Path(request["db_path"]))
    if request.get("operation") == "index": response = index.index_roots(request.get("roots", []))
    elif request.get("operation") == "search": response = {"hits": [asdict(h) for h in index.search(request.get("query", ""), request.get("limit", 8))]}
    else: raise ValueError("Unsupported operation")
    json.dump(response, sys.stdout)

if __name__ == "__main__": main()
