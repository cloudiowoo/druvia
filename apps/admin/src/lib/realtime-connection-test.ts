import { createClient as createGraphqlWsClient } from 'graphql-ws';

export type RealtimeConnectionTestState =
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'disconnected';

function normalizeRealtimeProbeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'reason' in error) {
    const reason = (error as { reason?: unknown }).reason;
    return new Error(String(reason || 'Realtime connection failed'));
  }
  return new Error(typeof error === 'string' ? error : 'Realtime connection failed');
}

export function startRealtimeConnectionTest(input: {
  websocketUrl: string;
  token: string;
  onState: (state: RealtimeConnectionTestState, error?: Error) => void;
}) {
  let disposed = false;
  input.onState('connecting');
  const client = createGraphqlWsClient({
    url: input.websocketUrl,
    lazy: false,
    retryAttempts: 0,
    connectionAckWaitTimeout: 10_000,
    connectionParams: {
      headers: { Authorization: `Bearer ${input.token}` },
    },
    onNonLazyError: () => undefined,
    on: {
      connected: () => {
        if (!disposed) input.onState('connected');
      },
      closed: (event) => {
        if (disposed) return;
        const close = event as { code?: number; reason?: string };
        if (close.code === 1000) {
          input.onState('disconnected');
          return;
        }
        input.onState('failed', new Error(close.reason || 'Realtime connection closed'));
      },
      error: (error) => {
        if (!disposed) input.onState('failed', normalizeRealtimeProbeError(error));
      },
    },
  });

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      void client.dispose();
    },
  };
}
