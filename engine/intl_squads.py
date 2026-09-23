"""Player records for national teams, so internationals get real player props.

Why this exists
---------------
HAWK's player stats are built per club: data/players/<statshub id>.json, and each
fixture in fixtures.json carries sh: [home id, away id] so the engine knows which
two files to read. StatsHub has no "Netherlands", so an international's sh is null
and every player is unknown — the engine then suppresses player props rather than
invent them from position averages.

Every one of those players does play for a club HAWK could know about, so this
script joins the two up:

    international lineup -> athleteId -> 365Scores clubId -> club NAME
    club name -> StatsHub team id (fuzzy, the weak step)
    StatsHub team -> that player's own match rows
    -> data/players/intl_<competitorId>.json, and sh set on the fixture

Written that way the engine needs no change at all: it loads the file like any
club squad.

Why it is a separate script
---------------------------
build_data.py builds everything HAWK knows. If this work threw inside it, a bad
name match or a slow feed would take ratings and player stats for every league
down with it. Here it runs afterwards, touches only international fixtures, and
exits 0 whatever happens — the worst case is that internationals keep working
exactly as they do today, with no player props.

Run: python engine/intl_squads.py <out_dir>     (after build_data.py)
"""

import datetime as dt
import json
import sys
from pathlib import Path

import sources
from build_data import players_json, write

# The competitions between national teams, and their 365Scores ids — the same
# six the engine carries in LEAGUE_GROUPS/INTL, so the league names match.
INTL_COMPS = {"World Cup": 5930, "Euro": 6316, "Nations League": 7016,
              "World Cup Qualifiers": 5421, "Copa America": 595, "Internationals": 570}
INTL_LEAGUES = set(INTL_COMPS)
DAYS_AHEAD = 8          # the horizon build_data.py uses for club fixtures
SQUAD_MIN = 11          # below this the join has clearly failed; write nothing
MATCH_LIMIT = 20        # matches per player, as for clubs
HOURS_AHEAD = 96        # only fixtures close enough for the squad to be named
CANDIDATE_CAP = 3       # StatsHub clubs to test per name before giving up
NAME_THRESHOLD = 0.8    # player name -> club squad row


def _athletes(ids):
    """365Scores athlete records (they carry clubId) for a list of athlete ids."""
    out = {}
    for i in range(0, len(ids), 40):
        chunk = ",".join(str(x) for x in ids[i:i + 40])
        data = sources._s365("athletes", athletes=chunk)
        for a in (data or {}).get("athletes", []) or []:
            out[a.get("id")] = a
    return out


def _club_names(club_ids):
    """365Scores competitor id -> club name."""
    out = {}
    for i in range(0, len(club_ids), 40):
        chunk = ",".join(str(x) for x in club_ids[i:i + 40])
        data = sources._s365("competitors", competitors=chunk)
        for c in (data or {}).get("competitors", []) or []:
            if c.get("id") and c.get("name"):
                out[c["id"]] = c["name"]
    return out


def _club_squad(name, want):
    """The rows of the StatsHub club called `name`, keyed by player name.

    Which club that is gets decided by who actually plays there: StatsHub
    offers both "Brighton" and "Brighton & Hove Albion", and both "Liverpool"
    and "AFC Liverpool", scoring identically on name. Asking which of them
    fields `want` settles it; name similarity never can."""
    best = (0, {})
    for _, _, sh_id in sources.sh_team_choices(name)[:CANDIDATE_CAP]:
        rows = {p["name"]: p for p in (sources.sh_players(sh_id, limit=MATCH_LIMIT) or {}).get("players") or []
                if p.get("name")}
        hits = sum(1 for w in want if sources.best_match(w, rows, threshold=NAME_THRESHOLD))
        if hits > best[0]:
            best = (hits, rows)
        if hits == len(want):
            break
    return best[1]


def squad_for(game_id, competitor):
    """[{name, position, matches}] for one national side, from its players'
    club records. Empty when the lineup isn't named or the join fails."""
    game = (sources._s365("game", gameId=game_id) or {}).get("game") or {}
    side = next((k for k in ("homeCompetitor", "awayCompetitor")
                 if (game.get(k) or {}).get("id") == competitor), None)
    if not side:
        return []
    members = ((game[side].get("lineups") or {}).get("members")) or []
    by_id = {m.get("id"): m for m in game.get("members") or []}
    ath_ids = [by_id[m["id"]]["athleteId"] for m in members
               if m.get("id") in by_id and by_id[m["id"]].get("athleteId")]
    if len(ath_ids) < SQUAD_MIN:
        return []

    athletes = _athletes(ath_ids)
    # The lineup includes the manager, whose "club" is the national team
    # itself — hence a Jürgen Klopp turning up in Germany's squad.
    sides = {(game.get(k) or {}).get("id") for k in ("homeCompetitor", "awayCompetitor")}
    athletes = {k: a for k, a in athletes.items() if a.get("clubId") not in sides}
    by_club = {}
    for a in athletes.values():
        if a.get("clubId") and a.get("name"):
            by_club.setdefault(a["clubId"], []).append(a["name"])
    clubs = _club_names(sorted(by_club))
    squads = {cid: _club_squad(cname, by_club[cid]) for cid, cname in clubs.items()}

    out, missed = [], []
    for a in athletes.values():
        rows = squads.get(a.get("clubId")) or {}
        hit = sources.best_match(a.get("name") or "", rows, threshold=NAME_THRESHOLD) if rows else None
        if not hit:
            missed.append(a.get("name"))
            continue
        p = rows[hit]
        out.append({"name": a["name"], "position": p.get("position"), "matches": p.get("matches") or []})
    if missed:
        print(f"[intl] {competitor}: no club record for {len(missed)} of {len(athletes)} — {', '.join(filter(None, missed[:5]))}")
    return out


def intl_fixtures(now):
    """Upcoming national-team fixtures, in fixtures.json's shape.

    build_data.py never sees these: sources.COMPETITIONS is club leagues only,
    so an international reaches the app from the live feed alone and shows
    "not in HAWK's data files yet". No football-data code and no club ratings
    exist for a national side, so fd stays empty and the result, goals, corner
    and card markets keep running off the bookmakers' prices as they do now.
    What this adds is the hook the player legs need: sh."""
    out = {}
    horizon = now + dt.timedelta(days=DAYS_AHEAD)
    for league, cid in INTL_COMPS.items():
        games = (sources._s365("games/fixtures", competitions=cid) or {}).get("games") or []
        for g in games:
            ko = sources.parse_kickoff(g.get("startTime"))
            home = (g.get("homeCompetitor") or {}).get("name")
            away = (g.get("awayCompetitor") or {}).get("name")
            if not ko or not home or not away or not g.get("id"):
                continue
            # Senior men's sides only, the same rule HAWK applies to clubs.
            # "Friendly International" in particular mixes in the women's and
            # the U17-U19 teams, and HAWK has no player data for any of them.
            if sources._NOT_MENS_FOOTBALL.search(home) or sources._NOT_MENS_FOOTBALL.search(away):
                continue
            ko = ko if ko.tzinfo else ko.replace(tzinfo=dt.timezone.utc)
            if not (now - dt.timedelta(hours=3) < ko <= horizon):
                continue
            out[str(g["id"])] = {
                "league": league, "home": home, "away": away, "kickoff": ko.isoformat(),
                "fd": {"home": None, "away": None}, "sh": None,
                "ref": None, "pm_slug": None, "uk": [],
            }
    return out


def main(out_dir):
    out_dir = Path(out_dir)
    fx_path = out_dir / "fixtures.json"
    if not fx_path.exists():
        print("[intl] no fixtures.json — run build_data.py first")
        return 0
    blob = json.loads(fx_path.read_text(encoding="utf-8"))
    fixtures = blob.setdefault("fixtures", {})
    now = dt.datetime.now(dt.timezone.utc)
    stamp = now.isoformat()

    added = 0
    for fid, f in intl_fixtures(now).items():
        if fid in fixtures:
            f["sh"] = fixtures[fid].get("sh")       # keep a squad an earlier run linked
        else:
            added += 1
        fixtures[fid] = f
    changed = added > 0
    print(f"[intl] {added} international fixture(s) added to fixtures.json")

    todo = []
    for fid, f in fixtures.items():
        if f.get("league") not in INTL_LEAGUES or f.get("sh"):
            continue
        ko = f.get("kickoff")
        try:
            t = dt.datetime.fromisoformat(ko)
            t = t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)
        except (TypeError, ValueError):
            continue
        if now - dt.timedelta(hours=3) < t <= now + dt.timedelta(hours=HOURS_AHEAD):
            todo.append((fid, f))
    if not todo:
        print("[intl] no international fixtures near enough to build squads for")
        if changed:
            write(fx_path, blob)
        return 0

    print(f"[intl] {len(todo)} international fixture(s) to try")
    built = {}
    for fid, f in todo:
        game = (sources._s365("game", gameId=fid) or {}).get("game") or {}
        pair = []
        for key in ("homeCompetitor", "awayCompetitor"):
            comp = (game.get(key) or {}).get("id")
            if not comp:
                pair = []
                break
            key_id = f"intl_{comp}"
            if key_id not in built:
                try:
                    squad = squad_for(fid, comp)
                except Exception as e:                      # never take the run down
                    print(f"[intl] {f['home']} v {f['away']}: {type(e).__name__} {e}")
                    squad = []
                if len(squad) >= SQUAD_MIN:
                    write(out_dir / "players" / f"{key_id}.json",
                          players_json(key_id, {"players": squad}, stamp))
                    built[key_id] = len(squad)
                    print(f"[intl] {(game.get(key) or {}).get('name')}: {len(squad)} players")
                else:
                    built[key_id] = 0
            if not built[key_id]:
                pair = []
                break
            pair.append(key_id)
        if len(pair) == 2:
            f["sh"] = pair
            changed = True

    if changed:
        write(fx_path, blob)
    good = sum(1 for v in built.values() if v)
    print(f"[intl] {good} national squad(s) written, {sum(1 for _, f in todo if f.get('sh'))} fixture(s) linked")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data"))
    except Exception as e:                                  # a failure here must never fail the build
        print(f"[intl] giving up: {type(e).__name__} {e}")
        sys.exit(0)
