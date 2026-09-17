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
  data/results365/<code>.json finished matches with team stats from 365Scores,
                              filled in a few hundred matches per run — the
                              backup for team ratings when football-data is down

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
MAX_AGE = {"profiles": dt.timedelta(days=10), "players": dt.timedelta(days=4), "results365": dt.timedelta(days=60)}
# 365Scores backup ratings: how far back to keep matches, how many match-stat
# requests one run may make (one per match; the history fills in over several
# runs), and how old football-data's last ratings may be before 365Scores' win.
S365_HISTORY_DAYS = 400
S365_STATS_PER_RUN = 900
S365_SECONDS = 300   # time this step may take per run (the Action has 30 minutes in all)
FD_STALE_AFTER = dt.timedelta(days=3)
# A source counts as working when at least this share of its requests did.
SOURCE_OK_SHARE = 0.8
ALERT_AFTER = dt.timedelta(hours=24)
# Player rows are stored as arrays to keep the files small; the website reads
# them in this order.
PLAYER_MATCH_FIELDS = ["ts", "opp", "home", "score", "comp", "minutes", "shots", "sot", "goals", "xg",
                       "yellow", "red", "sub_in", "assists", "xa", "fouls", "fouled", "tackles", "offsides", "saves"]
ROUNDED = {"xg", "xa"}


def find_team(name, codes, today, fallback=None):
    """(code, football-data name) for a 365Scores team, searching the given
    league codes' current-season team lists (or, with football-data down,
    `fallback(code)`: the names in the ratings HAWK will publish)."""
    best = None
    for code in codes:
        teams = sources.fd_teams(code, today) or (fallback(code) if fallback else [])
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


def results_rows(old):
    """Stored result rows (lists) -> dicts keyed like football-data's matches."""
    fields = (old or {}).get("fields") or sources.RESULT_FIELDS
    return [dict(zip(fields, r)) for r in (old or {}).get("rows") or []]


def profile_from_365(rows, today, aliases):
    """Team ratings from 365Scores results, in the same shape as football-data's.
    Matches without stats still count for goals. `aliases` are other names the
    site knows these teams by (football-data's), added as copies."""
    by_season = {}
    for r in rows:
        m = {k: r.get(k) for k in ("hg", "ag", "hxg", "axg", "hs", "as", "hst", "ast", "hc", "ac", "hy", "ay", "hr", "ar")}
        m.update(home=r["home"], away=r["away"], referee="", date=dt.date.fromisoformat(r["date"]))
        by_season.setdefault(r.get("season") or 0, []).append(m)
    order = sorted(by_season, key=lambda k: max(m["date"] for m in by_season[k]), reverse=True)
    if not order:
        return None
    profile = model.build_profile(by_season[order[0]], by_season[order[1]] if len(order) > 1 else [], today)
    if not profile:
        return None
    names = list(profile["teams"])
    for alias in aliases:
        if alias not in profile["teams"] and (hit := sources.closed_match(alias, names)):
            profile["teams"][alias] = profile["teams"][hit]
    return profile


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

    # football-data down: team names come from the ratings HAWK will publish
    # instead — last run's profile, or 365Scores' results for that league.
    fallback_names_cache = {}
    def fallback_names(code):
        if code not in fallback_names_cache:
            old = previous(f"profiles/{code}.json")
            names = list((old or {}).get("teams") or {})
            if not names:
                names = sorted({r[k] for r in results_rows(previous(f"results365/{code}.json")) for k in ("home", "away")})
            fallback_names_cache[code] = names
        return fallback_names_cache[code]

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
            fd_home, fd_away = (find_team(home, codes, today, fallback_names), find_team(away, codes, today, fallback_names)) if codes else (None, None)
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

    print(f"fixtures step done in {time.time() - started:.0f}s")
    # 2a. 365Scores results with team stats, kept up to date for every league
    # HAWK rates: new finished matches each run, the older history a few
    # hundred matches at a time (newest first) until S365_HISTORY_DAYS is covered.
    stamp = now.isoformat()
    since = today - dt.timedelta(days=S365_HISTORY_DAYS)
    results365, cursors, budget = {}, {}, S365_STATS_PER_RUN
    step_end = time.time() + S365_SECONDS
    def listing(code):
        prev = previous(f"results365/{code}.json") or {}
        rows = {r["id"]: r for r in results_rows(prev) if r["date"] >= since.isoformat()}
        got = sources.s365_results(sources.FD_TO_S365[code], since, set(rows), prev.get("cursor"), deadline=step_end - 120)
        if got is None:
            return code, rows, prev.get("cursor"), prev.get("done", False)
        fresh, cursor, done = got
        for r in fresh:
            rows[r["id"]] = {**r, "got": 0}
        return code, rows, cursor, done
    with ThreadPoolExecutor(4) as ex:
        for code, rows, cursor, done in ex.map(listing, sorted(c for c in codes_needed if c in sources.FD_TO_S365)):
            if rows:
                results365[code], cursors[code] = rows, (cursor, done)
    pending = sorted(((r["date"], code, r) for code, rows in results365.items() for r in rows.values() if not r.get("got")),
                     key=lambda x: x[0], reverse=True)
    print(f"365Scores results listed in {time.time() - started:.0f}s")
    def fill(item):
        _, _, r = item
        if time.time() > step_end:
            return
        st = sources.s365_match_stats(r["id"], r.get("hid"), r.get("aid"))
        if st is not None:
            r.update(st, got=1)
    with ThreadPoolExecutor(3) as ex:
        list(ex.map(fill, pending[:budget]))
    for code, rows in results365.items():
        ordered = sorted(rows.values(), key=lambda r: r["date"], reverse=True)
        write(out_dir / "results365" / f"{code}.json", {"built": stamp, "cursor": cursors[code][0], "done": cursors[code][1], "fields": sources.RESULT_FIELDS,
                                                        "rows": [[r.get(f) for f in sources.RESULT_FIELDS] for r in ordered]})
    have_stats = sum(1 for rows in results365.values() for r in rows.values() if r.get("got"))
    s365_matches = sum(len(rows) for rows in results365.values())
    print(f"365Scores results: {s365_matches} matches in {len(results365)} leagues, {have_stats} with stats "
          f"({min(len(pending), budget)} filled this run, {max(0, len(pending) - budget)} still to fill)")

    # 2b. Team ratings per league: football-data's; if it's down, last run's
    # while they're under FD_STALE_AFTER old, then 365Scores' (named so the
    # fixtures' football-data names still find their teams).
    rated = {"fresh": 0, "reused": 0, "missing": 0, "s365": 0, "oldest": stamp}
    for code in sorted(codes_needed):
        profile = model.build_profile(*sources.fd_seasons(code, today), today)
        old = None if profile else reuse("profiles", f"{code}.json")
        old_ok = old and now - parse_time(old["built"]) <= FD_STALE_AFTER and not old.get("source")
        backup = None
        if not profile and not old_ok and code in results365:
            aliases = set((old or {}).get("teams") or {}) | {f["fd"][side][1] for f in fixtures.values()
                                                              for side in ("home", "away") if f["fd"][side] and f["fd"][side][0] == code}
            backup = profile_from_365(results365[code].values(), today, aliases)
        if profile:
            write(out_dir / "profiles" / f"{code}.json", profile_json(profile, stamp))
            rated["fresh"] += 1
        elif backup:
            write(out_dir / "profiles" / f"{code}.json", {**profile_json(backup, stamp), "source": "365Scores"})
            rated["s365"] += 1
            problems.append(f"football-data didn't answer for {code} — ratings built from 365Scores results")
        elif old:
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
