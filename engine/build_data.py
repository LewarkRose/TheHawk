"""Builds the data files the HAWK website needs but can't fetch itself.

Browsers can read 365Scores and Polymarket directly, but StatsHub (player
stats) and football-data.co.uk (team ratings) don't allow cross-site
requests. The GitHub Action runs this every few hours and publishes the
results with the site:

  data/meta.json              when the data was built, and any problems
  data/fixtures.json          per upcoming fixture: football-data team names,
                              StatsHub team ids, referee card average,
                              Polymarket page, UK bookmaker odds snapshot
  data/profiles/<code>.json   team ratings for one league (model.build_profile)
  data/players/<id>.json      per-player stats, last 20 matches, one team

Run locally:  python build_data.py ../data
"""
import datetime as dt
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import model
import sources

DAYS_AHEAD = 8
# Player rows are stored as arrays to keep the files small; the website reads
# them in this order.
PLAYER_MATCH_FIELDS = ["ts", "opp", "home", "score", "comp", "minutes", "shots", "sot", "goals", "xg",
                       "yellow", "red", "sub_in", "assists", "xa", "fouls", "fouled", "tackles", "offsides", "saves"]
ROUNDED = {"xg", "xa"}


def find_team(name, codes, today):
    """(code, football-data name) for a 365Scores team, searching the given
    league codes' current-season team lists."""
    cur_season, _ = sources.fd_season_codes(today)
    best = None
    for code in codes:
        teams = sources.fd_teams(code, cur_season)
        match = sources.best_match(name, teams, threshold=0.75 if len(codes) > 1 else 0.7)
        if match:
            score = sources.name_similarity(name, match)
            if best is None or score > best[0]:
                best = (score, code, match)
    return [best[1], best[2]] if best else None


def profile_json(profile):
    return {"avg": profile["avg"], "teams": profile["teams"], "avg_cards_total": profile["avg_cards_total"],
            "referees": profile["referees"]}


def players_json(team_id, data):
    out = []
    for p in data["players"]:
        rows = [[round(m[f], 2) if f in ROUNDED else m[f] for f in PLAYER_MATCH_FIELDS] for m in p["matches"]]
        out.append({"name": p["name"], "position": p["position"], "m": rows})
    return {"team": team_id, "fields": PLAYER_MATCH_FIELDS, "players": out}


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def main(out_dir):
    started = time.time()
    today = dt.date.today()
    now = dt.datetime.now(dt.timezone.utc)
    horizon = now + dt.timedelta(days=DAYS_AHEAD)
    problems = []

    # 1. Upcoming fixtures, and what each one needs from the blocked sources.
    fixtures, codes_needed, sh_teams = {}, set(), set()
    for league in sources.LEAGUES:
        games = sources.s365_fixtures(league)
        if games is None:
            problems.append(f"365Scores fixtures unavailable for {league}")
            continue
        codes = ([sources.FD_LEAGUE_CODES[league]] if league in sources.FD_LEAGUE_CODES
                 else list(sources.FD_LEAGUE_CODES.values()) + list(sources.FD_EXTRA_CODES))
        for g in games:
            kickoff = sources.parse_kickoff(g.get("startTime"))
            if not kickoff or not now - dt.timedelta(hours=3) < kickoff <= horizon:
                continue
            home, away = g["homeCompetitor"]["name"], g["awayCompetitor"]["name"]
            fd_home, fd_away = find_team(home, codes, today), find_team(away, codes, today)
            ids = sources.sh_team_ids(home, away, league)
            referee = sources.sh_referee(home, away)
            pm = sources.pm_match(league, home, away, kickoff)
            uk = []
            if fd_home and fd_away and fd_home[0] == fd_away[0]:
                uk = sources.fd_upcoming_quotes(fd_home[0], fd_home[1], fd_away[1], kickoff.date())
            fixtures[str(g["id"])] = {
                "league": league, "home": home, "away": away, "kickoff": kickoff.isoformat(),
                "fd": {"home": fd_home, "away": fd_away}, "sh": list(ids) if ids else None,
                "ref": referee, "pm_slug": (pm or {}).get("slug"), "uk": uk,
            }
            codes_needed |= {c[0] for c in (fd_home, fd_away) if c}
            sh_teams |= {i for i in (ids or []) if i}
            if not ids:
                problems.append(f"StatsHub teams not found: {home} v {away}")
    print(f"{len(fixtures)} fixtures, {len(codes_needed)} leagues to rate, {len(sh_teams)} squads to fetch")

    # 2. Team ratings per league.
    cur_season, prev_season = sources.fd_season_codes(today)
    for code in sorted(codes_needed):
        profile = model.build_profile(sources.fd_matches(code, cur_season) or [],
                                      sources.fd_matches(code, prev_season) or [], today)
        if profile:
            write(out_dir / "profiles" / f"{code}.json", profile_json(profile))
        else:
            problems.append(f"no football-data ratings for {code}")

    # 3. Player stats per squad (throttled inside sources, so StatsHub isn't hammered).
    def fetch(team_id):
        data = sources.sh_players(team_id)
        if data:
            write(out_dir / "players" / f"{team_id}.json", players_json(team_id, data))
            return True
        return False
    with ThreadPoolExecutor(2) as ex:
        ok = sum(ex.map(fetch, sorted(sh_teams)))
    if ok < len(sh_teams):
        problems.append(f"player stats missing for {len(sh_teams) - ok} of {len(sh_teams)} squads (StatsHub)")

    write(out_dir / "fixtures.json", {"fixtures": fixtures})
    write(out_dir / "meta.json", {"generated": now.isoformat(), "seconds": round(time.time() - started),
                                  "fixtures": len(fixtures), "squads": ok, "problems": problems})
    print(f"done in {time.time() - started:.0f}s; {ok}/{len(sh_teams)} squads; {len(problems)} problems")
    for p in problems:
        print("  -", p)


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "data"))
