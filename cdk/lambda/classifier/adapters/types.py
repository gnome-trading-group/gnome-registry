from dataclasses import dataclass


@dataclass
class AdapterContract:
    exchange_id: int
    exchange_security_id: str
    exchange_security_symbol: str
    base_currency: str
    quote_currency: str
    settle_currency: str
    security_type: int
    contract_type: int
    asset_class: int
    inverse: bool
    is_quanto: bool
    tick_size: float
    lot_size: float
    min_notional: float
    contract_multiplier: float
    event_title: str
    outcome_label: str
    event_description: str | None = None
    event_category: str | None = None
    event_expiry: str | None = None
    exchange_event_native_id: str | None = None
