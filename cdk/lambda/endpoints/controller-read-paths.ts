// The routes the controller-reads Lambda serves; shared with the API stack, which mustn't load the handlers.
export const CONTROLLER_READ_PATHS = [
  'pnl/summary',
  'pnl/series',
  'monitoring/attention',
  'ledger/fills',
  'ledger/orders/list',
  'ledger/marks',
] as const;

export type ControllerReadPath = typeof CONTROLLER_READ_PATHS[number];
