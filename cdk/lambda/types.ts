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
  exchangeCode: string;
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
  active?: boolean;
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

interface IEventBase {
  title: string;
  description?: string;
  category?: string;
  expiry?: string | null;
  tags?: string[] | null;
  exchangeId: number;
  nativeEventId: string;
  nativeUrl?: string | null;
}
export interface ICreateEvent extends IEventBase {}
export interface IDeleteEvent {
  eventId: number;
}

interface IEventContractBase {
  eventId: number;
  securityId: number;
  outcomeLabel: string;
}
export interface ICreateEventContract extends IEventContractBase {}
export interface IModifyEventContract {
  outcomeLabel?: string;
  settlementPrice?: string | number;
}
export interface IDeleteEventContract {
  eventContractId: number;
}

interface IContractRelationshipBase {
  securityIdA: number;
  securityIdB: number;
  relationshipType: string;
  confidence: number;
  method: string;
}
export interface ICreateContractRelationship extends IContractRelationshipBase {}
export interface IDeleteContractRelationship {
  relationshipId: number;
}

interface IHedgeKeywordBase {
  securityId: number;
  keyword: string;
}
export interface ICreateHedgeKeyword extends IHedgeKeywordBase {}
export interface IDeleteHedgeKeyword {
  hedgeKeywordId: number;
}
