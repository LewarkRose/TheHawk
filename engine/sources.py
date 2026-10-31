"""Data sources for Hawk MK II.

Every fetcher returns plain dicts/lists (or None / empty on failure) and
prints a one-line diagnostic when something goes wrong, so the model and
the GUI never deal with HTTP details. Everything here is free and needs no
API key. Endpoints and field names were confirmed live on 2026-09-13; the
365Scores, Polymarket and StatsHub endpoints are undocumented, so they
could change without notice.

Sources that were tested and rejected: Sofascore (403 to scripts),
Oddspedia (Cloudflare challenge page), ESPN (403), ClubElo fixtures
(API deactivated), TheSportsDB free key (1 match per team, top-5 table
only, returns women's teams for some searches).
"""
import csv
import datetime as dt
import io
import json
import re
import threading
import time
import unicodedata
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher

import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
}
TIMEOUT = 12

# Every competition HAWK covers, in the order (and groups) the website shows
# them. Keep in step with LEAGUE_GROUPS in builder/engine.js.
#   s365  365Scores competition id (fixtures, odds, lineups, scores)
#   fd    football-data.co.uk league code for team ratings; a tuple for cups
#         means "look the teams up in these leagues"; None = market prices only
#   sh    StatsHub (= Sofascore) tournament id (team ids -> player stats)
#   sh_teams  extra competitions whose team lists identify a cup's teams
#   pm    Polymarket series id (match-result crowd prices), if it has one
#   cup   domestic cup: ties between two clubs from outside the fd leagues
#         (early qualifying rounds) are skipped — no data, no bet builders
# All ids confirmed live on 2026-09-14.
_EUROPE_FD = ("E0", "SP1", "I1", "D1", "F1", "N1", "P1", "SC0", "B1", "T1", "G1", "AUT", "SWZ", "DNK", "NOR", "SWE", "POL")
_TOP_TIERS = ("Premier League", "Championship", "League One", "League Two")
COMPETITIONS = {
    # Top 5
    "Premier League": dict(s365=7, fd="E0", sh=17, pm="10188"),
    "La Liga": dict(s365=11, fd="SP1", sh=8, pm="10193"),
    "Serie A": dict(s365=17, fd="I1", sh=23, pm="10203"),
    "Bundesliga": dict(s365=25, fd="D1", sh=35, pm="10194"),
    "Ligue 1": dict(s365=35, fd="F1", sh=34, pm="10195"),
    # European cups
    "Champions League": dict(s365=572, fd=_EUROPE_FD, sh=7, pm="10204"),
    "Europa League": dict(s365=573, fd=_EUROPE_FD, sh=679, sh_teams=("Champions League",), pm="10209"),
    "Conference League": dict(s365=7685, fd=_EUROPE_FD, sh=17015, sh_teams=("Europa League", "Champions League"), pm="10437"),
    # More Europe
    "Eredivisie": dict(s365=57, fd="N1", sh=37, pm="10286"),
    "Liga Portugal": dict(s365=73, fd="P1", sh=238, pm="10330"),
    "Scottish Premiership": dict(s365=61, fd="SC0", sh=36, pm="10674"),
    "Belgian Pro League": dict(s365=98, fd="B1", sh=38, pm="12351"),
    "Süper Lig": dict(s365=78, fd="T1", sh=52, pm="10292"),
    "Greek Super League": dict(s365=84, fd="G1", sh=185, pm="12356"),
    "Austrian Bundesliga": dict(s365=111, fd="AUT", sh=45, pm="11636"),
    "Swiss Super League": dict(s365=95, fd="SWZ", sh=215, pm="12319"),
    "Danish Superliga": dict(s365=119, fd="DNK", sh=39, pm="10363"),
    "Allsvenskan": dict(s365=122, fd="SWE", sh=40, pm="11637"),
    # Second tier — the Championship only. League One, 2. Bundesliga, Serie B,
    # LaLiga 2 and Ligue 2 were removed on 2026-10-31: HAWK covers the leagues it
    # is actually used on, and those five were roughly 110 clubs of the ~447
    # squads a run fetches. Their clubs still arrive through the domestic cups,
    # so their ids stay in _CUP_ONLY_SH below — read the note there first.
    "Championship": dict(s365=1, fd="E1", sh=18, pm="10355"),
    # Domestic cups
    "FA Cup": dict(cup=True, s365=8, fd=("E0", "E1", "E2", "E3", "EC"), sh=19, sh_teams=_TOP_TIERS, pm="10307"),
    "EFL Cup": dict(cup=True, s365=9, fd=("E0", "E1", "E2", "E3"), sh=21, sh_teams=_TOP_TIERS, pm="10230"),
    "Copa del Rey": dict(cup=True, s365=13, fd=("SP1", "SP2"), sh=329, sh_teams=("La Liga", "LaLiga 2"), pm="10316"),
    "Coppa Italia": dict(cup=True, s365=20, fd=("I1", "I2"), sh=328, sh_teams=("Serie A", "Serie B"), pm="10287"),
    "DFB-Pokal": dict(cup=True, s365=28, fd=("D1", "D2"), sh=217, sh_teams=("Bundesliga", "2. Bundesliga"), pm="10317"),
    "Coupe de France": dict(cup=True, s365=37, fd=("F1", "F2"), sh=335, sh_teams=("Ligue 1", "Ligue 2"), pm="10315"),
    # Rest of the world
    "MLS": dict(s365=104, fd="USA", sh=242, pm="10189"),
    "Brasileirão": dict(s365=113, fd="BRA", sh=325, pm="10359"),
    "Argentina Primera": dict(s365=72, fd="ARG", sh=155, pm="10285"),
    "Liga MX": dict(s365=141, fd="MEX", sh=11621, pm="10290"),
    "Saudi Pro League": dict(s365=649, fd=None, sh=955, pm="10361"),
    "Copa Libertadores": dict(s365=102, fd=("BRA", "ARG"), sh=384, sh_teams=("Brasileirão", "Argentina Primera"), pm="10289"),
}
LEAGUES = tuple(COMPETITIONS)

# ---------------------------------------------------------------------------
# Small helpers: HTTP, caching, team-name matching
# ---------------------------------------------------------------------------
_cache = {}
_cache_lock = threading.Lock()


def _cached(key, ttl_seconds, loader):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl_seconds:
            return hit[1]
    value = loader()
    if value is not None:
        with _cache_lock:
            _cache[key] = (now, value)
    return value


class _Throttle:
    """At most `concurrent` requests in flight to one host, started at
    least `gap` seconds apart."""

    def __init__(self, concurrent, gap):
        self._slots = threading.BoundedSemaphore(concurrent)
        self._gap = gap
        self._lock = threading.Lock()
        self._last = 0.0

    def acquire(self):
        self._slots.acquire()
        with self._lock:
            delay = self._last + self._gap - time.time()
            if delay > 0:
                time.sleep(delay)
            self._last = time.time()

    def release(self):
        self._slots.release()


# StatsHub answers HTTP 429 to bursts (seen when scanning many matches).
_THROTTLES = {"www.statshub.com": _Throttle(concurrent=2, gap=0.25)}


# Circuit breaker: after this many requests in a row to one host fail even
# with retries, that host is treated as down for the rest of the run (so a
# dead source costs seconds, not the 30-minute Action limit).
_BREAK_AFTER = 6
_host_fails = {}


def _get(url, params=None, timeout=TIMEOUT):
    host = urllib.parse.urlparse(url).netloc
    if _host_fails.get(host, 0) >= _BREAK_AFTER:
        return None
    r = _get_retrying(url, params, timeout)
    if r is False:   # failed with retries: network, 5xx or rate limit
        _host_fails[host] = _host_fails.get(host, 0) + 1
        if _host_fails[host] == _BREAK_AFTER:
            print(f"[http] {host} looks down ({_BREAK_AFTER} failures in a row) — skipping it for the rest of this run")
        return None
    _host_fails[host] = 0
    return r


def _get_retrying(url, params=None, timeout=TIMEOUT):
    # Retries: several requests fire in parallel per fixture; 365Scores
    # occasionally times out or returns a 504, and StatsHub rate-limits
    # with 429 (so back off before trying again). None = a plain "no"
    # (404 etc.), False = failed after retries.
    throttle = _THROTTLES.get(urllib.parse.urlparse(url).netloc)
    error = None
    for attempt, attempt_timeout in enumerate((timeout, timeout * 2, timeout * 2)):
        if throttle:
            throttle.acquire()
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=attempt_timeout)
        except (requests.Timeout, requests.ConnectionError) as e:
            error = e
            continue
        except requests.RequestException as e:
            print(f"[http] {url} failed: {e}")
            return False
        finally:
            if throttle:
                throttle.release()
        if r.status_code == 429:
            error = "HTTP 429 (rate limited)"
            time.sleep(2.0 * (attempt + 1))
            continue
        if r.status_code >= 500:
            error = f"HTTP {r.status_code}"
            continue
        if r.status_code != 200:
            print(f"[http] {url} -> HTTP {r.status_code}")
            return None
        return r
    print(f"[http] {url} failed after retries: {error}")
    return False


def _get_json(url, params=None, timeout=TIMEOUT):
    r = _get(url, params, timeout)
    if r is None:
        return None
    try:
        return r.json()
    except ValueError:
        print(f"[http] {url} returned non-JSON")
        return None


# Tokens that carry no identity ("FC", "Calcio", ...). "hove"/"albion" are
# here so "Brighton & Hove Albion" reduces to "brighton" like every other
# source's short name.
_STOPWORDS = {"fc", "afc", "cf", "sc", "ac", "as", "ss", "ssc", "club", "cd", "ud", "rc", "sd", "sv",
              "vfb", "vfl", "tsg", "the", "de", "calcio", "and", "hove", "albion", "1", "ca", "fk", "sk"}
# Words that don't identify a club on their own ("FC United" is not "Leeds United").
_GENERIC = {"united", "city", "town", "athletic", "county", "rovers", "wanderers", "sporting", "real", "racing",
            "dynamo", "olympic", "inter", "union", "sports", "borough"}
# Letters Unicode doesn't decompose to ASCII ("Brøndby" would lose its ø).
_LETTERS = str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D",
                          "ı": "i", "ð": "d", "þ": "th"})
# English vs local city names, per word.
_WORDS = {"vienna": "wien", "copenhagen": "kobenhavn", "salonica": "thessaloniki", "athinon": "athens", "utd": "united"}

# Short forms used by football-data.co.uk / Polymarket -> the long form.
_ALIASES = {
    "man united": "manchester united", "man utd": "manchester united", "man city": "manchester city",
    "nottm forest": "nottingham forest", "spurs": "tottenham", "tottenham hotspur": "tottenham",
    "wolves": "wolverhampton", "wolverhampton wanderers": "wolverhampton",
    "sheffield weds": "sheffield wednesday", "qpr": "queens park rangers",
    "ath madrid": "atletico madrid", "atletico de madrid": "atletico madrid",
    "ath bilbao": "athletic bilbao", "athletic": "athletic bilbao",
    "espanol": "espanyol", "la coruna": "deportivo la coruna", "deportivo": "deportivo la coruna",
    "mgladbach": "monchengladbach", "borussia monchengladbach": "monchengladbach", "gladbach": "monchengladbach",
    "borussia mgladbach": "monchengladbach", "stade rennais": "rennes",
    "ein frankfurt": "eintracht frankfurt", "koln": "koln", "cologne": "koln",
    "bayern munchen": "bayern munich", "bayern": "bayern munich",
    "paris sg": "paris saint germain", "psg": "paris saint germain",
    "inter milan": "inter", "internazionale": "inter",
    # the leagues added on 2026-09-14 (365Scores / football-data / StatsHub spellings)
    "sp lisbon": "sporting", "sporting cp": "sporting", "sporting lisbon": "sporting", "guimaraes": "vitoria",
    "stvv": "sint truiden", "st truiden": "sint truiden", "sint truidense vv": "sint truiden",
    "basaksehir": "buyuksehyr", "istanbul basaksehir": "buyuksehyr", "volos nfc": "nps volos", "volos": "nps volos",
    "gimnasia la plata": "gimnasia y esgrima", "chivas": "guadalajara", "atlas guadalajara": "atlas",
    "aarhus": "agf", "agf aarhus": "agf", "scr altach": "rheindorf altach", "altach": "rheindorf altach",
    "olympiacos": "olympiakos", "olympiacos piraeus": "olympiakos",
}


def _norm(name):
    s = unicodedata.normalize("NFKD", str(name or "").translate(_LETTERS)).encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ").replace("'", "").replace(".", "")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = " ".join(_WORDS.get(t, t) for t in s.split() if t not in _STOPWORDS)
    return _ALIASES.get(s, s)


def name_similarity(a, b):
    """0..1 score for whether two team names refer to the same club.
    Word-prefix matching handles abbreviations ("Man United" ~ "Manchester
    United") while requiring every significant word to match, so
    "Manchester United" and "Manchester City" stay apart."""
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in _GENERIC or nb in _GENERIC:
        return 0.0
    if re.search(rf"\b{re.escape(na)}\b", nb) or re.search(rf"\b{re.escape(nb)}\b", na):
        return 0.9
    ta = [t for t in na.split() if len(t) >= 3]
    tb = [t for t in nb.split() if len(t) >= 3]
    token = 0.0
    if ta and tb:
        short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        hits = sum(1 for s in short if any(s.startswith(l) or l.startswith(s) for l in long_))
        token = 0.85 if hits == len(short) else 0.5 * hits / len(short)
    return max(token, 0.8 * SequenceMatcher(None, na, nb).ratio())


def best_match(name, candidates, threshold=0.7):
    """The candidate that best matches `name`, or None if nothing clears
    the threshold or the top two are tied."""
    scored = sorted(((name_similarity(name, c), c) for c in candidates), reverse=True)
    if not scored or scored[0][0] < threshold:
        return None
    if len(scored) > 1 and scored[1][0] == scored[0][0] and scored[1][1] != scored[0][1]:
        return None
    return scored[0][1]


def closed_match(name, candidates):
    """best_match for a list the team is known to be in (one league's clubs):
    also accepts a weaker match that clearly beats every other club, e.g.
    "Rapid Vienna" -> "SK Rapid Wien" or "Hertha Berlin" -> "Hertha BSC"."""
    hit = best_match(name, candidates)
    if hit:
        return hit
    scored = sorted(((name_similarity(name, c), c) for c in candidates), reverse=True)
    if scored and scored[0][0] >= 0.5 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.15):
        return scored[0][1]
    return None


def parse_kickoff(start_time):
    try:
        return dt.datetime.fromisoformat(start_time)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# 365Scores — fixtures, odds from several bookmakers, lineups, referee, table
# ---------------------------------------------------------------------------
S365_BASE = "https://webws.365scores.com/web"
S365_PARAMS = {"appTypeId": 5, "langId": 1, "timezoneName": "Europe/London", "userCountryId": -1}
S365_COMPETITIONS = {name: c["s365"] for name, c in COMPETITIONS.items()}
# Odds are geo-gated by userCountryId (-1 returns none). Each country exposes a
# different bookmaker set, and 365Scores MOVES which one serves which book.
#
# Re-confirmed live 2026-10-18:
#   1 -> Bet365      21 -> 365Scores      31 -> BWIN      37 -> STS
#
# 21 used to serve Bet365 (the old comment here said so) and silently stopped.
# Nothing noticed, because a sweep that finds three other books looks healthy —
# so every price this pipeline believed was Bet365's had quietly become
# 365Scores', BWIN's and STS'. Country 1 is now in front, matching
# ODDS_COUNTRIES in builder/engine.js, which was fixed for the same drift.
# Bet365 was also live at 8, 9, 10, 13, 28 and 39 on the same check.
#
# CURRENTLY INERT. The only consumer of this list is s365_odds() below, and nothing
# calls s365_odds() — this pipeline's odds are fd_upcoming_quotes(), football-data's
# UK snapshot. The list is corrected so it is right if that function is ever wired
# up, but no price HAWK publishes depends on it today. The live Bet365 path is
# ODDS_COUNTRIES in builder/engine.js, which was fixed for this same drift on 1 Oct.
S365_ODDS_COUNTRIES = (1, 21, 31, 37)


def _s365(path, **params):
    return _get_json(f"{S365_BASE}/{path}/", dict(S365_PARAMS, **params))


def s365_fixtures(league):
    data = _s365("games/fixtures", competitions=S365_COMPETITIONS[league])
    if data is None:
        return None
    games = [g for g in data.get("games", []) if g.get("statusGroup") != 4]
    return sorted(games, key=lambda g: g.get("startTime", ""))


def s365_crest(competitor):
    return ("https://imagecache.365scores.com/image/upload/f_png,w_64,h_64,c_limit,q_auto:eco,dpr_2,"
            f"d_Competitors:default1.png/v{competitor.get('imageVersion', 1)}/Competitors/{competitor.get('id')}")


def s365_athlete_photo(member):
    return ("https://imagecache.365scores.com/image/upload/f_png,w_64,h_64,c_limit,q_auto:eco,dpr_2,"
            f"d_Athletes:default.png/v{member.get('imageVersion', 1)}/Athletes/{member.get('athleteId')}")


def s365_game(game_id):
    data = _s365("game", gameId=game_id)
    return (data or {}).get("game")


def s365_standings(league):
    """{competitor_id: row} across every table in the response."""
    data = _s365("standings", competitions=S365_COMPETITIONS[league])
    rows = {}
    for table in (data or {}).get("standings") or []:
        for row in table.get("rows") or []:
            cid = (row.get("competitor") or {}).get("id")
            if cid is not None:
                rows[cid] = row
    return rows


def s365_form(competitor_id, games=6):
    """Last `games` finished competitive results as e.g. 'WLDWW' (newest
    first), skipping friendlies and cancelled games."""
    data = _s365("games/results", competitors=competitor_id)
    if not data:
        return None
    out = []
    for g in sorted(data.get("games", []), key=lambda g: g.get("startTime", ""), reverse=True):
        status = (g.get("statusText") or "").lower()
        if g.get("statusGroup") != 4 or any(s in status for s in ("cancel", "postpon", "abandon")):
            continue
        if "friendl" in (g.get("competitionDisplayName") or "").lower():
            continue
        hc, ac = g.get("homeCompetitor", {}), g.get("awayCompetitor", {})
        try:
            hs, as_ = int(hc.get("score")), int(ac.get("score"))
        except (TypeError, ValueError):
            continue
        if hs < 0 or as_ < 0:
            continue
        mine, theirs = (hs, as_) if hc.get("id") == competitor_id else (as_, hs)
        out.append("W" if mine > theirs else "L" if mine < theirs else "D")
        if len(out) == games:
            break
    return "".join(out) or None


# Finished matches with their team stats — the backup for football-data's team
# ratings (and a second opinion). Results come 20 to a page, newest first; the
# stats are one request per match, so a league's history is filled in over
# several runs and kept in data/results365/ (a finished match never changes).
S365_ROOT = "https://webws.365scores.com"
# Stored row: [id, date, season, home, away, hg, ag, hxg, axg, hs, as, hst, ast, hc, ac, hy, ay, hr, ar]
RESULT_FIELDS = ["id", "date", "season", "home", "away", "hid", "aid", "hg", "ag", "hxg", "axg", "hs", "as", "hst", "ast", "hc", "ac", "hy", "ay", "hr", "ar", "got"]
FD_TO_S365 = {c["fd"]: c["s365"] for c in COMPETITIONS.values() if isinstance(c.get("fd"), str)}
_S365_STATS = {"Expected Goals": "xg", "Total Shots": "s", "Shots On Target": "st", "Corners": "c", "Yellow Cards": "y", "Red Cards": "r"}


def _s365_score(c):
    try:
        v = int(float(c.get("score")))
        return v if v >= 0 else None
    except (TypeError, ValueError):
        return None


def _s365_results_page(data, since):
    """(rows, oldest date on the page, link to the older page) for one results page."""
    rows, oldest = [], None
    for g in (data or {}).get("games", []):
        kick = parse_kickoff(g.get("startTime"))
        if not kick:
            continue
        oldest = min(oldest or kick.date(), kick.date())
        status = (g.get("statusText") or "").lower()
        if g.get("statusGroup") != 4 or kick.date() < since or any(s in status for s in ("cancel", "postpon", "abandon", "award")):
            continue
        hg, ag = _s365_score(g.get("homeCompetitor", {})), _s365_score(g.get("awayCompetitor", {}))
        if hg is None or ag is None:
            continue
        rows.append({"id": g["id"], "date": kick.date().isoformat(), "season": g.get("seasonNum"),
                     "home": g["homeCompetitor"]["name"], "away": g["awayCompetitor"]["name"],
                     "hid": g["homeCompetitor"].get("id"), "aid": g["awayCompetitor"].get("id"), "hg": hg, "ag": ag})
    return rows, oldest, ((data or {}).get("paging") or {}).get("previousPage")


def s365_results(competition_id, since, known, cursor=None, new_pages=5, old_pages=6, deadline=None):
    """Finished matches of one competition since `since`, as result rows without
    stats: first the newest pages until one holds a match already in `known`
    (ids), then — while the history isn't complete — `old_pages` more going
    back from `cursor` (the link saved last run). Returns (rows, cursor, done);
    cursor None + done True once `since` is reached. None if 365Scores didn't answer."""
    data = _s365("games/results", competitions=competition_id)
    if data is None:
        return None
    rows, link = [], None
    for page in range(new_pages):
        got, oldest, link = _s365_results_page(data, since)
        rows += [r for r in got if r["id"] not in known]
        if any(r["id"] in known for r in got) or not link or (oldest and oldest < since):
            break
        data = _get_json(S365_ROOT + link)
    if not known:
        cursor = link   # first time: carry on from where the newest pages ended
    done = cursor is None and bool(known)
    for page in range(old_pages if cursor else 0):
        if deadline and time.time() > deadline:   # out of time this run: carry on next run
            break
        data = _get_json(S365_ROOT + cursor)
        if data is None:
            break
        got, oldest, cursor = _s365_results_page(data, since)
        rows += [r for r in got if r["id"] not in known]
        if not cursor or (oldest and oldest < since):
            cursor, done = None, True
            break
    return rows, cursor, done


def s365_match_stats(game_id, home_id, away_id):
    """{"hs": .., "as": .., "hst": .., ...} for one finished match (None for a
    stat 365Scores doesn't have there), or None if it didn't answer."""
    data = _s365("game/stats", games=game_id)
    if data is None:
        return None
    out = {f"{side}{key}": None for key in _S365_STATS.values() for side in ("h", "a")}
    for s in data.get("statistics") or []:
        key = _S365_STATS.get(s.get("name"))
        side = "h" if s.get("competitorId") == home_id else "a" if s.get("competitorId") == away_id else None
        if not key or not side:
            continue
        try:
            out[f"{side}{key}"] = float(str(s.get("value")).split("/")[0].replace("%", "").strip())
        except ValueError:
            pass
    return out   # keys match football-data's: hs/as, hst/ast, hc/ac, hy/ay, hr/ar, hxg/axg


# ---------------------------------------------------------------------------
# Per-player, per-match stats
# ---------------------------------------------------------------------------
# These used to come from StatsHub, one request per CLUB (sh_players: a team's
# last 20 matches, every player, every field). On 2026-10-29 12:51 UTC Cloudflare
# began answering every statshub.com /api/* request with a managed challenge —
# HTTP 403, `cf-mitigated: challenge`, empty body — which is a setting somebody
# turned on, not an outage, so that route is gone and will not come back.
#
# 365Scores carries the same numbers inside the `game` payload, under
# {home,away}Competitor.lineups.members[].stats as {name, value} pairs.
# builder/hawk-settle.js already reads this exact shape to settle real bets, so
# after this the model and the settler rest on ONE feed and agree by
# construction rather than by measurement.
#
# The win is not the fields, it is the KEY. A fixture already holds the
# 365Scores game id and both competitorIds, so nothing is looked up by name.
# That is what killed the StatsHub route twice over: once the challenge went up,
# sh_team_ids() could no longer resolve a club, and fixtures entering the 8-day
# window simply stopped having ids — no error, just "StatsHub teams not found",
# 148 of them on 31 Oct and 152 one run later. Here there is nothing to resolve.
#
# ONE MEANING CHANGES, and it is not a rescaling. StatsHub counted challenges
# MADE; 365Scores publishes "Tackles Won", and names a player's tackles only
# once he has won one. Tackle rates built from this are a different quantity —
# they have to be measured again, not converted. See engine/grade.mjs on why
# FotMob is still read alongside: it is the second opinion for exactly this gap.

# 365Scores position ids. 0 is Management, which is why members are filtered on
# `status` below and never on position.
_S365_POS = {1: "G", 2: "D", 3: "M", 4: "F"}
# member.status: 1 starting, 2 substitute, 3 named but did not play, 4 staff.
# So sub_in is read straight off the feed. Worth saying out loud, because the
# StatsHub field it replaces meant the OPPOSITE of its name (substitutedIn was
# a sub coming on FOR him, i.e. he went off) and read backwards for a month.
_S365_STARTING, _S365_SUB = 1, 2
# HAWK's field <- 365Scores' stat title.
_S365_PLAYER_STATS = {"minutes": "Minutes", "shots": "Total Shots", "sot": "Shots On Target",
                      "goals": "Goals", "xg": "Expected Goals", "assists": "Assists",
                      "xa": "Expected Assists", "fouls": "Fouls Made", "fouled": "Was Fouled",
                      "tackles": "Tackles Won", "offsides": "Offsides", "saves": "Goalkeeper Saves"}


def _s365_count(value, total=False):
    """A 365Scores stat value as a number: "90'" -> 90, "10/32 (31%)" -> 10
    (32 with total=True), "" or None -> 0. Mirrors countOf() in
    builder/hawk-settle.js, which settles real bets off the same strings."""
    if value is None or value == "":
        return 0
    text = str(value).strip()
    pair = re.match(r"^(\d+)\s*/\s*(\d+)", text)
    if pair:
        return int(pair.group(2) if total else pair.group(1))
    num = re.match(r"^-?\d+(?:\.\d+)?", text)
    if not num:
        return 0
    # Whole numbers come back as int, so a count reads 0 and 90 rather than 0.0
    # and 90.0. Only xg and xa are ever fractional, and players_json rounds those
    # to 2dp — every other field is a tally, and "0.0" is three characters of
    # every row in a file that is published per club and fetched per match.
    value = float(num.group(0))
    return int(value) if value.is_integer() else value


def _s365_ts(start_time):
    """A fixture's startTime as unix seconds.

    365Scores is asked in Europe/London (S365_PARAMS) and answers with a naive
    local string, so it has to be READ as London. A plain .timestamp() on a naive
    datetime uses the build machine's own zone — UTC in the Action, CET on the
    laptop — which would move every match by an hour or two depending on where it
    was built. StatsHub's ts was a true unix timestamp and engine.js subtracts it
    from the kick-off to get days of rest, so the two have to mean the same thing.
    """
    kick = parse_kickoff(start_time)
    if not kick:
        return 0
    if kick.tzinfo is None:
        try:
            from zoneinfo import ZoneInfo
            kick = kick.replace(tzinfo=ZoneInfo(S365_PARAMS["timezoneName"]))
        except Exception:
            # No tz database (Windows without `tzdata`). UTC, not the machine's
            # zone, so a local run and the Action still agree with each other.
            kick = kick.replace(tzinfo=dt.timezone.utc)
    return int(kick.timestamp())


def s365_players(game_id):
    """Per-player stats for one finished match, ready to append to each club's
    history: {competitor_id: [{"name", "position", "match": {...}}, ...]}, where
    `match` holds exactly build_data's PLAYER_MATCH_FIELDS.

    None if 365Scores didn't answer or the match has no lineups — not every
    competition publishes them, and an absent lineup is not an empty one."""
    game = s365_game(game_id)
    if not game:
        return None
    home, away = game.get("homeCompetitor") or {}, game.get("awayCompetitor") or {}
    hid, aid = home.get("id"), away.get("id")
    if not hid or not aid:
        return None
    hs, aws = _s365_score(home), _s365_score(away)
    # Cards per player, from the EVENT list and not the stats block. The stats
    # under-count: measured over 106 finished matches (16 Oct 2026) 17 disagreed,
    # 16 of them with more cards in the events — see the note in hawk-settle.js.
    # A second yellow is published as its own Red Card event, so a sent-off
    # player ends with yellow 1 and red 1, which is what StatsHub gave too.
    yellow, red = {}, {}
    for e in game.get("events") or []:
        label = ((e.get("eventType") or {}).get("name") or "").lower()
        pid = e.get("playerId")
        if pid is None:
            continue
        if "yellow" in label:
            yellow[pid] = yellow.get(pid, 0) + 1
        elif "red" in label:
            red[pid] = red.get(pid, 0) + 1
    names = {m.get("id"): m.get("name") for m in game.get("members") or []}
    context = {"ts": _s365_ts(game.get("startTime")),
               "score": f"{hs}-{aws}" if hs is not None and aws is not None else "",
               "comp": game.get("competitionDisplayName") or ""}
    out = {}
    for side, team, opp in ((hid, home, away), (aid, away, home)):
        rows = []
        for m in ((team.get("lineups") or {}).get("members") or []):
            status = m.get("status")
            if status not in (_S365_STARTING, _S365_SUB):
                continue
            stats = {s.get("name"): s.get("value") for s in m.get("stats") or []}
            minutes = _s365_count(stats.get("Minutes"))
            if minutes <= 0:
                continue   # named, came on for nothing, or no stats published
            pid = m.get("id")
            row = {k: _s365_count(stats.get(title)) for k, title in _S365_PLAYER_STATS.items()}
            row.update(context, home=side == hid, opp=opp.get("name") or "?",
                       minutes=minutes, sub_in=status == _S365_SUB,
                       yellow=yellow.get(pid, 0), red=red.get(pid, 0))
            rows.append({"name": names.get(pid) or m.get("name") or "",
                         "position": _S365_POS.get((m.get("position") or {}).get("id")),
                         "match": row})
        out[side] = rows
    return out if any(out.values()) else None


def s365_club_games(competitor_id, limit=20):
    """[(game_id, unix ts)] for one club's last `limit` finished matches, newest
    first, across every competition — one request.

    This is the list that drives the player history: the caller already knows the
    kick-offs it has stored, so it fetches only the games it is missing. Rows are
    filtered the way s365_form does, because a postponed or abandoned game has no
    player stats to take and a friendly is not form.

    The extra guard the others don't need is the kick-off being in the past. A
    match that has not been played cannot have player stats, but 365Scores leaves
    a rescheduled one in statusGroup 4 with its NEW date and a statusText the
    list above does not cover — "Suspended" put a 14 Nov Liga MX game into the
    31 Oct fetch set. s365_form and s365_results survive that on their score
    guard (both scores come back -1); this function reads no scores, so it needs
    the time. Matching on more status words would not fix it: the list is open
    and localised, while "a finished match kicked off already" always holds."""
    data = _s365("games/results", competitors=competitor_id)
    if not data:
        return None
    now, out = time.time(), []
    for g in sorted(data.get("games") or [], key=lambda x: x.get("startTime") or "", reverse=True):
        status = (g.get("statusText") or "").lower()
        if g.get("statusGroup") != 4 or any(s in status for s in ("cancel", "postpon", "abandon", "suspend")):
            continue
        if "friendl" in (g.get("competitionDisplayName") or "").lower():
            continue
        ts = _s365_ts(g.get("startTime"))
        if g.get("id") is not None and ts and ts < now:
            out.append((g["id"], ts))
        if len(out) >= limit:
            break
    return out


def s365_odds(game_id):
    """Every bookmaker line 365Scores has for this game, as a list of
    quotes: {"book", "type" (lineTypeId), "market", "value" (line, e.g.
    "2.5", or ""), "prices": {option: decimal}}."""
    def fetch(country):
        data = _s365("bets/lines", userCountryId=country, games=game_id)
        if not data:
            return []
        names = {b.get("id"): b.get("name") for b in data.get("bookmakers") or []}
        quotes = []
        for line in data.get("lines") or []:
            prices = {}
            for opt in line.get("options") or []:
                price = (opt.get("rate") or {}).get("decimal")
                if opt.get("name") and price and float(price) > 1.0:
                    prices[str(opt["name"])] = float(price)
            if prices:
                quotes.append({
                    "book": names.get(line.get("bookmakerId"), f"Book {line.get('bookmakerId')}"),
                    "type": line.get("lineTypeId"),
                    "market": (line.get("lineType") or {}).get("name", ""),
                    "value": str(line.get("internalOptionValue") or ""),
                    "prices": prices,
                    "source": "365Scores",
                })
        return quotes

    with ThreadPoolExecutor(len(S365_ODDS_COUNTRIES)) as ex:
        batches = list(ex.map(fetch, S365_ODDS_COUNTRIES))
    return dedupe_quotes(q for batch in batches for q in batch)


def dedupe_quotes(quotes):
    seen, out = set(), []
    for q in quotes:
        key = (q["book"], q["type"], q["value"])
        if key not in seen:
            seen.add(key)
            out.append(q)
    return out


# ---------------------------------------------------------------------------
# football-data.co.uk — per-match xG, shots, corners, cards, referee, and a
# fixtures file with UK bookmaker + Betfair Exchange odds. Free CSVs that
# the site publishes for exactly this kind of use; updated ~twice a week.
# ---------------------------------------------------------------------------
FD_BASE = "https://www.football-data.co.uk"
# Leagues in football-data's "extra leagues" files: one CSV per country with
# every season, goals and odds only (no shots, corners or cards), so their
# ratings cover goals and the rest comes from the bookmakers.
FD_NEW_CODES = {"USA", "BRA", "ARG", "MEX", "AUT", "SWZ", "DNK", "NOR", "SWE", "POL"}


def fd_codes(league):
    """football-data codes to search for a competition's teams (cups: every
    league its teams come from). Teams outside them are priced from the
    bookmakers alone."""
    fd = COMPETITIONS[league]["fd"]
    return [] if not fd else [fd] if isinstance(fd, str) else list(fd)
# Column prefixes in fixtures.csv. B365 is skipped: 365Scores already has
# Bet365 live, and the CSV is only a snapshot.
FD_BOOKS = {"BFD": "Betfred", "BV": "BetVictor", "BW": "Betway", "PP": "Paddy Power",
            "SKB": "SkyBet", "BFE": "Betfair Exchange"}


def fd_season_codes(today):
    start = today.year % 100 if today.month >= 7 else today.year % 100 - 1
    return f"{start:02d}{start + 1:02d}", f"{start - 1:02d}{start:02d}"


def _num(row, key):
    try:
        return float((row.get(key) or "").strip())
    except ValueError:
        return None


def _parse_date(s):
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return dt.datetime.strptime((s or "").strip(), fmt).date()
        except ValueError:
            continue
    return None


def _parse_fd_csv(content, keep_raw=False):
    text = content.decode("utf-8-sig", errors="replace")
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        home, away, date = (row.get("HomeTeam") or "").strip(), (row.get("AwayTeam") or "").strip(), _parse_date(row.get("Date"))
        if not home or not away or not date:
            continue
        m = {"div": row.get("Div"), "date": date, "home": home, "away": away,
             "referee": (row.get("Referee") or "").strip()}
        for key, col in (("hg", "FTHG"), ("ag", "FTAG"), ("hxg", "HxG"), ("axg", "AxG"), ("hs", "HS"),
                         ("as", "AS"), ("hst", "HST"),
                         ("ast", "AST"), ("hc", "HC"), ("ac", "AC"), ("hy", "HY"), ("ay", "AY"),
                         ("hr", "HR"), ("ar", "AR")):
            m[key] = _num(row, col)
        if keep_raw:
            m["raw"] = row
        out.append(m)
    return out


def fd_matches(code, season):
    def load():
        r = _get(f"{FD_BASE}/mmz4281/{season}/{code}.csv", timeout=20)
        return None if r is None else _parse_fd_csv(r.content)
    return _cached(("fd", code, season), 6 * 3600, load)


def _parse_fd_new_csv(content, code):
    text = content.decode("utf-8-sig", errors="replace")
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        home, away, date = (row.get("Home") or "").strip(), (row.get("Away") or "").strip(), _parse_date(row.get("Date"))
        if not home or not away or not date:
            continue
        m = {"div": code, "season": (row.get("Season") or "").strip(), "date": date, "home": home, "away": away,
             "referee": "", "hg": _num(row, "HG"), "ag": _num(row, "AG")}
        for key in ("hxg", "axg", "hs", "as", "hst", "ast", "hc", "ac", "hy", "ay", "hr", "ar"):
            m[key] = None
        out.append(m)
    return out


def fd_seasons(code, today):
    """(this season's matches, last season's) for one football-data league."""
    if code not in FD_NEW_CODES:
        cur, prev = fd_season_codes(today)
        return fd_matches(code, cur) or [], fd_matches(code, prev) or []
    def load():
        r = _get(f"{FD_BASE}/new/{code}.csv", timeout=30)
        return None if r is None else _parse_fd_new_csv(r.content, code)
    by_season = {}
    for m in _cached(("fd", code, "all"), 6 * 3600, load) or []:
        by_season.setdefault(m["season"], []).append(m)
    # Newest season first ("2026", "2026/2027": whichever has the latest match).
    order = sorted(by_season, key=lambda s: max(m["date"] for m in by_season[s]), reverse=True)
    return (by_season[order[0]] if order else []), (by_season[order[1]] if len(order) > 1 else [])


def fd_teams(code, today):
    matches = fd_seasons(code, today)[0]
    return sorted({m["home"] for m in matches} | {m["away"] for m in matches})


def fd_upcoming():
    def load():
        r = _get(f"{FD_BASE}/fixtures.csv", timeout=20)
        return None if r is None else _parse_fd_csv(r.content, keep_raw=True)
    return _cached(("fd", "fixtures"), 15 * 60, load) or []


def fd_upcoming_quotes(code, home_fd, away_fd, kickoff_date):
    """1X2 and Over/Under 2.5 prices from the UK books + Betfair Exchange
    listed in fixtures.csv, as quotes in the same shape as s365_odds()."""
    quotes = []
    for m in fd_upcoming():
        if m["div"] != code or m["home"] != home_fd or m["away"] != away_fd:
            continue
        if abs((m["date"] - kickoff_date).days) > 1:
            continue
        raw = m["raw"]
        for prefix, book in FD_BOOKS.items():
            h, d, a = _num(raw, prefix + "H"), _num(raw, prefix + "D"), _num(raw, prefix + "A")
            if h and d and a:
                quotes.append({"book": book, "type": 1, "market": "Full Time Result", "value": "",
                               "prices": {"1": h, "X": d, "2": a}, "source": "football-data"})
            over, under = _num(raw, prefix + ">2.5"), _num(raw, prefix + "<2.5")
            if over and under:
                quotes.append({"book": book, "type": 3, "market": "Total Goals In Match", "value": "2.5",
                               "prices": {"Over": over, "Under": under}, "source": "football-data"})
        break
    return quotes


# ---------------------------------------------------------------------------
# Polymarket — real-money crowd prices for the match result. Official,
# public gamma API.
# ---------------------------------------------------------------------------
PM_BASE = "https://gamma-api.polymarket.com"
PM_SERIES = {name: c["pm"] for name, c in COMPETITIONS.items() if c.get("pm")}
_PM_MAIN_EVENT = re.compile(r"^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-(\d{4}-\d{2}-\d{2})$")


def pm_match(league, home, away, kickoff):
    """{"home", "draw", "away"} probabilities (normalised mid prices) plus
    "liquidity" and "title", or None if Polymarket has no market for it."""
    series = PM_SERIES.get(league)
    if not series or kickoff is None:
        return None
    events = _cached(("pm", series), 10 * 60, lambda: _get_json(
        f"{PM_BASE}/events", {"series_id": series, "closed": "false", "limit": 500}))
    kickoff_utc = kickoff.astimezone(dt.timezone.utc).date()
    for ev in events or []:
        m = _PM_MAIN_EVENT.match(ev.get("slug") or "")
        if not m or abs((dt.date.fromisoformat(m.group(1)) - kickoff_utc).days) > 1:
            continue
        parts = (ev.get("title") or "").split(" vs. ")
        if len(parts) != 2 or name_similarity(home, parts[0]) < 0.7 or name_similarity(away, parts[1]) < 0.7:
            continue
        probs, liquidity = {}, 0.0
        for mk in ev.get("markets") or []:
            price = _pm_price(mk)
            if price is None:
                continue
            liquidity += float(mk.get("liquidity") or 0)
            title = mk.get("groupItemTitle") or ""
            if "draw" in (mk.get("question") or "").lower():
                probs["draw"] = price
            elif name_similarity(home, title) >= name_similarity(away, title):
                probs["home"] = price
            else:
                probs["away"] = price
        if len(probs) == 3:
            total = sum(probs.values())
            return {**{k: v / total for k, v in probs.items()}, "liquidity": liquidity, "title": ev.get("title"),
                    "slug": ev.get("slug")}
    return None


def _pm_price(market):
    try:
        bid, ask = float(market.get("bestBid")), float(market.get("bestAsk"))
        if 0 < bid <= ask < 1:
            return (bid + ask) / 2
    except (TypeError, ValueError):
        pass
    try:
        return float(json.loads(market.get("outcomePrices") or "[]")[0])
    except (ValueError, IndexError, TypeError):
        return None


# ---------------------------------------------------------------------------
# StatsHub — recent corners/cards across ALL competitions (covers the
# Champions League, which football-data doesn't) and referee card averages
# for today's matches. Plain JSON API behind statshub.com, no browser needed.
# ---------------------------------------------------------------------------
SH_BASE = "https://www.statshub.com"
# statisticKey values confirmed live. "goals" is NOT goals (returns
# numbers in the hundreds), so it's deliberately not used.
SH_KEYS = {"corners": "cornerKicks", "yellow": "yellowCards", "red": "redCards", "sot": "shotsOnGoal"}


def sh_referee(home, away):
    """{"name", "avg_cards", "games"} for today's match, from the event
    list embedded in StatsHub's homepage. None if not listed today."""
    def load():
        r = _get(SH_BASE, timeout=20)
        if r is None:
            return None
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
        if not m:
            return None
        try:
            return json.loads(m.group(1))["props"]["pageProps"]["initialEvents"]["data"]
        except (ValueError, KeyError, TypeError):
            return None
    for item in _cached(("sh", "today"), 30 * 60, load) or []:
        ht, at = (item.get("homeTeam") or {}).get("name"), (item.get("awayTeam") or {}).get("name")
        if name_similarity(home, ht) >= 0.75 and name_similarity(away, at) >= 0.75:
            try:
                avg = float(item.get("refereeAvgCards") or 0) or None
            except (TypeError, ValueError):
                avg = None
            if item.get("refereeName"):
                return {"name": item["refereeName"], "avg_cards": avg, "games": item.get("refereeGames") or 0}
    return None


# StatsHub's competition ids (the same numbering Sofascore uses).
# Leagues HAWK does not list but whose clubs play in competitions it does. Every
# name here is named by some cup's `sh_teams`, which is how a cup tie resolves a
# club that is in no league HAWK covers. League Two was never covered; the other
# five were dropped on 2026-10-31 (see COMPETITIONS) and their ids HAVE to stay,
# because sh_league_teams() reads SH_TOURNAMENTS and nothing else. Delete one and
# the matching cup silently stops resolving half its draw: the FA Cup and EFL Cup
# through _TOP_TIERS, and Coppa Italia, DFB-Pokal, Copa del Rey and Coupe de
# France through their own sh_teams. No error, just "StatsHub teams not found".
_CUP_ONLY_SH = {"League Two": 25, "League One": 24, "2. Bundesliga": 44,
                "Serie B": 53, "LaLiga 2": 54, "Ligue 2": 182}
SH_TOURNAMENTS = {**{name: c["sh"] for name, c in COMPETITIONS.items()}, **_CUP_ONLY_SH}


def sh_league_teams(league):
    """{team name: StatsHub id} for a competition's current season, read
    from its league table. Cached 12 hours."""
    def load():
        ut = SH_TOURNAMENTS.get(league)
        if not ut:
            return None
        seasons = (_get_json(f"{SH_BASE}/api/unique-tournament/{ut}/seasons") or {}).get("data") or []
        if not seasons:
            return None
        season = max(seasons, key=lambda s: s.get("id") or 0)  # ids only grow, so the highest is current
        rows = (_get_json(f"{SH_BASE}/api/tournament/{ut}/{season['id']}/standing") or {}).get("data") or []
        return {r["teamName"]: r["teamId"] for r in rows if r.get("teamName") and r.get("teamId")} or None
    return _cached(("sh", "league", league), 12 * 3600, load)


def sh_team_ids(home, away, league=None):
    """(home_id, away_id) on StatsHub. Matches the names against the
    competition's own team list (reliable: 'Inter Milan' finds 'Inter'
    among 20 clubs), falling back to StatsHub's search, which only works
    for near-exact names. Cached 6 hours."""
    def load():
        teams = {}
        extra = list(COMPETITIONS[league].get("sh_teams", ())) if league in COMPETITIONS else []
        for lg in ([league] if league in SH_TOURNAMENTS else []) + extra:
            teams.update(sh_league_teams(lg) or {})
        # Each team from the competition's own list; if it isn't there (no
        # table yet, a cup, a newly promoted club), from StatsHub's team search.
        ids = []
        for name in (home, away):
            hit = (closed_match(name, teams) if not extra else best_match(name, teams)) if teams else None
            ids.append(teams[hit] if hit else sh_search_team(name) if not teams or extra else None)
        if all(ids) and ids[0] != ids[1]:
            return tuple(ids)
        data = _get_json(f"{SH_BASE}/api/search", {"q": home})
        for f in (data or {}).get("fixtures") or []:
            if name_similarity(home, f.get("homeTeamName")) >= 0.75 and name_similarity(away, f.get("awayTeamName")) >= 0.75:
                return f.get("homeTeamId"), f.get("awayTeamId")
        return None
    return _cached(("sh", "ids", home, away, league), 6 * 3600, load)


# StatsHub's search mixes in other sports and teams without saying so.
_NOT_MENS_FOOTBALL = re.compile(r"h[aå]nd(bold|ball|boll)|basket|volley|hockey|futsal|women|femin|frauen|\bw\b|\bu\d\d\b|reserves|\bii\b|\bb\b",
                                re.I)


def _not_mens(team):
    """The name alone isn't enough: StatsHub calls Chelsea's women's side
    "Chelsea FC" and Tottenham's "Tottenham FC", and only the slug
    ("chelsea-fc-women") says so. Both then tie with the men's team on name
    and the search gives up, losing that club's player stats entirely."""
    return bool(_NOT_MENS_FOOTBALL.search(team.get("name") or "")
                or _NOT_MENS_FOOTBALL.search((team.get("slug") or "").replace("-", " ")))


_SEARCH_SKIP = {"real", "club", "sport", "sporting", "athletic", "atletico", "united", "city", "town"}


def _search_queries(name):
    """What to ask StatsHub for `name`. Its search prefix-matches every word
    you give it against the words in a club's name, so "Bayern Munich" finds
    nothing at all (no word starts with "munich" — theirs is "München") while
    "Bayern" finds it at once. So: the whole name, its alias, then its own
    distinctive words, longest first."""
    seen = list(dict.fromkeys((name, _norm(name))))
    words = sorted((w for w in re.split(r"[^0-9A-Za-zÀ-ÿ]+", _norm(name))
                    if len(w) >= 4 and w.lower() not in _SEARCH_SKIP), key=len, reverse=True)
    return seen + [w for w in words[:2] if w not in seen]


def sh_team_choices(name):
    """Every men's club StatsHub offers for `name`, closest first, as
    [(similarity, club name, id)] — with no similarity floor, so a caller
    that can check a candidate some other way gets to see the near misses.
    Cached 12 hours."""
    def load():
        found = {}
        for q in _search_queries(name):
            for t in ((_get_json(f"{SH_BASE}/api/search", {"q": q}) or {}).get("teams") or []):
                # Keyed by id, never by name: StatsHub lists two clubs called
                # "Juventus" (2687 and 269824), and keying by name kept only
                # the second — the wrong one, silently.
                if t.get("name") and t.get("id") and not _not_mens(t):
                    found[t["id"]] = t["name"]
            if any(name_similarity(name, c) >= 0.75 for c in found.values()):
                break                                  # good enough; don't go fishing with single words
        # Ties break towards the lower id: where StatsHub holds the same club
        # name twice, the long-established men's club is the older record.
        return [(s, c, i) for s, i, c in
                sorted(((name_similarity(name, c), i, c) for i, c in found.items()),
                       key=lambda x: (-x[0], x[1]))]
    return _cached(("sh", "choices2", name), 12 * 3600, load)


def sh_search_team(name):
    """StatsHub id for one club from its team search, or None unless one
    result clearly is that club. Cached 12 hours."""
    choices = [c for c in sh_team_choices(name) if c[0] >= 0.75]
    if not choices:
        return None
    if len(choices) > 1 and choices[1][0] == choices[0][0] and choices[1][1] != choices[0][1]:
        return None                                    # two different names, equally good: neither is safe
    return choices[0][2]


def sh_players(team_id, limit=20):
    """Per-player, per-match stats for a team's last `limit` matches (all
    competitions): {"players": [{"name", "position" (G/D/M/F), "matches":
    [{"ts", "opp", "home", "score", "comp", "minutes", "shots", "sot",
    "goals", "xg", "yellow", "red", "sub_in", "assists", "xa", "fouls",
    "fouled", "tackles", "offsides", "saves"}, ...] newest first}]}.
    Cached 30 min (StatsHub rate-limits)."""
    def load():
        data = _get_json(f"{SH_BASE}/api/team/{team_id}/players/performance",
                         {"tournamentId": "", "limit": limit, "location": "both"}, timeout=25)
        if not data:
            return None
        events = {}
        for item in data.get("events") or []:
            ev = item.get("events") or {}
            is_home = ev.get("homeTeamId") == team_id
            opp = (item.get("awayTeam") if is_home else item.get("homeTeam")) or {}
            hs, aws = ev.get("homeScoreCurrent"), ev.get("awayScoreCurrent")
            events[str(ev.get("id"))] = {
                "ts": ev.get("timeStartTimestamp") or 0, "opp": opp.get("shortname") or opp.get("name") or "?",
                "home": is_home, "score": f"{hs}-{aws}" if hs is not None and aws is not None else "",
                "comp": (item.get("tournaments") or {}).get("name", ""),
            }
        players = []
        for p in data.get("data") or []:
            matches = []
            for event_id, s in (p.get("stats") or {}).items():
                minutes = s.get("minutesPlayed") or 0
                if minutes <= 0:
                    continue
                try:
                    xg = float(s.get("expectedGoals") or 0)
                except (TypeError, ValueError):
                    xg = 0.0
                info = events.get(str(event_id), {"ts": 0, "opp": "?", "home": True, "score": "", "comp": ""})
                try:
                    xa = float(s.get("expectedAssists") or 0)
                except (TypeError, ValueError):
                    xa = 0.0
                matches.append({**info, "minutes": minutes, "shots": s.get("shots") or 0,
                                "sot": s.get("onTargetScoringAttempt") or 0, "goals": s.get("goals") or 0, "xg": xg,
                                "yellow": 1 if s.get("yellowCard") else 0, "red": 1 if s.get("redCard") else 0,
                                # StatsHub names these from the substitution's point of
                                # view, not the player's, and they read backwards:
                                #   substitutedIn  = a sub came IN for him -> he came OFF
                                #   substitutedOut = he was the one who came ON
                                # Measured on 309 player-matches with minutes (Liverpool,
                                # last 20): substitutedIn=true is median 72 minutes and
                                # never a full 90, substitutedOut=true is median 18 with
                                # 60% under 20 minutes. The second one is a substitute
                                # appearance; the first is a starter being taken off.
                                # Reading substitutedIn here threw away every start that
                                # ended in a substitution and counted every cameo as one.
                                "sub_in": bool(s.get("substitutedOut")),
                                "assists": s.get("goalAssist") or 0, "xa": xa, "fouls": s.get("fouls") or 0,
                                "fouled": s.get("wasFouled") or 0, "tackles": s.get("totalTackle") or 0,
                                "offsides": s.get("totalOffside") or 0, "saves": s.get("saves") or 0})
            matches.sort(key=lambda m: m["ts"], reverse=True)
            players.append({"name": p.get("name"), "position": p.get("position"), "matches": matches})
        return {"players": players}
    return _cached(("sh", "players", team_id), 30 * 60, load)


def sh_recent(team_id, what, limit=10):
    """Per-match (for, against) values for a team's last `limit` matches."""
    data = _get_json(f"{SH_BASE}/api/team/{team_id}/event-statistics",
                     {"eventType": "all", "statisticKey": SH_KEYS[what], "eventHalf": "ALL", "limit": limit})
    out = []
    for row in (data or {}).get("data") or []:
        try:
            hv, av = float(row["home_value"]), float(row["away_value"])
        except (KeyError, TypeError, ValueError):
            continue
        out.append((hv, av) if row.get("home_team_id") == team_id else (av, hv))
    return out


def sh_team_averages(home, away, league=None):
    """{"home": {...}, "away": {...}} with per-game averages (for/against)
    of corners, cards and shots on target over the last 10 matches in all
    competitions. None if the teams can't be found on StatsHub. Cached for
    30 minutes: StatsHub rate-limits (HTTP 429) rapid repeat requests."""
    return _cached(("sh", "avg", home, away), 30 * 60, lambda: _sh_team_averages(home, away, league))


def _sh_team_averages(home, away, league):
    ids = sh_team_ids(home, away, league)
    if not ids or None in ids:
        return None
    jobs = {(side, what): (tid, what) for side, tid in zip(("home", "away"), ids) for what in SH_KEYS}
    with ThreadPoolExecutor(len(jobs)) as ex:
        results = dict(zip(jobs, ex.map(lambda args: sh_recent(*args), jobs.values())))
    out = {}
    for side in ("home", "away"):
        stats = {}
        for what in ("corners", "sot"):
            rows = results[(side, what)]
            if rows:
                stats[what] = (sum(r[0] for r in rows) / len(rows), sum(r[1] for r in rows) / len(rows), len(rows))
        y, r = results[(side, "yellow")], results[(side, "red")]
        if y:
            reds = r if len(r) == len(y) else [(0, 0)] * len(y)
            stats["cards"] = (sum(a[0] + b[0] for a, b in zip(y, reds)) / len(y),
                              sum(a[1] + b[1] for a, b in zip(y, reds)) / len(y), len(y))
        out[side] = stats
    return out


# ---------------------------------------------------------------------------
# Pipeline health checks for the status panel: (ok, detail)
# ---------------------------------------------------------------------------
def check_365scores():
    ok = _s365("games/fixtures", competitions=S365_COMPETITIONS["Premier League"]) is not None
    return ok, "fixtures endpoint"


def check_football_data():
    return _get(f"{FD_BASE}/fixtures.csv", timeout=15) is not None, "fixtures.csv"


def check_polymarket():
    return _get_json(f"{PM_BASE}/sports") is not None, "gamma /sports"


def check_statshub():
    return _get_json(f"{SH_BASE}/api/search", {"q": "arsenal"}) is not None, "api/search"


PIPELINE_CHECKS = {
    "365Scores": check_365scores,
    "football-data": check_football_data,
    "Polymarket": check_polymarket,
    "StatsHub": check_statshub,
}

# ---------------------------------------------------------------------------
# PropLine — player-prop prices from the books that price closest to Bet365
# ---------------------------------------------------------------------------
# Bet365 has no feed for player props, and no free service carries its prices.
# Measured on 18 matches against Bet365's own match prices (365Scores), these
# books sit within ~2-3%: DraftKings +0.1%, FanDuel +0.4%, Unibet -0.6%,
# BetRivers -0.7%. HAWK takes their median as the stand-in for Bet365's price.
# Needs a free PropLine key in the PROPLINE_KEY environment variable (a GitHub
# secret); without one this is skipped and HAWK falls back to Unibet alone.
PL_BASE = "https://api.prop-line.com/v1"
PL_BOOKS = ("draftkings", "fanduel", "unibet", "betrivers")
PL_SPORTS = {
    "Premier League": "soccer_epl", "La Liga": "soccer_la_liga", "Serie A": "soccer_serie_a",
    "Bundesliga": "soccer_bundesliga", "Ligue 1": "soccer_ligue_1", "MLS": "soccer_mls",
    "Championship": "soccer_championship", "Eredivisie": "soccer_eredivisie", "Liga MX": "soccer_liga_mx",
    "Liga Portugal": "soccer_primeira_liga", "Brasileirão": "soccer_brasileirao",
    "Argentina Primera": "soccer_argentina_primera", "Scottish Premiership": "soccer_scottish_premiership",
    "Saudi Pro League": "soccer_saudi_pro",
}
# PropLine market -> (HAWK prop key, how to read the line from an outcome)
PL_MARKETS = {
    "anytime_goal_scorer": "score", "goal_or_assist": "soa", "player_shots_on_target": "sot",
    "player_shots": "shots", "player_assists": "assist", "player_tackles": "tackles",
    "player_cards": "booked", "goalie_saves": "saves",
}
_PL_PLUS = re.compile(r"(\d+)\+")


def _pl(path, key, **params):
    if not key:
        return None
    return _get_json(PL_BASE + path, dict(params, apiKey=key), timeout=25)


def _american_to_decimal(price):
    try:
        a = float(price)
    except (TypeError, ValueError):
        return None
    if a == 0:
        return None
    return round(1 + (a / 100 if a > 0 else 100 / abs(a)), 3)


def pl_events(league, key):
    sport = PL_SPORTS.get(league)
    data = _pl(f"/sports/{sport}/events", key) if sport else None
    return data if isinstance(data, list) else []


def pl_props(league, event_id, key):
    """[{key: "sot2", player: "Bryan Mbeumo", price: 2.35, books: 3}] — the median
    price of the close-to-Bet365 books for every player leg HAWK builds with."""
    sport = PL_SPORTS.get(league)
    data = _pl(f"/sports/{sport}/events/{event_id}/odds", key,
               markets=",".join(PL_MARKETS), bookmakers=",".join(PL_BOOKS)) if sport else None
    prices = {}
    for book in (data or {}).get("bookmakers", []):
        for market in book.get("markets", []):
            stat = PL_MARKETS.get(market.get("key"))
            if not stat:
                continue
            for out in market.get("outcomes", []):
                player = out.get("description") or market.get("description") or ""
                name = str(out.get("name") or "")
                need = 1
                if stat in ("sot", "shots", "tackles", "saves", "assist"):
                    m = _PL_PLUS.search(name)
                    point = out.get("point")
                    if m:
                        need = int(m.group(1))
                    elif point is not None and "over" in name.lower():
                        need = int(float(point) + 0.5)
                    else:
                        continue
                elif "no" in name.lower().split() or name.lower().startswith("no "):
                    continue
                dec = _american_to_decimal(out.get("price"))
                if not player or not dec or dec <= 1.01:
                    continue
                leg = f"{stat}{need if stat not in ('score', 'soa', 'booked') else ''}"
                prices.setdefault((leg, player.strip()), []).append(dec)
    rows = []
    for (leg, player), vals in prices.items():
        vals.sort()
        median = vals[len(vals) // 2] if len(vals) % 2 else round((vals[len(vals) // 2 - 1] + vals[len(vals) // 2]) / 2, 3)
        rows.append({"key": leg, "player": player, "price": median, "books": len(vals)})
    return rows
