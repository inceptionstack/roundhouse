/**
 * transports/index.ts — Transport adapter registry
 */

export type {
  TransportAdapter,
  ChatThread,
  ChatThreadPost,
  IncomingMessage,
  PairingResult,
  RichButton,
  RichMenuSection,
  RichMenu,
  RichResponse,
  ProgressMessage,
  MinimalThread,
} from "./types";
export { TelegramAdapter } from "./telegram/telegram-adapter";
export { SlackAdapter } from "./slack/slack-adapter";
export { CompositeTransportAdapter, buildCompositeTransport } from "./composite";
export { chatAdapterFactories, buildChatAdapters as buildChatSdkAdapters } from "./chat-adapters";
export { buildSelectableMenu, richMenuToCard, stripMarkdownToPlain } from "./rich-helpers";
export type { SelectableOption, SelectableMenuOpts } from "./rich-helpers";
