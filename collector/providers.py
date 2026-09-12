from __future__ import annotations

import csv
import io
import json
import math
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .db import utc_now


NEW_YORK = ZoneInfo("America/New_York")
MARKETDATA_BASE_URL = "https://api.marketdata.app/v1"


class ProviderError(RuntimeError):
    pass


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def canonical_yahoo_close(close: Any) -> float | None:
    """Return Yahoo's non-dividend Close unchanged when valid.

    With yfinance ``auto_adjust=False``, Yahoo's Close is already adjusted for
    stock splits, while Adj Close also reflects dividends. Applying the split
    events again would double-adjust the series. This explicit function keeps
    that policy visible and testable.
    """
    value = _number(close)
    return value if value is not None and value > 0 else None


def _chunks(items: Sequence[str], size: int) -> Iterable[list[str]]:
    for index in range(0, len(items), size):
        yield list(items[index : index + size])


def _http_json(
    url: str,
    *,
    timeout: float,
    headers: Mapping[str, str] | None = None,
) -> tuple[dict[str, Any], Mapping[str, str], int]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "Portanahung-Mac-Collector/1.0",
            **(dict(headers or {})),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return (json.loads(body) if body else {}), response.headers, response.status
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("errmsg") or json.loads(body).get("error")
        except (json.JSONDecodeError, AttributeError):
            detail = body[:300]
        raise ProviderError(f"HTTP {error.code}: {detail or error.reason}") from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ProviderError(str(error)) from error


def _parse_numeric_cell(value: Any) -> float:
    text = str(value or "").strip().replace(",", "").replace("$", "")
    return float(text)


def fetch_google_sheet_portfolios(
    *,
    sheet_id: str,
    portfolios: Sequence[str],
    timeout: float,
    base_url: str = "https://docs.google.com/spreadsheets/d",
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str]]:
    """Read holdings directly from Google gviz, never from the Railway replica."""
    result: dict[str, list[dict[str, Any]]] = {}
    errors: dict[str, str] = {}

    for portfolio in portfolios:
        query = urllib.parse.urlencode({"tqx": "out:csv", "sheet": portfolio})
        url = f"{base_url}/{urllib.parse.quote(sheet_id, safe='')}/gviz/tq?{query}"
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "text/csv,*/*;q=0.8",
                "User-Agent": "Mozilla/5.0 Portanahung-Mac-Collector/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content = response.read().decode("utf-8-sig")
            table = list(csv.reader(io.StringIO(content)))
            if not table:
                raise ProviderError("empty CSV response")
            headers = [cell.strip().upper() for cell in table[0]]
            if not headers or headers[0] not in {"SMBL", "SYMBOL", "S"}:
                raise ProviderError("unexpected CSV header (sheet may not be public)")

            holdings: list[dict[str, Any]] = []
            for cells in table[1:]:
                if len(cells) < 3:
                    continue
                symbol = cells[0].strip().upper()
                if not symbol:
                    continue
                try:
                    shares = _parse_numeric_cell(cells[1])
                    cost = _parse_numeric_cell(cells[2])
                except ValueError:
                    continue
                if math.isfinite(shares) and math.isfinite(cost):
                    holdings.append(
                        {"symbol": symbol, "shares": shares, "cost": cost}
                    )
            result[portfolio.upper()] = holdings
        except (urllib.error.URLError, TimeoutError, ProviderError) as error:
            errors[portfolio.upper()] = str(error)

    return result, errors


def _provider_symbol(symbol: str) -> str:
    # Yahoo represents US class shares such as BRK.B as BRK-B.
    return symbol.replace(".", "-")


def _frame_series(frame: Any, provider_symbol: str, field: str) -> Any | None:
    columns = getattr(frame, "columns", ())
    candidates = (
        (provider_symbol, field),
        (field, provider_symbol),
        (provider_symbol.upper(), field),
        (field, provider_symbol.upper()),
        field,
    )
    for candidate in candidates:
        try:
            if candidate in columns:
                return frame[candidate]
        except (KeyError, TypeError):
            continue
    return None


def _session_date(index_value: Any) -> str:
    if hasattr(index_value, "date"):
        return index_value.date().isoformat()
    return str(index_value)[:10]


def is_completed_yahoo_session(session_date: str, now: datetime | None = None) -> bool:
    """Exclude today's daily bar until the US close has settled."""
    current = (now or datetime.now(UTC)).astimezone(NEW_YORK)
    try:
        session_day = date.fromisoformat(session_date)
    except ValueError:
        return False
    if session_day < current.date():
        return True
    if session_day > current.date():
        return False
    return current.weekday() < 5 and current.time() >= time(16, 20)


def extract_yfinance_rows(
    frame: Any,
    symbol_map: Mapping[str, str],
    fetched_at: str,
    now: datetime | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Convert a yfinance download frame to canonical split-only close rows."""
    rows: list[dict[str, Any]] = []
    missing: list[str] = []

    for provider_symbol, canonical_symbol in symbol_map.items():
        close_series = _frame_series(frame, provider_symbol, "Close")
        adjusted_series = _frame_series(frame, provider_symbol, "Adj Close")
        if close_series is None:
            missing.append(canonical_symbol)
            continue

        symbol_count = 0
        for index_value, raw_value in close_series.items():
            session_date = _session_date(index_value)
            if not is_completed_yahoo_session(session_date, now):
                continue
            close = canonical_yahoo_close(raw_value)
            if close is None:
                continue
            adjusted = None
            if adjusted_series is not None:
                try:
                    adjusted = _number(adjusted_series.loc[index_value])
                except (KeyError, TypeError):
                    adjusted = None
            rows.append(
                {
                    "symbol": canonical_symbol,
                    "sessionDate": session_date,
                    "close": close,
                    "rawClose": close,
                    "adjustedClose": adjusted if adjusted and adjusted > 0 else None,
                    "source": "yfinance",
                    "fetchedAt": fetched_at,
                }
            )
            symbol_count += 1
        if symbol_count == 0:
            missing.append(canonical_symbol)

    return rows, missing


def fetch_yfinance_history(
    symbols: Sequence[str],
    *,
    backfill_days: int,
    chunk_size: int,
    timeout: float,
    today: date | None = None,
    now: datetime | None = None,
    yf_module: Any | None = None,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    try:
        if yf_module is None:
            import yfinance as yf_module  # type: ignore[import-not-found]
    except ImportError as error:
        raise ProviderError(
            "yfinance is not installed; run pip install -r collector/requirements.txt"
        ) from error

    canonical_symbols = sorted({symbol.strip().upper() for symbol in symbols if symbol.strip()})
    current = now or datetime.now(UTC)
    end_date = (today or current.astimezone(NEW_YORK).date()) + timedelta(days=1)
    start_date = end_date - timedelta(days=backfill_days)
    fetched_at = utc_now()
    rows: list[dict[str, Any]] = []
    errors: dict[str, str] = {}

    for canonical_chunk in _chunks(canonical_symbols, chunk_size):
        symbol_map = {_provider_symbol(symbol): symbol for symbol in canonical_chunk}
        try:
            common_arguments = dict(
                tickers=list(symbol_map),
                interval="1d",
                auto_adjust=False,
                actions=False,
                repair=False,
                keepna=False,
                group_by="ticker",
                threads=True,
                progress=False,
                timeout=timeout,
            )
            frame = yf_module.download(
                **common_arguments,
                start=start_date.isoformat(),
                end=end_date.isoformat(),
            )
            if bool(getattr(frame, "empty", False)):
                if backfill_days <= 365:
                    period = "1y"
                elif backfill_days <= 730:
                    period = "2y"
                elif backfill_days <= 1825:
                    period = "5y"
                elif backfill_days <= 3650:
                    period = "10y"
                else:
                    period = "max"
                frame = yf_module.download(**common_arguments, period=period)
            chunk_rows, missing = extract_yfinance_rows(
                frame, symbol_map, fetched_at, now=current
            )
            rows.extend(chunk_rows)
            for symbol in missing:
                errors[symbol] = "no valid Yahoo Close rows returned"
        except Exception as error:  # yfinance raises several provider/library types
            for symbol in canonical_chunk:
                errors[symbol] = str(error)

    return rows, errors


def _array_item(data: Mapping[str, Any], key: str, index: int) -> Any:
    values = data.get(key)
    return values[index] if isinstance(values, list) and index < len(values) else None


def fetch_marketdata_quotes(
    symbols: Sequence[str],
    *,
    token: str,
    chunk_size: int,
    timeout: float,
    cache_maxage_seconds: int = 300,
    base_url: str = MARKETDATA_BASE_URL,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    canonical_symbols = sorted({symbol.strip().upper() for symbol in symbols if symbol.strip()})
    fetched_at = utc_now()
    rows: list[dict[str, Any]] = []
    errors: dict[str, str] = {}

    for symbol_chunk in _chunks(canonical_symbols, chunk_size):
        def parse_response(data: Mapping[str, Any]) -> tuple[list[dict[str, Any]], set[str]]:
            parsed_rows: list[dict[str, Any]] = []
            returned: set[str] = set()
            if not data:
                return parsed_rows, returned
            if data.get("s") != "ok":
                raise ProviderError(str(data.get("errmsg") or "Marketdata returned an error"))
            returned_symbols = data.get("symbol")
            if not isinstance(returned_symbols, list):
                raise ProviderError("Marketdata response omitted symbol array")
            for index, raw_symbol in enumerate(returned_symbols):
                symbol = str(raw_symbol or "").strip().upper()
                price = _number(_array_item(data, "last", index))
                updated_epoch = _number(_array_item(data, "updated", index))
                if not symbol or price is None or price <= 0 or updated_epoch is None:
                    continue
                returned.add(symbol)
                change = _number(_array_item(data, "change", index))
                raw_pct = _number(_array_item(data, "changepct", index))
                previous_close = price - change if change is not None else None
                updated = datetime.fromtimestamp(updated_epoch, UTC)
                parsed_rows.append(
                    {
                        "symbol": symbol,
                        "sessionDate": updated.astimezone(NEW_YORK).date().isoformat(),
                        "price": price,
                        "previousClose": (
                            previous_close
                            if previous_close is not None and previous_close > 0
                            else None
                        ),
                        "change": change,
                        "changePct": raw_pct * 100 if raw_pct is not None else None,
                        "providerUpdatedAt": updated.isoformat(timespec="seconds").replace(
                            "+00:00", "Z"
                        ),
                        "source": "marketdata.app",
                        "fetchedAt": fetched_at,
                    }
                )
            return parsed_rows, returned

        cached_rows: list[dict[str, Any]] = []
        cached_returned: set[str] = set()
        try:
            cached_query = urllib.parse.urlencode(
                {
                    "symbols": ",".join(symbol_chunk),
                    "extended": "false",
                    "mode": "cached",
                    "maxage": cache_maxage_seconds,
                }
            )
            cached_data, _headers, _status = _http_json(
                f"{base_url.rstrip('/')}/stocks/quotes/?{cached_query}",
                timeout=timeout,
                headers={"Authorization": f"Bearer {token}"},
            )
            cached_rows, cached_returned = parse_response(cached_data)
        except ProviderError:
            # A cache miss or unavailable cached mode is safe to recover with
            # the normal quote request. Only missing symbols spend live credits.
            pass

        rows.extend(cached_rows)
        missing = sorted(set(symbol_chunk) - cached_returned)
        if not missing:
            continue
        try:
            live_query = urllib.parse.urlencode(
                {"symbols": ",".join(missing), "extended": "false"}
            )
            live_data, _headers, _status = _http_json(
                f"{base_url.rstrip('/')}/stocks/quotes/?{live_query}",
                timeout=timeout,
                headers={"Authorization": f"Bearer {token}"},
            )
            live_rows, live_returned = parse_response(live_data)
            rows.extend(live_rows)
            for symbol in set(missing) - live_returned:
                errors[symbol] = "no valid quote returned"
        except ProviderError as error:
            for symbol in missing:
                errors[symbol] = str(error)

    return rows, errors


def yfinance_close_fallback_quotes(
    price_rows: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Build last-known daily quote rows without erasing fresher Marketdata rows."""
    by_symbol: dict[str, list[Mapping[str, Any]]] = {}
    for row in price_rows:
        by_symbol.setdefault(str(row["symbol"]), []).append(row)

    quotes: list[dict[str, Any]] = []
    for symbol, rows in by_symbol.items():
        ordered = sorted(rows, key=lambda row: str(row["sessionDate"]))
        if not ordered:
            continue
        latest = ordered[-1]
        previous = ordered[-2] if len(ordered) > 1 else None
        price = _number(latest.get("close"))
        previous_close = _number(previous.get("close")) if previous else None
        if price is None or price <= 0:
            continue
        change = price - previous_close if previous_close and previous_close > 0 else None
        quotes.append(
            {
                "symbol": symbol,
                "sessionDate": str(latest["sessionDate"]),
                "price": price,
                "previousClose": previous_close,
                "change": change,
                "changePct": (
                    (change / previous_close) * 100
                    if change is not None and previous_close
                    else None
                ),
                "providerUpdatedAt": None,
                "source": "yfinance-close-fallback",
                "fetchedAt": str(latest.get("fetchedAt") or utc_now()),
            }
        )
    return quotes
