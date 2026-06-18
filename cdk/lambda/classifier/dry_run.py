"""
Run the classifier locally without touching the DB.

Usage:
    ANTHROPIC_API_KEY=... VOYAGE_API_KEY=... poetry run python dry_run.py [adapter] [--no-canonicalize] [-n N]

    adapter            Optional: polymarket | kalshi | hyperliquid
    --no-canonicalize  Skip Claude canonicalization — events keep raw titles/categories
    --skip-semantic    Count embedding pairs that would be sent to Claude without calling it
    -n N               Limit to first N contracts across all adapters
"""
import dataclasses
import json
import logging
import os
import sys
from unittest.mock import MagicMock

import anthropic
import voyageai

from adapters import ADAPTERS
from gnomepy.registry import RegistryClient
from gnomepy.registry.types import (
    ContractRelationship,
    Currency,
    Event,
    EventContract,
    Exchange,
    ExchangeEvent,
    Listing,
    ListingSpec,
    Security,
)
from pipeline import Pipeline

logging.basicConfig(level=logging.DEBUG, format="%(levelname)s %(name)s: %(message)s")


class StubRegistry(RegistryClient):
    """In-memory registry that simulates empty DB state. All writes are stored locally."""

    def __init__(self):
        self._next_id = 1
        self._events: list[Event] = []
        self._securities: list[Security] = []
        self._listings: list[Listing] = []
        self._listing_specs: list[ListingSpec] = []
        self._event_contracts: list[EventContract] = []
        self._exchange_events: list[ExchangeEvent] = []
        self._contract_relationships: list[ContractRelationship] = []
        self._currencies: list[Currency] = []

    def _alloc_id(self) -> int:
        i = self._next_id
        self._next_id += 1
        return i

    # --- reads ---

    def get_exchange(self) -> list[Exchange]:
        return [
            Exchange(exchange_id=1, exchange_name="polymarket", region="", schema_type="", date_modified="", date_created=""),
            Exchange(exchange_id=2, exchange_name="kalshi", region="", schema_type="", date_modified="", date_created=""),
            Exchange(exchange_id=3, exchange_name="hyperliquid", region="", schema_type="", date_modified="", date_created=""),
        ]

    def get_currency(self) -> list[Currency]:
        return list(self._currencies)

    def get_security(self) -> list[Security]:
        return list(self._securities)

    def get_listing(self) -> list[Listing]:
        return list(self._listings)

    def get_listing_spec(self) -> list[ListingSpec]:
        return list(self._listing_specs)

    def get_event(self) -> list[Event]:
        return list(self._events)

    def get_event_contracts(self) -> list[EventContract]:
        return list(self._event_contracts)

    def get_contract_relationships(self) -> list[ContractRelationship]:
        return list(self._contract_relationships)

    def get_exchange_events(self) -> list[ExchangeEvent]:
        return list(self._exchange_events)

    # --- writes ---

    def bulk_create_events(self, items: list[dict]) -> list[dict]:
        results = []
        for item in items:
            event_id = self._alloc_id()
            d = {
                "event_id": event_id,
                "title": item.get("title", ""),
                "description": item.get("description"),
                "category": item.get("category"),
                "resolution_source": None,
                "tags": item.get("tags"),
                "embedding": item.get("embedding"),
                "resolved": False,
                "resolved_at": None,
                "expiry": item.get("expiry"),
                "date_modified": "",
                "date_created": "",
            }
            self._events.append(Event(**d))
            results.append(d)
        return results

    def bulk_create_securities(self, items: list[dict]) -> list[dict]:
        results = []
        for item in items:
            security_id = self._alloc_id()
            d = {"security_id": security_id, **item}
            self._securities.append(Security(
                security_id=security_id,
                symbol=item.get("symbol", ""),
                type=item.get("type", 0),
                contract_type=item.get("contract_type", 0),
                asset_class=item.get("asset_class", 0),
                base_currency_id=item.get("base_currency_id"),
                quote_currency_id=item.get("quote_currency_id"),
                settle_currency_id=item.get("settle_currency_id"),
                inverse=item.get("inverse", False),
                is_quanto=item.get("quanto", False),
                expiry=item.get("expiry"),
                strike_price=None,
                active=item.get("active", True),
                underlying_security_id=None,
                description=None,
                date_modified="",
                date_created="",
            ))
            results.append(d)
        return results

    def bulk_create_listings(self, items: list[dict]) -> list[dict]:
        results = []
        for item in items:
            listing_id = self._alloc_id()
            d = {
                "listing_id": listing_id,
                "security_id": item["security_id"],
                "exchange_id": item["exchange_id"],
                "exchange_security_id": item.get("exchange_security_id"),
                "exchange_security_symbol": item.get("exchange_security_symbol"),
                "date_modified": "",
                "date_created": "",
            }
            self._listings.append(Listing(**d))
            results.append(d)
        return results

    def bulk_create_event_contracts(self, items: list[dict]) -> list[dict]:
        results = []
        for item in items:
            ec_id = self._alloc_id()
            d = {
                "event_contract_id": ec_id,
                "event_id": item["event_id"],
                "security_id": item["security_id"],
                "outcome_label": item["outcome_label"],
                "complement_security_id": None,
                "date_created": "",
            }
            self._event_contracts.append(EventContract(**d))
            results.append(d)
        return results

    def bulk_create_listing_specs(self, items: list[dict]) -> list[dict]:
        results = []
        for item in items:
            spec_id = self._alloc_id()
            d = {
                "id": spec_id,
                "listing_id": item["listing_id"],
                "tick_size": item["tick_size"],
                "lot_size": item["lot_size"],
                "min_notional": item["min_notional"],
                "contract_multiplier": item["contract_multiplier"],
                "recorded_at": "",
            }
            self._listing_specs.append(ListingSpec(**d))
            results.append(d)
        return results

    def bulk_create_exchange_events(self, items: list[dict]) -> list[dict]:
        results = []
        for item in items:
            ee_id = self._alloc_id()
            d = {
                "exchange_event_id": ee_id,
                "exchange_id": item["exchange_id"],
                "event_id": item["event_id"],
                "native_event_id": item["native_event_id"],
                "raw_title": item.get("raw_title", ""),
                "date_created": "",
            }
            self._exchange_events.append(ExchangeEvent(**d))
            results.append(d)
        return results

    def bulk_create_contract_relationships(self, items: list[dict]) -> list[dict]:
        results = []
        for item in items:
            rel_id = self._alloc_id()
            d = {
                "relationship_id": rel_id,
                "security_id_a": item["security_id_a"],
                "security_id_b": item["security_id_b"],
                "relationship_type": item["relationship_type"],
                "confidence": item["confidence"],
                "method": item["method"],
                "reviewed": False,
                "reviewed_at": None,
                "date_created": "",
            }
            self._contract_relationships.append(ContractRelationship(**d))
            results.append(d)
        return results

    def patch_event_contract(self, event_contract_id: int, **kwargs) -> dict:
        for i, ec in enumerate(self._event_contracts):
            if ec.event_contract_id == event_contract_id:
                updated = dataclasses.replace(ec, **kwargs)
                self._event_contracts[i] = updated
                return dataclasses.asdict(updated)
        return {}

    def _post(self, path: str, body: dict) -> dict:
        if path == "/currencies":
            currency_id = self._alloc_id()
            d = {
                "currency_id": currency_id,
                "symbol": body.get("symbol", ""),
                "name": None,
                "decimals": 6,
                "date_modified": "",
                "date_created": "",
            }
            self._currencies.append(Currency(**d))
            return d
        return {}

    def _post_bulk(self, path: str, items: list[dict]) -> list[dict]:
        return []

    def _patch(self, path: str, params: dict, body: dict) -> dict:
        return {}

    def get_dry_run_data(self) -> dict:
        return {
            "events": [dataclasses.asdict(e) for e in self._events],
            "securities": [dataclasses.asdict(s) for s in self._securities],
            "listings": [dataclasses.asdict(l) for l in self._listings],
            "event_contracts": [dataclasses.asdict(ec) for ec in self._event_contracts],
            "relationships": [dataclasses.asdict(r) for r in self._contract_relationships],
        }


def _no_op_anthropic_client() -> anthropic.Anthropic:
    """Returns a mock Anthropic client whose messages.create returns raw title as canonical title."""
    def _fake_create(*args, **kwargs):
        messages = kwargs.get("messages", args[1] if len(args) > 1 else [])
        content = messages[0].get("content", "") if messages else ""
        # Extract all [N] Title: lines from a batch prompt, or the single "Exchange-provided title:" line
        titles = []
        for line in content.splitlines():
            if line.startswith("[") and "] Title: " in line:
                title = line.split("] Title: ", 1)[1].split(" | ")[0].strip()
                titles.append({"title": title, "category": "OTHER"})
            elif line.startswith("Exchange-provided title:"):
                title = line.split(":", 1)[1].strip()
                titles.append({"title": title, "category": "OTHER"})

        if not titles:
            text = json.dumps([])
        else:
            text = json.dumps(titles) if len(titles) != 1 else json.dumps(titles[0])
        mock_content = MagicMock()
        mock_content.text = text
        mock_response = MagicMock()
        mock_response.content = [mock_content]
        return mock_response

    client = MagicMock(spec=anthropic.Anthropic)
    client.messages.create.side_effect = _fake_create
    return client


def main() -> None:
    args = sys.argv[1:]
    no_canonicalize = "--no-canonicalize" in args
    skip_semantic = "--skip-semantic" in args
    if "--debug" in args:
        logging.getLogger().setLevel(logging.DEBUG)

    max_contracts = None
    if "-n" in args:
        idx = args.index("-n")
        try:
            max_contracts = int(args[idx + 1])
        except (IndexError, ValueError):
            print("Usage: -n N requires an integer argument")
            sys.exit(1)

    output_path = "dry_run_output.json"
    for flag in ("-o", "--output"):
        if flag in args:
            idx = args.index(flag)
            try:
                output_path = args[idx + 1]
            except IndexError:
                print(f"Usage: {flag} PATH requires a path argument")
                sys.exit(1)

    consumed_values: set[str] = set()
    for flag in ("-n", "-o", "--output"):
        if flag in args:
            idx = args.index(flag)
            if idx + 1 < len(args):
                consumed_values.add(args[idx + 1])
    positional = [a for a in args if not a.startswith("-") and a not in consumed_values]
    adapter_filter = positional[0].lower() if positional else None

    if no_canonicalize:
        client = _no_op_anthropic_client()
    else:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            print("ANTHROPIC_API_KEY not set — pass --no-canonicalize to skip, or set the key")
            sys.exit(1)
        client = anthropic.Anthropic(api_key=api_key)

    voyage_key = os.environ.get("VOYAGE_API_KEY")
    if not voyage_key:
        print("VOYAGE_API_KEY not set")
        sys.exit(1)
    voyage_client = voyageai.Client(api_key=voyage_key)

    if adapter_filter:
        original = ADAPTERS[:]
        filtered = [a for a in ADAPTERS if a.exchange_name == adapter_filter]
        if not filtered:
            print(f"Unknown adapter '{adapter_filter}'. Choices: {[a.exchange_name for a in ADAPTERS]}")
            sys.exit(1)
        ADAPTERS[:] = filtered

    registry = StubRegistry()
    pipeline = Pipeline(registry=registry, anthropic_client=client, voyage_client=voyage_client, max_contracts=max_contracts, skip_semantic=skip_semantic)

    print("\n=== DRY RUN ===\n")
    summary = pipeline.run()

    print("\n=== SUMMARY ===")
    for k, v in summary.items():
        if k != "new_security_ids":
            print(f"  {k}: {v}")

    output = {**registry.get_dry_run_data(), "summary": summary}
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nFull output written to {output_path}")

    if adapter_filter:
        ADAPTERS[:] = original


if __name__ == "__main__":
    main()
