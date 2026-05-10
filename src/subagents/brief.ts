import type { SpawnSpec } from "./types";

export function buildBrief(spec: SpawnSpec): string {
  const sections: string[] = [
    "# Role",
    spec.role,
    "",
    "# Task",
    spec.task,
    "",
    "# Working Directory",
    spec.cwd,
  ];

  if (spec.context?.briefing) {
    sections.push("", "# Context", spec.context.briefing);
  }

  if (spec.context?.targetFiles?.length) {
    sections.push("", "# Target Files", ...spec.context.targetFiles.map((file) => `- ${file}`));
  }

  if (spec.context?.completionContract) {
    sections.push("", "# Done When", spec.context.completionContract);
  }

  return sections.join("\n") + "\n";
}
