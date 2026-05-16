/**
 * transports/index.ts — Transport adapter registry
 */

export type {
  TransportAdapter,
  ChatThread,
  IncomingMessage,
  PairingResult,
  RichButton,
  RichMenuSection,
  RichMenu,
  RichResponse,
} from "./types";
export { TelegramAdapter } from "./telegram/telegram-adapter";
