/**
 * code-review.ts — Pi extension
 *
 * After each agent turn that modifies files, spawns a fresh pi instance
 * to do a code review. Feeds the review feedback back to the main agent
 * as a steering message so it can decide whether to fix anything.
 *
 * Install:
 *   pi -e ./extensions/code-review.ts
 *   or copy to ~/.pi/agent/extensions/
 */

import {
  type ExtensionAPI,
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer. You will be given a description of changes that were just made to a codebase. Your job is to:

1. Check for bugs, logic errors, off-by-one errors
2. Check for security issues
3. Check for clarity and readability problems
4. Check for missing error handling
5. Check for DRY violations

Be concise. If everything looks fine, say "LGTM — no issues found."
If there are issues, list them as bullet points with severity (high/medium/low).
Do NOT suggest stylistic preferences. Only flag real problems.`;

export default function (pi: ExtensionAPI) {
  let reviewEnabled = true;

  // Track which tool calls happened this turn
  let turnToolCalls: Array<{ name: string; input: any; result?: string }> = [];

  pi.on("tool_execution_end", async (event) => {
    turnToolCalls.push({
      name: event.toolName,
      input: event.args,
      result: event.result?.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n")
        .slice(0, 2000), // truncate large outputs
    });
  });

  pi.on("turn_start", async () => {
    turnToolCalls = [];
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!reviewEnabled) return;

    // Only review if files were modified (write, edit, bash with file ops)
    const fileModifyingTools = ["write", "edit"];
    const hasFileChanges = turnToolCalls.some(
      (tc) =>
        fileModifyingTools.includes(tc.name) ||
        (tc.name === "bash" &&
          /\b(cat\s*>|tee|sed\s+-i|mv\s|cp\s|rm\s|mkdir|echo\s.*>)\b/.test(
            tc.input?.command ?? ""
          ))
    );

    if (!hasFileChanges) {
      turnToolCalls = [];
      return;
    }

    // Build a summary of what changed
    const changeSummary = turnToolCalls
      .filter((tc) => fileModifyingTools.includes(tc.name) || tc.name === "bash")
      .map((tc) => {
        if (tc.name === "write") {
          return `WROTE file: ${tc.input?.path}\n${(tc.input?.content ?? "").slice(0, 3000)}`;
        }
        if (tc.name === "edit") {
          const edits = tc.input?.edits ?? [];
          const editSummary = edits
            .map(
              (e: any, i: number) =>
                `  Edit ${i + 1}: replaced "${(e.oldText ?? "").slice(0, 200)}" with "${(e.newText ?? "").slice(0, 200)}"`
            )
            .join("\n");
          return `EDITED file: ${tc.input?.path}\n${editSummary}`;
        }
        if (tc.name === "bash") {
          return `BASH: ${tc.input?.command}\n→ ${(tc.result ?? "").slice(0, 1000)}`;
        }
        return `${tc.name}: ${JSON.stringify(tc.input).slice(0, 500)}`;
      })
      .join("\n\n---\n\n");

    if (!changeSummary.trim()) {
      turnToolCalls = [];
      return;
    }

    console.log("[code-review] File changes detected, spawning reviewer...");

    try {
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);

      const { session: reviewSession } = await createAgentSession({
        cwd: ctx.cwd,
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry,
      });

      // Collect the reviewer's response
      let reviewText = "";
      const unsub = reviewSession.subscribe((ev) => {
        if (
          ev.type === "message_update" &&
          ev.assistantMessageEvent.type === "text_delta"
        ) {
          reviewText += ev.assistantMessageEvent.delta;
        }
      });

      try {
        await reviewSession.prompt(
          `${REVIEW_SYSTEM_PROMPT}\n\n---\n\nHere are the changes made:\n\n${changeSummary}`
        );
      } finally {
        unsub();
        reviewSession.dispose();
      }

      if (!reviewText.trim() || reviewText.includes("LGTM")) {
        console.log("[code-review] Reviewer says: LGTM");
        turnToolCalls = [];
        return;
      }

      console.log("[code-review] Reviewer found issues, feeding back...");

      // Inject the review as a steering message to the main agent
      pi.sendMessage(
        {
          customType: "code-review",
          content: `🔍 **Automated Code Review**\n\nA separate reviewer examined your recent changes and found potential issues:\n\n${reviewText}\n\nPlease review these findings. If any are valid, fix them. If they're false positives, briefly explain why and move on.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    } catch (err) {
      console.error("[code-review] Review failed:", err);
    }

    turnToolCalls = [];
  });

  // Toggle command
  pi.registerCommand("review", {
    description: "Toggle automatic code review after each turn",
    handler: async (_args, ctx) => {
      reviewEnabled = !reviewEnabled;
      ctx.ui.notify(
        `Code review: ${reviewEnabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(
      "code-review",
      ctx.ui.theme.fg("accent", "review") +
        " " +
        ctx.ui.theme.fg("success", "on")
    );
  });
}
