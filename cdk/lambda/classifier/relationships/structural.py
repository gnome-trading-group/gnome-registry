from collections import defaultdict

from gnomepy.registry.types import EventContract

STRUCTURAL_CONFIDENCE = 0.95


def find_complement_pairs(
    event_contracts: list[EventContract],
) -> list[tuple[int, int]]:
    by_event: dict[int, list[EventContract]] = defaultdict(list)
    for ec in event_contracts:
        by_event[ec.event_id].append(ec)

    pairs: list[tuple[int, int]] = []
    for contracts in by_event.values():
        if len(contracts) == 2:
            a, b = contracts[0], contracts[1]
            pairs.append((min(a.security_id, b.security_id), max(a.security_id, b.security_id)))
    return pairs


def find_mutually_exclusive_sets(
    event_contracts: list[EventContract],
) -> list[list[int]]:
    by_event: dict[int, list[int]] = defaultdict(list)
    for ec in event_contracts:
        by_event[ec.event_id].append(ec.security_id)
    return [ids for ids in by_event.values() if len(ids) >= 2]
