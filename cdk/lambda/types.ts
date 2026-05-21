interface ISecurityBase {
  symbol: string;
  description?: string;
  type: number;
  contractType?: number;
  assetClass?: number;
  baseCurrencyId?: number;
  quoteCurrencyId?: number;
  settleCurrencyId?: number;
  inverse?: boolean;
  quanto?: boolean;
  expiry?: string | null;
  strikePrice?: number | null;
  active?: boolean;
  underlyingSecurityId?: number | null;
}
export interface ICreateSecurity extends ISecurityBase {}
export interface ISecurity extends ISecurityBase {
  securityId: number;
  baseCurrency?: string;
  quoteCurrency?: string;
  settleCurrency?: string;
  dateCreated: string;
  dateModified: string;
}
export interface IDeleteSecurity {
  securityId: number;
}

interface IExchangeBase {
  exchangeName: string;
  region: string;
  schemaType: string;
}
export interface ICreateExchange extends IExchangeBase {}
export interface IExchange extends IExchangeBase {
  exchangeId: number;
  dateCreated: string;
  dateModified: string;
}
export interface IDeleteExchange {
  exchangeId: number;
}

interface IListingBase {
  exchangeId: number;
  securityId: number;
  exchangeSecurityId: string;
  exchangeSecuritySymbol: string;
}
export interface ICreateListing extends IListingBase {}
export interface IListing extends IListingBase {
  listingId: number;
  dateCreated: string;
  dateModified: string;
}
export interface IDeleteListing {
  listingId: number;
}
