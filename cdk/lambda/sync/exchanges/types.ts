export interface ListingSpecData {
  tickSize: number;
  lotSize: number;
  minNotional: number;
}

export interface Listing {
  listing_id: number;
  exchange_id: number;
  security_id: number;
  exchange_security_id: string;
  exchange_security_symbol: string;
}

export interface Security {
  security_id: number;
  symbol: string;
  type: number;
}

export interface Exchange {
  exchange_id: number;
  exchange_name: string;
}

export interface ExchangeAdapter {
  fetchSpecs(listings: Listing[], securities: Security[]): Promise<Map<number, ListingSpecData>>;
}
