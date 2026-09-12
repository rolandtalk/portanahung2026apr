from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


def utc_now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA busy_timeout = 5000")

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def initialize(self) -> None:
        schema_path = Path(__file__).with_name("schema.sql")
        self.connection.executescript(schema_path.read_text(encoding="utf-8"))

    def start_run(self, task: str) -> int:
        cursor = self.connection.execute(
            "INSERT INTO collection_runs(task, started_at, status) VALUES (?, ?, 'running')",
            (task, utc_now()),
        )
        self.connection.commit()
        return int(cursor.lastrowid)

    def finish_run(
        self,
        run_id: int,
        status: str,
        records_written: int,
        detail: str | None = None,
    ) -> None:
        self.connection.execute(
            """
            UPDATE collection_runs
               SET finished_at = ?, status = ?, records_written = ?, detail = ?
             WHERE id = ?
            """,
            (utc_now(), status, records_written, detail, run_id),
        )
        self.connection.commit()

    def upsert_prices(self, rows: Iterable[Mapping[str, Any]]) -> int:
        normalized = [
            (
                row["symbol"],
                row["sessionDate"],
                row["close"],
                row.get("rawClose"),
                row.get("adjustedClose"),
                row["source"],
                row["fetchedAt"],
            )
            for row in rows
        ]
        if not normalized:
            return 0
        with self.connection:
            self.connection.executemany(
                """
                INSERT INTO daily_prices(
                    symbol, session_date, close, raw_close, adjusted_close, source, fetched_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, session_date) DO UPDATE SET
                    close = excluded.close,
                    raw_close = excluded.raw_close,
                    adjusted_close = excluded.adjusted_close,
                    source = excluded.source,
                    fetched_at = excluded.fetched_at,
                    sync_pending = 1
                WHERE daily_prices.close IS NOT excluded.close
                   OR daily_prices.raw_close IS NOT excluded.raw_close
                   OR daily_prices.adjusted_close IS NOT excluded.adjusted_close
                   OR daily_prices.source IS NOT excluded.source
                """,
                normalized,
            )
        return len(normalized)

    def upsert_quotes(self, rows: Iterable[Mapping[str, Any]]) -> int:
        normalized = [
            (
                row["symbol"],
                row["sessionDate"],
                row["price"],
                row.get("previousClose"),
                row.get("change"),
                row.get("changePct"),
                row.get("providerUpdatedAt"),
                row["source"],
                row["fetchedAt"],
            )
            for row in rows
        ]
        if not normalized:
            return 0
        with self.connection:
            self.connection.executemany(
                """
                INSERT INTO quotes(
                    symbol, session_date, price, previous_close, change, change_pct,
                    provider_updated_at, source, fetched_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol) DO UPDATE SET
                    session_date = excluded.session_date,
                    price = excluded.price,
                    previous_close = excluded.previous_close,
                    change = excluded.change,
                    change_pct = excluded.change_pct,
                    provider_updated_at = excluded.provider_updated_at,
                    source = excluded.source,
                    fetched_at = excluded.fetched_at,
                    sync_pending = 1
                WHERE excluded.session_date > quotes.session_date
                   OR (
                       excluded.session_date = quotes.session_date
                       AND excluded.source = 'marketdata.app'
                       AND quotes.source <> 'marketdata.app'
                   )
                   OR (
                       excluded.session_date = quotes.session_date
                       AND excluded.source = quotes.source
                       AND (
                           excluded.price IS NOT quotes.price
                           OR excluded.previous_close IS NOT quotes.previous_close
                           OR excluded.change IS NOT quotes.change
                           OR excluded.change_pct IS NOT quotes.change_pct
                           OR COALESCE(excluded.provider_updated_at, '')
                              > COALESCE(quotes.provider_updated_at, '')
                       )
                   )
                """,
                normalized,
            )
        return len(normalized)

    def replace_portfolios(
        self, portfolios: Mapping[str, Iterable[Mapping[str, Any]]]
    ) -> int:
        """Replace only portfolios successfully fetched in this collection pass."""
        timestamp = utc_now()
        count = 0
        dirty = False
        with self.connection:
            for portfolio, holdings in portfolios.items():
                rows = [
                    (
                        portfolio.upper(),
                        str(row["symbol"]).upper(),
                        float(row["shares"]),
                        float(row["cost"]),
                        timestamp,
                    )
                    for row in holdings
                ]
                existing = [
                    (row["portfolio"], row["symbol"], row["shares"], row["cost"])
                    for row in self.connection.execute(
                        """
                        SELECT portfolio, symbol, shares, cost
                          FROM holdings WHERE portfolio = ? ORDER BY symbol
                        """,
                        (portfolio.upper(),),
                    )
                ]
                incoming = sorted((row[0], row[1], row[2], row[3]) for row in rows)
                was_seen = self.connection.execute(
                    "SELECT 1 FROM metadata WHERE key = ?",
                    (f"portfolio_seen:{portfolio.upper()}",),
                ).fetchone()
                if was_seen is None or existing != incoming:
                    self.connection.execute(
                        "DELETE FROM holdings WHERE portfolio = ?", (portfolio.upper(),)
                    )
                    self.connection.executemany(
                        """
                        INSERT INTO holdings(
                            portfolio, symbol, shares, cost, fetched_at, sync_pending
                        ) VALUES (?, ?, ?, ?, ?, 1)
                        """,
                        rows,
                    )
                    dirty = True
                count += len(rows)
                self.connection.execute(
                    """
                    INSERT INTO metadata(key, value, updated_at)
                    VALUES (?, '1', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                                   updated_at = excluded.updated_at
                    """,
                    (f"portfolio_seen:{portfolio.upper()}", timestamp),
                )
            if dirty:
                self.connection.execute(
                    """
                    INSERT INTO metadata(key, value, updated_at)
                    VALUES ('portfolios_sync_pending', '1', ?)
                    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
                    """,
                    (timestamp,),
                )
        return count

    def known_portfolios(self) -> list[str]:
        return [
            row[0].split(":", 1)[1]
            for row in self.connection.execute(
                "SELECT key FROM metadata WHERE key LIKE 'portfolio_seen:%' ORDER BY key"
            )
        ]

    def get_portfolios(self) -> dict[str, list[dict[str, Any]]]:
        rows = self.connection.execute(
            """
            SELECT portfolio, symbol, shares, cost
              FROM holdings
             ORDER BY portfolio, symbol
            """
        ).fetchall()
        result: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            result.setdefault(row["portfolio"], []).append(
                {
                    "symbol": row["symbol"],
                    "shares": row["shares"],
                    "cost": row["cost"],
                }
            )
        return result

    def symbols(self) -> list[str]:
        return [
            row[0]
            for row in self.connection.execute(
                "SELECT DISTINCT symbol FROM holdings ORDER BY symbol"
            )
        ]

    def has_price(self, symbol: str, session_date: str) -> bool:
        return self.connection.execute(
            """
            SELECT 1 FROM daily_prices
             WHERE symbol = ? AND session_date = ? LIMIT 1
            """,
            (symbol.upper(), session_date),
        ).fetchone() is not None

    def price_rows(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """
            SELECT symbol, session_date, close, raw_close, adjusted_close, source, fetched_at
              FROM daily_prices
             ORDER BY symbol, session_date
            """
        ).fetchall()
        return [
            {
                "symbol": row["symbol"],
                "sessionDate": row["session_date"],
                "close": row["close"],
                "rawClose": row["raw_close"],
                "adjustedClose": row["adjusted_close"],
                "source": row["source"],
                "fetchedAt": row["fetched_at"],
            }
            for row in rows
        ]

    def pending_price_rows(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """
            SELECT symbol, session_date, close, raw_close, adjusted_close, source, fetched_at
              FROM daily_prices
             WHERE sync_pending = 1
             ORDER BY symbol, session_date
            """
        ).fetchall()
        return [
            {
                "symbol": row["symbol"],
                "sessionDate": row["session_date"],
                "close": row["close"],
                "rawClose": row["raw_close"],
                "adjustedClose": row["adjusted_close"],
                "source": row["source"],
                "fetchedAt": row["fetched_at"],
            }
            for row in rows
        ]

    def quote_rows(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """
            SELECT symbol, session_date, price, previous_close, change, change_pct,
                   provider_updated_at, source, fetched_at
              FROM quotes
             ORDER BY symbol
            """
        ).fetchall()
        return [
            {
                "symbol": row["symbol"],
                "sessionDate": row["session_date"],
                "price": row["price"],
                "previousClose": row["previous_close"],
                "change": row["change"],
                "changePct": row["change_pct"],
                "providerUpdatedAt": row["provider_updated_at"],
                "source": row["source"],
                "fetchedAt": row["fetched_at"],
            }
            for row in rows
        ]

    def pending_quote_rows(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """
            SELECT symbol, session_date, price, previous_close, change, change_pct,
                   provider_updated_at, source, fetched_at
              FROM quotes
             WHERE sync_pending = 1
             ORDER BY symbol
            """
        ).fetchall()
        return [
            {
                "symbol": row["symbol"],
                "sessionDate": row["session_date"],
                "price": row["price"],
                "previousClose": row["previous_close"],
                "change": row["change"],
                "changePct": row["change_pct"],
                "providerUpdatedAt": row["provider_updated_at"],
                "source": row["source"],
                "fetchedAt": row["fetched_at"],
            }
            for row in rows
        ]

    def pending_portfolios(self) -> dict[str, list[dict[str, Any]]]:
        if self.get_metadata("portfolios_sync_pending") != "1":
            return {}
        stored = self.get_portfolios()
        return {
            portfolio: stored.get(portfolio, [])
            for portfolio in self.known_portfolios()
        }

    def mark_prices_queued(self, rows: Iterable[Mapping[str, Any]]) -> None:
        keys = [(row["symbol"], row["sessionDate"]) for row in rows]
        with self.connection:
            self.connection.executemany(
                """
                UPDATE daily_prices SET sync_pending = 0
                 WHERE symbol = ? AND session_date = ?
                """,
                keys,
            )

    def mark_quotes_queued(self, rows: Iterable[Mapping[str, Any]]) -> None:
        keys = [(row["symbol"],) for row in rows]
        with self.connection:
            self.connection.executemany(
                "UPDATE quotes SET sync_pending = 0 WHERE symbol = ?", keys
            )

    def mark_portfolios_queued(self) -> None:
        with self.connection:
            self.connection.execute("UPDATE holdings SET sync_pending = 0")
            self.connection.execute(
                """
                INSERT INTO metadata(key, value, updated_at)
                VALUES ('portfolios_sync_pending', '0', ?)
                ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at
                """,
                (utc_now(),),
            )

    def get_metadata(self, key: str) -> str | None:
        row = self.connection.execute(
            "SELECT value FROM metadata WHERE key = ?", (key,)
        ).fetchone()
        return str(row[0]) if row else None

    def set_metadata(self, key: str, value: str) -> None:
        now = utc_now()
        self.connection.execute(
            """
            INSERT INTO metadata(key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                           updated_at = excluded.updated_at
            """,
            (key, value, now),
        )
        self.connection.commit()

    def enqueue_batch(self, batch_id: str, payload: Mapping[str, Any]) -> bool:
        payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        cursor = self.connection.execute(
            """
            INSERT OR IGNORE INTO outbox_batches(batch_id, payload_json, created_at)
            VALUES (?, ?, ?)
            """,
            (batch_id, payload_json, utc_now()),
        )
        self.connection.commit()
        return cursor.rowcount == 1

    def pending_batches(self) -> list[sqlite3.Row]:
        return self.connection.execute(
            """
            SELECT batch_id, payload_json, attempts
              FROM outbox_batches
             WHERE synced_at IS NULL
             ORDER BY created_at, batch_id
            """
        ).fetchall()

    def mark_batch_synced(self, batch_id: str) -> None:
        self.connection.execute(
            """
            UPDATE outbox_batches
               SET attempts = attempts + 1, last_attempt_at = ?, synced_at = ?, last_error = NULL
             WHERE batch_id = ?
            """,
            (utc_now(), utc_now(), batch_id),
        )
        self.connection.commit()

    def mark_batch_failed(self, batch_id: str, error: str) -> None:
        self.connection.execute(
            """
            UPDATE outbox_batches
               SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
             WHERE batch_id = ?
            """,
            (utc_now(), error[:1000], batch_id),
        )
        self.connection.commit()

    def summary(self) -> dict[str, Any]:
        counts = {}
        for table in ("daily_prices", "quotes", "holdings", "outbox_batches"):
            counts[table] = self.connection.execute(
                f"SELECT COUNT(*) FROM {table}"
            ).fetchone()[0]
        counts["outbox_pending"] = self.connection.execute(
            "SELECT COUNT(*) FROM outbox_batches WHERE synced_at IS NULL"
        ).fetchone()[0]
        latest_run = self.connection.execute(
            """
            SELECT task, started_at, finished_at, status, records_written, detail
              FROM collection_runs ORDER BY id DESC LIMIT 1
            """
        ).fetchone()
        latest_price = self.connection.execute(
            "SELECT MAX(session_date) FROM daily_prices"
        ).fetchone()[0]
        latest_quote = self.connection.execute(
            "SELECT MAX(COALESCE(provider_updated_at, fetched_at)) FROM quotes"
        ).fetchone()[0]
        return {
            **counts,
            "latest_price_session": latest_price,
            "latest_quote_at": latest_quote,
            "latest_run": dict(latest_run) if latest_run else None,
        }

    def status(self) -> dict[str, Any]:
        def scalar(sql: str) -> Any:
            return self.connection.execute(sql).fetchone()[0]

        return {
            "database": str(self.path),
            "prices": scalar("SELECT COUNT(*) FROM daily_prices"),
            "quotes": scalar("SELECT COUNT(*) FROM quotes"),
            "holdings": scalar("SELECT COUNT(*) FROM holdings"),
            "pendingBatches": scalar(
                "SELECT COUNT(*) FROM outbox_batches WHERE synced_at IS NULL"
            ),
            "latestPriceDate": scalar("SELECT MAX(session_date) FROM daily_prices"),
            "latestQuoteAt": scalar("SELECT MAX(fetched_at) FROM quotes"),
        }
