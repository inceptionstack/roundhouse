/**
 * cli/message.ts — Send a message to the running gateway via IPC
 *
 * Usage:
 *   roundhouse message "Hello from CLI"
 *   roundhouse message --session main "Hello"
 */

import { sendIpc } from "../ipc/client";

export async function cmdMessage(args: string[]): Promise<void> {
  let session: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && args[i + 1]) {
      session = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  const text = positional.join(" ").trim();
  if (!text) {
    console.error('Usage: roundhouse message [--session <name>] "<message>"');
    process.exit(1);
  }

  try {
    const response = await sendIpc({ type: "notify", text, session });
    if (response.ok) {
      console.log("✅ Message delivered to gateway");
    } else {
      console.error(`❌ ${response.error}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
