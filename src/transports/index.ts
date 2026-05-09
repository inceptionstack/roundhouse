/**
 * transports/index.ts — Transport adapter registry
 */

export type { TransportAdapter, ChatThread, IncomingMessage, ProgressHandle } from "./types";
export { TelegramTransportAdapter } from "./telegram/adapter";
