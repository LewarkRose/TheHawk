import tkinter as tk
from tkinter import ttk, messagebox
import threading
import math
import requests

try:
    from playwright.sync_api import sync_playwright
    _PLAYWRIGHT_AVAILABLE = True
except ImportError:
    _PLAYWRIGHT_AVAILABLE = False

try:
    from football_scraper import FootballClient
    _football_client = FootballClient()
    _FOOTBALL_SCRAPER_AVAILABLE = True
except ImportError:
    _football_client = None
    _FOOTBALL_SCRAPER_AVAILABLE = False

# ============================================================
# CONFIG — no API keys needed at all. Fixtures, odds, recent
# form, league table and lineup status all come from
# 365Scores' public JSON feed; Polymarket supplies sentiment.
# StatsHub is checked but not used for legs — see
# check_statshub() below for why. Sofascore was dropped — its
# unofficial API blocked every real attempt to reach it
# (headers, then cloudscraper), which is a strong sign it's
# blocking by IP or account pattern rather than anything
# fixable from a plain script.
#
# TheSportsDB was dropped too. Its free key "3" turned out to
# be unusable, confirmed live: eventslast.php returns only ONE
# match per team, lookuptable.php returns only the top 5 rows
# of the table, and searchteams.php returns the women's side
# for some clubs ("Brighton" -> Brighton WFC, "Tottenham" ->
# Tottenham Women). 365Scores covers all of it by team ID, so
# there's no name matching to go wrong.
# ============================================================
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
}

# 365Scores competition IDs — same ones verified directly from your web
# app's widget generator earlier.
SCORES365_COMPETITION_IDS = {
    "Premier League": 7,
    "La Liga": 11,
    "Serie A": 17,
    "Bundesliga": 25,
    "Ligue 1": 35,
    "Champions League": 572,
}

SCORES365_BASE = "https://webws.365scores.com/web"
SCORES365_COMMON_PARAMS = {
    "appTypeId": 5,
    "langId": 1,
    "timezoneName": "Europe/London",
    "userCountryId": -1,
}
# Odds live at /bets/lines/?games=<id>, not on the /game/ payload, and
# they're geo-gated: userCountryId=-1 returns an empty "lines" list.
# Country 1 is confirmed live to return bookmaker 14's full market list
# (1X2, Double Chance, Over/Under, BTTS, Corners, Cards, ...).
ODDS_COUNTRY_ID = 1
TOP_BOOKMAKER_ID = 14

# 365Scores lineTypeId values, confirmed live from /bets/lines/.
LINE_1X2 = 1
LINE_TOTAL_GOALS = 3
LINE_BTTS = 12
LINE_DOUBLE_CHANCE = 14
LINE_TOTAL_CORNERS = 137
LINE_TOTAL_CARDS = 141

# How many recent competitive (non-friendly) matches feed the form stats
# and the Poisson model.
FORM_GAMES = 6


class JarvisHawkApp:
    def __init__(self, root):
        self.root = root
        self.root.title("JARVIS // Hawk MK II Command Center")
        self.root.geometry("560x880")
        self.root.configure(bg="#121212")
        self.root.resizable(False, False)

        self.is_polling = True
        self.live_fixtures = {}  # league name -> list of (display_name, game_dict)

        title_label = tk.Label(
            root, text="HAWK MK II CONTROL PANEL",
            font=("Consolas", 16, "bold"), fg="#FFD700", bg="#121212"
        )
        title_label.pack(pady=(15, 5))

        self.status_label = tk.Label(
            root, text="System Status: Checking data pipelines...",
            font=("Arial", 10), fg="#FFD700", bg="#121212"
        )
        self.status_label.pack(pady=(0, 10))

        # ---- Step 1: League selection ----
        league_frame = tk.LabelFrame(
            root, text=" Step 1: League ",
            font=("Arial", 10, "bold"), fg="#FFFFFF", bg="#1e1e1e", bd=2
        )
        league_frame.pack(fill="x", padx=20, pady=5)

        self.league_combobox = ttk.Combobox(league_frame, font=("Arial", 10), state="readonly")
        self.league_combobox['values'] = list(SCORES365_COMPETITION_IDS.keys())
        self.league_combobox.pack(fill="x", padx=15, pady=10)
        self.league_combobox.bind("<<ComboboxSelected>>", self.on_league_selected)

        # ---- Step 2: Fixture selection (from 365Scores directly) ----
        fixture_frame = tk.LabelFrame(
            root, text=" Step 2: Fixture (loaded live from 365Scores) ",
            font=("Arial", 10, "bold"), fg="#FFFFFF", bg="#1e1e1e", bd=2
        )
        fixture_frame.pack(fill="x", padx=20, pady=5)

        self.fixture_combobox = ttk.Combobox(fixture_frame, font=("Arial", 10), state="readonly")
        self.fixture_combobox.pack(fill="x", padx=15, pady=10)

        # ---- Pipeline Status Frame — every one of these is a REAL check ----
        pipeline_frame = tk.LabelFrame(
            root, text=" Active Data Pipelines (live-checked, not simulated) ",
            font=("Arial", 10, "bold"), fg="#FFFFFF", bg="#1e1e1e", bd=2
        )
        pipeline_frame.pack(fill="x", padx=20, pady=5)

        self.pipeline_labels = {}
        pipelines = [
            ("scores365", "365Scores Fixtures, Odds, Form & Table"),
            ("fotmob", "FotMob Lineup Verification"),
            ("polymarket", "Polymarket Sentiment"),
            ("statshub", "StatsHub Deep Stats (via headless browser)"),
        ]
        for key, name in pipelines:
            row = tk.Frame(pipeline_frame, bg="#1e1e1e")
            row.pack(fill="x", padx=15, pady=3)
            tk.Label(row, text=name, font=("Arial", 9), fg="#cccccc", bg="#1e1e1e").pack(side="left")
            status_lbl = tk.Label(row, text="CHECKING...", font=("Arial", 9, "bold"), fg="#888888", bg="#1e1e1e")
            status_lbl.pack(side="right")
            self.pipeline_labels[key] = status_lbl

        recheck_btn = tk.Button(
            pipeline_frame, text="Re-check Pipelines", font=("Arial", 8),
            bg="#2a2a2a", fg="#cccccc", command=self.start_pipeline_checks
        )
        recheck_btn.pack(pady=(2, 8))

        # ---- Bet Builder Output Frame ----
        builder_frame = tk.LabelFrame(
            root, text=" Hawk MK II Bet Builder Engine ",
            font=("Arial", 10, "bold"), fg="#FFD700", bg="#1e1e1e", bd=2
        )
        builder_frame.pack(fill="x", padx=20, pady=10)

        # The full report runs well past 13 lines, so it needs a scrollbar.
        builder_scroll = tk.Scrollbar(builder_frame)
        builder_scroll.pack(side="right", fill="y", pady=10, padx=(0, 10))
        self.builder_text = tk.Text(
            builder_frame, height=13, width=58, font=("Consolas", 9),
            bg="#0a0a0a", fg="#00FF7F", bd=0, relief="flat", wrap="word",
            yscrollcommand=builder_scroll.set
        )
        self.builder_text.pack(side="left", padx=(10, 0), pady=10)
        builder_scroll.config(command=self.builder_text.yview)
        self._set_builder_text(
            "1. Pick a league above.\n"
            "2. Pick a fixture — loaded live from 365Scores' own feed,\n"
            "   the same source your HAWK web app uses.\n"
            "3. Click 'Generate Best Legs' — pulls odds and recent\n"
            "   form directly from 365Scores itself (no API key needed\n"
            "   anywhere here), plus sentiment context from Polymarket.\n\n"
            "If a source has nothing, it says so — nothing here is\n"
            "filled in with placeholder text."
        )

        # ---- Action Buttons ----
        btn_frame = tk.Frame(root, bg="#121212")
        btn_frame.pack(fill="x", padx=20, pady=10)

        self.builder_btn = tk.Button(
            btn_frame, text="Generate Best Legs",
            font=("Arial", 10, "bold"), bg="#00FF7F", fg="#121212",
            width=20, height=2, command=self.on_generate_clicked
        )
        self.builder_btn.pack(side="left", padx=(0, 10))

        exit_btn = tk.Button(
            btn_frame, text="Shutdown",
            font=("Arial", 10, "bold"), bg="#ff4d4d", fg="#ffffff",
            width=12, height=2, command=self.on_close
        )
        exit_btn.pack(side="right")

        footer_label = tk.Label(
            root, text="Jarvis x Hawk MK II Integration Framework",
            font=("Arial", 8), fg="#666666", bg="#121212"
        )
        footer_label.pack(side="bottom", pady=10)

        self.start_pipeline_checks()

    # ------------------------------------------------------------------
    # PIPELINE HEALTH CHECKS
    # ------------------------------------------------------------------
    def start_pipeline_checks(self):
        for key in self.pipeline_labels:
            self.pipeline_labels[key].config(text="CHECKING...", fg="#888888")
        threading.Thread(target=self._run_pipeline_checks, daemon=True).start()

    def _run_pipeline_checks(self):
        checks = {
            "scores365": self.check_365scores,
            "fotmob": self.check_fotmob,
            "polymarket": self.check_polymarket,
            "statshub": self.check_statshub,
        }
        for key, fn in checks.items():
            try:
                ok, detail = fn()
            except Exception as e:
                ok, detail = False, str(e)
            self.root.after(0, self._update_pipeline_label, key, ok, detail)

    def _update_pipeline_label(self, key, ok, detail):
        label = self.pipeline_labels[key]
        label.config(text="ONLINE" if ok else "OFFLINE", fg="#00FF7F" if ok else "#ff4d4d")
        print(f"[pipeline check] {key}: {'OK' if ok else 'FAILED'} ({detail})")

    def check_365scores(self):
        # Undocumented but public JSON endpoint — same one confirmed used by
        # several open-source 365Scores integrations. Could change without
        # notice since it's not an officially published API.
        # Retries once with a longer timeout: this call runs alongside three
        # other checks firing at once on startup, which can cause a slow
        # first response even when the endpoint itself is fine.
        params = dict(SCORES365_COMMON_PARAMS, competitions=SCORES365_COMPETITION_IDS["Premier League"])
        for timeout in (8, 15):
            try:
                r = requests.get(f"{SCORES365_BASE}/games/results/", params=params, headers=REQUEST_HEADERS, timeout=timeout)
                return r.status_code == 200, f"HTTP {r.status_code}"
            except requests.exceptions.Timeout:
                continue
        return False, "Timed out twice — check your connection or try Re-check Pipelines"

    def check_polymarket(self):
        r = requests.get("https://gamma-api.polymarket.com/markets?limit=1", timeout=6)
        return r.status_code == 200, f"HTTP {r.status_code}"

    def check_fotmob(self):
        # Previous guessed endpoint (fotmob.com/api/matches) 404'd for real —
        # confirmed the URL itself was wrong, not blocked. Using the
        # documented method from cesc-football-scraper instead, which wraps
        # FotMob's actual working endpoint properly.
        if not _FOOTBALL_SCRAPER_AVAILABLE:
            return False, "football_scraper not installed — run: pip install cesc-football-scraper"
        try:
            matches = _football_client.fotmob.matches_live_today.extract_matches_live_full()
            # This returns a pandas DataFrame, not a list — confirmed directly
            # from a real error message, not guessed. Plain "if matches" on a
            # DataFrame is ambiguous and pandas raises on it, so check .empty
            # explicitly instead.
            if matches is None:
                return False, "returned None"
            is_empty = getattr(matches, "empty", len(matches) == 0)
            count = 0 if is_empty else len(matches)
            return (not is_empty), f"returned {count} matches"
        except Exception as e:
            return False, str(e)

    def check_statshub(self):
        # This is just a fast connectivity check (confirms the site responds at
        # all) — kept lightweight so app startup doesn't have to launch a full
        # browser every time. The REAL data fetch happens in
        # _fetch_statshub_stats() below, using Playwright, only when you
        # actually click Generate — that's the one that needed a headless
        # browser, since StatsHub's real numbers only appear after their
        # JavaScript runs, not in the initial page response.
        if not _PLAYWRIGHT_AVAILABLE:
            return False, "playwright not installed — run: pip install playwright && playwright install chromium"
        r = requests.get("https://www.statshub.com", headers=REQUEST_HEADERS, timeout=6)
        return r.status_code == 200, f"HTTP {r.status_code}"

    # ------------------------------------------------------------------
    # FIXTURES — pulled live from 365Scores, not a hardcoded list.
    # ------------------------------------------------------------------
    def on_league_selected(self, event=None):
        league_name = self.league_combobox.get()
        self.fixture_combobox.set('')
        self.fixture_combobox['values'] = ["Loading real fixtures from 365Scores..."]
        self.status_label.config(text=f"System Status: Fetching {league_name} fixtures from 365Scores...")
        threading.Thread(target=self._load_fixtures_thread, args=(league_name,), daemon=True).start()

    def _load_fixtures_thread(self, league_name):
        competition_id = SCORES365_COMPETITION_IDS.get(league_name)
        fixtures = []
        error = None
        try:
            params = dict(SCORES365_COMMON_PARAMS, competitions=competition_id)
            r = requests.get(f"{SCORES365_BASE}/games/fixtures/", params=params, headers=REQUEST_HEADERS, timeout=10)
            if r.status_code != 200:
                # Some deployments of this endpoint use a different path for
                # upcoming games — fall back to the results endpoint's
                # "notStarted" games if the dedicated fixtures path 404s.
                r = requests.get(f"{SCORES365_BASE}/games/results/", params=params, headers=REQUEST_HEADERS, timeout=10)

            if r.status_code == 200:
                data = r.json()
                games = data.get("games", [])
                for g in games:
                    home = g.get("homeCompetitor", {}).get("name", "?")
                    away = g.get("awayCompetitor", {}).get("name", "?")
                    display = f"{home} vs {away}"
                    fixtures.append((display, g))
            else:
                error = f"365Scores returned HTTP {r.status_code}"
        except requests.RequestException as e:
            error = str(e)
        except ValueError as e:
            error = f"Unexpected response format: {e}"

        self.root.after(0, self._populate_fixture_dropdown, league_name, fixtures, error)

    def _populate_fixture_dropdown(self, league_name, fixtures, error):
        self.live_fixtures[league_name] = fixtures
        if error:
            self.fixture_combobox['values'] = [f"(error: {error})"]
            self.status_label.config(text=f"System Status: Could not load fixtures — {error}")
        elif not fixtures:
            self.fixture_combobox['values'] = ["(no fixtures returned right now)"]
            self.status_label.config(text="System Status: No fixtures found for this league right now")
        else:
            self.fixture_combobox['values'] = [f[0] for f in fixtures]
            self.fixture_combobox.set(fixtures[0][0])
            self.status_label.config(text=f"System Status: {len(fixtures)} real fixtures loaded from 365Scores")

    # ------------------------------------------------------------------
    # BET BUILDER
    # ------------------------------------------------------------------
    def on_generate_clicked(self):
        league_name = self.league_combobox.get()
        fixture_display = self.fixture_combobox.get()
        if not league_name or not fixture_display or fixture_display.startswith("("):
            messagebox.showwarning("Missing selection", "Pick a league and a real fixture first.")
            return

        game = None
        for display, g in self.live_fixtures.get(league_name, []):
            if display == fixture_display:
                game = g
                break
        if game is None:
            messagebox.showwarning("Not found", "Couldn't match that fixture — try re-selecting the league.")
            return

        self._set_builder_text(f"Pulling real data for {fixture_display}...\n(this can take a few seconds)")
        self.status_label.config(text=f"System Status: Generating for {fixture_display}...")
        threading.Thread(target=self._generate_builder_thread, args=(league_name, game), daemon=True).start()

    def _generate_builder_thread(self, league_name, game):
        home_comp = game.get("homeCompetitor", {})
        away_comp = game.get("awayCompetitor", {})
        home, away = home_comp.get("name", "?"), away_comp.get("name", "?")
        game_id = game.get("id")

        markets, bookmaker, odds_error = self._fetch_365scores_odds(game_id)
        home_form = self._fetch_team_form(home_comp.get("id"))
        away_form = self._fetch_team_form(away_comp.get("id"))
        poly_result = self._fetch_polymarket_info(home) or self._fetch_polymarket_info(away)
        result_odds = markets.get((LINE_1X2, ""), {})

        lines = [f"[MATCH: {home} vs {away}]", ""]

        # ---- Poisson goal model — real computed probabilities, not a
        # favorite pick. This is the actual prediction engine, everything
        # else below is supporting context. ----
        model = self._predict_match_poisson(home_form, away_form)
        model_ok = model is not None and not model.get("insufficient_data")
        if model is None:
            lines.append("Model: No recent match data available from 365Scores for one or both teams")
        elif not model_ok:
            lines.append(f"Model: Not enough recent competitive games ({home}: {model['home_games']}, "
                         f"{away}: {model['away_games']}) — need at least {self.MIN_GAMES_FOR_MODEL} each.")
        else:
            lines.append(f"MODEL PREDICTION (Poisson goal model, last {FORM_GAMES} competitive games each):")
            lines.append(f"  Expected score: {home} {model['expected_home_goals']:.2f} - "
                         f"{model['expected_away_goals']:.2f} {away}")
            lines.append(f"  Home Win {model['home_win_pct']:.1f}% | Draw {model['draw_pct']:.1f}% | "
                         f"Away Win {model['away_win_pct']:.1f}%")
            lines.append(f"  Over 2.5 Goals: {model['over_2_5_pct']:.1f}%")
        if all(k in result_odds for k in ("1", "X", "2")):
            lines.append(f"BOOK (365Scores, bookmaker {bookmaker}): "
                         f"1 @ {result_odds['1']:.2f} | X @ {result_odds['X']:.2f} | 2 @ {result_odds['2']:.2f}")
            lines.append(f"  Implied: {self._implied(result_odds['1'])} | {self._implied(result_odds['X'])} | "
                         f"{self._implied(result_odds['2'])} (includes the bookmaker's margin)")
        lines.append("")

        home_standing = self._fetch_standings(league_name, home_comp.get("id"))
        away_standing = self._fetch_standings(league_name, away_comp.get("id"))
        lines.append(f"Table: {home_standing or f'{home} — not found'} | {away_standing or f'{away} — not found'}")
        lines.append("")

        # ---- Leg 1: Result / Double Chance, reasoned from real odds ----
        if "1" in result_odds and "2" in result_odds:
            fav_is_home = result_odds["1"] <= result_odds["2"]
            favorite = home if fav_is_home else away
            fav_price = result_odds["1"] if fav_is_home else result_odds["2"]
            if fav_price <= 1.60:
                lines.append(f"Leg 1: {favorite} Win — @ {fav_price:.2f} (365Scores)")
                lines.append("  Reasoning: short enough price that the straight win looks safe on its own.")
                if model_ok:
                    model_win = model["home_win_pct"] if fav_is_home else model["away_win_pct"]
                    lines.append(f"  Model gives {favorite} {model_win:.1f}% vs book {self._implied(fav_price)}.")
            else:
                dc_key = "1X" if fav_is_home else "X2"
                dc_price = markets.get((LINE_DOUBLE_CHANCE, ""), {}).get(dc_key)
                price_text = f"@ {dc_price:.2f}" if dc_price else "(DC price not listed)"
                lines.append(f"Leg 1: {favorite} Double Chance ({dc_key}) {price_text} — safer than the straight win")
                lines.append(f"  (underlying win price was {fav_price:.2f} — competitive enough to want the cushion)")
                if model_ok:
                    model_dc = model["draw_pct"] + (model["home_win_pct"] if fav_is_home else model["away_win_pct"])
                    book_text = f" vs book {self._implied(dc_price)}" if dc_price else ""
                    lines.append(f"  Model gives {favorite} win-or-draw {model_dc:.1f}%{book_text}.")
        else:
            lines.append(f"Leg 1: No 1X2 odds from 365Scores — {odds_error or 'market not listed for this game'}")
        lines.append("")

        # ---- Leg 2: Goals Over/Under — the model's Over 2.5 probability
        # when it has enough data, the simple combined-average rule when not ----
        if home_form and away_form:
            ou_odds = markets.get((LINE_TOTAL_GOALS, "2.5"), {})
            if model_ok:
                goal_side = "Over" if model["over_2_5_pct"] >= 50 else "Under"
                side_pct = model["over_2_5_pct"] if goal_side == "Over" else 100 - model["over_2_5_pct"]
                basis = f"model {side_pct:.1f}%"
            else:
                home_total = home_form["avg_scored"] + home_form["avg_conceded"]
                away_total = away_form["avg_scored"] + away_form["avg_conceded"]
                combined_avg = (home_total + away_total) / 2
                goal_side = "Over" if combined_avg >= 2.6 else "Under"
                basis = f"combined avg {combined_avg:.2f} goals/game, low sample — treat cautiously"
            price = ou_odds.get(goal_side)
            price_text = f" @ {price:.2f} (book {self._implied(price)})" if price else ""
            lines.append(f"Leg 2: {goal_side} 2.5 Goals{price_text} — {basis}")
            for name, form in ((home, home_form), (away, away_form)):
                lines.append(f"  {name} last {form['games']}: form {form['form']}, "
                             f"avg {form['avg_scored']:.1f} scored / {form['avg_conceded']:.1f} conceded")
        else:
            missing = [n for n, f in ((home, home_form), (away, away_form)) if not f]
            lines.append(f"Leg 2: No goals data — 365Scores had no recent results for: {', '.join(missing)}")
        lines.append("")

        # ---- Lineup verification — directly serves the HAWK 2.0 rule:
        # never lock a ticket without confirmed lineups. ----
        lines.append(f"Lineups (365Scores): {self._fetch_365scores_lineups(game_id, home, away)}")
        lineup_status = self._fetch_fotmob_lineup_status(home, away)
        lines.append(f"Lineups (FotMob): {lineup_status or 'Could not find this match on FotMob'}")
        lines.append("")

        # ---- Other markets straight from the same 365Scores odds feed ----
        extra = []
        btts = markets.get((LINE_BTTS, ""), {})
        if "Yes" in btts and "No" in btts:
            extra.append(f"  BTTS: Yes @ {btts['Yes']:.2f} / No @ {btts['No']:.2f}")
        for line_type, label in ((LINE_TOTAL_CORNERS, "Corners"), (LINE_TOTAL_CARDS, "Cards")):
            for (lt, option_value), prices in markets.items():
                if lt == line_type and "Over" in prices and "Under" in prices:
                    extra.append(f"  {label} {option_value}: Over @ {prices['Over']:.2f} / Under @ {prices['Under']:.2f}")
        lines.append("Other Markets (365Scores book lines):")
        lines.extend(extra or ["  none listed for this game"])
        lines.append("")

        statshub_result = self._fetch_statshub_stats(home)
        if statshub_result:
            lines.append("Additional Markets (StatsHub, real page data):")
            for tab_name in ("Corners", "Cards"):
                tab_text = statshub_result.get(tab_name, "")
                if tab_text and not tab_text.startswith("(couldn't click"):
                    lines.append(f"  {tab_name}: real data captured — see terminal for exact numbers "
                                f"(field parsing not yet confirmed, full text printed there)")
                else:
                    lines.append(f"  {tab_name}: {tab_text or 'no data captured'}")
        else:
            lines.append("Additional Markets (StatsHub): No data found / browser fetch failed")
        lines.append("")

        # ---- Sentiment context (not a leg, just supporting context) ----
        lines.append(f"Sentiment (Polymarket): {poly_result}" if poly_result
                     else "Sentiment (Polymarket): No related prediction market found")
        lines.append("")
        lines.append("This is built from real fetched data — always verify current odds on your")
        lines.append("book before locking this into HAWK, prices move.")

        self.root.after(0, self._show_builder_result, "\n".join(lines))

    @staticmethod
    def _implied(price):
        return f"{100 / price:.1f}%"

    @staticmethod
    def _ordinal(n):
        try:
            n = int(n)
        except (TypeError, ValueError):
            return f"{n}th"
        suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
        return f"{n}{suffix}"

    @staticmethod
    def _poisson_pmf(k, lam):
        return (lam ** k) * math.exp(-lam) / math.factorial(k)

    LEAGUE_AVG_GOALS_PER_TEAM = 1.35  # roughly matches typical top-5-league scoring rates; a
    # documented, transparent assumption rather than something computed live.
    MIN_GAMES_FOR_MODEL = 3

    def _predict_match_poisson(self, home_form, away_form, max_goals=15):
        """Returns a dict of real computed probabilities, or None if either
        team's form data is missing. Takes the form dicts already fetched by
        the caller rather than re-fetching them."""
        if not home_form or not away_form:
            return None
        if home_form["games"] < self.MIN_GAMES_FOR_MODEL or away_form["games"] < self.MIN_GAMES_FOR_MODEL:
            return {"insufficient_data": True, "home_games": home_form["games"], "away_games": away_form["games"]}

        league_avg = self.LEAGUE_AVG_GOALS_PER_TEAM
        home_attack = home_form["avg_scored"] / league_avg
        home_defense = home_form["avg_conceded"] / league_avg
        away_attack = away_form["avg_scored"] / league_avg
        away_defense = away_form["avg_conceded"] / league_avg

        expected_home_goals = home_attack * away_defense * league_avg
        expected_away_goals = away_attack * home_defense * league_avg

        # 0..15 goals per side covers effectively all the probability mass
        # (the old 0..5 grid dropped several percent for high-scoring sides,
        # so the three results didn't add up to 100%).
        home_win = draw = away_win = under_2_5 = 0.0
        for hg in range(max_goals + 1):
            for ag in range(max_goals + 1):
                p = self._poisson_pmf(hg, expected_home_goals) * self._poisson_pmf(ag, expected_away_goals)
                if hg > ag: home_win += p
                elif hg == ag: draw += p
                else: away_win += p
                if hg + ag <= 2: under_2_5 += p

        return {
            "insufficient_data": False,
            "expected_home_goals": expected_home_goals,
            "expected_away_goals": expected_away_goals,
            "home_win_pct": home_win * 100,
            "draw_pct": draw * 100,
            "away_win_pct": away_win * 100,
            # Computed as the complement of the exact Under 2.5 sum, so it
            # isn't affected by where the grid is cut off.
            "over_2_5_pct": (1 - under_2_5) * 100,
        }

    def _fetch_standings(self, league_name, competitor_id):
        """Real league table position from 365Scores, matched by team ID.
        Checks every table in the response (the Champions League can return
        more than one). Returns a short summary string, or None."""
        competition_id = SCORES365_COMPETITION_IDS.get(league_name)
        if not competition_id or not competitor_id:
            return None
        try:
            params = dict(SCORES365_COMMON_PARAMS, competitions=competition_id)
            r = requests.get(f"{SCORES365_BASE}/standings/", params=params, headers=REQUEST_HEADERS, timeout=10)
            if r.status_code != 200:
                print(f"[standings] 365Scores returned HTTP {r.status_code}")
                return None
            for table in r.json().get("standings") or []:
                for row in table.get("rows") or []:
                    if row.get("competitor", {}).get("id") == competitor_id:
                        return (f"{row['competitor'].get('name')}: {self._ordinal(row.get('position'))}, "
                                f"{int(row.get('points') or 0)} pts, "
                                f"{row.get('gamesWon')}W-{row.get('gamesEven')}D-{row.get('gamesLost')}L")
            return None
        except (requests.RequestException, ValueError) as e:
            print(f"[standings] request failed: {e}")
            return None

    def _fetch_team_form(self, competitor_id):
        """A team's last FORM_GAMES finished competitive matches from
        365Scores, looked up by the team's 365Scores ID (taken straight from
        the fixture, so there's no name matching to go wrong). Friendlies and
        cancelled games are skipped. Returns a dict with form string, average
        goals scored and conceded, and games counted — or None."""
        if not competitor_id:
            return None
        try:
            params = dict(SCORES365_COMMON_PARAMS, competitors=competitor_id)
            r = requests.get(f"{SCORES365_BASE}/games/results/", params=params, headers=REQUEST_HEADERS, timeout=10)
            if r.status_code != 200:
                print(f"[form] 365Scores results for competitor {competitor_id} returned HTTP {r.status_code}")
                return None
            games = sorted(r.json().get("games", []), key=lambda g: g.get("startTime", ""), reverse=True)

            form, scored, conceded = [], [], []
            for g in games:
                status_text = (g.get("statusText") or "").lower()
                competition = (g.get("competitionDisplayName") or "").lower()
                if g.get("statusGroup") != 4 or any(s in status_text for s in ("cancel", "postpon", "abandon")):
                    continue
                if "friendl" in competition:
                    continue
                home_c, away_c = g.get("homeCompetitor", {}), g.get("awayCompetitor", {})
                try:
                    home_score, away_score = int(home_c.get("score")), int(away_c.get("score"))
                except (TypeError, ValueError):
                    continue
                if home_score < 0 or away_score < 0:
                    continue
                is_home = home_c.get("id") == competitor_id
                team_score, opp_score = (home_score, away_score) if is_home else (away_score, home_score)
                scored.append(team_score)
                conceded.append(opp_score)
                form.append("W" if team_score > opp_score else "L" if team_score < opp_score else "D")
                if len(form) == FORM_GAMES:
                    break

            if not form:
                return None
            return {
                "form": "".join(form),
                "avg_scored": sum(scored) / len(scored),
                "avg_conceded": sum(conceded) / len(conceded),
                "games": len(form),
            }
        except (requests.RequestException, ValueError) as e:
            print(f"[form] 365Scores results for competitor {competitor_id} failed: {e}")
            return None

    def _fetch_365scores_odds(self, game_id):
        """Returns (markets, bookmaker_id, error). markets maps (lineTypeId,
        option value) to {option name: decimal price} — e.g. (1, "") ->
        {"1": 3.75, "X": 3.8, "2": 1.9}, (3, "2.5") -> {"Over": 1.67,
        "Under": 2.2}. Field names confirmed live from /bets/lines/."""
        if not game_id:
            return {}, None, "missing game id, can't look up odds"
        try:
            params = dict(SCORES365_COMMON_PARAMS, userCountryId=ODDS_COUNTRY_ID, games=game_id)
            r = requests.get(f"{SCORES365_BASE}/bets/lines/", params=params, headers=REQUEST_HEADERS, timeout=10)
            if r.status_code != 200:
                return {}, None, f"request failed (HTTP {r.status_code})"
            all_lines = r.json().get("lines") or []
            if not all_lines:
                return {}, None, "365Scores has no odds listed for this game yet"

            # Prefer the configured bookmaker; fall back to whichever one
            # the feed lists first if that bookmaker doesn't cover the game.
            bookmaker = TOP_BOOKMAKER_ID
            if not any(l.get("bookmakerId") == bookmaker for l in all_lines):
                bookmaker = all_lines[0].get("bookmakerId")

            markets = {}
            for line in all_lines:
                if line.get("bookmakerId") != bookmaker:
                    continue
                prices = {}
                for opt in line.get("options") or []:
                    price = (opt.get("rate") or {}).get("decimal")
                    if opt.get("name") and price:
                        prices[str(opt["name"])] = float(price)
                if prices:
                    markets[(line.get("lineTypeId"), str(line.get("internalOptionValue") or ""))] = prices
            return markets, bookmaker, None
        except (requests.RequestException, ValueError) as e:
            return {}, None, f"error — {e}"

    def _fetch_365scores_lineups(self, game_id, home, away):
        """Lineup status straight from 365Scores' game payload — each side's
        lineups block carries a status (e.g. "Confirmed") and formation."""
        try:
            params = dict(SCORES365_COMMON_PARAMS, gameId=game_id)
            r = requests.get(f"{SCORES365_BASE}/game/", params=params, headers=REQUEST_HEADERS, timeout=10)
            if r.status_code != 200:
                return f"request failed (HTTP {r.status_code})"
            game_data = r.json().get("game", {})
            parts = []
            for name, side in ((home, "homeCompetitor"), (away, "awayCompetitor")):
                lineup = game_data.get(side, {}).get("lineups") or {}
                if not lineup.get("status"):
                    parts.append(f"{name}: not published yet")
                else:
                    formation = f" ({lineup['formation']})" if lineup.get("formation") else ""
                    parts.append(f"{name}: {lineup['status']}{formation}")
            return " | ".join(parts)
        except (requests.RequestException, ValueError) as e:
            return f"error — {e}"

    @staticmethod
    def _teams_match(name_a, name_b):
        """Loose team-name matching that handles common abbreviations (Man
        United vs Manchester United) via word-prefix comparison. Requires
        EVERY significant word in the shorter name to find a partner in the
        other name — matching on just one shared word was a real bug found
        live: 'Manchester United' and 'Manchester City' both share
        'Manchester' and were falsely matching each other. Won't catch
        genuine nicknames with no shared word (Spurs vs Tottenham) — that
        would need a nickname dictionary, not worth the complexity here."""
        a, b = name_a.strip().lower(), name_b.strip().lower()
        if not a or not b:
            # Empty string is trivially "in" every string in Python — without
            # this guard, a blank/unmatched field would silently match ANY
            # row instead of correctly matching none. This is exactly what
            # caused FotMob to return a completely unrelated match earlier.
            return False
        if a in b or b in a:
            return True
        words_a = [w for w in a.split() if len(w) >= 3]
        words_b = [w for w in b.split() if len(w) >= 3]
        if not words_a or not words_b:
            return False
        shorter, longer = (words_a, words_b) if len(words_a) <= len(words_b) else (words_b, words_a)
        for w_short in shorter:
            if not any(w_short.startswith(w_long) or w_long.startswith(w_short) for w_long in longer):
                return False
        return True

    def _fetch_fotmob_lineup_status(self, home, away):
        """Finds today's FotMob match for these two teams via the
        cesc-football-scraper library. Returns a plain-language status
        string, or None if the match couldn't be found at all."""
        if not _FOOTBALL_SCRAPER_AVAILABLE:
            return "football_scraper not installed — run: pip install cesc-football-scraper"
        try:
            today_matches = _football_client.fotmob.matches_live_today.extract_matches_live_full()
            is_empty = today_matches is None or getattr(today_matches, "empty", len(today_matches) == 0)
            if is_empty:
                return None

            records = today_matches.to_dict("records")

            match_entry = None
            for m in records:
                # Real confirmed column names from a live run — was
                # previously guessing wrong names entirely, which combined
                # with the empty-string bug above caused a false match.
                home_name = str(m.get("home_team_name") or "")
                away_name = str(m.get("away_team_name") or "")
                if self._teams_match(home, home_name) and self._teams_match(away, away_name):
                    match_entry = m
                    break

            if not match_entry:
                print(f"[fotmob] No match found for {home} vs {away} among {len(records)} rows.")
                return None

            # There's genuinely no URL field in this data (confirmed — full
            # column list printed on an earlier run) — extract_match_momentum
            # needs one per its documented signature, so we can't chain into
            # that for now. Report what we DO have directly instead of
            # guessing at a URL construction I can't verify.
            match_id = match_entry.get("match_id")
            started = match_entry.get("started")
            finished = match_entry.get("finished")
            score = match_entry.get("global_score_str") or match_entry.get("score_str")

            if finished:
                return f"Match already finished (FotMob match_id {match_id}), score: {score}"
            elif started:
                return f"Match in progress (FotMob match_id {match_id}), score: {score} — lineups will be locked in by now"
            else:
                return (f"Match confirmed on FotMob (match_id {match_id}), not yet started — "
                       f"lineup-specific data needs a follow-up method, not yet found in this library's documented API")
        except Exception as e:
            return f"error — {e}"

    def _fetch_statshub_stats(self, team_name):
        """Uses a real headless browser to load a StatsHub team page, then
        clicks through the Corners and Cards tabs specifically (the markets
        that actually make 'every market open' possible beyond just Result/
        Goals) and extracts whatever renders. Returns a dict of
        {tab_name: extracted_text} or None if the page/team wasn't found.
        Exact numeric field parsing isn't confirmed yet — this captures the
        real rendered text per tab so we can pin down the precise numbers
        together on a real run, same pattern as everywhere else here."""
        if not _PLAYWRIGHT_AVAILABLE:
            return None
        try:
            slug = team_name.lower().strip().replace(" ", "-")
            url = f"https://www.statshub.com/team/{slug}"
            results = {}
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page(user_agent=REQUEST_HEADERS["User-Agent"])
                try:
                    response = page.goto(url, timeout=15000, wait_until="networkidle")
                    if not response or response.status == 404:
                        return None
                    page.wait_for_timeout(2000)

                    # Overview tab (whatever loads by default) as a baseline.
                    results["Overview"] = page.inner_text("body")[:600]

                    # Try clicking each market tab we saw earlier and capture
                    # what renders. Text-based selectors since we don't have
                    # confirmed CSS classes for these tab elements.
                    for tab_name in ("Corners", "Cards"):
                        try:
                            page.click(f"text={tab_name}", timeout=5000)
                            page.wait_for_timeout(1500)
                            results[tab_name] = page.inner_text("body")[:600]
                        except Exception as tab_err:
                            results[tab_name] = f"(couldn't click this tab: {tab_err})"
                finally:
                    browser.close()

            for tab_name, text in results.items():
                print(f"[statshub] '{tab_name}' tab rendered text for {team_name} (first 600 chars):\n{text}\n---")

            return results
        except Exception as e:
            print(f"[statshub] Browser fetch failed for {team_name}: {e}")
            return None

    def _fetch_polymarket_info(self, team_name):
        try:
            r = requests.get(
                "https://gamma-api.polymarket.com/markets",
                params={"limit": 20, "active": "true"}, timeout=8
            )
            if r.status_code != 200:
                return None
            for market in r.json():
                question = market.get("question", "")
                if team_name.lower() in question.lower():
                    return f'Market found: "{question}"'
            return None
        except (requests.RequestException, ValueError):
            return None

    def _set_builder_text(self, text):
        self.builder_text.config(state="normal")
        self.builder_text.delete("1.0", tk.END)
        self.builder_text.insert(tk.END, text)
        self.builder_text.config(state="disabled")

    def _show_builder_result(self, text):
        self._set_builder_text(text)
        self.status_label.config(text="System Status: Generation complete")

    def on_close(self):
        self.is_polling = False
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    app = JarvisHawkApp(root)
    root.mainloop()
