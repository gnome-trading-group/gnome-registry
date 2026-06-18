import json
import logging
import math
from collections import defaultdict


import anthropic
import voyageai

from gnomepy.registry.types import Event, EventContract

logger = logging.getLogger(__name__)

EMBEDDING_SIMILARITY_THRESHOLD = 0.80

VALID_RELATIONSHIP_TYPES = {
    "EQUIVALENT", "IMPLIES", "CORRELATED", "MUTUALLY_EXCLUSIVE", "NONE",
}

MODEL = "claude-sonnet-4-6"

_JUDGE_SYSTEM_PROMPT = """You are classifying relationships between specific prediction market contracts for trading purposes.

For each pair of contracts (one from A, one from B) that has a meaningful trading relationship, return an entry. Use these types:
- EQUIVALENT: Same question worded differently (direct arbitrage)
- IMPLIES: Contract A[i] being true logically implies contract B[j] must be true. Use "direction": "B_IMPLIES_A" if the reverse.
- CORRELATED: Same underlying asset/entity, outcomes tend to move together but neither strictly implies the other. Different assets are NEVER CORRELATED (BTC and ETH are NONE).
- MUTUALLY_EXCLUSIVE: Both contracts CANNOT BOTH RESOLVE YES — they are logically incompatible outcomes (e.g., "Candidate A wins" and "Candidate B wins" in the same race). Do NOT use this for contracts that merely seem like opposites but can both resolve as stated — e.g., "election called by June 30 — No" and "election called by December 31 — Yes" CAN both be true (election called in September), so they are NOT mutually exclusive.

- NONE / omit: No meaningful trading relationship

Most pairs are unrelated — only include pairs with genuine trading signal. Return [] if none.

Respond with a JSON array only:
[{"a": 1, "b": 1, "type": "EQUIVALENT", "confidence": 0.95}, ...]
For IMPLIES entries add "direction": "A_IMPLIES_B" or "B_IMPLIES_A".
Only output the JSON array, nothing else."""



def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def embed_events_voyage(
    voyage_client: voyageai.Client,
    events: list[Event],
    precomputed: dict[int, list[float]] | None = None,
) -> dict[int, list[float]]:
    embeddings: dict[int, list[float]] = dict(precomputed) if precomputed else {}
    texts = []
    ids_to_embed = []
    for event in events:
        if event.event_id in embeddings:
            continue
        if event.embedding:
            embeddings[event.event_id] = event.embedding
            continue
        text = event.title
        if event.description:
            text += ". " + event.description[:200]
        texts.append(text)
        ids_to_embed.append(event.event_id)

    for i in range(0, len(texts), 128):
        batch_texts = texts[i:i + 128]
        batch_ids = ids_to_embed[i:i + 128]
        result = voyage_client.embed(batch_texts, model="voyage-3", input_type="document")  # type: ignore[attr-defined]
        for eid, emb in zip(batch_ids, result.embeddings):
            embeddings[eid] = emb

    return embeddings


def find_semantic_matches(
    anthropic_client: anthropic.Anthropic,
    events: list[Event],
    event_contracts: list[EventContract],
    embeddings: dict[int, list[float]],
    new_event_ids: set[int] | None = None,
    skip_judgment: bool = False,
) -> list[tuple[int, int, str, float, str]]:
    by_event: dict[int, list[EventContract]] = defaultdict(list)
    for ec in event_contracts:
        by_event[ec.event_id].append(ec)

    event_by_id = {e.event_id: e for e in events}
    event_ids = [e.event_id for e in events if e.event_id in embeddings and e.event_id in by_event]
    matches: list[tuple[int, int, str, float, str]] = []
    would_judge_count = 0

    for i in range(len(event_ids)):
        for j in range(i + 1, len(event_ids)):
            eid_a, eid_b = event_ids[i], event_ids[j]

            if new_event_ids is not None and eid_a not in new_event_ids and eid_b not in new_event_ids:
                continue

            try:
                ev_a, ev_b = event_by_id[eid_a], event_by_id[eid_b]
                if ev_a.category and ev_b.category and ev_a.category != ev_b.category:
                    continue

                similarity = _cosine_similarity(embeddings[eid_a], embeddings[eid_b])

                if similarity < EMBEDDING_SIMILARITY_THRESHOLD:
                    continue

                contracts_a = by_event[eid_a]
                contracts_b = by_event[eid_b]

                if skip_judgment:
                    would_judge_count += 1
                    logger.info(
                        "Would judge: '%s' vs '%s' (similarity=%.3f, %d×%d contracts)",
                        ev_a.title, ev_b.title, similarity, len(contracts_a), len(contracts_b),
                    )
                    continue
                contract_matches = _judge_relationship(
                    anthropic_client, ev_a, ev_b, contracts_a, contracts_b, similarity
                )
                matches.extend((sa, sb, rt, conf, "embedding") for sa, sb, rt, conf in contract_matches)
            except Exception as e:
                logger.error("Failed comparing events %d and %d: %s", eid_a, eid_b, e)

    if skip_judgment:
        logger.info("skip_judgment: would have called Claude %d times", would_judge_count)

    return matches


def _judge_relationship(
    client: anthropic.Anthropic,
    event_a: Event,
    event_b: Event,
    contracts_a: list[EventContract],
    contracts_b: list[EventContract],
    similarity: float,
) -> list[tuple[int, int, str, float]]:
    """Returns list of (sid_a, sid_b, rel_type, confidence) for related contract pairs.
    For IMPLIES, sid_a is always the antecedent and sid_b the consequent.
    For symmetric types, sid_a < sid_b."""
    yes_a = [ec for ec in contracts_a if ec.outcome_label.lower() != "no"]
    yes_b = [ec for ec in contracts_b if ec.outcome_label.lower() != "no"]
    if not yes_a or not yes_b:
        return []

    complement_of: dict[int, int] = {}
    for ec in contracts_a + contracts_b:
        if ec.complement_security_id is not None:
            complement_of[ec.security_id] = ec.complement_security_id

    contracts_a_lines = "  ".join(f"[{i+1}] {ec.outcome_label}" for i, ec in enumerate(yes_a))
    contracts_b_lines = "  ".join(f"[{i+1}] {ec.outcome_label}" for i, ec in enumerate(yes_b))

    user_content = (
        f"Event A: {event_a.title}\n"
        f"  Contracts: {contracts_a_lines}\n\n"
        f"Event B: {event_b.title}\n"
        f"  Contracts: {contracts_b_lines}\n\n"
        f"Embedding similarity: {similarity:.3f}"
    )

    logger.debug("judge_relationship user message:\n%s", user_content)

    response = client.messages.create(
        model=MODEL,
        max_tokens=300,
        system=[{"type": "text", "text": _JUDGE_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_content}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    logger.debug("judge_relationship response: %s", raw)

    idx_to_sid_a = {i + 1: ec.security_id for i, ec in enumerate(yes_a)}
    idx_to_sid_b = {i + 1: ec.security_id for i, ec in enumerate(yes_b)}
    logger.debug("idx_to_sid_a: %s  idx_to_sid_b: %s", idx_to_sid_a, idx_to_sid_b)

    try:
        items = json.loads(raw)
        if not isinstance(items, list):
            logger.debug("response is not a list: %r", items)
            return []
        results: list[tuple[int, int, str, float]] = []
        for item in items:
            idx_a = item.get("a")
            idx_b = item.get("b")
            rel_type = item.get("type", "NONE")
            confidence = float(item.get("confidence", 0.70))
            if idx_a not in idx_to_sid_a or idx_b not in idx_to_sid_b:
                logger.debug("skipping item (index out of range): %s", item)
                continue
            if rel_type not in VALID_RELATIONSHIP_TYPES or rel_type == "NONE":
                logger.debug("skipping item (invalid type): %s", item)
                continue
            if confidence < 0.70:
                logger.debug("skipping item (low confidence): %s", item)
                continue
            sid_a = idx_to_sid_a[idx_a]
            sid_b = idx_to_sid_b[idx_b]
            if rel_type == "IMPLIES" and item.get("direction") == "B_IMPLIES_A":
                results.append((sid_b, sid_a, rel_type, confidence))
            elif rel_type == "IMPLIES":
                results.append((sid_a, sid_b, rel_type, confidence))
            else:
                results.append((min(sid_a, sid_b), max(sid_a, sid_b), rel_type, confidence))

        derived: list[tuple[int, int, str, float]] = []
        for sid_a, sid_b, rel_type, conf in results:
            comp_a = complement_of.get(sid_a)
            comp_b = complement_of.get(sid_b)
            if comp_a is None or comp_b is None:
                continue
            if rel_type == "IMPLIES":
                derived.append((comp_b, comp_a, rel_type, conf))
            elif rel_type == "EQUIVALENT":
                derived.append((min(comp_a, comp_b), max(comp_a, comp_b), rel_type, conf))
            elif rel_type == "CORRELATED":
                derived.append((min(comp_a, comp_b), max(comp_a, comp_b), rel_type, conf))
        results.extend(derived)

        logger.debug("judge_relationship returning %d results (%d derived)", len(results), len(derived))
        return results
    except (json.JSONDecodeError, KeyError, ValueError, TypeError) as e:
        logger.debug("judge_relationship parse error: %s — raw: %r", e, raw)
        return []
