import type { ReadmePlan } from "./types";

const SHELL_FENCE = /```(?:bash|sh|shell|zsh|console)?\s*\n([\s\S]*?)```/gi;

function cleanShellLine(line: string): string | null {
  const cleaned = line.trim().replace(/^\$\s+/, "");
  if (!cleaned || cleaned.startsWith("#")) return null;
  if (/^(>|\.\.\.|output:)/i.test(cleaned)) return null;
  return cleaned;
}

function extractCommands(markdown: string): string[] {
  const commands: string[] = [];
  for (const match of markdown.matchAll(SHELL_FENCE)) {
    for (const rawLine of match[1].split("\n")) {
      const line = cleanShellLine(rawLine);
      if (line) commands.push(line);
    }
  }
  return [...new Set(commands)];
}

function firstMatch(commands: string[], patterns: RegExp[]): string | null {
  return commands.find((command) => patterns.some((pattern) => pattern.test(command))) ?? null;
}

function extractRuntime(markdown: string, runtime: "node" | "python"): string | null {
  const pattern = runtime === "node"
    ? /\b(?:Node(?:\.js)?|node)\s*(?:version|v|>=|=|:)?\s*(\d+(?:\.\d+){0,2}(?:\s*(?:LTS|\+))?)/i
    : /\bPython\s*(?:version|v|>=|=|:)?\s*(\d+(?:\.\d+){0,2}(?:\+)?)\b/i;
  return markdown.match(pattern)?.[1] ?? null;
}

export function extractReadmePlan(markdown: string): ReadmePlan {
  const commands = extractCommands(markdown);
  const installCommand = firstMatch(commands, [
    /^(npm\s+(?:ci|install|i))(?:\s|$)/,
    /^pnpm\s+(?:install|i)(?:\s|$)/,
    /^yarn(?:\s+install)?(?:\s|$)/,
    /^bun\s+install(?:\s|$)/,
    /^(?:python\s+-m\s+)?pip\s+install(?:\s|$)/,
    /^poetry\s+install(?:\s|$)/,
    /^uv\s+sync(?:\s|$)/,
  ]);
  const startCommand = firstMatch(commands, [
    /^npm\s+(?:run\s+)?(?:dev|start)(?:\s|$)/,
    /^pnpm\s+(?:run\s+)?(?:dev|start)(?:\s|$)/,
    /^yarn\s+(?:run\s+)?(?:dev|start)(?:\s|$)/,
    /^bun\s+(?:run\s+)?(?:dev|start)(?:\s|$)/,
    /^(?:npx\s+)?(?:next|vite)\s+(?:dev|start)(?:\s|$)/,
    /^uvicorn\s+/,
    /^flask\s+run(?:\s|$)/,
    /^python(?:3)?\s+[^\n]*(?:app|server|main)\.py(?:\s|$)/,
  ]);

  const urlMatch = markdown.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{2,5}))?(?:\/[^\s)`]*)?/i);
  const expectedUrl = urlMatch?.[0] ?? null;
  const expectedPort = urlMatch?.[1] ? Number(urlMatch[1]) : null;

  return {
    commands,
    installCommand,
    startCommand,
    expectedPort,
    expectedUrl,
    nodeRequirement: extractRuntime(markdown, "node"),
    pythonRequirement: extractRuntime(markdown, "python"),
    copiesEnvExample: commands.some((command) => /(?:cp|copy)\s+\.env(?:\.example|\.sample)\s+\.env\b/i.test(command)),
  };
}

export function npmScriptReferencedByCommand(command: string): string | null {
  const match = command.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)(?:\s|$)/);
  if (!match) return null;
  const script = match[1];
  if (["install", "i", "ci", "add", "exec", "dlx"].includes(script)) return null;
  return script;
}

export function isSafeOnboardingCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;

  const blocked = [
    /\bcurl\b/i,
    /\bwget\b/i,
    /\bssh\b/i,
    /\bscp\b/i,
    /\bgit\s+push\b/i,
    /\bnpm\s+publish\b/i,
    /\b(?:vercel|netlify|flyctl)\s+(?:deploy|--prod)\b/i,
    /\bterraform\s+(?:apply|destroy)\b/i,
    /\bkubectl\b/i,
    /\b(?:aws|gcloud|az)\b/i,
    /\bsudo\b/i,
    /\brm\s+-rf\s+\/(?:\s|$)/i,
    /\b(?:docker|podman)\s+(?:push|login)\b/i,
  ];
  if (blocked.some((pattern) => pattern.test(normalized))) return false;
  if (/[;&|`]/.test(normalized) || /\$\(/.test(normalized) || /(?:^|\s)[<>](?:\s|$)/.test(normalized)) return false;

  const allowed = [
    /^(?:npm|pnpm|yarn|bun)(?:\s|$)/,
    /^(?:npx|pnpx|bunx)\s+(?:next|vite)(?:\s|$)/,
    /^(?:python|python3)\s+-m\s+pip(?:\s|$)/,
    /^pip(?:3)?\s+install(?:\s|$)/,
    /^poetry\s+(?:install|run)(?:\s|$)/,
    /^uv\s+(?:sync|run)(?:\s|$)/,
    /^uvicorn(?:\s|$)/,
    /^flask\s+run(?:\s|$)/,
    /^(?:cp|copy)\s+\.env(?:\.example|\.sample)\s+\.env(?:\s|$)/i,
    /^(?:mkdir|touch)\s+/,
  ];
  return allowed.some((pattern) => pattern.test(normalized));
}
