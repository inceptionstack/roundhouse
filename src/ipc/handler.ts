/**
 * ipc/handler.ts — Gateway IPC request handler factory
 */

import type { GatewayConfig } from "../types";
import type { TransportAdapter } from "../transports";
import type { IpcRequest, IpcResponse } from "./types";

export function createIpcHandler(
  transport: TransportAdapter,
  getConfig: () => GatewayConfig,
): (req: IpcRequest) => Promise<IpcResponse> {
  return async (req: IpcRequest): Promise<IpcResponse> => {
    if (req.type === "ping") return { ok: true };

    if (req.type === "notify") {
      const allChatIds = getConfig().chat.notifyChatIds ?? [];
      if (allChatIds.length === 0) return { ok: false, error: "No notifyChatIds configured" };

      let targetIds: (string | number)[];
      if (req.session === "main") {
        targetIds = [allChatIds[0]];
      } else if (req.session && transport.ownsChatId(req.session)) {
        // session value is a recognized chat id (telegram numeric-as-string
        // OR slack `Cxxx`/`Dxxx`/`Uxxx`/`Gxxx`). Single-target route.
        targetIds = [req.session];
      } else {
        // No session, or session that doesn't match any transport's id shape:
        // fan out to all configured ids.
        targetIds = allChatIds;
      }

      try {
        await transport.notify(targetIds, req.text);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    return { ok: false, error: "Unknown request type" };
  };
}
