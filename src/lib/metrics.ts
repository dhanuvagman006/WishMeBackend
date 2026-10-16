import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'wishme_' });

export const httpDuration = new client.Histogram({
  name: 'wishme_http_request_duration_seconds',
  help: 'HTTP request duration by route group, mode and status class',
  labelNames: ['group', 'mode', 'method', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const vendorCalls = new client.Counter({
  name: 'wishme_vendor_calls_total',
  help: 'Outbound vendor calls by vendor and outcome',
  labelNames: ['vendor', 'outcome'] as const,
  registers: [registry],
});

export const ledgerMovements = new client.Counter({
  name: 'wishme_ledger_movements_total',
  help: 'Ledger movements by kind',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const realtimeSockets = new client.Gauge({
  name: 'wishme_realtime_sockets',
  help: 'Open Realtime websocket connections on this replica',
  registers: [registry],
});
