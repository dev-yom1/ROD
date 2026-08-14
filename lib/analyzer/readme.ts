import type { ReadmePlan } from "./types";

const SHELL_FENCE = /```(?:bash|sh|shell|zsh|console)?\s*\n([\s\S]*?)```/gi;
const ENV_COPY = /^(?:cp|copy)\s+\.env(?:\.example|\.sample)\s+\.env(?:\.local|\.development\.local)?\s*$/i;

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
  const name = runtime === "node" ? /\bNode(?:\.js)?\b/i : /\bPython\b/i;
  const token = /(?:>=|<=|>|<|\^|~=|~|==|=)?\s*v?\d+(?:\.(?:\d+|x|\*)){0,2}\+?/gi;

  for (const line of markdown.split("\n")) {
    const runtimeMatch = name.exec(line);
    if (!runtimeMatch) continue;
    const tail = line.slice(runtimeMatch.index + runtimeMatch[0].length);
    const matches = [...tail.matchAll(token)].map((match) => match[0].trim()).filter(Boolean);
    if (!matches.length) continue;

    let requirement = matches.join(" ").replace(/\s+/g, " ");
    if (/\+$/.test(requirement) || /\b(?:or\s+(?:newer|later)|and\s+(?:newer|later))\b/i.test(tail)) {
      requirement = `>=${requirement.replace(/\+$/, "").replace(/^[=\s]+/, "")}`;
    }
    return requirement;
  }
  return null;
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
    copiesEnvExample: commands.some((command) => ENV_COPY.test(command)),
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
    ENV_COPY,
    /^(?:mkdir|touch)\s+/,
  ];
  return allowed.some((pattern) => pattern.test(normalized));
}
