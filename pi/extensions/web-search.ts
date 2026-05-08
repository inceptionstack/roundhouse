import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Tavily. Returns JSON results with title, url, and content for each result. Use this when you need current information from the internet.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      num_results: Type.Optional(
        Type.Number({ description: "Number of results (1-20, default 5)", minimum: 1, maximum: 20 })
      ),
      include_answer: Type.Optional(
        Type.Boolean({ description: "Include AI-generated answer summary (default false)" })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const apiKey = process.env.TAVILY_API_KEY || "";
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "TAVILY_API_KEY environment variable not set. Set it to use web search." }],
          details: { error: "missing_api_key" },
        };
      }

      const maxResults = Math.min(Math.max(params.num_results ?? 5, 1), 20);
      const includeAnswer = params.include_answer ?? false;

      const startTime = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      if (signal) signal.addEventListener("abort", () => controller.abort());

      let response: Response;
      try {
        response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: params.query,
            max_results: maxResults,
            include_answer: includeAnswer,
            api_key: apiKey,
          }),
          signal: controller.signal,
        });
      } catch (err: any) {
        clearTimeout(timeout);
        const msg = err.name === "AbortError" ? "Request timed out (30s)" : `Network error: ${err.message}`;
        return {
          content: [{ type: "text", text: msg }],
          details: { query: params.query, error: err.name },
        };
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [{ type: "text", text: `Tavily API error (${response.status}): ${errorText}` }],
          details: { query: params.query, error: response.status },
        };
      }

      const data = (await response.json()) as {
        answer?: string;
        results?: Array<{ title: string; url: string; content: string }>;
      };
      const responseTime = Date.now() - startTime;

      const results = data.results ?? [];
      const parts: string[] = [];

      if (includeAnswer && data.answer) {
        parts.push(`**Answer:** ${data.answer}\n`);
      }

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        parts.push(`${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content}`);
      }

      const text = parts.length > 0 ? parts.join("\n\n") : "No results found.";

      return {
        content: [{ type: "text", text }],
        details: {
          query: params.query,
          resultCount: results.length,
          responseTime: `${responseTime}ms`,
        },
      };
    },
  });
}
