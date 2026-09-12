from __future__ import annotations

import json
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from collector.cli import (
    history_target,
    is_regular_market_window,
    mark_history_target_if_present,
)
from collector.db import Store
from collector.providers import (
    canonical_yahoo_close,
    extract_yfinance_rows,
    fetch_marketdata_quotes,
    fetch_yfinance_history,
    yfinance_close_fallback_quotes,
)
from collector.sync import enqueue_pending, make_batch


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tempdir.name) / "prices.sqlite3")
        self.store.initialize()

    def tearDown(self):
        self.store.close()
        self.tempdir.cleanup()

    def test_provider_failure_cannot_erase_last_known_good_quote(self):
        marketdata = {
            "symbol": "AAPL",
            "sessionDate": "2026-09-11",
            "price": 101.0,
            "previousClose": 100.0,
            "change": 1.0,
            "changePct": 1.0,
            "providerUpdatedAt": "2026-09-11T19:59:00Z",
            "source": "marketdata.app",
            "fetchedAt": "2026-09-11T20:00:00Z",
        }
        stale_fallback = {
            **marketdata,
            "sessionDate": "2026-09-10",
            "price": 99.0,
            "source": "yfinance-close-fallback",
            "providerUpdatedAt": None,
            "fetchedAt": "2026-09-12T01:00:00Z",
        }
        self.store.upsert_quotes([marketdata])
        self.store.upsert_quotes([stale_fallback])
        self.assertEqual(self.store.quote_rows()[0]["price"], 101.0)
        self.assertEqual(self.store.quote_rows()[0]["source"], "marketdata.app")

    def test_marketdata_wins_same_session_over_yahoo_fallback(self):
        fallback = {
            "symbol": "AAPL",
            "sessionDate": "2026-09-11",
            "price": 100.0,
            "previousClose": 99.0,
            "change": 1.0,
            "changePct": 1.01,
            "providerUpdatedAt": None,
            "source": "yfinance-close-fallback",
            "fetchedAt": "2026-09-11T21:00:00Z",
        }
        fresh = {
            **fallback,
            "price": 102.0,
            "source": "marketdata.app",
            "providerUpdatedAt": "2026-09-11T20:00:00Z",
            "fetchedAt": "2026-09-11T20:01:00Z",
        }
        self.store.upsert_quotes([fallback])
        self.store.upsert_quotes([fresh])
        self.assertEqual(self.store.quote_rows()[0]["price"], 102.0)
        self.assertEqual(self.store.quote_rows()[0]["source"], "marketdata.app")

    def test_empty_known_portfolio_is_sent_as_an_explicit_empty_array(self):
        self.store.replace_portfolios({"CUB": []})
        queued = enqueue_pending(self.store, 500)
        self.assertEqual(queued["batches"], 1)
        payload = json.loads(self.store.pending_batches()[0]["payload_json"])
        self.assertEqual(payload["portfolios"], {"CUB": []})

        # Polling the unchanged sheet must not create a new outbox batch.
        self.store.replace_portfolios({"CUB": []})
        queued_again = enqueue_pending(self.store, 500)
        self.assertEqual(queued_again["batches"], 0)

    def test_outbox_retry_can_reproduce_the_same_batch(self):
        row = {
            "symbol": "AAPL",
            "sessionDate": "2026-09-11",
            "close": 100.0,
            "rawClose": 100.0,
            "adjustedClose": 99.0,
            "source": "yfinance",
            "fetchedAt": "2026-09-12T00:00:00Z",
        }
        options = {
            "prices": [row],
            "batch_nonce": "revision-1",
            "generated_at": "2026-09-12T00:00:00Z",
        }
        first_id, first = make_batch(**options)
        second_id, second = make_batch(**options)
        self.assertEqual(first_id, second_id)
        self.assertEqual(first["batchId"], second["batchId"])

    def test_a_to_b_to_a_gets_three_distinct_batch_ids(self):
        ids = []
        seen = set()
        for shares in (1.0, 2.0, 1.0):
            self.store.replace_portfolios(
                {"CUB": [{"symbol": "AAPL", "shares": shares, "cost": 10.0}]}
            )
            enqueue_pending(self.store, 500)
            current = {row["batch_id"] for row in self.store.pending_batches()}
            new_ids = current - seen
            self.assertEqual(len(new_ids), 1)
            ids.append(new_ids.pop())
            seen = current
        self.assertEqual(len(set(ids)), 3)

    def test_history_target_requires_the_target_spy_session(self):
        older = {
            "symbol": "SPY",
            "sessionDate": "2026-09-10",
            "close": 650.0,
            "rawClose": 650.0,
            "adjustedClose": 649.0,
            "source": "yfinance",
            "fetchedAt": "2026-09-11T20:20:00Z",
        }
        self.store.upsert_prices([older])
        self.assertFalse(mark_history_target_if_present(self.store, "2026-09-11"))
        self.assertIsNone(self.store.get_metadata("history_completed_target"))
        self.store.upsert_prices([{**older, "sessionDate": "2026-09-11"}])
        self.assertTrue(mark_history_target_if_present(self.store, "2026-09-11"))


class ProviderPolicyTest(unittest.TestCase):
    class FakeSeries:
        def __init__(self, values):
            self.values = dict(values)
            self.loc = self

        def items(self):
            return self.values.items()

        def __getitem__(self, key):
            return self.values[key]

    class FakeFrame:
        def __init__(self, columns=None, empty=False):
            self._columns = columns or {}
            self.columns = list(self._columns)
            self.empty = empty

        def __getitem__(self, key):
            return self._columns[key]

    def frame(self):
        dates = [datetime(2026, 9, 10), datetime(2026, 9, 11)]
        return self.FakeFrame(
            {
                ("AAPL", "Close"): self.FakeSeries(zip(dates, [100.0, 101.0])),
                ("AAPL", "Adj Close"): self.FakeSeries(zip(dates, [99.0, 100.0])),
            }
        )

    def test_yahoo_close_is_not_double_adjusted_by_split_events(self):
        # Yahoo Close already presents the split-adjusted 50 on both sides of
        # this conceptual 2:1 split. Canonical ingestion must remain 50, not 25.
        conceptual_yahoo_closes = [50.0, 50.0]
        self.assertEqual(
            [canonical_yahoo_close(value) for value in conceptual_yahoo_closes],
            [50.0, 50.0],
        )

    def test_daily_closes_form_fallback_change(self):
        rows = [
            {"symbol": "AAA", "sessionDate": "2026-09-10", "close": 10.0},
            {"symbol": "AAA", "sessionDate": "2026-09-11", "close": 12.0},
        ]
        quote = yfinance_close_fallback_quotes(rows)[0]
        self.assertEqual(quote["previousClose"], 10.0)
        self.assertEqual(quote["change"], 2.0)
        self.assertEqual(quote["changePct"], 20.0)

    def test_intraday_current_new_york_session_is_dropped(self):
        rows, missing = extract_yfinance_rows(
            self.frame(),
            {"AAPL": "AAPL"},
            "2026-09-11T15:00:00Z",
            now=datetime(2026, 9, 11, 15, 0, tzinfo=UTC),
        )
        self.assertEqual([row["sessionDate"] for row in rows], ["2026-09-10"])
        self.assertEqual(missing, [])

    def test_empty_explicit_dates_retry_with_period_and_no_repair(self):
        valid = self.frame()

        class FakeYFinance:
            def __init__(self):
                self.calls = []

            def download(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 1:
                    return ProviderPolicyTest.FakeFrame(empty=True)
                return valid

        fake = FakeYFinance()
        rows, errors = fetch_yfinance_history(
            ["AAPL"],
            backfill_days=550,
            chunk_size=25,
            timeout=30,
            now=datetime(2026, 9, 12, 12, 0, tzinfo=UTC),
            yf_module=fake,
        )
        self.assertTrue(rows)
        self.assertEqual(errors, {})
        self.assertEqual(len(fake.calls), 2)
        self.assertFalse(fake.calls[0]["repair"])
        self.assertEqual(fake.calls[1]["period"], "2y")

    def test_marketdata_cached_bulk_then_live_only_for_missing(self):
        timestamp = datetime(2026, 9, 11, 19, 0, tzinfo=UTC).timestamp()
        cached = {
            "s": "ok", "symbol": ["AAPL"], "last": [101.0],
            "change": [1.0], "changepct": [0.01], "updated": [timestamp],
        }
        live = {
            "s": "ok", "symbol": ["MSFT"], "last": [202.0],
            "change": [2.0], "changepct": [0.01], "updated": [timestamp],
        }
        replies = [(cached, {}, 203), (live, {}, 200)]
        with patch("collector.providers._http_json", side_effect=replies) as request:
            rows, errors = fetch_marketdata_quotes(
                ["AAPL", "MSFT"], token="secret", chunk_size=100, timeout=30
            )
        self.assertEqual({row["symbol"] for row in rows}, {"AAPL", "MSFT"})
        self.assertEqual(errors, {})
        self.assertIn("mode=cached", request.call_args_list[0].args[0])
        self.assertIn("symbols=MSFT", request.call_args_list[1].args[0])


class ScheduleTest(unittest.TestCase):
    def test_market_window_uses_new_york_clock(self):
        from zoneinfo import ZoneInfo

        eastern = ZoneInfo("America/New_York")
        during_dst_session = datetime(2026, 7, 6, 14, 0, tzinfo=UTC).astimezone(
            eastern
        )
        self.assertTrue(is_regular_market_window(during_dst_session))
        self.assertFalse(is_regular_market_window(datetime(2026, 7, 5, 10, 0, tzinfo=eastern)))

    def test_history_target_rolls_weekend_to_friday(self):
        from zoneinfo import ZoneInfo

        eastern = ZoneInfo("America/New_York")
        saturday = datetime(2026, 9, 12, 12, 0, tzinfo=eastern)
        self.assertEqual(history_target(saturday).isoformat(), "2026-09-11")


if __name__ == "__main__":
    unittest.main()
