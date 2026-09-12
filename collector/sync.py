from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from .db import Store, utc_now


SCHEMA_VERSION = 1


class SyncError(RuntimeError):
    pass


def _chunks(rows: Sequence[dict[str, Any]], size: int):
    for index in range(0, len(rows), size):
        yield rows[index : index + size]


def make_batch(
    *,
    prices: Sequence[dict[str, Any]] = (),
    quotes: Sequence[dict[str, Any]] = (),
    portfolios: Mapping[str, Sequence[dict[str, Any]]] | None = None,
    batch_nonce: str | None = None,
    generated_at: str | None = None,
) -> tuple[str, dict[str, Any]]:
    generated_at = generated_at or utc_now()
    canonical: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "batchNonce": batch_nonce or uuid.uuid4().hex,
        "generatedAt": generated_at,
        "prices": list(prices),
        "quotes": list(quotes),
    }
    if portfolios is not None:
        canonical["portfolios"] = {
            key: list(value) for key, value in sorted(portfolios.items())
        }
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    batch_id = hashlib.sha256(encoded).hexdigest()
    payload = {**canonical, "batchId": batch_id}
    return batch_id, payload


def enqueue_pending(store: Store, batch_size: int) -> dict[str, int]:
    counts = {"prices": 0, "quotes": 0, "portfolios": 0, "batches": 0}

    for rows in _chunks(store.pending_price_rows(), batch_size):
        batch_id, payload = make_batch(prices=rows)
        if store.enqueue_batch(batch_id, payload):
            counts["batches"] += 1
        store.mark_prices_queued(rows)
        counts["prices"] += len(rows)

    for rows in _chunks(store.pending_quote_rows(), batch_size):
        batch_id, payload = make_batch(quotes=rows)
        if store.enqueue_batch(batch_id, payload):
            counts["batches"] += 1
        store.mark_quotes_queued(rows)
        counts["quotes"] += len(rows)

    portfolios = store.pending_portfolios()
    if portfolios:
        batch_id, payload = make_batch(portfolios=portfolios)
        if store.enqueue_batch(batch_id, payload):
            counts["batches"] += 1
        store.mark_portfolios_queued()
        counts["portfolios"] = sum(len(rows) for rows in portfolios.values())

    return counts


def post_batch(
    url: str,
    token: str,
    batch_id: str,
    payload_json: str,
    timeout: float,
) -> None:
    request = urllib.request.Request(
        url,
        data=payload_json.encode("utf-8"),
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "Idempotency-Key": batch_id,
            "User-Agent": "Portanahung-Mac-Collector/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if not 200 <= response.status < 300:
                raise SyncError(f"Railway ingestion returned HTTP {response.status}")
            response.read()
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")[:500]
        raise SyncError(f"Railway ingestion returned HTTP {error.code}: {body}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise SyncError(f"Railway ingestion request failed: {error}") from error


def flush_outbox(
    store: Store,
    *,
    url: str,
    token: str,
    timeout: float,
) -> tuple[int, str | None]:
    sent = 0
    for batch in store.pending_batches():
        try:
            post_batch(
                url,
                token,
                batch["batch_id"],
                batch["payload_json"],
                timeout,
            )
        except SyncError as error:
            store.mark_batch_failed(batch["batch_id"], str(error))
            return sent, str(error)
        store.mark_batch_synced(batch["batch_id"])
        sent += 1
    return sent, None
