from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_RAILWAY_URL = "https://portanahunggoogsheet-production.up.railway.app"


def load_env_file(path: Path) -> None:
    """Load KEY=VALUE pairs without overriding an existing process variable."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


def _positive_int(name: str, default: int) -> int:
    value = int(os.environ.get(name, default))
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def _positive_float(name: str, default: float) -> float:
    value = float(os.environ.get(name, default))
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


@dataclass(frozen=True)
class Config:
    db_path: Path
    railway_base_url: str
    railway_ingest_token: str | None
    marketdata_token: str | None
    google_sheet_id: str
    google_sheets_base_url: str
    portfolios: tuple[str, ...]
    yfinance_backfill_days: int
    yfinance_chunk_size: int
    sync_batch_size: int
    request_timeout_seconds: float
    marketdata_quote_chunk_size: int
    marketdata_cache_maxage_seconds: int
    holdings_refresh_minutes: int
    history_retry_minutes: int

    @property
    def ingest_url(self) -> str:
        return f"{self.railway_base_url}/api/ingest/market-data"

    @classmethod
    def from_environment(cls, env_file: Path | None = None) -> "Config":
        load_env_file(env_file or Path(__file__).with_name(".env"))

        default_db = (
            Path.home()
            / "Library"
            / "Application Support"
            / "Portanahung"
            / "market-data.sqlite3"
        )
        railway_base_url = os.environ.get(
            "RAILWAY_BASE_URL", DEFAULT_RAILWAY_URL
        ).rstrip("/")
        portfolios = tuple(
            item.strip().upper()
            for item in os.environ.get("PORTFOLIOS", "CUB,PSC,DBS,FT").split(",")
            if item.strip()
        )
        if not portfolios:
            raise ValueError("PORTFOLIOS must contain at least one portfolio")

        return cls(
            db_path=Path(os.environ.get("COLLECTOR_DB_PATH", default_db)).expanduser(),
            railway_base_url=railway_base_url,
            railway_ingest_token=os.environ.get("RAILWAY_INGEST_TOKEN") or None,
            marketdata_token=os.environ.get("MARKETDATA_TOKEN") or None,
            google_sheet_id=os.environ.get(
                "GOOGLE_SHEET_ID", "1XsHYx1Ifb-y2jX2mssDCB7ICW4YnhEsjWiDi3F3UIdE"
            ),
            google_sheets_base_url=os.environ.get(
                "GOOGLE_SHEETS_BASE_URL", "https://docs.google.com/spreadsheets/d"
            ).rstrip("/"),
            portfolios=portfolios,
            yfinance_backfill_days=_positive_int("YFINANCE_BACKFILL_DAYS", 550),
            yfinance_chunk_size=_positive_int("YFINANCE_CHUNK_SIZE", 25),
            sync_batch_size=_positive_int("SYNC_BATCH_SIZE", 500),
            request_timeout_seconds=_positive_float("REQUEST_TIMEOUT_SECONDS", 30),
            marketdata_quote_chunk_size=_positive_int(
                "MARKETDATA_QUOTE_CHUNK_SIZE", 100
            ),
            marketdata_cache_maxage_seconds=_positive_int(
                "MARKETDATA_CACHE_MAXAGE_SECONDS", 300
            ),
            holdings_refresh_minutes=_positive_int("HOLDINGS_REFRESH_MINUTES", 15),
            history_retry_minutes=_positive_int("HISTORY_RETRY_MINUTES", 30),
        )
