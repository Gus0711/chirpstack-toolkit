import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { createConnection, getConnection, destroyConnection, listConnections } from '../mqtt-explorer/manager.js';
import { flattenTree, getNodeByTopic, getTreeStats } from '../mqtt-explorer/topic-tree.js';
import type { MqttExplorerConnectParams } from '../types.js';

interface WsClient {
  ws: WebSocket;
  connectionId: string;
  expandedTopics: Set<string>;
  selectedTopic: string | null;
  filter: string | null;
}

const wsClients: Set<WsClient> = new Set();

let treeTickInterval: ReturnType<typeof setInterval> | null = null;
let statsTickInterval: ReturnType<typeof setInterval> | null = null;

function startBroadcastTimers(): void {
  if (treeTickInterval) return;

  // Tree updates at 10 Hz
  treeTickInterval = setInterval(() => {
    for (const client of wsClients) {
      try {
        if (client.ws.readyState !== 1) {
          wsClients.delete(client);
          continue;
        }
        const conn = getConnection(client.connectionId);
        if (!conn) continue;

        const nodes = flattenTree(conn.topicTree, client.expandedTopics, client.filter ?? undefined);
        client.ws.send(JSON.stringify({ type: 'tree_update', nodes }));
      } catch {
        wsClients.delete(client);
      }
    }
  }, 100);

  // Stats at 1 Hz
  statsTickInterval = setInterval(() => {
    for (const client of wsClients) {
      try {
        if (client.ws.readyState !== 1) {
          wsClients.delete(client);
          continue;
        }
        const conn = getConnection(client.connectionId);
        if (!conn) continue;

        const stats = conn.getStats();
        client.ws.send(JSON.stringify({
          type: 'stats',
          messagesTotal: stats.messagesTotal,
          messagesPerSec: stats.messagesPerSecond,
          topicCount: stats.topicCount,
          bytesTotal: stats.bytesTotal,
        }));
      } catch {
        wsClients.delete(client);
      }
    }
  }, 1000);
}

function stopBroadcastTimers(): void {
  if (treeTickInterval) { clearInterval(treeTickInterval); treeTickInterval = null; }
  if (statsTickInterval) { clearInterval(statsTickInterval); statsTickInterval = null; }
}

export async function mqttExplorerRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/mqtt-explorer/connect
  fastify.post<{ Body: MqttExplorerConnectParams }>('/api/mqtt-explorer/connect', async (request, reply) => {
    const body = request.body;
    if (!body.host) {
      reply.code(400);
      return { error: 'host is required' };
    }
    if (!body.port) {
      reply.code(400);
      return { error: 'port is required' };
    }
    if (!body.protocol) {
      body.protocol = 'mqtt';
    }

    try {
      const connectionId = createConnection(body);
      return { connectionId };
    } catch (err: unknown) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : 'Connection failed' };
    }
  });

  // DELETE /api/mqtt-explorer/connect/:id
  fastify.delete<{ Params: { id: string } }>('/api/mqtt-explorer/connect/:id', async (request) => {
    await destroyConnection(request.params.id);
    return { success: true };
  });

  // POST /api/mqtt-explorer/disconnect/:id (for sendBeacon on page unload)
  fastify.post<{ Params: { id: string } }>('/api/mqtt-explorer/disconnect/:id', async (request) => {
    await destroyConnection(request.params.id);
    return { success: true };
  });

  // GET /api/mqtt-explorer/connections
  fastify.get('/api/mqtt-explorer/connections', async () => {
    return { connections: listConnections() };
  });

  // POST /api/mqtt-explorer/:id/subscribe
  fastify.post<{ Params: { id: string }; Body: { topic: string; qos?: number } }>('/api/mqtt-explorer/:id/subscribe', async (request, reply) => {
    const conn = getConnection(request.params.id);
    if (!conn) {
      reply.code(404);
      return { error: 'Connection not found' };
    }
    const { topic, qos } = request.body;
    if (!topic) {
      reply.code(400);
      return { error: 'topic is required' };
    }
    conn.subscribe(topic, (qos ?? 0) as 0 | 1 | 2);
    return { success: true };
  });

  // DELETE /api/mqtt-explorer/:id/subscribe
  fastify.delete<{ Params: { id: string }; Body: { topic: string } }>('/api/mqtt-explorer/:id/subscribe', async (request, reply) => {
    const conn = getConnection(request.params.id);
    if (!conn) {
      reply.code(404);
      return { error: 'Connection not found' };
    }
    const { topic } = request.body;
    if (!topic) {
      reply.code(400);
      return { error: 'topic is required' };
    }
    conn.unsubscribe(topic);
    return { success: true };
  });

  // POST /api/mqtt-explorer/:id/publish
  fastify.post<{ Params: { id: string }; Body: { topic: string; payload: string; qos?: number; retain?: boolean } }>('/api/mqtt-explorer/:id/publish', async (request, reply) => {
    const conn = getConnection(request.params.id);
    if (!conn) {
      reply.code(404);
      return { error: 'Connection not found' };
    }
    const { topic, payload, qos, retain } = request.body;
    if (!topic) {
      reply.code(400);
      return { error: 'topic is required' };
    }
    conn.publish(topic, payload ?? '', (qos ?? 0) as 0 | 1 | 2, retain ?? false);
    return { success: true };
  });

  // WS /api/mqtt-explorer/ws/:id
  fastify.get<{ Params: { id: string } }>('/api/mqtt-explorer/ws/:id', { websocket: true }, (socket, request) => {
    const connId = request.params.id;
    const conn = getConnection(connId);

    if (!conn) {
      socket.close(4404, 'Connection not found');
      return;
    }

    const client: WsClient = {
      ws: socket,
      connectionId: connId,
      expandedTopics: new Set(),
      selectedTopic: null,
      filter: null,
    };

    wsClients.add(client);
    startBroadcastTimers();

    // Send initial status
    socket.send(JSON.stringify({ type: 'status', status: conn.status }));

    // Listen for status changes
    const prevStatusHandler = conn.onStatusChange;
    conn.onStatusChange = (status, error) => {
      if (prevStatusHandler) prevStatusHandler(status, error);
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'status', status, error }));
        }
      } catch { /* ignore */ }
    };

    // Listen for messages to send selected topic detail
    const prevMessageHandler = conn.onMessage;
    conn.onMessage = (topic, payload, qos, retain) => {
      if (prevMessageHandler) prevMessageHandler(topic, payload, qos, retain);
      try {
        if (socket.readyState !== 1) return;

        // If this topic is selected, send detailed message
        if (client.selectedTopic && topic === client.selectedTopic) {
          const payloadBase64 = payload.toString('base64');
          let payloadText = '';
          let format: 'json' | 'text' | 'hex' | 'base64' = 'base64';

          try {
            payloadText = payload.toString('utf-8');
            try {
              JSON.parse(payloadText);
              format = 'json';
            } catch {
              // Check if it's valid text
              if (/^[\x20-\x7E\r\n\t]*$/.test(payloadText)) {
                format = 'text';
              } else {
                format = 'hex';
                payloadText = payload.toString('hex');
              }
            }
          } catch {
            format = 'hex';
            payloadText = payload.toString('hex');
          }

          socket.send(JSON.stringify({
            type: 'message',
            topic,
            payload: payloadBase64,
            payloadText,
            format,
            qos,
            retain,
            ts: Date.now(),
            size: payload.length,
          }));
        }
      } catch { /* ignore */ }
    };

    // Handle client messages
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case 'expand':
            if (msg.topic) client.expandedTopics.add(msg.topic);
            break;
          case 'collapse':
            if (msg.topic) client.expandedTopics.delete(msg.topic);
            break;
          case 'select':
            client.selectedTopic = msg.topic || null;
            // Send current payload for selected topic
            if (client.selectedTopic && conn) {
              const node = getNodeByTopic(conn.topicTree, client.selectedTopic);
              if (node && node.lastMessage) {
                const payload = node.lastMessage.payload;
                const payloadBase64 = payload.toString('base64');
                let payloadText = '';
                let format: 'json' | 'text' | 'hex' | 'base64' = 'base64';
                try {
                  payloadText = payload.toString('utf-8');
                  try { JSON.parse(payloadText); format = 'json'; } catch {
                    if (/^[\x20-\x7E\r\n\t]*$/.test(payloadText)) format = 'text';
                    else { format = 'hex'; payloadText = payload.toString('hex'); }
                  }
                } catch { format = 'hex'; payloadText = payload.toString('hex'); }

                let previousPayloadText: string | null = null;
                if (node.previousPayload) {
                  try { previousPayloadText = node.previousPayload.toString('utf-8'); } catch { /* ignore */ }
                }

                socket.send(JSON.stringify({
                  type: 'message',
                  topic: client.selectedTopic,
                  payload: payloadBase64,
                  payloadText,
                  format,
                  qos: node.lastMessage.qos,
                  retain: node.lastMessage.retain,
                  ts: node.lastMessage.timestamp,
                  size: node.lastMessage.size,
                  previousPayloadText,
                  valueHistory: node.valueHistory,
                  messageCount: node.messageCount,
                }));
              }
            }
            break;
          case 'filter':
            client.filter = msg.query || null;
            break;
          case 'clear':
            if (conn) conn.clearTopicTree();
            break;
          case 'expand_all': {
            if (!conn) break;
            const expandAll = (node: ReturnType<typeof getNodeByTopic>) => {
              if (!node) return;
              if (node.fullTopic) client.expandedTopics.add(node.fullTopic);
              for (const [, child] of node.children) expandAll(child);
            };
            expandAll(conn.topicTree);
            break;
          }
          case 'collapse_all':
            client.expandedTopics.clear();
            break;
        }
      } catch {
        // Ignore invalid messages
      }
    });

    socket.on('close', () => {
      wsClients.delete(client);
      if (wsClients.size === 0) {
        stopBroadcastTimers();
      }
    });

    socket.on('error', () => {
      wsClients.delete(client);
      if (wsClients.size === 0) {
        stopBroadcastTimers();
      }
    });
  });
}
