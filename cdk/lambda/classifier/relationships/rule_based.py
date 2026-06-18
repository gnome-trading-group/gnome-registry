from collections import defaultdict
from datetime import datetime

from normalize import (
    normalize_title,
    normalize_outcome_label,
    jaccard_similarity,
)
from gnomepy.registry.types import Currency, Event, EventContract, Security, SecurityType

EQUIVALENT_CONFIDENCE_BASE = 0.85
HEDGEABLE_WITH_CONFIDENCE = 0.90

EXPIRY_TOLERANCE_DAYS = 7
JACCARD_THRESHOLD = 0.90


def _expiry_within_tolerance(expiry_a: str | None, expiry_b: str | None, tolerance_days: int) -> bool:
    if expiry_a is None or expiry_b is None:
        return True
    try:
        da = datetime.fromisoformat(expiry_a.replace("Z", "+00:00"))
        db = datetime.fromisoformat(expiry_b.replace("Z", "+00:00"))
        return abs((da - db).days) <= tolerance_days
    except ValueError:
        return True


def find_rule_based_equivalents(
    events: list[Event],
    event_contracts: list[EventContract],
    existing_security_ids: set[int],
    new_event_ids: set[int] | None = None,
) -> list[tuple[int, int, float, str]]:
    by_event: dict[int, list[EventContract]] = defaultdict(list)
    for ec in event_contracts:
        by_event[ec.event_id].append(ec)

    event_by_id = {e.event_id: e for e in events}
    event_ids = [e.event_id for e in events if e.event_id in by_event]
    matches: list[tuple[int, int, float, str]] = []

    for i in range(len(event_ids)):
        for j in range(i + 1, len(event_ids)):
            eid_a, eid_b = event_ids[i], event_ids[j]
            ev_a, ev_b = event_by_id[eid_a], event_by_id[eid_b]

            if new_event_ids is not None and eid_a not in new_event_ids and eid_b not in new_event_ids:
                continue
            if ev_a.category and ev_b.category and ev_a.category != ev_b.category:
                continue

            norm_a = normalize_title(ev_a.title)
            norm_b = normalize_title(ev_b.title)
            similarity = jaccard_similarity(norm_a, norm_b)

            if similarity < JACCARD_THRESHOLD:
                continue
            if not _expiry_within_tolerance(ev_a.expiry, ev_b.expiry, EXPIRY_TOLERANCE_DAYS):
                continue

            confidence = EQUIVALENT_CONFIDENCE_BASE + (similarity - JACCARD_THRESHOLD) * 0.5
            confidence = min(confidence, 0.92)

            contracts_a = by_event[eid_a]
            contracts_b = by_event[eid_b]
            if len(contracts_a) != len(contracts_b):
                continue

            label_to_a = {normalize_outcome_label(ec.outcome_label): ec.security_id for ec in contracts_a}
            for ec_b in contracts_b:
                label = normalize_outcome_label(ec_b.outcome_label)
                if label in label_to_a:
                    sid_a = label_to_a[label]
                    sid_b = ec_b.security_id
                    matches.append((min(sid_a, sid_b), max(sid_a, sid_b), confidence, "rule"))

    return matches


def find_hedgeable_pairs(
    event_contracts: list[EventContract],
    events: list[Event],
    existing_securities: list[Security],
    currencies: list[Currency],
) -> list[tuple[int, int, float, str]]:
    event_by_id = {e.event_id: e for e in events}

    # Build keyword -> currency_id map from registry currencies
    currency_by_id = {c.currency_id: c for c in currencies}
    keyword_to_currency_id: dict[str, int] = {}
    for c in currencies:
        keyword_to_currency_id[c.symbol.lower()] = c.currency_id
        if c.name:
            keyword_to_currency_id[c.name.lower()] = c.currency_id

    # Index tradeable securities by all keywords matching their base currency
    securities_by_keyword: dict[str, list[Security]] = {}
    for sec in existing_securities:
        if sec.type == SecurityType.EVENT_CONTRACT or sec.base_currency_id is None:
            continue
        currency = currency_by_id.get(sec.base_currency_id)
        if currency is None:
            continue
        keywords = {currency.symbol.lower()}
        if currency.name:
            keywords.add(currency.name.lower())
        for kw in keywords:
            securities_by_keyword.setdefault(kw, []).append(sec)

    all_keywords = set(securities_by_keyword)
    matches: list[tuple[int, int, float, str]] = []
    for ec in event_contracts:
        event = event_by_id.get(ec.event_id)
        if event is None:
            continue
        text = (event.title + " " + ec.outcome_label).lower()
        for kw in all_keywords:
            if kw in text:
                for tradeable_sec in securities_by_keyword[kw]:
                    matches.append((ec.security_id, tradeable_sec.security_id, HEDGEABLE_WITH_CONFIDENCE, "rule"))

    return matches
