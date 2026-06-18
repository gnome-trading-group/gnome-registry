import dataclasses
import json
import logging
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

import anthropic

from adapters import ADAPTERS
from normalize import jaccard_similarity, normalize_title
from gnomepy.registry import RegistryClient
from gnomepy.registry.types import Currency, Event, EventContract, Listing, SecurityType
from adapters.types import AdapterContract
from relationships.structural import STRUCTURAL_CONFIDENCE, find_complement_pairs, find_mutually_exclusive_sets
from relationships.rule_based import find_rule_based_equivalents, find_hedgeable_pairs
from relationships.semantic import embed_events_voyage, find_semantic_matches

logger = logging.getLogger(__name__)

STANDARDIZED_CATEGORIES = frozenset({
    "CRYPTO", "POLITICS", "SPORTS", "ECONOMICS", "ENTERTAINMENT",
    "SCIENCE", "TECHNOLOGY", "WEATHER", "LEGAL", "OTHER",
})

CANONICALIZE_BATCH_SIZE = 50
EMBED_BATCH_SIZE = 128

DEDUP_COSINE_THRESHOLD = 0.90
DEDUP_JACCARD_THRESHOLD = 0.80
DEDUP_EXPIRY_TOLERANCE_DAYS = 7
DEDUP_EXPIRY_TOLERANCE_HOURS = 1

MIN_CONFIDENCE = 0.70

import voyageai


@dataclasses.dataclass
class _EmbedCandidate:
    raw_titles: list[str]
    canonical_title: str
    category: str
    tags: list[str]
    expiry: str | None
    description: str | None
    text: str
    embedding: list[float] | None = None


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _generate_security_symbol(canonical_title: str, outcome_label: str) -> str:
    slug = re.sub(r'[^a-z0-9\s]', '', canonical_title.lower()).strip()
    slug = re.sub(r'\s+', '-', slug)[:80]
    outcome = re.sub(r'[^a-z0-9\s]', '', outcome_label.lower()).strip()
    outcome = re.sub(r'\s+', '-', outcome)
    return f"{slug}-{outcome}".upper()


def _from_dict(cls, data: dict):
    known = {f.name for f in dataclasses.fields(cls)}
    return cls(**{k: v for k, v in data.items() if k in known})


def _parse_canonical_result(item: dict, raw_title: str) -> dict:
    category = item.get("category", "OTHER")
    if category not in STANDARDIZED_CATEGORIES:
        category = "OTHER"
    tags = item.get("tags", [])
    if not isinstance(tags, list) or not (3 <= len(tags) <= 8):
        tags = []
    return {"title": item.get("title", raw_title), "category": category, "tags": tags}


def _expiry_close(a: str | None, b: str | None, tolerance: timedelta) -> bool:
    if a is None or b is None:
        return True
    try:
        da = datetime.fromisoformat(a.replace("Z", "+00:00"))
        db = datetime.fromisoformat(b.replace("Z", "+00:00"))
        return abs((da - db).total_seconds()) <= tolerance.total_seconds()
    except ValueError:
        return True


class Pipeline:

    def __init__(
        self,
        registry: RegistryClient,
        anthropic_client: anthropic.Anthropic,
        voyage_client: voyageai.Client,
        min_confidence: float = MIN_CONFIDENCE,
        max_contracts: int | None = None,
        skip_semantic: bool = False,
    ):
        self.registry = registry
        self.anthropic = anthropic_client
        self.voyage = voyage_client
        self.min_confidence = min_confidence
        self.max_contracts = max_contracts
        self.skip_semantic = skip_semantic

    def run(self) -> dict[str, int]:
        """Fetch from all adapters, create entities, then classify relationships."""
        exchanges = self.registry.get_exchange()
        exchange_by_name = {e.exchange_name.lower(): e for e in exchanges}

        all_contracts: list[AdapterContract] = []
        for adapter in ADAPTERS:
            exchange_name = adapter.exchange_name
            exchange = exchange_by_name.get(exchange_name)
            if not exchange:
                logger.warning("No exchange record found for adapter '%s' — skipping", exchange_name)
                continue
            try:
                contracts = adapter.fetch(exchange.exchange_id)
                logger.info("Fetched %d contracts from %s", len(contracts), exchange_name)
                all_contracts.extend(contracts)
            except Exception as e:
                logger.error("Failed to fetch from %s: %s", exchange_name, e)

        if self.max_contracts is not None:
            all_contracts = all_contracts[:self.max_contracts]
            logger.info("Limiting to %d contracts", len(all_contracts))

        entity_summary = self._create_entities(all_contracts, exchange_by_name)
        new_security_ids = entity_summary.pop("new_security_ids")
        embeddings = entity_summary.pop("embeddings")

        relationship_summary = self._classify_relationships(new_security_ids, embeddings)

        return {**entity_summary, **relationship_summary}

    def _create_entities(self, contracts: list[AdapterContract], exchange_by_name: dict) -> dict:
        if not contracts:
            return {
                "events_created": 0, "securities_created": 0, "listings_created": 0,
                "event_contracts_created": 0, "listing_specs_created": 0, "new_security_ids": [],
            }

        existing_events = self.registry.get_event()
        existing_securities = self.registry.get_security()
        existing_listings = self.registry.get_listing()
        existing_event_contracts = self.registry.get_event_contracts()
        currencies = self.registry.get_currency()
        existing_listing_specs = self.registry.get_listing_spec()

        currency_by_symbol = {c.symbol: c for c in currencies}
        exchange_name_by_id = {e.exchange_id: name for name, e in exchange_by_name.items()}
        listing_by_key = {f"{l.exchange_id}:{l.exchange_security_id}": l for l in existing_listings}
        event_contract_by_key = {f"{ec.event_id}:{ec.security_id}": ec for ec in existing_event_contracts}
        spec_by_listing_id = {s.listing_id: s for s in existing_listing_specs}

        contracts_by_raw_title: dict[str, list[AdapterContract]] = {}
        for c in contracts:
            contracts_by_raw_title.setdefault(c.event_title, []).append(c)

        existing_exchange_events = self.registry.get_exchange_events()
        exchange_event_by_key: dict[str, object] = {
            f"{ee.exchange_id}:{ee.native_event_id}": ee for ee in existing_exchange_events
        }

        event_id_by_raw: dict[str, int] = {}
        events_to_canonicalize = []
        for raw_title, group in contracts_by_raw_title.items():
            c = group[0]
            if c.exchange_event_native_id:
                key = f"{c.exchange_id}:{c.exchange_event_native_id}"
                ee = exchange_event_by_key.get(key)
                if ee:
                    event_id_by_raw[raw_title] = ee.event_id
                    continue
            events_to_canonicalize.append((raw_title, c.event_description, c.event_category))

        canonical_by_raw = self._canonicalize_events_batch(events_to_canonicalize)

        event_by_id = {ev.event_id: ev for ev in existing_events}
        for raw_title in list(event_id_by_raw):
            if raw_title not in canonical_by_raw:
                ev = event_by_id.get(event_id_by_raw[raw_title])
                if ev:
                    canonical_by_raw[raw_title] = {
                        "title": ev.title,
                        "category": ev.category or "OTHER",
                        "tags": ev.tags or [],
                    }

        existing_embeddings: dict[int, list[float]] = {
            ev.event_id: ev.embedding for ev in existing_events if ev.embedding
        }

        events_created = 0
        securities_created = 0
        listings_created = 0
        event_contracts_created = 0
        listing_specs_created = 0
        new_security_ids: list[int] = []

        created_event_records: list[tuple[str, str | None, int]] = [
            (ev.title, ev.expiry, ev.event_id) for ev in existing_events
        ]

        # Phase 1: title+expiry dedup; collect events that need embedding
        embed_candidates: list[_EmbedCandidate] = []
        for raw_title, canonical_info in canonical_by_raw.items():
            canonical_title = canonical_info["title"]
            category = canonical_info["category"]
            tags = canonical_info["tags"]
            group = contracts_by_raw_title[raw_title]
            expiry = group[0].event_expiry
            description = group[0].event_description

            existing_match_id = next(
                (eid for t, exp, eid in created_event_records
                 if t == canonical_title and _expiry_close(expiry, exp, timedelta(hours=DEDUP_EXPIRY_TOLERANCE_HOURS))),
                None,
            )
            if existing_match_id is not None:
                event_id_by_raw[raw_title] = existing_match_id
                continue

            candidate_match_idx = next(
                (idx for idx, cand in enumerate(embed_candidates)
                 if cand.canonical_title == canonical_title and _expiry_close(expiry, cand.expiry, timedelta(hours=DEDUP_EXPIRY_TOLERANCE_HOURS))),
                None,
            )
            if candidate_match_idx is not None:
                embed_candidates[candidate_match_idx].raw_titles.append(raw_title)
                continue

            text = canonical_title
            if description:
                text += ". " + description[:200]
            embed_candidates.append(_EmbedCandidate(
                raw_titles=[raw_title],
                canonical_title=canonical_title,
                category=category,
                tags=tags,
                expiry=expiry,
                description=description,
                text=text,
            ))

        # Phase 2: batch embed all candidates
        texts = [cand.text for cand in embed_candidates]
        for i in range(0, len(texts), EMBED_BATCH_SIZE):
            batch = texts[i:i + EMBED_BATCH_SIZE]
            try:
                result = self.voyage.embed(batch, model="voyage-3", input_type="document")
                for j, emb in enumerate(result.embeddings):
                    embed_candidates[i + j].embedding = emb
            except Exception as e:
                logger.warning("Batch embedding failed at offset %d: %s", i, e)

        # Phase 3: cosine dedup + Jaccard fallback + build pending_events
        pending_events: list[dict] = []
        pending_raw_to_event_idx: dict[str, int] = {}

        for cand in embed_candidates:
            matched_event_id = None

            if cand.embedding is not None:
                best_sim = 0.0
                best_eid = None
                for eid, emb in existing_embeddings.items():
                    sim = _cosine_similarity(cand.embedding, emb)
                    if sim > best_sim:
                        best_sim = sim
                        best_eid = eid
                if best_sim >= DEDUP_COSINE_THRESHOLD and best_eid is not None:
                    matched_event_id = best_eid

            if matched_event_id is None:
                norm_new = normalize_title(cand.canonical_title)
                for ev in existing_events:
                    if jaccard_similarity(norm_new, normalize_title(ev.title)) >= DEDUP_JACCARD_THRESHOLD:
                        if _expiry_close(cand.expiry, ev.expiry, timedelta(days=DEDUP_EXPIRY_TOLERANCE_DAYS)):
                            matched_event_id = ev.event_id
                            break

            if matched_event_id is not None:
                for raw_title in cand.raw_titles:
                    event_id_by_raw[raw_title] = matched_event_id
                created_event_records.append((cand.canonical_title, cand.expiry, matched_event_id))
                continue

            event_idx = len(pending_events)
            for raw_title in cand.raw_titles:
                pending_raw_to_event_idx[raw_title] = event_idx
            pending_events.append(dict(
                title=cand.canonical_title,
                description=cand.description,
                category=cand.category,
                tags=cand.tags,
                embedding=cand.embedding,
                expiry=cand.expiry,
            ))

        created_event_ids: list[int | None] = [None] * len(pending_events)
        if pending_events:
            try:
                created_list = self.registry.bulk_create_events(pending_events)
                events_created += len(created_list)
                for idx, created in enumerate(created_list):
                    new_eid = created["event_id"]
                    created_event_ids[idx] = new_eid
                    ev = pending_events[idx]
                    created_event_records.append((ev["title"], ev.get("expiry"), new_eid))
                    if ev.get("embedding"):
                        existing_embeddings[new_eid] = ev["embedding"]
            except Exception as e:
                logger.error("Bulk event creation failed: %s", e)

        for raw_title, event_idx in pending_raw_to_event_idx.items():
            eid = created_event_ids[event_idx] if event_idx < len(created_event_ids) else None
            if eid is not None:
                event_id_by_raw[raw_title] = eid

        pending_exchange_events: list[dict] = []
        for raw_title, group in contracts_by_raw_title.items():
            c = group[0]
            if not c.exchange_event_native_id:
                continue
            key = f"{c.exchange_id}:{c.exchange_event_native_id}"
            if key in exchange_event_by_key:
                continue
            eid = event_id_by_raw.get(raw_title)
            if eid is None:
                continue
            pending_exchange_events.append(dict(
                exchange_id=c.exchange_id,
                event_id=eid,
                native_event_id=c.exchange_event_native_id,
                raw_title=raw_title,
            ))
            exchange_event_by_key[key] = True

        if pending_exchange_events:
            try:
                self.registry.bulk_create_exchange_events(pending_exchange_events)
            except Exception as e:
                logger.error("Bulk exchange_event creation failed: %s", e)

        all_currency_symbols = (
            {c.base_currency for c in contracts}
            | {c.quote_currency for c in contracts}
            | {c.settle_currency for c in contracts}
        )
        for sym in all_currency_symbols:
            if sym not in currency_by_symbol:
                try:
                    created_curr = self.registry._post("/currencies", {"symbol": sym})
                    currency_by_symbol[sym] = _from_dict(Currency, created_curr)
                except Exception as e:
                    logger.error("Failed to create currency '%s': %s", sym, e)

        security_id_by_symbol: dict[str, int] = {s.symbol: s.security_id for s in existing_securities}
        security_id_by_outcome: dict[tuple[str, str], int] = {}

        seen_symbols: dict[str, AdapterContract] = {}
        for c in contracts:
            symbol = _generate_security_symbol(canonical_by_raw[c.event_title]["title"], c.outcome_label)
            if symbol not in seen_symbols:
                seen_symbols[symbol] = c

        pending_securities: list[dict] = []
        pending_security_symbols: list[str] = []
        pending_security_outcomes: list[tuple[str, str]] = []

        for symbol, c in seen_symbols.items():
            canonical_info = canonical_by_raw[c.event_title]
            if symbol in security_id_by_symbol:
                security_id_by_outcome[(c.event_title, c.outcome_label)] = security_id_by_symbol[symbol]
                continue

            base_ccy = currency_by_symbol.get(c.base_currency)
            quote_ccy = currency_by_symbol.get(c.quote_currency)
            settle_ccy = currency_by_symbol.get(c.settle_currency)

            pending_securities.append(dict(
                symbol=symbol,
                type=SecurityType.EVENT_CONTRACT,
                contract_type=c.contract_type,
                asset_class=c.asset_class,
                base_currency_id=base_ccy.currency_id if base_ccy else None,
                quote_currency_id=quote_ccy.currency_id if quote_ccy else None,
                settle_currency_id=settle_ccy.currency_id if settle_ccy else None,
                inverse=c.inverse,
                quanto=c.is_quanto,
                expiry=c.event_expiry,
                active=True,
            ))
            pending_security_symbols.append(symbol)
            pending_security_outcomes.append((c.event_title, c.outcome_label))

        if pending_securities:
            try:
                created_list = self.registry.bulk_create_securities(pending_securities)
                securities_created += len(created_list)
                for idx, created in enumerate(created_list):
                    new_sid = created["security_id"]
                    security_id_by_symbol[pending_security_symbols[idx]] = new_sid
                    security_id_by_outcome[pending_security_outcomes[idx]] = new_sid
                    new_security_ids.append(new_sid)
            except Exception as e:
                logger.error("Bulk security creation failed: %s", e)

        pending_listings: list[dict] = []
        pending_listing_keys: list[str] = []

        for c in contracts:
            key = f"{c.exchange_id}:{c.exchange_security_id}"
            if key in listing_by_key:
                continue
            sid = security_id_by_outcome.get((c.event_title, c.outcome_label))
            if sid is None:
                continue

            listing_by_key[key] = None  # sentinel to prevent duplicate queuing
            pending_listings.append(dict(
                exchange_id=c.exchange_id,
                security_id=sid,
                exchange_security_id=c.exchange_security_id,
                exchange_security_symbol=c.exchange_security_symbol,
            ))
            pending_listing_keys.append(key)

        if pending_listings:
            try:
                created_list = self.registry.bulk_create_listings(pending_listings)
                listings_created += len(created_list)
                for idx, created in enumerate(created_list):
                    listing_by_key[pending_listing_keys[idx]] = _from_dict(Listing, created)
            except Exception as e:
                logger.error("Bulk listing creation failed: %s", e)

        pending_ecs: list[dict] = []
        pending_ec_keys: list[str] = []

        for c in contracts:
            event_id = event_id_by_raw.get(c.event_title)
            sid = security_id_by_outcome.get((c.event_title, c.outcome_label))
            if event_id is None or sid is None:
                continue
            ec_key = f"{event_id}:{sid}"
            if ec_key in event_contract_by_key:
                continue

            event_contract_by_key[ec_key] = None  # sentinel to prevent duplicate queuing
            pending_ecs.append(dict(
                event_id=event_id,
                security_id=sid,
                outcome_label=c.outcome_label,
            ))
            pending_ec_keys.append(ec_key)

        if pending_ecs:
            try:
                created_list = self.registry.bulk_create_event_contracts(pending_ecs)
                event_contracts_created += len(created_list)
                for idx, created in enumerate(created_list):
                    event_contract_by_key[pending_ec_keys[idx]] = _from_dict(EventContract, created)
            except Exception as e:
                logger.error("Bulk event_contract creation failed: %s", e)

        self._link_complements(contracts, canonical_by_raw, event_id_by_raw, security_id_by_outcome, event_contract_by_key)

        pending_specs: list[dict] = []

        for c in contracts:
            key = f"{c.exchange_id}:{c.exchange_security_id}"
            listing = listing_by_key.get(key)
            if listing is None:
                continue
            listing_id = listing.listing_id if hasattr(listing, "listing_id") else listing["listing_id"]
            if listing_id in spec_by_listing_id:
                continue

            spec_by_listing_id[listing_id] = True  # sentinel to prevent duplicate queuing
            pending_specs.append(dict(
                listing_id=listing_id,
                tick_size=c.tick_size,
                lot_size=c.lot_size,
                min_notional=c.min_notional,
                contract_multiplier=c.contract_multiplier,
            ))

        if pending_specs:
            try:
                created_list = self.registry.bulk_create_listing_specs(pending_specs)
                listing_specs_created += len(created_list)
            except Exception as e:
                logger.error("Bulk listing_spec creation failed: %s", e)

        return {
            "events_created": events_created,
            "securities_created": securities_created,
            "listings_created": listings_created,
            "event_contracts_created": event_contracts_created,
            "listing_specs_created": listing_specs_created,
            "new_security_ids": new_security_ids,
            "embeddings": existing_embeddings,
        }

    def _link_complements(
        self,
        contracts: list[AdapterContract],
        canonical_by_raw: dict[str, dict],
        event_id_by_raw: dict[str, int],
        security_id_by_outcome: dict[tuple[str, str], int],
        event_contract_by_key: dict[str, EventContract],
    ) -> None:
        outcomes_by_event: dict[str, list[str]] = defaultdict(list)
        seen: dict[str, set[str]] = defaultdict(set)
        for c in contracts:
            if c.outcome_label not in seen[c.event_title]:
                outcomes_by_event[c.event_title].append(c.outcome_label)
                seen[c.event_title].add(c.outcome_label)

        for raw_title, outcomes in outcomes_by_event.items():
            if len(outcomes) != 2:
                continue
            event_id = event_id_by_raw.get(raw_title)
            if event_id is None:
                continue
            for i, outcome in enumerate(outcomes):
                complement_outcome = outcomes[1 - i]
                sid = security_id_by_outcome.get((raw_title, outcome))
                complement_sid = security_id_by_outcome.get((raw_title, complement_outcome))
                if sid is None or complement_sid is None:
                    continue
                ec = event_contract_by_key.get(f"{event_id}:{sid}")
                if ec is None or ec.complement_security_id is not None:
                    continue
                try:
                    self.registry.patch_event_contract(ec.event_contract_id, complement_security_id=complement_sid)
                except Exception as e:
                    logger.warning("Failed to set complement for event_contract_id=%d: %s", ec.event_contract_id, e)

    def _canonicalize_events_batch(
        self,
        events: list[tuple[str, str | None, str | None]],
    ) -> dict[str, dict[str, Any]]:
        results: dict[str, dict] = {}
        categories_str = ", ".join(sorted(STANDARDIZED_CATEGORIES))

        for i in range(0, len(events), CANONICALIZE_BATCH_SIZE):
            batch = events[i:i + CANONICALIZE_BATCH_SIZE]
            event_lines = "\n".join(
                f"[{j + 1}] Title: {raw_title} | Description: {(desc or '')[:200]} | Category: {cat or ''}"
                for j, (raw_title, desc, cat) in enumerate(batch)
            )
            prompt = f"""You are standardizing prediction market events for a cross-exchange registry.

For each event below, generate:
1. title: Clean, exchange-neutral, concise title for this prediction market question
2. category: One of {categories_str}
3. tags: 3-8 lowercase keyword tags

Events:
{event_lines}

Respond with a JSON array in the same order, one object per event:
[{{"title": "...", "category": "...", "tags": ["..."]}}, ...]"""

            batch_results = None
            try:
                response = self.anthropic.messages.create(
                    model="claude-haiku-4-5-20251001",
                    max_tokens=250 * len(batch),
                    messages=[{"role": "user", "content": prompt}],
                )
                text = response.content[0].text.strip()
                if text.startswith("```"):
                    text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
                parsed = json.loads(text)
                if isinstance(parsed, list) and len(parsed) == len(batch):
                    batch_results = parsed
                else:
                    logger.warning("Batch canonicalization returned wrong length (expected %d, got %d)", len(batch), len(parsed) if isinstance(parsed, list) else -1)
            except Exception as e:
                logger.warning("Batch canonicalization failed at offset %d: %s", i, e)

            if batch_results is not None:
                for j, (raw_title, _, _) in enumerate(batch):
                    results[raw_title] = _parse_canonical_result(batch_results[j], raw_title)
            else:
                for raw_title, desc, cat in batch:
                    results[raw_title] = self._canonicalize_event(raw_title, desc, cat)

        return results

    def _canonicalize_event(
        self,
        raw_title: str,
        description: str | None,
        exchange_category: str | None,
    ) -> dict:
        prompt = f"""You are standardizing a prediction market event for a cross-exchange registry.

Exchange-provided title: {raw_title}
Description: {description or ''}
Exchange category: {exchange_category or ''}

Generate:
1. title: Clean, exchange-neutral, concise title for this prediction market question.
2. category: One of {', '.join(sorted(STANDARDIZED_CATEGORIES))}
3. tags: 3-8 lowercase keyword tags

Respond with JSON only: {{"title": "...", "category": "...", "tags": ["..."]}}"""

        try:
            response = self.anthropic.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=200,
                messages=[{"role": "user", "content": prompt}],
            )
            result = json.loads(response.content[0].text.strip())
            return _parse_canonical_result(result, raw_title)
        except Exception as e:
            logger.warning("Canonicalization failed for '%s': %s", raw_title, e)
            return {"title": raw_title, "category": "OTHER", "tags": []}

    def _classify_relationships(self, new_security_ids: list[int], precomputed_embeddings: dict[int, list[float]]) -> dict[str, int]:
        events = self.registry.get_event()
        event_contracts = self.registry.get_event_contracts()
        securities = self.registry.get_security()
        currencies = self.registry.get_currency()
        existing_relationships = self.registry.get_contract_relationships()

        existing_pairs: set[tuple[int, int]] = {
            (rel.security_id_a, rel.security_id_b)
            for rel in existing_relationships
            if rel.method != "manual"
        }

        new_sids = set(new_security_ids)
        new_event_ids: set[int] | None = None
        if new_sids:
            new_event_ids = {ec.event_id for ec in event_contracts if ec.security_id in new_sids}

        pending: list[tuple[int, int, str, float, str]] = []

        complement_pairs = find_complement_pairs(event_contracts)
        for sid_a, sid_b in complement_pairs:
            pending.append((sid_a, sid_b, "COMPLEMENT", STRUCTURAL_CONFIDENCE, "structural"))

        me_sets = find_mutually_exclusive_sets(event_contracts)
        for group in me_sets:
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    sid_a, sid_b = min(group[i], group[j]), max(group[i], group[j])
                    pending.append((sid_a, sid_b, "MUTUALLY_EXCLUSIVE", STRUCTURAL_CONFIDENCE, "structural"))

        rule_equiv = find_rule_based_equivalents(events, event_contracts, set(), new_event_ids=new_event_ids)
        for sid_a, sid_b, conf, method in rule_equiv:
            pending.append((sid_a, sid_b, "EQUIVALENT", conf, method))

        hedgeable = find_hedgeable_pairs(event_contracts, events, securities, currencies)
        for sid_a, sid_b, conf, method in hedgeable:
            pending.append((sid_a, sid_b, "HEDGEABLE_WITH", conf, method))

        try:
            embeddings = embed_events_voyage(self.voyage, events, precomputed=precomputed_embeddings)
        except Exception as e:
            logger.error("Embedding failed: %s", e)
            embeddings = precomputed_embeddings or {}

        semantic = find_semantic_matches(self.anthropic, events, event_contracts, embeddings, new_event_ids=new_event_ids, skip_judgment=self.skip_semantic)
        logger.debug("semantic matches: %d", len(semantic))
        pending.extend(semantic)
        logger.debug("pending total: %d, new_sids: %d, embeddings: %d", len(pending), len(new_sids), len(embeddings))

        best: dict[tuple[int, int], tuple[str, float, str]] = {}
        for sid_a, sid_b, rel_type, conf, method in pending:
            if new_sids and sid_a not in new_sids and sid_b not in new_sids:
                continue
            pair = (sid_a, sid_b)
            if pair in existing_pairs:
                continue
            if pair not in best or conf > best[pair][1]:
                best[pair] = (rel_type, conf, method)
        logger.debug("best after dedup: %d", len(best))

        written = 0
        skipped_low_confidence = 0
        errors = 0
        pending_rels: list[dict] = []

        for (sid_a, sid_b), (rel_type, conf, method) in best.items():
            if conf < self.min_confidence:
                skipped_low_confidence += 1
                continue
            pending_rels.append(dict(
                security_id_a=sid_a,
                security_id_b=sid_b,
                relationship_type=rel_type,
                confidence=conf,
                method=method,
            ))

        if pending_rels:
            try:
                created_list = self.registry.bulk_create_contract_relationships(pending_rels)
                written += len(created_list)
            except Exception as e:
                logger.error("Bulk relationship creation failed: %s", e)
                errors += len(pending_rels)

        return {
            "relationships_written": written,
            "relationships_skipped_low_confidence": skipped_low_confidence,
            "relationship_errors": errors,
        }
