"""Build the title-only Fringe catalogue used by the web app."""

import json
import sys
from pathlib import Path

import pandas as pd


def main(source: str, destination: str) -> None:
    frame = pd.read_excel(source, header=2)
    fringe = frame[
        (frame["Festival"] == "Edinburgh Festival Fringe")
        & (frame["Year"].astype(str) == "2026")
    ].copy()
    fringe = fringe.dropna(subset=["Title", "ID"])
    fringe["title"] = fringe["Title"].astype(str).str.strip()
    fringe["id"] = fringe["ID"].astype(str).str.rsplit("/", n=1).str[-1]
    shows = (
        fringe[["id", "title"]]
        .drop_duplicates(subset=["id"])
        .sort_values(["title", "id"], key=lambda column: column.str.casefold())
        .to_dict(orient="records")
    )

    output = Path(destination)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps({"generated": "2026-08-09", "count": len(shows), "shows": shows}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {len(shows)} Fringe shows to {output}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: build_catalog.py SOURCE.xlsx DESTINATION.json")
    main(sys.argv[1], sys.argv[2])
