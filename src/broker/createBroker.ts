import type { BrokerAdapter, ConnectionInfo, TradingMode } from '../shared/types';
import { SimBrokerAdapter } from './SimBrokerAdapter';
import { IpcBrokerClient } from './IpcBrokerClient';

export interface CreateBrokerResult {
  broker: BrokerAdapter;
  connection: ConnectionInfo;
}

/**
 * Picks the active BrokerAdapter for this session:
 *  - web build (no window.exvest bridge) => always the client-side simulator.
 *  - Electron build => ask the main process what it managed to connect to. If
 *    IB Gateway/TWS was unreachable at launch, main already recorded that as
 *    a fellBackFrom and this returns a fresh local simulator instead of the
 *    IPC client, so the renderer never talks to a broken bridge.
 */
export async function createBroker(): Promise<CreateBrokerResult> {
  const bridge = window.exvest;
  if (!bridge) {
    const broker = new SimBrokerAdapter();
    const connection = await broker.connect();
    return { broker, connection };
  }

  const client = new IpcBrokerClient(bridge);
  const connection = await client.connect();
  if (connection.connected) {
    return { broker: client, connection };
  }

  const fallback = new SimBrokerAdapter();
  const fallbackConnection = await fallback.connect();
  return {
    broker: fallback,
    connection: { ...fallbackConnection, fellBackFrom: connection.mode, reason: connection.reason }
  };
}

/** Mode this renderer would use for placing orders if not connected (build-time only, informational). */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.exvest;
}

export type { TradingMode };
