import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import type { MqttExplorerConnectParams, MqttExplorerStats } from '../types.js';
import { createRootNode, insertMessage, clearTree, getTreeStats, getNodeByTopic, updateNodeSearchText, type TopicTreeNode } from './topic-tree.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// Regex for ChirpStack event topics: application/{appId}/device/{devEui}/event/{type}
const CS_TOPIC_RE = /^application\/([^/]+)\/device\/([^/]+)\/event\/(.+)$/;

export class MqttExplorerConnection {
  id: string;
  host: string;
  port: number;
  client: MqttClient | null = null;
  topicTree: TopicTreeNode;
  status: ConnectionStatus = 'disconnected';
  error: string | null = null;
  connectedAt: number | null = null;
  subscriptions: Map<string, { qos: 0 | 1 | 2 }> = new Map();
  bytesTotal: number = 0;
  onMessage: ((topic: string, payload: Buffer, qos: number, retain: boolean) => void) | null = null;
  onStatusChange: ((status: ConnectionStatus, error?: string) => void) | null = null;
  onNamesUpdate: ((devices: Record<string, { name: string; tags: Record<string, string> }>, applications: Record<string, string>) => void) | null = null;

  // Name resolution caches
  deviceNames: Map<string, { name: string; tags: Record<string, string> }> = new Map();
  applicationNames: Map<string, string> = new Map();

  private msgPerSecCounter: number = 0;
  private msgPerSecValue: number = 0;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private namesDirty: boolean = false;

  constructor(id: string, host: string, port: number) {
    this.id = id;
    this.host = host;
    this.port = port;
    this.topicTree = createRootNode();
  }

  connect(params: MqttExplorerConnectParams): void {
    const url = `${params.protocol}://${params.host}:${params.port}`;

    const options: mqtt.IClientOptions = {
      clientId: params.clientId || `mqtt-explorer-${this.id.slice(0, 8)}`,
      clean: params.cleanSession !== false,
      connectTimeout: 10000,
      reconnectPeriod: 5000,
    };

    if (params.username) options.username = params.username;
    if (params.password) options.password = params.password;

    this.setStatus('connecting');
    this.client = mqtt.connect(url, options);

    this.client.on('connect', () => {
      this.connectedAt = Date.now();
      this.setStatus('connected');

      // Auto-subscribe
      const subs = params.subscriptions && params.subscriptions.length > 0
        ? params.subscriptions
        : ['#'];

      for (const topic of subs) {
        this.subscribe(topic, 0);
      }
    });

    this.client.on('message', (topic, payload, packet) => {
      const size = payload.length;
      this.bytesTotal += size;
      this.msgPerSecCounter++;

      // Enforce topic limit
      const stats = getTreeStats(this.topicTree);
      if (stats.topicCount < 10000) {
        insertMessage(this.topicTree, topic, payload, packet.qos, packet.retain ?? false);
      }

      // Extract ChirpStack device/application names from payloads
      this.extractNamesFromPayload(topic, payload);

      if (this.onMessage) {
        try {
          this.onMessage(topic, payload, packet.qos, packet.retain ?? false);
        } catch (err) {
          console.error('[mqtt-explorer] onMessage handler error:', err);
        }
      }
    });

    this.client.on('error', (err) => {
      this.error = err.message;
      this.setStatus('error', err.message);
    });

    this.client.on('close', () => {
      if (this.status !== 'error') {
        this.setStatus('disconnected');
      }
    });

    this.client.on('offline', () => {
      if (this.status !== 'error') {
        this.setStatus('disconnected');
      }
    });

    // msg/sec counter
    this.statsInterval = setInterval(() => {
      this.msgPerSecValue = this.msgPerSecCounter;
      this.msgPerSecCounter = 0;
    }, 1000);
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }

      if (this.client) {
        this.client.end(true, {}, () => {
          this.client = null;
          this.setStatus('disconnected');
          resolve();
        });
      } else {
        this.setStatus('disconnected');
        resolve();
      }
    });
  }

  subscribe(topic: string, qos: 0 | 1 | 2 = 0): void {
    if (!this.client || this.status !== 'connected') return;
    this.client.subscribe(topic, { qos }, (err) => {
      if (err) {
        console.error(`[mqtt-explorer] Subscribe error for ${topic}:`, err);
      } else {
        this.subscriptions.set(topic, { qos });
      }
    });
  }

  unsubscribe(topic: string): void {
    if (!this.client) return;
    this.client.unsubscribe(topic, (err) => {
      if (err) {
        console.error(`[mqtt-explorer] Unsubscribe error for ${topic}:`, err);
      } else {
        this.subscriptions.delete(topic);
      }
    });
  }

  publish(topic: string, payload: string | Buffer, qos: 0 | 1 | 2 = 0, retain: boolean = false): void {
    if (!this.client || this.status !== 'connected') return;
    this.client.publish(topic, payload, { qos, retain }, (err) => {
      if (err) {
        console.error(`[mqtt-explorer] Publish error for ${topic}:`, err);
      }
    });
  }

  clearTopicTree(): void {
    clearTree(this.topicTree);
    this.bytesTotal = 0;
    this.msgPerSecCounter = 0;
    this.msgPerSecValue = 0;
    this.deviceNames.clear();
    this.applicationNames.clear();
    this.namesDirty = false;
  }

  private extractNamesFromPayload(topic: string, payload: Buffer): void {
    const m = CS_TOPIC_RE.exec(topic);
    if (!m) return;

    const appId = m[1];
    const devEui = m[2];

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload.toString('utf-8'));
    } catch { return; }

    // Extract from deviceInfo (ChirpStack v4 format)
    const di = parsed.deviceInfo as Record<string, unknown> | undefined;
    if (!di) return;

    const deviceName = di.deviceName as string | undefined;
    const applicationName = di.applicationName as string | undefined;
    const tags = di.tags as Record<string, string> | undefined;

    let changed = false;

    if (deviceName && devEui) {
      const prev = this.deviceNames.get(devEui);
      const newTags = tags && typeof tags === 'object' ? tags : {};
      if (!prev || prev.name !== deviceName || JSON.stringify(prev.tags) !== JSON.stringify(newTags)) {
        this.deviceNames.set(devEui, { name: deviceName, tags: newTags });
        changed = true;

        // Update the devEui node in the trie
        const devNode = getNodeByTopic(this.topicTree, `application/${appId}/device/${devEui}`);
        if (devNode) {
          devNode.resolvedName = deviceName;
          devNode.tags = newTags;
          updateNodeSearchText(devNode);
        }
        // Also update all child nodes searchText (they inherit for search)
      }
    }

    if (applicationName && appId) {
      const prev = this.applicationNames.get(appId);
      if (prev !== applicationName) {
        this.applicationNames.set(appId, applicationName);
        changed = true;

        // Update the application node in the trie
        const appNode = getNodeByTopic(this.topicTree, `application/${appId}`);
        if (appNode) {
          appNode.resolvedName = applicationName;
          updateNodeSearchText(appNode);
        }
      }
    }

    if (changed) {
      this.namesDirty = true;
    }
  }

  /** Returns pending names update and resets dirty flag. Returns null if no updates. */
  consumeNamesUpdate(): { devices: Record<string, { name: string; tags: Record<string, string> }>; applications: Record<string, string> } | null {
    if (!this.namesDirty) return null;
    this.namesDirty = false;

    const devices: Record<string, { name: string; tags: Record<string, string> }> = {};
    for (const [k, v] of this.deviceNames) {
      devices[k] = v;
    }
    const applications: Record<string, string> = {};
    for (const [k, v] of this.applicationNames) {
      applications[k] = v;
    }
    return { devices, applications };
  }

  getStats(): MqttExplorerStats {
    const treeStats = getTreeStats(this.topicTree);
    return {
      messagesTotal: treeStats.messagesTotal,
      messagesPerSecond: this.msgPerSecValue,
      topicCount: treeStats.topicCount,
      bytesTotal: this.bytesTotal,
    };
  }

  private setStatus(status: ConnectionStatus, error?: string): void {
    this.status = status;
    if (error !== undefined) this.error = error;
    if (this.onStatusChange) {
      try {
        this.onStatusChange(status, error);
      } catch (err) {
        console.error('[mqtt-explorer] onStatusChange handler error:', err);
      }
    }
  }
}
