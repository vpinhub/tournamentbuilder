#!/usr/bin/env python3
"""
Rebuilds data/pool.json and data/history.json from live sources.

  data/pool.json    - every VPS table (one best release each), with an
                      `inPool` flag marking the nFozzy + target-author
                      releases the admin tool's Random button draws from.
  data/history.json - most recent VPINHUB CompetitionCentral result per
                      table name (series, event period, winner).

Run it whenever the VPS database or the competition results change:

    python scripts/update_data.py

Stdlib only - no pip install needed. Requires Python 3.9+.
"""

import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

VPSDB_URL = "https://raw.githubusercontent.com/VirtualPinballSpreadsheet/vps-db/refs/heads/main/db/vpsdb.json"
LIST_URL = "https://raw.githubusercontent.com/vpinhub/competitioncentral/refs/heads/main/json/list.json"
CC_BASE_URL = "https://raw.githubusercontent.com/vpinhub/competitioncentral/refs/heads/main/"

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
POOL_PATH = DATA_DIR / "pool.json"
HISTORY_PATH = DATA_DIR / "history.json"

# Author names (substring, case-insensitive) whose nFozzy releases feed the
# auto-pick pool. Keep in sync with scripts/build-pool.js.
TARGET_AUTHORS = [
    "vpinworkshop",
    "vpw",
    "wizball",
    "joepicasso",
    "unclepaulie",
    "bord",
    "scottacus",
    "hauntfreaks",
    "idigstuff",
    "zandysarcade",
    "tastywasps",
    "rothbauerw",
    "g5k",
]

COMPETITION_LABELS = {
    "Special_When_Lit": "Special When Lit",
    "Thursday_Throwdown": "Thursday Throwdown",
}


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "tournament-creator-update/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------
# pool.json
# --------------------------------------------------------------------------

def matches_target_author(author):
    lower = author.lower()
    return any(t in lower for t in TARGET_AUTHORS)


def has_nfozzy(features):
    return any(re.search("nfozzy", f, re.IGNORECASE) for f in (features or []))


def matched_authors_of(authors):
    return [a for a in (authors or []) if matches_target_author(a)]


def score_release(tf):
    score = 0
    if not tf.get("parentId"):
        score += 10
    if tf.get("tableFormat") == "VPX":
        score += 5
    score += len(matched_authors_of(tf.get("authors")))
    score += (tf.get("updatedAt") or 0) / 1e15
    return score


def pick_best_b2s_image(game, tf):
    b2s_files = game.get("b2sFiles") or []
    if b2s_files:
        for b in b2s_files:
            if "FullDMD" in (b.get("features") or []) and b.get("imgUrl"):
                return b["imgUrl"]
        for b in b2s_files:
            if b.get("imgUrl"):
                return b["imgUrl"]
    return tf.get("imgUrl") or game.get("imgUrl") or None


def pick_rom_info(game):
    rom_files = sorted(
        game.get("romFiles") or [],
        key=lambda r: r.get("updatedAt") or 0,
        reverse=True,
    )
    if not rom_files:
        return {"romId": None, "romAuthor": None, "romOptions": []}
    primary = rom_files[0]
    return {
        "romId": primary.get("version") or None,
        "romAuthor": (primary.get("authors") or [None])[0],
        "romOptions": [
            {
                "romId": r.get("version") or None,
                "author": (r.get("authors") or [None])[0],
            }
            for r in rom_files[:5]
        ],
    }


def pick_tutorials(game):
    out = []
    for t in game.get("tutorialFiles") or []:
        url = t.get("url") or (t.get("urls") or [{}])[0].get("url")
        if not url:
            continue
        title = t.get("title") or (t.get("authors") or ["Tutorial"])[0]
        out.append({"title": title, "url": url})
        if len(out) == 4:
            break
    return out


def build_pool_entry(game, tf):
    table_id = game.get("id")
    release_id = tf.get("id")
    entry = {
        "tableId": table_id,
        "releaseId": release_id,
        "name": game.get("name"),
        "manufacturer": game.get("manufacturer") or None,
        "year": game.get("year") or None,
        "theme": game.get("theme") or [],
        "mpu": game.get("MPU") or None,
        "type": game.get("type") or None,
        "authors": tf.get("authors") or [],
        "matchedAuthors": matched_authors_of(tf.get("authors")),
        "features": tf.get("features") or [],
        "b2sImageUrl": pick_best_b2s_image(game, tf),
        "tableImageUrl": tf.get("imgUrl") or game.get("imgUrl") or None,
        "ipdbUrl": game.get("ipdbUrl") or None,
    }
    entry.update(pick_rom_info(game))
    entry["tutorials"] = pick_tutorials(game)
    entry["tournamentHelperUrl"] = (
        f"https://vpinhub.github.io/tournamenthelper/?tableId={table_id}&releaseId={release_id}"
    )
    entry["iscoredTag"] = (
        f"https://virtualpinballspreadsheet.github.io/?game={table_id}&fileType=table#{release_id}"
    )
    return entry


def build_pool():
    print(f"Fetching {VPSDB_URL} ...")
    games = fetch_json(VPSDB_URL)
    print(f"  {len(games)} games in the VPS database")

    tables = []
    for game in games:
        best_qualifying = None
        best_overall = None
        for tf in game.get("tableFiles") or []:
            s = score_release(tf)
            if best_overall is None or s > best_overall[0]:
                best_overall = (s, tf)
            if has_nfozzy(tf.get("features")) and any(
                matches_target_author(a) for a in (tf.get("authors") or [])
            ):
                if best_qualifying is None or s > best_qualifying[0]:
                    best_qualifying = (s, tf)

        chosen = best_qualifying or best_overall
        if chosen is None:  # no table files at all
            continue

        entry = build_pool_entry(game, chosen[1])
        entry["inPool"] = best_qualifying is not None
        tables.append(entry)

    tables.sort(key=lambda e: (e["name"] or "").casefold())
    pool_count = sum(1 for t in tables if t["inPool"])

    write_json(
        POOL_PATH,
        {
            "generatedAt": now_iso(),
            "sourceAuthors": TARGET_AUTHORS,
            "count": len(tables),
            "poolCount": pool_count,
            "tables": tables,
        },
    )
    print(f"Wrote {len(tables)} tables ({pool_count} auto-pick eligible) to {POOL_PATH}")


# --------------------------------------------------------------------------
# history.json
# --------------------------------------------------------------------------

def parse_date_from_name(name):
    m = re.search(r"(\d{4}-\d{2}-\d{2})", name or "")
    return m.group(1) if m else None


def fetch_history_record(entry):
    try:
        data = fetch_json(CC_BASE_URL + entry["path"])
    except Exception as exc:  # noqa: BLE001
        print(f"  skip {entry.get('path')}: {exc}")
        return None
    date = parse_date_from_name(entry.get("name")) or (data.get("date_exported") or "")[:10]
    if not data.get("table") or not date:
        return None
    awards = data.get("awards") or {}
    return {
        "table": data["table"],
        "competition": data.get("competition"),
        "period": data.get("period") or None,
        "winner": awards.get("winner") or None,
        "date": date,
    }


def build_history():
    print(f"Fetching {LIST_URL} ...")
    entries = fetch_json(LIST_URL)
    print(f"  {len(entries)} past tournament records, fetching each ...")

    with ThreadPoolExecutor(max_workers=8) as pool:
        records = list(pool.map(fetch_history_record, entries))

    by_table = {}
    for rec in records:
        if not rec:
            continue
        key = rec["table"].strip().lower()
        existing = by_table.get(key)
        if existing is None or rec["date"] > existing["date"]:
            by_table[key] = {
                "table": rec["table"],
                "competition": COMPETITION_LABELS.get(rec["competition"], rec["competition"]),
                "period": rec["period"],
                "winner": rec["winner"],
                "date": rec["date"],
            }

    write_json(
        HISTORY_PATH,
        {"generatedAt": now_iso(), "count": len(by_table), "byTable": by_table},
    )
    print(f"Wrote history for {len(by_table)} tables to {HISTORY_PATH}")


def main():
    build_pool()
    build_history()
    print("Done. Refresh the admin tool in your browser to pick up the changes.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
