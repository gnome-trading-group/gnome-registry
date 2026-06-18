from adapters.hyperliquid import HyperliquidAdapter
from adapters.kalshi import KalshiAdapter
from adapters.polymarket import PolymarketAdapter

ADAPTERS = [
    PolymarketAdapter(),
    KalshiAdapter(),
    HyperliquidAdapter(),
]
