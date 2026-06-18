import re

_STOP_WORDS = frozenset({
    "will", "the", "a", "an", "in", "of", "for", "to", "be", "is", "are",
    "was", "were", "on", "at", "by", "with", "from", "that", "this", "or",
    "and", "not", "no", "who", "what", "when", "where", "which", "how",
    "does", "do", "did", "has", "have", "had", "if", "than",
})

_SYNONYMS: dict[str, str] = {
    "gop": "republican",
    "dem": "democrat",
    "democratic": "democrat",
    "dems": "democrat",
    "democrats": "democrat",
    "republicans": "republican",
    "gop's": "republican",
    "prez": "president",
    "potus": "president",
    "vp": "vice president",
    "btc": "bitcoin",
    "eth": "ethereum",
}

_YEAR_PATTERN = re.compile(r'\b(20\d\d)\b')
_MONTH_NAMES = {
    "january": "01", "february": "02", "march": "03", "april": "04",
    "may": "05", "june": "06", "july": "07", "august": "08",
    "september": "09", "october": "10", "november": "11", "december": "12",
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "jun": "06", "jul": "07", "aug": "08", "sep": "09",
    "oct": "10", "nov": "11", "dec": "12",
}


def normalize_title(title: str) -> str:
    text = title.lower()
    text = re.sub(r"[^\w\s]", " ", text)
    tokens = text.split()
    tokens = [_SYNONYMS.get(t, t) for t in tokens]
    tokens = [t for t in tokens if t not in _STOP_WORDS and len(t) > 1]
    return " ".join(tokens)


def normalize_outcome_label(label: str) -> str:
    text = label.lower().strip()
    text = re.sub(r"[^\w\s]", " ", text)
    tokens = text.split()
    tokens = [_SYNONYMS.get(t, t) for t in tokens]
    return " ".join(tokens)


def jaccard_similarity(a: str, b: str) -> float:
    set_a = set(a.split())
    set_b = set(b.split())
    if not set_a and not set_b:
        return 1.0
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


def parse_numeric_threshold(title: str) -> tuple[str | None, float | None, str | None]:
    """
    Extract (underlying, threshold, direction) from titles like:
    'BTC above $150,000 by end of 2025' → ('bitcoin', 150000.0, 'above')
    Returns (None, None, None) if no threshold pattern found.
    """
    text = title.lower()
    text = re.sub(r"[,$]", "", text)
    text = text.replace("k", "000").replace("m", "000000")

    direction = None
    if any(w in text for w in ("above", "exceed", "over", "higher than", "greater than", ">", "beat")):
        direction = "above"
    elif any(w in text for w in ("below", "under", "lower than", "less than", "<")):
        direction = "below"

    if direction is None:
        return None, None, None

    nums = re.findall(r'\b(\d+(?:\.\d+)?)\b', text)
    if not nums:
        return None, None, None

    threshold = max(float(n) for n in nums)
    if threshold < 100:
        return None, None, None

    underlying = None
    for asset, canonical in _SYNONYMS.items():
        if asset in text:
            underlying = canonical
            break
    for token in ["bitcoin", "ethereum", "solana", "bnb", "xrp", "trump", "biden", "harris"]:
        if token in text:
            underlying = token
            break

    return underlying, threshold, direction
