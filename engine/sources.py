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

LEAGUES = ("Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Champions League")

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


def _get(url, params=None, timeout=TIMEOUT):
    # Retries: several requests fire in parallel per fixture; 365Scores
    # occasionally times out or returns a 504, and StatsHub rate-limits
    # with 429 (so back off before trying again).
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
            return None
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
    return None


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
              "vfb", "vfl", "tsg", "the", "de", "calcio", "and", "hove", "albion", "1"}

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
}


def _norm(name):
    s = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ").replace("'", "").replace(".", "")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = " ".join(t for t in s.split() if t not in _STOPWORDS)
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
S365_COMPETITIONS = {
    "Premier League": 7, "La Liga": 11, "Serie A": 17,
    "Bundesliga": 25, "Ligue 1": 35, "Champions League": 572,
}
# Odds are geo-gated by userCountryId (-1 returns none). Each of these
# countries exposes a different bookmaker set, confirmed live:
#   21 -> Bet365, NoviBet, Superbet, SportingBet   31 -> BWIN   37 -> STS
S365_ODDS_COUNTRIES = (21, 31, 37)


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
FD_LEAGUE_CODES = {"Premier League": "E0", "La Liga": "SP1", "Serie A": "I1", "Bundesliga": "D1", "Ligue 1": "F1"}
# Extra top divisions, only searched for Champions League teams.
FD_EXTRA_CODES = ("P1", "N1", "B1", "SC0", "T1", "G1")
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


def fd_teams(code, season):
    matches = fd_matches(code, season) or []
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
PM_SERIES = {"Premier League": "10188", "La Liga": "10193", "Serie A": "10203",
             "Bundesliga": "10194", "Ligue 1": "10195", "Champions League": "10204"}
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
SH_TOURNAMENTS = {"Premier League": 17, "La Liga": 8, "Serie A": 23, "Bundesliga": 35, "Ligue 1": 34,
                  "Champions League": 7}


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
        for lg in ([league] if league in SH_TOURNAMENTS else []) + (["Champions League"] if league else []):
            teams.update(sh_league_teams(lg) or {})
        if teams:
            h, a = best_match(home, teams, threshold=0.7), best_match(away, teams, threshold=0.7)
            if h and a:
                return teams[h], teams[a]
        data = _get_json(f"{SH_BASE}/api/search", {"q": home})
        for f in (data or {}).get("fixtures") or []:
            if name_similarity(home, f.get("homeTeamName")) >= 0.75 and name_similarity(away, f.get("awayTeamName")) >= 0.75:
                return f.get("homeTeamId"), f.get("awayTeamId")
        return None
    return _cached(("sh", "ids", home, away, league), 6 * 3600, load)


def sh_players(team_id, limit=20):
    """Per-player, per-match stats for a team's last `limit` matches (all
    competitions): {"players": [{"name", "position" (G/D/M/F), "matches":
    [{"ts", "opp", "home", "score", "comp", "minutes", "shots", "sot",
    "goals", "xg", "yellow", "red", "sub_in"}, ...] newest first}]}.
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
                matches.append({**info, "minutes": minutes, "shots": s.get("shots") or 0,
                                "sot": s.get("onTargetScoringAttempt") or 0, "goals": s.get("goals") or 0, "xg": xg,
                                "yellow": 1 if s.get("yellowCard") else 0, "red": 1 if s.get("redCard") else 0,
                                "sub_in": bool(s.get("substitutedIn"))})
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
