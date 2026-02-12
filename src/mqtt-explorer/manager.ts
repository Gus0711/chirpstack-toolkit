import { randomUUID } from 'crypto';
import type { MqttExplorerConnectParams, MqttExplorerConnectionInfo } from '../types.js';
import { MqttExplorerConnection } from './connection.js';

const connections: Map<string, MqttExplorerConnection> = new Map();
const MAX_CONNECTIONS = 5;

export function createConnection(params: MqttExplorerConnectParams): string {
  if (connections.size >= MAX_CONNECTIONS) {
    throw new Error(`Maximum ${MAX_CONNECTIONS} concurrent connections reached`);
  }

  const id = randomUUID().slice(0, 8);
  const conn = new MqttExplorerConnection(id, params.host, params.port);
  connections.set(id, conn);
  conn.connect(params);
  return id;
}

export function getConnection(id: string): MqttExplorerConnection | null {
  return connections.get(id) ?? null;
}

export async function destroyConnection(id: string): Promise<void> {
  const conn = connections.get(id);
  if (!conn) return;
  await conn.disconnect();
  connections.delete(id);
}

export function listConnections(): MqttExplorerConnectionInfo[] {
  const result: MqttExplorerConnectionInfo[] = [];
  for (const [, conn] of connections) {
    result.push({
      id: conn.id,
      host: conn.host,
      port: conn.port,
      status: conn.status,
      error: conn.error ?? undefined,
      connectedAt: conn.connectedAt,
      subscriptions: [...conn.subscriptions.keys()],
      stats: conn.getStats(),
    });
  }
  return result;
}

export async function destroyAllConnections(): Promise<void> {
  const ids = [...connections.keys()];
  for (const id of ids) {
    try {
      await destroyConnection(id);
    } catch (err) {
      console.error(`[mqtt-explorer] Error destroying connection ${id}:`, err);
    }
  }
}
