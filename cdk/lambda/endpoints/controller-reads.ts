import { APIGatewayProxyEvent } from 'aws-lambda';
import { ControllerReadPath } from './controller-read-paths';
import { createResponse } from './ledger-common';
import { handler as fills } from './ledger-fills';
import { handler as marks } from './ledger-marks';
import { handler as orderList } from './ledger-order-list';
import { handler as attention } from './monitoring-attention';
import { handler as tables } from './monitoring-tables';
import { handler as usage } from './risk-usage';
import { handler as summary } from './pnl-summary';
import { handler as series } from './pnl-series';
import { handler as daily } from './pnl-daily';
import { handler as events } from './pnl-events';

// The controller's ledger and PnL reads, served by one Lambda: each would otherwise bring its own function, role
// and permissions, and the API stack has to stay under CloudFormation's 500-resource limit. Each read keeps its own
// module; this only routes to it.
const ROUTES: Record<ControllerReadPath, (event: APIGatewayProxyEvent) => Promise<unknown>> = {
  'pnl/summary': summary,
  'pnl/series': series,
  'pnl/daily': daily,
  'pnl/events': events,
  'monitoring/attention': attention,
  'monitoring/tables': tables,
  'risk/usage': usage,
  'ledger/fills': fills,
  'ledger/orders/list': orderList,
  'ledger/marks': marks,
};

export const handler = async (event: APIGatewayProxyEvent) => {
  const route = ROUTES[event.resource.replace(/^\/(cognito\/)?/, '') as ControllerReadPath];
  return route ? route(event) : createResponse(404, { message: `No read at ${event.resource}` });
};
