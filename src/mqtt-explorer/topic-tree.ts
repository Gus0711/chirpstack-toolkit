export interface TopicTreeNode {
  segment: string;
  fullTopic: string;
  children: Map<string, TopicTreeNode>;
  messageCount: number;
  lastMessage: { payload: Buffer; qos: number; retain: boolean; timestamp: number; size: number } | null;
  previousPayload: Buffer | null;
  lastReceived: number;
  recentTimestamps: number[];
  valueHistory: Array<{ ts: number; value: number | null }>;
}

export interface FlatTreeNode {
  fullTopic: string;
  segment: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  messageCount: number;
  lastReceived: number;
  msgPerSec: number;
  lastPayloadPreview: string;
  retain: boolean;
}

export function createRootNode(): TopicTreeNode {
  return {
    segment: '',
    fullTopic: '',
    children: new Map(),
    messageCount: 0,
    lastMessage: null,
    previousPayload: null,
    lastReceived: 0,
    recentTimestamps: [],
    valueHistory: [],
  };
}

export function insertMessage(root: TopicTreeNode, topic: string, payload: Buffer, qos: number, retain: boolean): void {
  const segments = topic.split('/');
  let current = root;
  const now = Date.now();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let child = current.children.get(seg);
    if (!child) {
      child = {
        segment: seg,
        fullTopic: segments.slice(0, i + 1).join('/'),
        children: new Map(),
        messageCount: 0,
        lastMessage: null,
        previousPayload: null,
        lastReceived: 0,
        recentTimestamps: [],
        valueHistory: [],
      };
      current.children.set(seg, child);
    }
    current = child;
  }

  // Store previous payload for diff
  if (current.lastMessage) {
    current.previousPayload = current.lastMessage.payload;
  }

  current.messageCount++;
  current.lastReceived = now;
  current.lastMessage = { payload, qos, retain, timestamp: now, size: payload.length };

  // Ring buffer for msg/sec (keep last 60s)
  current.recentTimestamps.push(now);
  const cutoff = now - 60000;
  while (current.recentTimestamps.length > 0 && current.recentTimestamps[0] < cutoff) {
    current.recentTimestamps.shift();
  }
  if (current.recentTimestamps.length > 60) {
    current.recentTimestamps = current.recentTimestamps.slice(-60);
  }

  // Value history (try to extract numeric value)
  let numericValue: number | null = null;
  try {
    const text = payload.toString('utf-8');
    const parsed = JSON.parse(text);
    if (typeof parsed === 'number') {
      numericValue = parsed;
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed);
      if (keys.length > 0) {
        const firstVal = parsed[keys[0]];
        if (typeof firstVal === 'number') {
          numericValue = firstVal;
        }
      }
    }
  } catch {
    const num = parseFloat(payload.toString('utf-8'));
    if (!isNaN(num) && isFinite(num)) {
      numericValue = num;
    }
  }
  current.valueHistory.push({ ts: now, value: numericValue });
  if (current.valueHistory.length > 100) {
    current.valueHistory = current.valueHistory.slice(-100);
  }
}

function getMsgPerSec(node: TopicTreeNode): number {
  const now = Date.now();
  const cutoff = now - 10000;
  let count = 0;
  for (let i = node.recentTimestamps.length - 1; i >= 0; i--) {
    if (node.recentTimestamps[i] >= cutoff) count++;
    else break;
  }
  return count / 10;
}

function getPayloadPreview(node: TopicTreeNode): string {
  if (!node.lastMessage) return '';
  try {
    const text = node.lastMessage.payload.toString('utf-8');
    if (text.length <= 60) return text;
    return text.slice(0, 57) + '...';
  } catch {
    return node.lastMessage.payload.toString('hex').slice(0, 30);
  }
}

export function flattenTree(
  root: TopicTreeNode,
  expandedSet: Set<string>,
  filter?: string
): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  const lowerFilter = filter?.toLowerCase();

  function walk(node: TopicTreeNode, depth: number): void {
    const sortedChildren = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    for (const [, child] of sortedChildren) {
      const hasChildren = child.children.size > 0;
      const expanded = expandedSet.has(child.fullTopic);

      // If filter is active, only include matching nodes
      if (lowerFilter) {
        const matches = child.fullTopic.toLowerCase().includes(lowerFilter);
        const hasMatchingDescendant = hasMatchInSubtree(child, lowerFilter);
        if (!matches && !hasMatchingDescendant) continue;
      }

      result.push({
        fullTopic: child.fullTopic,
        segment: child.segment,
        depth,
        hasChildren,
        expanded,
        messageCount: child.messageCount,
        lastReceived: child.lastReceived,
        msgPerSec: getMsgPerSec(child),
        lastPayloadPreview: getPayloadPreview(child),
        retain: child.lastMessage?.retain ?? false,
      });

      if (hasChildren && (expanded || lowerFilter)) {
        walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);
  return result;
}

function hasMatchInSubtree(node: TopicTreeNode, lowerFilter: string): boolean {
  for (const [, child] of node.children) {
    if (child.fullTopic.toLowerCase().includes(lowerFilter)) return true;
    if (hasMatchInSubtree(child, lowerFilter)) return true;
  }
  return false;
}

export function getNodeByTopic(root: TopicTreeNode, topic: string): TopicTreeNode | null {
  const segments = topic.split('/');
  let current = root;
  for (const seg of segments) {
    const child = current.children.get(seg);
    if (!child) return null;
    current = child;
  }
  return current;
}

export function clearTree(root: TopicTreeNode): void {
  root.children.clear();
  root.messageCount = 0;
  root.lastMessage = null;
  root.previousPayload = null;
  root.lastReceived = 0;
  root.recentTimestamps = [];
  root.valueHistory = [];
}

function countTopicsRecursive(node: TopicTreeNode): number {
  let count = node.lastMessage ? 1 : 0;
  for (const [, child] of node.children) {
    count += countTopicsRecursive(child);
  }
  return count;
}

function countMessagesRecursive(node: TopicTreeNode): number {
  let count = node.messageCount;
  for (const [, child] of node.children) {
    count += countMessagesRecursive(child);
  }
  return count;
}

export function getTreeStats(root: TopicTreeNode): { topicCount: number; messagesTotal: number } {
  return {
    topicCount: countTopicsRecursive(root),
    messagesTotal: countMessagesRecursive(root),
  };
}
