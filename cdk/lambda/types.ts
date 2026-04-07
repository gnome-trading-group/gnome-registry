interface ISecurityBase {
  symbol: string;
  description?: string;
  type: number;
}
export interface ICreateSecurity extends ISecurityBase {}
export interface ISecurity extends ISecurityBase {
  securityId: number;
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
