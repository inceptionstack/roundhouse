/**
 * cli/setup-prompts.ts — Interactive prompts using only Node built-in readline.
 * No external dependencies.
 */
import { createInterface, Interface } from "node:readline";

/**
 * Prompt the user for text input with optional default.
 */
export async function promptText(
  question: string,
  options?: { defaultValue?: string },
): Promise<string> {
  const suffix = options?.defaultValue ? ` (${options.defaultValue})` : "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      rl.question(`${question}${suffix}: `, (answer) => {
        settled = true;
        resolve(answer.trim() || options?.defaultValue || "");
      });
      rl.on("close", () => { if (!settled) reject(new Error("Input cancelled")); });
    });
  } finally {
    rl.close();
  }
}

/**
 * Prompt for secret input — characters are not echoed to the terminal.
 * Uses readline with _writeToOutput override to suppress echo.
 */
export async function promptMasked(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Suppress character echo after the prompt is written
  let prompted = false;
  const originalWrite = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
    if (!prompted) {
      originalWrite.call(rl, s);
      if (s.includes(question)) prompted = true;
    }
    // After prompt is shown, swallow all output (no echo)
  };

  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      rl.question(`${question}: `, (answer) => {
        settled = true;
        process.stdout.write("\n");
        resolve(answer.trim());
      });
      rl.on("close", () => { if (!settled) reject(new Error("Input cancelled")); });
    });
  } finally {
    rl.close();
  }
}

/**
 * Prompt for yes/no confirmation. Returns true for yes.
 */
export async function promptConfirm(
  question: string,
  options?: { defaultYes?: boolean },
): Promise<boolean> {
  const hint = options?.defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await promptText(`${question} ${hint}`);
  if (!answer) return !!options?.defaultYes;
  return answer.toLowerCase().startsWith("y");
}
