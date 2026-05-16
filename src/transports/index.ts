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
  ProgressMessage,
} from "./types";
export { TelegramAdapter } from "./telegram/telegram-adapter";
export { buildSelectableMenu } from "./rich-helpers";
export type { SelectableOption, SelectableMenuOpts } from "./rich-helpers";
