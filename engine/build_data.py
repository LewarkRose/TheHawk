"""Builds the data files the HAWK website needs but can't fetch itself.

Browsers can read 365Scores and Polymarket directly, but StatsHub (player
stats) and football-data.co.uk (team ratings) don't allow cross-site
requests. The GitHub Action runs this every few hours and publishes the
results with the site:

  data/meta.json              when the data was built, how each source did
                              (and when it last worked), and any problems
  data/fixtures.json          per upcoming fixture: football-data team names,
                              StatsHub team ids, referee card average,
                              Polymarket page, UK bookmaker odds snapshot
  data/profiles/<code>.json   team ratings for one league (model.build_profile)
  data/players/<id>.json      per-player stats, last 20 matches, one team

Last good data: every run starts from scratch, so when a source is down HAWK
reuses what the previous run published (the live site's copy) instead of
losing it — ratings up to 10 days old, player stats up to 4 days, and the
fixtures of any league 365Scores didn't answer for. Each file keeps the time
it was really built ("built"), so the site can say how fresh it is.

Run locally:  python build_data.py ../data
"""
import datetime as dt
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

import model
import sources

DAYS_AHEAD = 8
LIVE_DATA = os.environ.get("HAWK_LIVE", "https://lewarkrose.github.io/TheHawk") + "/data/"
MAX_AGE = {"profiles": dt.timedelta(days=10), "players": dt.timedelta(days=4)}
# A source counts as working when at least this share of its requests did.
SOURCE_OK_SHARE = 0.8
ALERT_AFTER = dt.timedelta(hours=24)
# Player rows are stored as arrays to keep the files small; the website reads
# them in this order.
PLAYER_MATCH_FIELDS = ["ts", "opp", "home", "score", "comp", "minutes", "shots", "sot", "goals", "xg",
                       "yellow", "red", "sub_in", "assists", "xa", "fouls", "fouled", "tackles", "offsides", "saves"]
ROUNDED = {"xg", "xa"}


def find_team(name, codes, today):
    """(code, football-data name) for a 365Scores team, searching the given
    league codes' current-season team lists."""
    best = None
    for code in codes:
        teams = sources.fd_teams(code, today)
        # One league: the team must be in it, so a clear best guess will do.
        match = sources.best_match(name, teams, threshold=0.75) if len(codes) > 1 else sources.closed_match(name, teams)
        if match:
            score = sources.name_similarity(name, match)
            if best is None or score > best[0]:
                best = (score, code, match)
    return [best[1], best[2]] if best else None


def profile_json(profile, built):
    return {"built": built, "avg": profile["avg"], "teams": profile["teams"], "avg_cards_total": profile["avg_cards_total"],
            "referees": profile["referees"]}


def players_json(team_id, data, built):
    out = []
    for p in data["players"]:
        rows = [[round(m[f], 2) if f in ROUNDED else m[f] for f in PLAYER_MATCH_FIELDS] for m in p["matches"]]
        out.append({"name": p["name"], "position": p["position"], "m": rows})
    return {"team": team_id, "built": built, "fields": PLAYER_MATCH_FIELDS, "players": out}


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def previous(name):
    """The last published copy of a data file (the live site), or None."""
    try:
        r = requests.get(LIVE_DATA + name, params={"t": int(time.time())}, timeout=20)
        return r.json() if r.status_code == 200 else None
    except (requests.RequestException, ValueError):
        return None


def parse_time(s):
    try:
        t = dt.datetime.fromisoformat(s)
        return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError):
        return None


def main(out_dir):
    started = time.time()
    today = dt.date.today()
    now = dt.datetime.now(dt.timezone.utc)
    horizon = now + dt.timedelta(days=DAYS_AHEAD)
    problems = []
    prev_meta = previous("meta.json") or {}
    prev_fixtures = (previous("fixtures.json") or {}).get("fixtures", {})
    # Files from runs before "built" was added date from that run.
    prev_built = prev_meta.get("generated")

    def reuse(kind, name):
        """A previous file, if it's recent enough to stand in for a fresh one."""
        old = previous(f"{kind}/{name}")
        built = parse_time((old or {}).get("built") or prev_built)
        if not old or not built or now - built > MAX_AGE[kind]:
            return None
        old["built"] = built.isoformat()
        return old

    # 1. Upcoming fixtures, and what each one needs from the blocked sources.
    fixtures, codes_needed, sh_teams = {}, set(), set()
    s365_ok = s365_failed = 0
    for league in sources.LEAGUES:
        games = sources.s365_fixtures(league)
        if games is None:
            s365_failed += 1
            # Keep this league's fixtures from the last run (those still to come).
            kept = {fid: f for fid, f in prev_fixtures.items() if f.get("league") == league
                    and (parse_time(f.get("kickoff")) or now) > now - dt.timedelta(hours=3)}
            fixtures.update(kept)
            for f in kept.values():
                codes_needed |= {c[0] for c in (f["fd"]["home"], f["fd"]["away"]) if c}
                sh_teams |= {i for i in (f.get("sh") or []) if i}
            problems.append(f"365Scores fixtures unavailable for {league}" + (f" — kept {len(kept)} from the last run" if kept else ""))
            continue
        s365_ok += 1
        codes = sources.fd_codes(league)
        for g in games:
            kickoff = sources.parse_kickoff(g.get("startTime"))
            if not kickoff or not now - dt.timedelta(hours=3) < kickoff <= horizon:
                continue
            home, away = g["homeCompetitor"]["name"], g["awayCompetitor"]["name"]
            cup = sources.COMPETITIONS[league].get("cup")
            if cup and re.search(r"qualif|prelim", g.get("stageName") or "", re.I):
                continue   # early rounds between amateur clubs: no data, no bet builders
            fd_home, fd_away = (find_team(home, codes, today), find_team(away, codes, today)) if codes else (None, None)
            # Whatever a source couldn't give this time, the last run may have.
            old = prev_fixtures.get(str(g["id"])) or {}
            old_fd = old.get("fd") or {}
            fd_home, fd_away = fd_home or old_fd.get("home"), fd_away or old_fd.get("away")
            if cup and not (fd_home or fd_away):
                continue   # two clubs from outside the leagues HAWK rates
            ids = sources.sh_team_ids(home, away, league)
            referee = sources.sh_referee(home, away)
            pm = sources.pm_match(league, home, away, kickoff)
            uk = []
            if fd_home and fd_away and fd_home[0] == fd_away[0]:
                uk = sources.fd_upcoming_quotes(fd_home[0], fd_home[1], fd_away[1], kickoff.date())
            ids = ids or (tuple(old["sh"]) if old.get("sh") else None)
            fixtures[str(g["id"])] = {
                "league": league, "home": home, "away": away, "kickoff": kickoff.isoformat(),
                "fd": {"home": fd_home, "away": fd_away}, "sh": list(ids) if ids else None,
                "ref": referee or old.get("ref"), "pm_slug": (pm or {}).get("slug") or old.get("pm_slug"), "uk": uk or old.get("uk") or [],
            }
            codes_needed |= {c[0] for c in (fd_home, fd_away) if c}
            sh_teams |= {i for i in (ids or []) if i}
            if not ids:
                problems.append(f"StatsHub teams not found: {home} v {away}")
    print(f"{len(fixtures)} fixtures, {len(codes_needed)} leagues to rate, {len(sh_teams)} squads to fetch")

    # 2. Team ratings per league (the last run's, if football-data is down).
    stamp = now.isoformat()
    rated = {"fresh": 0, "reused": 0, "missing": 0, "oldest": stamp}
    for code in sorted(codes_needed):
        profile = model.build_profile(*sources.fd_seasons(code, today), today)
        if profile:
            write(out_dir / "profiles" / f"{code}.json", profile_json(profile, stamp))
            rated["fresh"] += 1
        elif (old := reuse("profiles", f"{code}.json")):
            write(out_dir / "profiles" / f"{code}.json", old)
            rated["reused"] += 1
            rated["oldest"] = min(rated["oldest"], old["built"])
            problems.append(f"football-data didn't answer for {code} — using ratings from {old['built'][:16].replace('T', ' ')}")
        else:
            rated["missing"] += 1
            problems.append(f"no football-data ratings for {code}")

    # 3. Player stats per squad (throttled inside sources, so StatsHub isn't
    # hammered; the last run's file if StatsHub fails for a squad).
    def fetch(team_id):
        data = sources.sh_players(team_id)
        if data:
            write(out_dir / "players" / f"{team_id}.json", players_json(team_id, data, stamp))
            return "fresh", stamp
        old = reuse("players", f"{team_id}.json")
        if old:
            write(out_dir / "players" / f"{team_id}.json", old)
            return "reused", old["built"]
        return "missing", None
    with ThreadPoolExecutor(2) as ex:
        results = list(ex.map(fetch, sorted(sh_teams)))
    squads = {k: sum(1 for r, _ in results if r == k) for k in ("fresh", "reused", "missing")}
    squads["oldest"] = min([b for _, b in results if b] or [stamp])
    if squads["reused"]:
        problems.append(f"StatsHub failed for {squads['reused']} squads — using their last stats (oldest {squads['oldest'][:16].replace('T', ' ')})")
    if squads["missing"]:
        problems.append(f"player stats missing for {squads['missing']} of {len(sh_teams)} squads (StatsHub)")

    # 4. How each source did, and when it last worked (for the site's data
    # health line and the Action's alert).
    def share(ok, total):
        return total == 0 or ok / total >= SOURCE_OK_SHARE
    worked = {"365Scores": share(s365_ok, s365_ok + s365_failed),
              "football-data": share(rated["fresh"], len(codes_needed)),
              "StatsHub": share(squads["fresh"], len(sh_teams))}
    prev_sources = prev_meta.get("sources") or {}
    status = {}
    for name, ok in worked.items():
        last_ok = stamp if ok else (prev_sources.get(name) or {}).get("last_ok") or prev_built
        status[name] = {"ok": ok, "last_ok": last_ok}
    alerts = [name for name, s in status.items() if not s["ok"] and (not parse_time(s["last_ok"]) or now - parse_time(s["last_ok"]) > ALERT_AFTER)]

    write(out_dir / "fixtures.json", {"fixtures": fixtures})
    write(out_dir / "meta.json", {"generated": stamp, "seconds": round(time.time() - started),
                                  "fixtures": len(fixtures), "squads": squads["fresh"] + squads["reused"],
                                  "sources": status, "health": {"fixtures": {"leagues_ok": s365_ok, "leagues_failed": s365_failed},
                                                                "ratings": rated, "players": squads},
                                  "alerts": alerts, "problems": problems})
    print(f"done in {time.time() - started:.0f}s; squads {squads}; ratings {rated}; {len(problems)} problems")
    for p in problems:
        print("  -", p)
    for name in alerts:
        print(f"  !! {name} hasn't worked since {status[name]['last_ok']}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "data"))
