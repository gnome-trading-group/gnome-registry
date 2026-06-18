export const SecurityType = {
  SPOT: 0,
  PERPETUAL: 1,
  FUTURE: 2,
  OPTION: 3,
  EVENT_CONTRACT: 4,
} as const;

export const ContractType = {
  NONE: 0,
  LINEAR_PERPETUAL: 1,
  INVERSE_PERPETUAL: 2,
  LINEAR_FUTURE: 3,
  INVERSE_FUTURE: 4,
  CALL_OPTION: 5,
  PUT_OPTION: 6,
  BINARY: 7,
  MULTI_OUTCOME: 8,
} as const;

export const AssetClass = {
  CRYPTO: 0,
  EQUITY: 1,
  COMMODITY: 2,
  FX: 3,
  INDEX: 4,
  PREDICTION: 5,
} as const;

// Data returned by each exchange adapter per discovered security
export interface ExchangeSecurityData {
  baseCurrency: string;
  quoteCurrency: string;
  settleCurrency: string;
  securitySymbol: string;
  securityType: number;
  contractType: number;
  assetClass: number;
  inverse: boolean;
  isQuanto: boolean;
  exchangeSecurityId: string;
  exchangeSecuritySymbol: string;
  tickSize: number;
  lotSize: number;
  minNotional: number;
  contractMultiplier: number;
  // Prediction market fields (optional)
  eventTitle?: string;
  eventDescription?: string;
  eventCategory?: string;
  eventExpiry?: string;        // ISO 8601 timestamp
  outcomeLabel?: string;       // e.g. "Yes", "No", "Trump wins"
  complementExchangeSecurityId?: string;  // exchangeSecurityId of the opposing contract
}

export interface ExchangeAdapter {
  fetchSecurities(): Promise<ExchangeSecurityData[]>;
}

// Registry API response types
export interface ExchangeResponse {
  exchange_id: number;
  exchange_name: string;
}

export interface CurrencyResponse {
  currency_id: number;
  symbol: string;
  name?: string;
  decimals: number;
}

export interface SecurityResponse {
  security_id: number;
  symbol: string;
}

export interface ListingResponse {
  listing_id: number;
  exchange_id: number;
  security_id: number;
  exchange_security_id: string;
  exchange_security_symbol: string;
}

export interface ListingSpecResponse {
  listing_id: number;
  tick_size: number;
  lot_size: number;
  min_notional: number;
  contract_multiplier: number;
}

export interface EventResponse {
  event_id: number;
  title: string;
  description?: string;
  category?: string;
  resolution_source?: string;
  tags?: string[];
  embedding?: number[];
  resolved: boolean;
  resolved_at?: string;
  expiry?: string;
}

export interface EventContractResponse {
  event_contract_id: number;
  event_id: number;
  security_id: number;
  outcome_label: string;
  complement_security_id?: number;
}
