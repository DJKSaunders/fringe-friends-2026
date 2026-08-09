"""Build the title-only Fringe catalogue used by the web app."""

import json
import sys
import unicodedata
from pathlib import Path

import pandas as pd


def normalise_title(value: str) -> str:
    return " ".join(
        unicodedata.normalize("NFKC", value)
        .replace("‘", "'")
        .replace("’", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("–", "-")
        .replace("—", "-")
        .casefold()
        .split()
    )


def main(source: str, destination: str) -> None:
    frame = pd.read_excel(source, header=2)
    fringe = frame[
        (frame["Festival"] == "Edinburgh Festival Fringe")
        & (frame["Year"].astype(str) == "2026")
    ].copy()
    fringe = fringe.dropna(subset=["Title", "ID"])
    fringe["title"] = fringe["Title"].astype(str).str.strip()
    fringe["id"] = fringe["ID"].astype(str).str.rsplit("/", n=1).str[-1]
    fringe["normalised_title"] = fringe["title"].map(normalise_title)
    shows = (
        fringe[["id", "title", "normalised_title"]]
        .drop_duplicates(subset=["id"])
        .sort_values(["title", "id"], key=lambda column: column.str.casefold())
        .drop_duplicates(subset=["normalised_title"], keep="first")
        .drop(columns=["normalised_title"])
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
