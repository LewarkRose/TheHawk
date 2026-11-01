"""Maltese player history, from the Malta FA's own match centre.

WHY THIS EXISTS
365Scores publishes a lineup for about one Maltese Premier League game in five
and per-player stats for none of them, so Malta shipped as team markets only.
Thirteen sources were checked on 1 Nov 2026 (see the Malta note in
engine/sources.py). ESPN dropped Malta after 2024/25; FotMob never carried it;
FootyStats has season aggregates; Soccerway and Transfermarkt have line-ups,
goals, cards and minutes but no shots or tackles; SofaScore has everything and
answers 403 to this machine AND to a GitHub runner, on plain requests, so it is
out on its own terms.

The Malta FA's own match centre is open: no key, no bot wall, plain JSON, and
it is the federation publishing its own competition. It gives the confirmed XI
with shirt numbers, the referee, and — the part that matters — a per-player
event list from which minutes, goals and cards fall out.

WHAT IT CANNOT DO, AND THIS IS NOT A BUG TO FIX LATER
There are no shots, shots on target, tackles, fouls or offsides. The MFA's own
/statistics endpoint returns {"matchStatistics": []} on every finished match
checked (six of them). Nobody collects those numbers for Malta. So every row
this module writes leaves them None, and None must stay None all the way to the
builder: a missing shot count read as a zero would have HAWK price "under 0.5
shots" at a near-certainty and offer it as value. See MALTA_FIELDS below.

NO CORS, SO THIS IS PIPELINE-ONLY
api.mfa.com.mt sends no Access-Control-Allow-Origin, so unlike ESPN — which
builder/engine.js fetches live in the browser near kick-off — nothing here can
reach the app directly. It arrives as a built data file, which is right for
history (history is never fresh) and weak for a confirmed XI (the build runs
every 2 hours; line-ups land about an hour before kick-off).
"""

import datetime as dt
import re
import time

import sources

MALTA_PREMIER = 58539          # competitionTypeId: "VBET Malta Premier"
HISTORY_PAGE = 200             # 64 matches so far in 26/27, back to 14 Aug

# MFA competitor id -> 365Scores competitor id. Twelve clubs, mapped by hand and
# checked one by one, because fuzzy matching is the wrong tool on this list:
# "Balzan"/"Balzan Youths FC", "Hibernians"/"Hibernians Paola" and
# "Zabbar St.Patrick"/"Zabbar SP" are the same club under names a similarity
# score reads as different, while "Birkirkara"/"Birzebbuga St.Peter's" are two
# clubs a loose threshold can read as one. A wrong entry here does not fail --
# it files one club's players under another, silently, forever.
TEAM_365 = {
    39612: 14611,   # Balzan                 -> Balzan Youths FC
    39636: 14610,   # Birkirkara             -> Birkirkara FC
    40417: 16528,   # Birzebbuga St.Peter's  -> Birzebbuga St. Peters
    39637: 8489,    # Floriana               -> Floriana FC
    39615: 14800,   # Gzira United           -> Gzira United
    39639: 14989,   # Hamrun Spartans        -> Hamrun Spartans
    39640: 12820,   # Hibernians             -> Hibernians Paola
    39617: 5647,    # Marsaxlokk             -> Marsaxlokk
    39606: 14607,   # Mosta                  -> Mosta FC
    39646: 5973,    # Sliema Wanderers       -> Sliema Wanderers
    39648: 5590,    # Valletta               -> Valletta FC
    40419: 28173,   # Zabbar St.Patrick      -> Zabbar SP
}

# The fields Malta can actually fill. Everything else in build_data's
# PLAYER_MATCH_FIELDS is written as None, NOT zero — a zero is a measurement and
# this is an absence. builder/engine.js gates on exactly this.
MALTA_FIELDS = {"ts", "opp", "home", "score", "comp", "minutes", "goals",
                "yellow", "red", "sub_in"}

# A goal is a goal however it was scored, so an anytime-scorer rate counts both.
# PENALTY_FAILED exists as its own type and is deliberately not counted.
GOAL_TYPES = {"GOAL", "PENALTY"}
RED_TYPES = {"RED", "SECOND_YELLOW"}


def _ts(start_date):
    """\"2026-10-31T18:00:00.0000000Z\" -> unix seconds.

    Its own parser rather than sources._s365_ts, which exists to read 365Scores'
    NAIVE strings as Europe/London. The MFA stamps an explicit Z, so reading it
    as London would move every Maltese match by an hour for half the year — and
    engine.js subtracts these from the kick-off to get days of rest, so a drifting
    timestamp is a quietly wrong number rather than an error. Python's fromisoformat
    rejects the seven-digit fraction, so it is trimmed to six.
    """
    text = str(start_date or "").strip()
    if not text:
        return None
    text = re.sub(r"\.(\d{6})\d*", r".\1", text).replace("Z", "+00:00")
    try:
        return int(dt.datetime.fromisoformat(text).timestamp())
    except ValueError:
        return None


def canonical_name(name):
    """One spelling for a player the MFA spells two ways.

    The match centre prints the HOME side as "Diego CAMARA CALLEJA" and the AWAY
    side as "MARCHEGIANI Gabriele" — given name first at home, surname first
    away, for the same player in the same competition. Keying history by the
    string therefore filed every player twice, once per venue: squads came out
    ~42 strong against a real ~22, and a regular who had started eleven games
    showed six. That is why this module keys by the numeric player id and uses
    this only for display.

    The rule is the capitals: the MFA upper-cases the surname in both layouts,
    so the ALL-CAPS tokens are the family name wherever they sit and the rest is
    the given name. Falls back to the raw string when a name is all caps or
    none, which no row in 26/27 is, but a fallback costs nothing.
    """
    text = " ".join(str(name or "").split())
    if not text:
        return ""
    caps = [w for w in text.split(" ") if w.isupper()]
    rest = [w for w in text.split(" ") if not w.isupper()]
    return f"{' '.join(rest)} {' '.join(caps)}" if caps and rest else text


def _minute(text):
    """\"90+2'\" -> 92, \"61'\" -> 61. Stoppage is added on because a player
    subbed at 90+2 played those two minutes and a per-90 rate should say so."""
    found = [int(n) for n in re.findall(r"\d+", str(text or ""))]
    return sum(found) if found else None


def past_matches(competition=MALTA_PREMIER, limit=HISTORY_PAGE):
    """FINISHED matches, newest first. None if the MFA is unreachable.

    The status filter is not defensive tidying, it is the whole correctness of
    this module. "pastMatches" is the match centre's name for the list under
    PAST RESULTS, and it carries today's kick-off from the moment the line-up is
    published — SCHEDULED, no events, twenty-two confirmed names. Without the
    filter every starter in it scores 90 minutes and nothing else, so an unplayed
    match enters the history as a game in which nobody shot, scored or was booked
    and every rate is dragged towards zero. Caught on the first live run: 65 rows
    came back, 64 PLAYED and one SCHEDULED.
    """
    rows = sources.mfa_past_matches(competition, limit)
    if rows is None:
        return None
    return sorted((r for r in rows if r.get("id") and r.get("status") == "PLAYED"),
                  key=lambda r: r.get("startDate") or "", reverse=True)


def _played(player, events):
    """Minutes, or None when the player never came on.

    Verified against 53725530 on 1 Nov 2026, 14 substitution events with no
    exception: `playerId` is the man coming ON and `playerIdTwo` the man coming
    OFF. HAWK has read a substitution field backwards once already (StatsHub's
    sub_in meant "came off"), so this is measured, not assumed — and the check
    is by id rather than by name, because these names collide across clubs.
    """
    started = bool(player.get("startingLineup"))
    for e in events:
        if e.get("type") != "SUBSTITUTION":
            continue
        when = _minute(e.get("time"))
        if when is None:
            continue
        if e.get("playerIdTwo") == player.get("id"):
            return when            # came off
        if e.get("playerId") == player.get("id"):
            return max(0, 90 - when)   # came on
    return 90 if started else None   # an unused substitute has no row at all


def match_rows(match):
    """One match -> {365Scores competitor id: [player row, ...]}, or None if the
    line-up could not be read. A match whose clubs are not both mapped is
    skipped rather than guessed at."""
    lineup = sources.mfa_lineup(match["id"])
    if not lineup:
        return None
    ts = _ts(match.get("startDate"))
    if not ts:
        return None
    sides = [("homeTeam", "awayTeam", True), ("awayTeam", "homeTeam", False)]
    out = {}
    for key, other_key, at_home in sides:
        mfa_id = (match.get(key) or {}).get("id")
        cid = TEAM_365.get(mfa_id)
        if not cid:
            continue
        opponent = ((match.get(other_key) or {}).get("name") or "").strip()
        rows = []
        for player in (lineup.get(key) or {}).get("players") or []:
            events = player.get("events") or []
            minutes = _played(player, events)
            if minutes is None:
                continue
            types = [e.get("type") for e in events]
            rows.append({
                "ts": ts,
                "opp": opponent,
                "home": at_home,
                "score": None,
                "comp": match.get("competitionName") or "Maltese Premier League",
                "minutes": minutes,
                "goals": sum(1 for t in types if t in GOAL_TYPES),
                "yellow": sum(1 for t in types if t == "YELLOW"),
                "red": sum(1 for t in types if t in RED_TYPES),
                "sub_in": not player.get("startingLineup"),
                "pid": player.get("id"),
                "name": canonical_name(player.get("name")),
                # The MFA says only whether a man is a keeper. Outfield positions
                # are not published, so everyone else is M: it is the position
                # whose card and minute priors sit between a defender's and a
                # forward's, and with ten-plus matches of real minutes a player's
                # own rate outweighs the prior anyway. It is still a guess, and
                # it is the one number in this file that is.
                "position": "G" if player.get("isGoalkeeper") else "M",
            })
        if rows:
            out[cid] = rows
    return out or None


def player_history(known=(), competition=MALTA_PREMIER, budget=None):
    """{365Scores cid: {name: {"position", "matches": {ts: row}}}} — build_data's
    own history shape, so it merges with what is already on disk.

    `known` is the set of (cid, ts) already stored: a match in it is not fetched
    again, so a full build costs 64 line-up calls once and a handful thereafter.
    `budget` is a deadline in time.time() terms; running out stops the walk and
    leaves the rest for the next run, exactly as the 365Scores player walk does.

    Rows carry ONLY the fields Malta has. build_data fills the rest with None —
    not here, because PLAYER_MATCH_FIELDS lives there and two copies of a field
    list is how they drift apart.

    Returns (history, matches_fetched), because a count smuggled into the history
    dict under a reserved key is a trap for every caller that iterates club ids.
    """
    matches = past_matches(competition)
    if matches is None:
        return None, 0
    history, by_pid, fetched = {}, {}, 0
    for match in matches:
        if budget and time.time() > budget:
            break
        ts = _ts(match.get("startDate"))
        sides = [(match.get(k) or {}).get("id") for k in ("homeTeam", "awayTeam")]
        cids = [TEAM_365.get(i) for i in sides]
        # Nothing to learn from this one: both clubs already have it stored.
        if ts and all(c is None or (c, ts) in known for c in cids):
            continue
        rows = match_rows(match)
        fetched += 1
        for cid, players in (rows or {}).items():
            club = by_pid.setdefault(cid, {})
            for row in players:
                pid, name = row.pop("pid"), row.pop("name")
                position = row.pop("position")
                if pid is None:
                    continue    # no stable key, and the name is not one
                rec = club.setdefault(pid, {"position": position, "name": name, "matches": {}})
                # A keeper is a keeper; everything else is the M guess, so a
                # later row never downgrades a G that an earlier one established.
                if position == "G":
                    rec["position"] = "G"
                rec["matches"][row["ts"]] = row

    # Out by name, because that is build_data's shape. Two players on one club
    # whose canonical names collide are merged here rather than silently
    # overwriting one another — rare, but a squad is small and brothers exist.
    for cid, club in by_pid.items():
        out = history.setdefault(cid, {})
        for rec in club.values():
            kept = out.setdefault(rec["name"], {"position": rec["position"], "matches": {}})
            if rec["position"] == "G":
                kept["position"] = "G"
            kept["matches"].update(rec["matches"])
    return history, fetched
