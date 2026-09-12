# Mac market-data collector

This collector keeps a last-known-good SQLite cache on the Mac and pushes
idempotent batches to the Railway replica. The production request path never
needs to wait for Yahoo, Marketdata.app, Google Sheets, or this Mac.

## Data policy

- Holdings: read directly from the public `CUB`, `PSC`, `DBS`, and `FT` Google
  Sheet tabs and cached locally. The collector deliberately does not read the
  Railway holding replica.
- Daily history: collected with yfinance using `auto_adjust=False`. Yahoo's
  `Close` is already adjusted for splits but not dividends, so it matches the
  app's existing `adjustsplits=true&adjustdividends=false` policy. `Adj Close`
  is stored only as a reference. No second split adjustment is applied.
- Fresh quotes: collected from Marketdata.app only during the weekday 09:30–
  16:15 New York window by the scheduled command. It tries a five-minute cached
  bulk request first, then spends live credits only on cache-miss symbols.
- Fallback: each successful Yahoo run also creates a completed-close quote.
  A newer session wins, and a Marketdata row wins over Yahoo on the same
  session. Provider errors never delete good rows.
- Sync: changed rows are first placed in a durable SQLite outbox. Each batch has
  a durable random revision nonce, is hashed, sent with the same `batchId` and
  `Idempotency-Key`, and is retried until Railway returns a 2xx response. The
  nonce prevents A→B→A from being mistaken for the first A batch.

## Install

From the repository root:

```sh
python3 -m venv .venv-collector
.venv-collector/bin/pip install -r collector/requirements.txt
```

The installed launchd job uses `railway run`, so this Mac reads the existing
`MARKETDATA_TOKEN` and `RAILWAY_INGEST_TOKEN` from Railway without keeping a
second plaintext copy. Confirm `railway status` identifies the
`portanahunggoogsheet` service. For a machine without Railway CLI access, copy
`.env.example` to `collector/.env`, set its secrets, and run `chmod 600
collector/.env`; never commit it. The SQLite file, `.env`, and virtual
environment are ignored by git.

Initialize and perform a first full collection:

```sh
railway run .venv-collector/bin/python -m collector.cli init
railway run .venv-collector/bin/python -m collector.cli run
railway run .venv-collector/bin/python -m collector.cli status
```

The initial run downloads 550 calendar days so Analysis and AVC have more than
60 trading sessions. Subsequent runs update rows in place. A failed Railway
connection leaves batches pending in the local outbox.

Useful manual commands:

```sh
railway run .venv-collector/bin/python -m collector.cli holdings
railway run .venv-collector/bin/python -m collector.cli history
railway run .venv-collector/bin/python -m collector.cli quotes
railway run .venv-collector/bin/python -m collector.cli sync
```

For a harmless provider test, pass an explicit small symbol set to `history`,
`quotes`, or `run`, for example `--symbols AAPL,SPY`.

## Scheduling on macOS

Use the included launchd plist as a template. Replace `__REPOSITORY_PATH__` with
this checkout's absolute path and `__LOG_PATH__` with a writable log directory,
then save it as:

`~/Library/LaunchAgents/com.rolandtalk.portanahung-collector.plist`

Load it with:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.rolandtalk.portanahung-collector.plist
```

The supplied template invokes `/opt/homebrew/bin/railway run --service
portanahunggoogsheet`, keeping API secrets in Railway. The five-minute launchd
interval is only a wake-up tick. `scheduled` evaluates
the current New York time, so US daylight-saving changes do not require plist
changes. It:

1. refreshes Google holdings at the configured interval;
2. fetches Marketdata quotes only in the regular-session window;
3. runs one Yahoo daily update after 16:20 New York time (or catches up later);
4. retries every pending Railway batch on every tick.

It does not fabricate missing five-minute observations. If the Mac sleeps,
the next tick refreshes the current state and retries the durable outbox.

## Ingestion contract

The collector posts to `POST /api/ingest/market-data` with a bearer token and a
body shaped like:

```json
{
  "schemaVersion": 1,
  "batchNonce": "durable-random-revision",
  "batchId": "sha256-content-hash",
  "generatedAt": "2026-09-12T13:30:00Z",
  "prices": [
    {
      "symbol": "AAPL",
      "sessionDate": "2026-09-11",
      "close": 230.14,
      "rawClose": 230.14,
      "adjustedClose": 229.91,
      "source": "yfinance",
      "fetchedAt": "2026-09-12T13:30:00Z"
    }
  ],
  "quotes": [],
  "portfolios": {
    "CUB": [{ "symbol": "AAPL", "shares": 10, "cost": 1500 }],
    "PSC": [],
    "DBS": [],
    "FT": []
  }
}
```

Price, quote, and portfolio data may arrive in separate batches. `prices` and
`quotes` are always arrays; `portfolios` is optional. Railway must treat a
repeated `batchId` as a successful no-op.
