export const SecurityType = {
  SPOT: 0,
  PERPETUAL: 1,
  FUTURE: 2,
  OPTION: 3,
} as const;

export const ContractType = {
  NONE: 0,
  LINEAR_PERPETUAL: 1,
  INVERSE_PERPETUAL: 2,
  LINEAR_FUTURE: 3,
  INVERSE_FUTURE: 4,
  CALL_OPTION: 5,
  PUT_OPTION: 6,
} as const;

export const AssetClass = {
  CRYPTO: 0,
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
