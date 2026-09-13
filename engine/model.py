"""Hawk MK II probability engine.

Three layers, each deliberately simple and documented:

1. Team ratings (build_profile): recency-weighted attack/defence ratings
   for goals, shots on target, corners and cards from football-data.co.uk
   match data. Goals use a 60/40 blend of xG and real goals where xG
   exists. Ratings are relative to the league's home/away averages (so
   home advantage lives in the league numbers) and are shrunk toward a
   prior, so a team's first few games can't produce extreme values.

2. Match expectation: expected count per side = league average x attack
   x opposing defence. Goals go through a Dixon-Coles adjusted Poisson
   score matrix; corners/cards/shots use a Poisson on the match total.

3. Market blend: the bookmakers' consensus (margin removed) is blended
   with the model, MARKET_WEIGHT to the market. The market gets most of
   the weight because it is usually the better forecaster; the model's
   job is to catch lines where one book's price is out of step.
"""
import math

import numpy as np

XG_WEIGHT = 0.6            # share of xG (vs real goals) in the goals metric
HALF_LIFE_DAYS = 180.0     # a match this many days old counts half as much
SHRINK_GAMES = 6.0         # prior strength, in "matches", for every rating
MARKET_WEIGHT = 0.7        # share of bookmaker consensus in final probabilities
DC_RHO = -0.10             # Dixon-Coles low-score correction (typical fitted
                           # values for top leagues sit around -0.05 to -0.15)
MAX_GOALS = 10
REF_SHRINK_GAMES = 10.0    # prior strength for referee card averages
STATS = ("goals", "shots", "sot", "corners", "cards")
# Teams missing from last season's league (promoted) start from a weaker
# prior instead of league average: (attack, defence).
PROMOTED_PRIOR = {"goals": (0.85, 1.15), "shots": (0.9, 1.1), "sot": (0.85, 1.15), "corners": (0.9, 1.1),
                  "cards": (1.0, 1.0)}

_LOGFACT = np.array([math.lgamma(k + 1) for k in range(200)])


# ---------------------------------------------------------------------------
# 1. Team ratings
# ---------------------------------------------------------------------------
def _values(m, stat):
    """(home, away) value of `stat` for one match, or None if missing."""
    if stat == "goals":
        if m["hg"] is None or m["ag"] is None:
            return None
        if m["hxg"] is not None and m["axg"] is not None:
            return (XG_WEIGHT * m["hxg"] + (1 - XG_WEIGHT) * m["hg"],
                    XG_WEIGHT * m["axg"] + (1 - XG_WEIGHT) * m["ag"])
        return m["hg"], m["ag"]
    if stat == "cards":  # yellows + reds, the usual "number of cards" count
        if m["hy"] is None or m["ay"] is None:
            return None
        return m["hy"] + (m["hr"] or 0), m["ay"] + (m["ar"] or 0)
    pair = {"sot": (m["hst"], m["ast"]), "shots": (m.get("hs"), m.get("as")), "corners": (m["hc"], m["ac"])}[stat]
    return None if None in pair else pair


def build_profile(current, previous, today):
    """Ratings for every team in one league, from this season's and last
    season's matches. Returns None if there's no data at all."""
    weighted = [(m, 0.5 ** (max((today - m["date"]).days, 0) / HALF_LIFE_DAYS)) for m in current + previous]
    if not weighted:
        return None
    prev_teams = {m["home"] for m in previous} | {m["away"] for m in previous}

    avg = {}
    for stat in STATS:
        sw = sh = sa = 0.0
        for m, w in weighted:
            v = _values(m, stat)
            if v:
                sw, sh, sa = sw + w, sh + w * v[0], sa + w * v[1]
        if sw > 0 and sh > 0 and sa > 0:
            avg[stat] = (sh / sw, sa / sw)

    teams = {}
    for stat, (avg_home, avg_away) in avg.items():
        acc = {}
        for m, w in weighted:
            v = _values(m, stat)
            if not v:
                continue
            for team, got, conceded, avg_got, avg_conceded in (
                    (m["home"], v[0], v[1], avg_home, avg_away),
                    (m["away"], v[1], v[0], avg_away, avg_home)):
                s = acc.setdefault(team, [0.0, 0.0, 0.0])
                s[0] += w * got / avg_got
                s[1] += w * conceded / avg_conceded
                s[2] += w
        for team, (s_att, s_def, s_w) in acc.items():
            promoted = bool(previous) and team not in prev_teams
            p_att, p_def = PROMOTED_PRIOR[stat] if promoted else (1.0, 1.0)
            teams.setdefault(team, {"promoted": promoted})[stat] = {
                "att": (s_att + SHRINK_GAMES * p_att) / (s_w + SHRINK_GAMES),
                "def": (s_def + SHRINK_GAMES * p_def) / (s_w + SHRINK_GAMES),
            }
    for team in teams:
        teams[team]["games_this_season"] = sum(1 for m in current if team in (m["home"], m["away"]))

    referees = {}
    for m, _ in weighted:
        v = _values(m, "cards")
        if v and m["referee"]:
            r = referees.setdefault(m["referee"], [0.0, 0])
            r[0] += v[0] + v[1]
            r[1] += 1

    return {"avg": avg, "teams": teams, "referees": referees,
            "avg_cards_total": sum(avg["cards"]) if "cards" in avg else None}


def expected_pair(home_prof, home, away_prof, away, stat):
    """Expected (home, away) count of `stat`, or None without data. The two
    profiles differ only for cross-league (Champions League) matches, where
    the league averages are averaged."""
    try:
        h, a = home_prof["teams"][home][stat], away_prof["teams"][away][stat]
        avg_home = (home_prof["avg"][stat][0] + away_prof["avg"][stat][0]) / 2
        avg_away = (home_prof["avg"][stat][1] + away_prof["avg"][stat][1]) / 2
    except (KeyError, TypeError):
        return None
    return avg_home * h["att"] * a["def"], avg_away * a["att"] * h["def"]


def referee_factor(avg_cards, games, league_avg_total):
    """Multiplier for expected cards: the referee's shrunk average over the
    league average. 1.0 when either number is unknown."""
    if not avg_cards or not games or not league_avg_total:
        return 1.0
    shrunk = (games * avg_cards + REF_SHRINK_GAMES * league_avg_total) / (games + REF_SHRINK_GAMES)
    return shrunk / league_avg_total


# ---------------------------------------------------------------------------
# 2. Distributions
# ---------------------------------------------------------------------------
def _pmf_table(lams, n):
    lams = np.atleast_1d(np.asarray(lams, dtype=float))
    k = np.arange(n + 1)
    return np.exp(-lams[:, None] + k[None, :] * np.log(lams[:, None]) - _LOGFACT[:n + 1][None, :])


def score_matrix(lam_home, lam_away):
    """P(home goals = i, away goals = j), Dixon-Coles adjusted."""
    m = np.outer(_pmf_table(lam_home, MAX_GOALS)[0], _pmf_table(lam_away, MAX_GOALS)[0])
    m[0, 0] *= 1 - lam_home * lam_away * DC_RHO
    m[0, 1] *= 1 + lam_home * DC_RHO
    m[1, 0] *= 1 + lam_away * DC_RHO
    m[1, 1] *= 1 - DC_RHO
    return m / m.sum()


def poisson_over(lam, line):
    """P(total > line) for a half line such as 9.5."""
    k = int(math.floor(line))
    return float(1.0 - _pmf_table(lam, k)[0].sum())


# ---------------------------------------------------------------------------
# 3. Fitting the market's numbers back into model parameters
# ---------------------------------------------------------------------------
_I, _J = np.indices((MAX_GOALS + 1, MAX_GOALS + 1))


def _grid_probs(grid_h, grid_a, mask):
    """P(mask) for every (lam_home, lam_away) pair on the grid, including
    the Dixon-Coles adjustment (only the four low-score cells change)."""
    H, A = _pmf_table(grid_h, MAX_GOALS), _pmf_table(grid_a, MAX_GOALS)
    p = H @ mask.astype(float) @ A.T
    lh, la = np.asarray(grid_h)[:, None], np.asarray(grid_a)[None, :]
    deltas = {(0, 0): -lh * la * DC_RHO, (0, 1): lh * DC_RHO, (1, 0): la * DC_RHO, (1, 1): -DC_RHO}
    for (i, j), tau in deltas.items():
        if mask[i, j]:
            p = p + H[:, i][:, None] * A[:, j][None, :] * tau
    return p


def fit_goal_lambdas(p_1x2=None, totals=()):
    """The (lam_home, lam_away) whose score matrix best reproduces the
    market's 1X2 probabilities and Over probabilities at each total line.
    p_1x2 = (home, draw, away); totals = [(line, p_over), ...]."""
    if not p_1x2 and not totals:
        return None
    targets = []
    if p_1x2:
        targets += [(_I > _J, p_1x2[0]), (_I == _J, p_1x2[1]), (_I < _J, p_1x2[2])]
    targets += [((_I + _J) > line, p_over) for line, p_over in totals]

    def solve(grid_h, grid_a):
        loss = sum((_grid_probs(grid_h, grid_a, mask) - target) ** 2 for mask, target in targets)
        i, j = np.unravel_index(np.argmin(loss), loss.shape)
        return float(grid_h[i]), float(grid_a[j])

    coarse = np.arange(0.10, 4.01, 0.05)
    lh, la = solve(coarse, coarse)
    return solve(np.arange(max(0.02, lh - 0.06), lh + 0.061, 0.005),
                 np.arange(max(0.02, la - 0.06), la + 0.061, 0.005))


def fit_total_lambda(lines):
    """The Poisson mean that best reproduces the market's Over
    probabilities at each line. lines = [(line, p_over), ...]."""
    if not lines:
        return None

    def solve(grid):
        loss = np.zeros(len(grid))
        for line, p_over in lines:
            k = int(math.floor(line))
            over = 1.0 - _pmf_table(grid, k).sum(axis=1)
            loss += (over - p_over) ** 2
        return float(grid[np.argmin(loss)])

    lam = solve(np.arange(0.2, 40.0, 0.05))
    return solve(np.arange(max(0.05, lam - 0.06), lam + 0.061, 0.005))


def blend(model_value, market_value, weight=MARKET_WEIGHT):
    """MARKET_WEIGHT of the market plus the rest from the model; whichever
    exists if only one does."""
    if model_value is None:
        return market_value
    if market_value is None:
        return model_value
    return weight * market_value + (1 - weight) * model_value
