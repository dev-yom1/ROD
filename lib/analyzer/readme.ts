import type { ReadmePlan, ReadmeStep, ReadmeStepRole } from "./types";

const SHELL_FENCE_START = /^\s*```(?:bash|sh|shell|zsh)\s*$/i;
const FENCE_END = /^\s*```\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const ENV_COPY = /^(?:cp|copy)\s+\.env(?:\.example|\.sample)\s+\.env(?:\.local|\.development\.local)?\s*$/i;

const INSTALL_PATTERNS = [
  /^(npm\s+(?:ci|install|i))(?:\s|$)/,
  /^pnpm\s+(?:install|i)(?:\s|$)/,
  /^yarn(?:\s+install)?(?:\s|$)/,
  /^bun\s+install(?:\s|$)/,
  /^(?:python\s+-m\s+)?pip\s+install(?:\s|$)/,
  /^poetry\s+install(?:\s|$)/,
  /^uv\s+sync(?:\s|$)/,
];

const START_PATTERNS = [
  /^npm\s+(?:run\s+)?(?:dev|start)(?:\s|$)/,
  /^pnpm\s+(?:run\s+)?(?:dev|start)(?:\s|$)/,
  /^yarn\s+(?:run\s+)?(?:dev|start)(?:\s|$)/,
  /^bun\s+(?:run\s+)?(?:dev|start)(?:\s|$)/,
  /^(?:npx\s+)?(?:next|vite)\s+(?:dev|start)(?:\s|$)/,
  /^uvicorn\s+/,
  /^flask\s+run(?:\s|$)/,
  /^python(?:3)?\s+[^\n]*(?:app|server|main)\.py(?:\s|$)/,
];

type SectionBucket = {
  key: number;
  section: string | null;
  firstFenceIndex: number;
  lines: string[];
  steps: ReadmeStep[];
};

function cleanShellLine(line: string): string | null {
  const cleaned = line.trim().replace(/^\$\s+/, "");
  if (!cleaned || cleaned.startsWith("#")) return null;
  if (/^(>|\.\.\.|output:)/i.test(cleaned)) return null;
  return cleaned;
}

function parseLogicalCommands(lines: Array<{ text: string; line: number }>): Array<{ command: string; line: number }> {
  const commands: Array<{ command: string; line: number }> = [];
  let pending = "";
  let pendingLine = 0;

  for (const item of lines) {
    const cleaned = cleanShellLine(item.text);
    if (!cleaned) continue;
    if (!pending) pendingLine = item.line;

    const continued = /\\\s*$/.test(cleaned);
    const piece = cleaned.replace(/\\\s*$/, "").trim();
    pending = `${pending}${pending ? " " : ""}${piece}`.trim();
    if (continued) continue;

    if (pending) commands.push({ command: pending, line: pendingLine });
    pending = "";
    pendingLine = 0;
  }

  if (pending) commands.push({ command: pending, line: pendingLine });
  return commands;
}

function commandRole(command: string): ReadmeStepRole {
  if (INSTALL_PATTERNS.some((pattern) => pattern.test(command))) return "install";
  if (START_PATTERNS.some((pattern) => pattern.test(command))) return "start";
  if (/^(?:cp|copy|mkdir|touch)\s+/i.test(command)) return "preparation";
  return "other";
}

function parseSections(markdown: string): SectionBucket[] {
  const lines = markdown.split("\n");
  const buckets: SectionBucket[] = [];
  let sectionKey = 0;
  let fenceIndex = 0;
  let current: SectionBucket = {
    key: sectionKey,
    section: null,
    firstFenceIndex: Number.MAX_SAFE_INTEGER,
    lines: [],
    steps: [],
  };
  buckets.push(current);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(HEADING);
    if (heading && heading[1].length <= 2) {
      sectionKey += 1;
      current = {
        key: sectionKey,
        section: heading[2].replace(/\s+#+\s*$/, "").trim(),
        firstFenceIndex: Number.MAX_SAFE_INTEGER,
        lines: [line],
        steps: [],
      };
      buckets.push(current);
      continue;
    }

    current.lines.push(line);
    if (!SHELL_FENCE_START.test(line)) continue;

    const thisFenceIndex = fenceIndex;
    fenceIndex += 1;
    current.firstFenceIndex = Math.min(current.firstFenceIndex, thisFenceIndex);
    const fenceLines: Array<{ text: string; line: number }> = [];

    for (index += 1; index < lines.length; index += 1) {
      const inner = lines[index];
      current.lines.push(inner);
      if (FENCE_END.test(inner)) break;
      fenceLines.push({ text: inner, line: index + 1 });
    }

    const logical = parseLogicalCommands(fenceLines);
    logical.forEach((item, occurrence) => {
      current.steps.push({
        id: `s${current.key}:f${thisFenceIndex}:l${item.line}:o${occurrence}`,
        command: item.command,
        section: current.section,
        fenceIndex: thisFenceIndex,
        line: item.line,
        role: commandRole(item.command),
      });
    });
  }

  return buckets.filter((bucket) => bucket.steps.length > 0);
}

function flowScore(bucket: SectionBucket): number {
  const hasStart = bucket.steps.some((step) => step.role === "start");
  const hasInstall = bucket.steps.some((step) => step.role === "install");
  const hasPreparation = bucket.steps.some((step) => step.role === "preparation");
  const sectionBonus = /\b(?:getting started|quick ?start|development|develop|local|setup|install|run)\b/i.test(bucket.section ?? "") ? 20 : 0;
  return (hasStart ? 100 : 0) + (hasInstall ? 30 : 0) + (hasPreparation ? 5 : 0) + sectionBonus;
}

function selectOnboardingFlow(markdown: string): SectionBucket | null {
  const buckets = parseSections(markdown);
  if (!buckets.length) return null;
  return [...buckets].sort((a, b) => {
    const score = flowScore(b) - flowScore(a);
    if (score !== 0) return score;
    return a.firstFenceIndex - b.firstFenceIndex;
  })[0];
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
  const flow = selectOnboardingFlow(markdown);
  const steps = flow?.steps ?? [];
  const installStep = steps.find((step) => step.role === "install") ?? null;
  const startStep = steps.find((step) => step.role === "start") ?? null;
  const flowText = flow?.lines.join("\n") ?? markdown;
  const urlMatch = flowText.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{2,5}))?(?:\/[^\s)`]*)?/i);
  const expectedUrl = urlMatch?.[0] ?? null;
  const expectedPort = urlMatch?.[1] ? Number(urlMatch[1]) : null;

  return {
    steps,
    commands: steps.map((step) => step.command),
    installCommand: installStep?.command ?? null,
    startCommand: startStep?.command ?? null,
    expectedPort,
    expectedUrl,
    nodeRequirement: extractRuntime(markdown, "node"),
    pythonRequirement: extractRuntime(markdown, "python"),
    copiesEnvExample: steps.some((step) => ENV_COPY.test(step.command)),
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
