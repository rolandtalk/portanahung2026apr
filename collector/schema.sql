PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS daily_prices (
    symbol TEXT NOT NULL,
    session_date TEXT NOT NULL,
    close REAL NOT NULL CHECK (close > 0),
    raw_close REAL CHECK (raw_close IS NULL OR raw_close > 0),
    adjusted_close REAL CHECK (adjusted_close IS NULL OR adjusted_close > 0),
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    sync_pending INTEGER NOT NULL DEFAULT 1 CHECK (sync_pending IN (0, 1)),
    PRIMARY KEY (symbol, session_date)
);

CREATE INDEX IF NOT EXISTS daily_prices_session_date_idx
    ON daily_prices (session_date);

CREATE TABLE IF NOT EXISTS quotes (
    symbol TEXT PRIMARY KEY,
    session_date TEXT NOT NULL,
    price REAL NOT NULL CHECK (price > 0),
    previous_close REAL CHECK (previous_close IS NULL OR previous_close > 0),
    change REAL,
    change_pct REAL,
    provider_updated_at TEXT,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    sync_pending INTEGER NOT NULL DEFAULT 1 CHECK (sync_pending IN (0, 1))
);

CREATE TABLE IF NOT EXISTS holdings (
    portfolio TEXT NOT NULL,
    symbol TEXT NOT NULL,
    shares REAL NOT NULL,
    cost REAL NOT NULL,
    fetched_at TEXT NOT NULL,
    sync_pending INTEGER NOT NULL DEFAULT 1 CHECK (sync_pending IN (0, 1)),
    PRIMARY KEY (portfolio, symbol)
);

CREATE TABLE IF NOT EXISTS collection_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
    records_written INTEGER NOT NULL DEFAULT 0,
    detail TEXT
);

CREATE TABLE IF NOT EXISTS outbox_batches (
    batch_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    synced_at TEXT,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
    ON outbox_batches (synced_at, created_at);

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
