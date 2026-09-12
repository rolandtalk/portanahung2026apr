from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .config import Config
from .db import Store, utc_now
from .providers import (
    ProviderError,
    fetch_google_sheet_portfolios,
    fetch_marketdata_quotes,
    fetch_yfinance_history,
    yfinance_close_fallback_quotes,
)
from .sync import enqueue_pending, flush_outbox


NEW_YORK = ZoneInfo("America/New_York")


def _detail(errors: dict[str, str]) -> str | None:
    if not errors:
        return None
    preview = "; ".join(f"{key}: {value}" for key, value in list(errors.items())[:8])
    if len(errors) > 8:
        preview += f"; and {len(errors) - 8} more"
    return preview


def collect_holdings(store: Store, config: Config) -> tuple[int, dict[str, str]]:
    run_id = store.start_run("google_sheet_holdings")
    portfolios, errors = fetch_google_sheet_portfolios(
        sheet_id=config.google_sheet_id,
        portfolios=config.portfolios,
        timeout=config.request_timeout_seconds,
        base_url=config.google_sheets_base_url,
    )
    count = store.replace_portfolios(portfolios) if portfolios else 0
    status = "ok" if not errors else "partial" if portfolios else "failed"
    store.finish_run(run_id, status, count, _detail(errors))
    if portfolios:
        store.set_metadata("holdings_last_fetch_at", utc_now())
    return count, errors


def _all_symbols(store: Store, explicit: list[str] | None = None) -> list[str]:
    holdings = explicit if explicit else store.symbols()
    return sorted({"SPY", "QQQ", *(symbol.upper() for symbol in holdings)})


def collect_history(
    store: Store, config: Config, explicit_symbols: list[str] | None = None
) -> tuple[int, dict[str, str]]:
    symbols = _all_symbols(store, explicit_symbols)
    if len(symbols) <= 2 and not explicit_symbols:
        raise ProviderError("no holdings symbols available; collect Google Sheet holdings first")
    run_id = store.start_run("yfinance_history")
    try:
        rows, errors = fetch_yfinance_history(
            symbols,
            backfill_days=config.yfinance_backfill_days,
            chunk_size=config.yfinance_chunk_size,
            timeout=config.request_timeout_seconds,
        )
        count = store.upsert_prices(rows)
        # This gives the app a completed-close last-known-good quote. A current
        # or same-session Marketdata row always wins in Store.upsert_quotes().
        store.upsert_quotes(yfinance_close_fallback_quotes(store.price_rows()))
        status = "ok" if not errors else "partial" if rows else "failed"
        store.finish_run(run_id, status, count, _detail(errors))
        return count, errors
    except Exception as error:
        store.finish_run(run_id, "failed", 0, str(error))
        raise


def collect_quotes(
    store: Store, config: Config, explicit_symbols: list[str] | None = None
) -> tuple[int, dict[str, str]]:
    if not config.marketdata_token:
        raise ProviderError("MARKETDATA_TOKEN is not configured")
    symbols = _all_symbols(store, explicit_symbols)
    if len(symbols) <= 2 and not explicit_symbols:
        raise ProviderError("no holdings symbols available; collect Google Sheet holdings first")
    run_id = store.start_run("marketdata_quotes")
    try:
        rows, errors = fetch_marketdata_quotes(
            symbols,
            token=config.marketdata_token,
            chunk_size=config.marketdata_quote_chunk_size,
            timeout=config.request_timeout_seconds,
            cache_maxage_seconds=config.marketdata_cache_maxage_seconds,
        )
        count = store.upsert_quotes(rows)
        status = "ok" if not errors else "partial" if rows else "failed"
        store.finish_run(run_id, status, count, _detail(errors))
        return count, errors
    except Exception as error:
        store.finish_run(run_id, "failed", 0, str(error))
        raise


def sync(store: Store, config: Config) -> tuple[int, str | None, dict[str, int]]:
    queued = enqueue_pending(store, config.sync_batch_size)
    if not config.railway_ingest_token:
        return 0, "RAILWAY_INGEST_TOKEN is not configured", queued
    sent, error = flush_outbox(
        store,
        url=config.ingest_url,
        token=config.railway_ingest_token,
        timeout=config.request_timeout_seconds,
    )
    return sent, error, queued


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _due(last_run: str | None, minutes: int, now: datetime) -> bool:
    previous = _parse_timestamp(last_run)
    return previous is None or now.astimezone(UTC) - previous.astimezone(UTC) >= timedelta(
        minutes=minutes
    )


def _previous_weekday(day: date) -> date:
    candidate = day - timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


def history_target(now_et: datetime) -> date:
    if now_et.weekday() < 5 and now_et.time() >= time(16, 20):
        return now_et.date()
    return _previous_weekday(now_et.date())


def is_regular_market_window(now_et: datetime) -> bool:
    return (
        now_et.weekday() < 5
        and time(9, 30) <= now_et.time() <= time(16, 15)
    )


def mark_history_target_if_present(store: Store, target: str) -> bool:
    """Complete a schedule target only when the canonical SPY close exists."""
    if not store.has_price("SPY", target):
        return False
    store.set_metadata("history_completed_target", target)
    return True


def scheduled_tick(store: Store, config: Config, now: datetime | None = None) -> int:
    """One launchd-safe tick. The schedule is evaluated in New York time."""
    now_utc = now.astimezone(UTC) if now else datetime.now(UTC)
    now_et = now_utc.astimezone(NEW_YORK)
    failures = 0

    if _due(
        store.get_metadata("holdings_last_fetch_at"),
        config.holdings_refresh_minutes,
        now_utc,
    ):
        try:
            count, errors = collect_holdings(store, config)
            print(f"holdings: {count} rows ({len(errors)} tab errors)")
            failures += int(bool(errors and count == 0))
        except Exception as error:
            failures += 1
            print(f"holdings failed: {error}", file=sys.stderr)

    target = history_target(now_et).isoformat()
    history_done = store.get_metadata("history_completed_target") == target
    history_attempt_due = _due(
        store.get_metadata("history_last_attempt_at"),
        config.history_retry_minutes,
        now_utc,
    )
    if not history_done and history_attempt_due:
        store.set_metadata("history_last_attempt_at", utc_now())
        try:
            count, errors = collect_history(store, config)
            print(f"history: {count} rows ({len(errors)} symbol errors)")
            if not mark_history_target_if_present(store, target):
                failures += 1
        except Exception as error:
            failures += 1
            print(f"history failed: {error}", file=sys.stderr)

    if is_regular_market_window(now_et):
        try:
            count, errors = collect_quotes(store, config)
            print(f"quotes: {count} rows ({len(errors)} symbol errors)")
            failures += int(count == 0)
        except Exception as error:
            failures += 1
            print(f"quotes failed: {error}", file=sys.stderr)

    sent, sync_error, queued = sync(store, config)
    print(f"sync: queued {queued['batches']} batches, sent {sent}")
    if sync_error:
        failures += 1
        print(f"sync pending: {sync_error}", file=sys.stderr)
    return 1 if failures else 0


def _symbols(value: str | None) -> list[str] | None:
    if not value:
        return None
    return sorted({item.strip().upper() for item in value.split(",") if item.strip()})


def _print_result(label: str, count: int, errors: dict[str, str]) -> None:
    print(json.dumps({"task": label, "records": count, "errors": errors}, indent=2))


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Portanahung Mac market-data collector")
    parser.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help="config file (default: collector/.env)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init", help="create or migrate the local SQLite database")
    subparsers.add_parser("holdings", help="replicate holdings directly from Google Sheets")
    for name, help_text in (
        ("history", "collect split-adjusted/non-dividend daily closes with yfinance"),
        ("quotes", "collect fresh regular-session quotes from Marketdata.app"),
        ("run", "force holdings, history, quotes, and Railway sync now"),
    ):
        child = subparsers.add_parser(name, help=help_text)
        child.add_argument("--symbols", help="comma-separated override for testing")
    subparsers.add_parser("sync", help="enqueue local changes and retry Railway sync")
    subparsers.add_parser(
        "scheduled", help="run one New-York-market-aware launchd tick"
    )
    subparsers.add_parser("status", help="show local database and outbox status")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    config = Config.from_environment(args.env_file)
    with Store(config.db_path) as store:
        store.initialize()
        if args.command == "init":
            print(f"initialized {config.db_path}")
            return 0
        if args.command == "status":
            print(json.dumps({"database": str(config.db_path), **store.summary()}, indent=2))
            return 0
        if args.command == "holdings":
            count, errors = collect_holdings(store, config)
            _print_result("holdings", count, errors)
            return int(bool(errors and count == 0))
        if args.command == "history":
            count, errors = collect_history(store, config, _symbols(args.symbols))
            _print_result("history", count, errors)
            return int(count == 0)
        if args.command == "quotes":
            count, errors = collect_quotes(store, config, _symbols(args.symbols))
            _print_result("quotes", count, errors)
            return int(count == 0)
        if args.command == "sync":
            sent, error, queued = sync(store, config)
            print(json.dumps({"queued": queued, "batchesSent": sent, "error": error}, indent=2))
            return int(bool(error))
        if args.command == "scheduled":
            return scheduled_tick(store, config)
        if args.command == "run":
            explicit = _symbols(args.symbols)
            failures = 0
            count, errors = collect_holdings(store, config)
            _print_result("holdings", count, errors)
            failures += int(bool(errors and count == 0))
            for label, operation in (
                ("history", lambda: collect_history(store, config, explicit)),
                ("quotes", lambda: collect_quotes(store, config, explicit)),
            ):
                try:
                    count, errors = operation()
                    _print_result(label, count, errors)
                    failures += int(count == 0)
                except Exception as error:
                    failures += 1
                    print(f"{label} failed: {error}", file=sys.stderr)
            sent, error, queued = sync(store, config)
            print(json.dumps({"queued": queued, "batchesSent": sent, "error": error}, indent=2))
            failures += int(bool(error))
            return int(bool(failures))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
