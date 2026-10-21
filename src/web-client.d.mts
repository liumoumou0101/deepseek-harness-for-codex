import type { EventEmitter } from 'node:events';

export interface WebClient {
  readonly protocol: 'remote' | 'legacy';
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface WebSocketLike extends Pick<EventEmitter, 'on' | 'off'> {
  readonly readyState: number;
  close(): void;
  terminate?(): void;
}

export interface WebClientOptions {
  fetch?: typeof globalThis.fetch;
  WebSocket?: new (url: string, options: { headers: Record<string, string> }) => WebSocketLike;
  timeoutMs?: number;
}

export function createWebClient(webUrl: string, options?: WebClientOptions): Promise<WebClient>;
export function createLegacyWebClient(webUrl: string, options?: Omit<WebClientOptions, 'WebSocket'>): Promise<WebClient>;
