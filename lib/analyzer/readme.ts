import type {
  EnvTemplateName,
  ReadmePlan,
  ReadmeStep,
  ReadmeStepRole,
  RuntimeKind,
} from "./types";

const FENCE_START = /^\s*```([A-Za-z0-9_-]*)\s*$/;
const FENCE_END = /^\s*```\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh"]);
const ENV_COPY = /^(?:cp|copy)\s+(\.env(?:\.example|\.sample))\s+\.env(?:\.local|\.development\.local)?\s*$/i;

export interface ParsedOnboardingCommand {
  role: ReadmeStepRole;
  safe: boolean;
  executable: boolean;
  runtime: RuntimeKind | null;
  envCopySource: EnvTemplateName | null;
  portHints: number[];
}

type LogicalCommand = { command: string; line: number; malformed: boolean };
type ParsedFence = {
  index: number;
  startLine: number;
  endLine: number;
  steps: ReadmeStep[];
};
type SectionBucket = {
  key: number;
  section: string | null;
  startLine: number;
  endLine: number;
  lines: Array<{ line: number; text: string }>;
  fences: ParsedFence[];
  steps: ReadmeStep[];
};
type SelectedFlow = {
  steps: ReadmeStep[];
  text: string;
  sections: string[];
  issue: string | null;
};

function cleanShellLine(line: string): string | null {
  const cleaned = line.trim().replace(/^\$\s+/, "");
  if (!cleaned || cleaned.startsWith("#")) return null;
  if (/^(>|\.\.\.|output:)/i.test(cleaned)) return null;
  return cleaned;
}

function parseLogicalCommands(lines: Array<{ text: string; line: number }>): LogicalCommand[] {
  const commands: LogicalCommand[] = [];
  let pendingParts: string[] = [];
  let pendingLine = 0;

  for (const item of lines) {
    const cleaned = cleanShellLine(item.text);
    if (!cleaned) continue;
    if (!pendingParts.length) pendingLine = item.line;

    const continued = /\\\s*$/.test(cleaned);
    pendingParts.push(cleaned.replace(/\\\s*$/, "").trim());
    if (continued) continue;

    commands.push({ command: pendingParts.join(" ").trim(), line: pendingLine, malformed: false });
    pendingParts = [];
    pendingLine = 0;
  }

  if (pendingParts.length) {
    commands.push({
      command: `${pendingParts.join(" ").trim()} \\`,
      line: pendingLine,
      malformed: true,
    });
  }
  return commands;
}

function portHints(command: string): number[] {
  const ports = new Set<number>();
  const patterns = [
    /(?:^|\s)--port(?:=|\s+)(\d{2,5})(?=\s|$)/gi,
    /(?:^|\s)-p\s+(\d{2,5})(?=\s|$)/gi,
    /(?:^|\s)PORT=(\d{2,5})(?=\s|$)/g,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
    }
  }
  return [...ports];
}

function stripLeadingEnvAssignments(command: string): string {
  let remaining = command.trim();
  while (true) {
    const match = remaining.match(/^[A-Z_][A-Z0-9_]*=[^\s]+\s+(.+)$/);
    if (!match) return remaining;
    remaining = match[1].trim();
  }
}

function commandToolFamily(command: string): string | null {
  const body = stripLeadingEnvAssignments(command);
  const executable = body.match(/^([A-Za-z0-9_.+-]+)/)?.[1]?.toLowerCase() ?? null;
  if (!executable) return null;
  if (executable === "npx") return "npm";
  if (executable === "pnpx") return "pnpm";
  if (executable === "bunx") return "bun";
  if (["python", "python3", "pip", "pip3"].includes(executable)) return "pip";
  return executable;
}

function blockedShellSyntax(command: string): boolean {
  if (/[;&|`]/.test(command) || /\$\(/.test(command) || /(?:^|\s)[<>](?:\s|$)/.test(command)) return true;
  return [
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
  ].some((pattern) => pattern.test(command));
}

function nestedPythonStart(body: string): boolean {
  return /^(?:uvicorn\b|flask\s+run\b|(?:python|python3)\s+[^\n]*(?:app|server|main)\.py(?:\s|$))/i.test(body);
}

function wrappedNodeRole(body: string): ReadmeStepRole | null {
  const wrapped = body.match(/^(?:npx|pnpx|bunx)\s+(next|vite)(?:\s+([^\s]+))?(?:\s|$)/i);
  if (!wrapped) return null;
  const framework = wrapped[1].toLowerCase();
  const subcommand = wrapped[2]?.toLowerCase() ?? null;
  if (framework === "next") return subcommand === "dev" || subcommand === "start" ? "start" : "other";
  if (framework === "vite") return subcommand === null || subcommand === "dev" || subcommand === "serve" ? "start" : "other";
  return "other";
}

export function parseOnboardingCommand(command: string, malformed = false): ParsedOnboardingCommand {
  const hints = portHints(command);
  if (malformed || !command.trim() || blockedShellSyntax(command)) {
    return { role: "other", safe: false, executable: false, runtime: null, envCopySource: null, portHints: hints };
  }

  const body = stripLeadingEnvAssignments(command);
  const copy = body.match(ENV_COPY);
  if (copy) {
    return {
      role: "preparation",
      safe: true,
      executable: true,
      runtime: null,
      envCopySource: copy[1].toLowerCase() as EnvTemplateName,
      portHints: hints,
    };
  }
  if (/^(?:mkdir|touch)\s+/i.test(body)) {
    return { role: "preparation", safe: true, executable: true, runtime: null, envCopySource: null, portHints: hints };
  }

  const nodeStart = [
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)(?:\s|$)/i,
  ].some((pattern) => pattern.test(body));
  if (nodeStart) {
    return { role: "start", safe: true, executable: true, runtime: "node", envCopySource: null, portHints: hints };
  }

  const wrappedNode = wrappedNodeRole(body);
  if (wrappedNode) {
    return { role: wrappedNode, safe: true, executable: true, runtime: "node", envCopySource: null, portHints: hints };
  }

  if (nestedPythonStart(body)) {
    return { role: "start", safe: true, executable: true, runtime: "python", envCopySource: null, portHints: hints };
  }
  const wrappedPython = body.match(/^(?:poetry|uv)\s+run\s+(.+)$/i);
  if (wrappedPython && nestedPythonStart(wrappedPython[1])) {
    return { role: "start", safe: true, executable: true, runtime: "python", envCopySource: null, portHints: hints };
  }

  const nodeInstall = [
    /^npm\s+(?:ci|install|i)(?:\s|$)/i,
    /^pnpm\s+(?:install|i)(?:\s|$)/i,
    /^yarn\s*$/i,
    /^yarn\s+install(?:\s|$)/i,
    /^yarn\s+--(?:immutable|immutable-cache|check-cache|frozen-lockfile)(?:[=\s]|$)/i,
    /^bun\s+install(?:\s|$)/i,
  ].some((pattern) => pattern.test(body));
  if (nodeInstall) {
    return { role: "install", safe: true, executable: true, runtime: "node", envCopySource: null, portHints: hints };
  }

  const pythonInstall = [
    /^(?:python|python3)\s+-m\s+pip\s+install(?:\s|$)/i,
    /^pip(?:3)?\s+install(?:\s|$)/i,
    /^poetry\s+install(?:\s|$)/i,
    /^uv\s+sync(?:\s|$)/i,
  ].some((pattern) => pattern.test(body));
  if (pythonInstall) {
    return { role: "install", safe: true, executable: true, runtime: "python", envCopySource: null, portHints: hints };
  }

  if (/^(?:npm|pnpm|yarn|bun)(?:\s|$)/i.test(body)) {
    return { role: "other", safe: true, executable: true, runtime: "node", envCopySource: null, portHints: hints };
  }
  if (/^(?:poetry\s+run|uv\s+run)(?:\s|$)/i.test(body)) {
    return { role: "other", safe: true, executable: true, runtime: "python", envCopySource: null, portHints: hints };
  }

  return { role: "other", safe: false, executable: false, runtime: null, envCopySource: null, portHints: hints };
}

function parseSections(markdown: string): SectionBucket[] {
  const lines = markdown.split("\n");
  const buckets: SectionBucket[] = [];
  let sectionKey = 0;
  let fenceIndex = 0;
  let current: SectionBucket = {
    key: sectionKey,
    section: null,
    startLine: 1,
    endLine: lines.length,
    lines: [],
    fences: [],
    steps: [],
  };
  buckets.push(current);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(HEADING);
    if (heading && heading[1].length <= 2) {
      current.endLine = index;
      sectionKey += 1;
      current = {
        key: sectionKey,
        section: heading[2].replace(/\s+#+\s*$/, "").trim(),
        startLine: index + 1,
        endLine: lines.length,
        lines: [{ line: index + 1, text: line }],
        fences: [],
        steps: [],
      };
      buckets.push(current);
      continue;
    }

    current.lines.push({ line: index + 1, text: line });
    const fenceStart = line.match(FENCE_START);
    if (!fenceStart) continue;

    const language = fenceStart[1].toLowerCase();
    const thisFenceIndex = fenceIndex;
    fenceIndex += 1;
    const startLine = index + 1;
    const fenceLines: Array<{ text: string; line: number }> = [];

    for (index += 1; index < lines.length; index += 1) {
      const inner = lines[index];
      current.lines.push({ line: index + 1, text: inner });
      if (FENCE_END.test(inner)) break;
      if (SHELL_LANGS.has(language)) fenceLines.push({ text: inner, line: index + 1 });
    }

    const logical = SHELL_LANGS.has(language) ? parseLogicalCommands(fenceLines) : [];
    const steps = logical.map((item, occurrence): ReadmeStep => {
      const parsed = parseOnboardingCommand(item.command, item.malformed);
      return {
        id: `s${current.key}:f${thisFenceIndex}:l${item.line}:o${occurrence}`,
        command: item.command,
        section: current.section,
        fenceIndex: thisFenceIndex,
        line: item.line,
        role: parsed.role,
        malformed: item.malformed || undefined,
      };
    });
    current.steps.push(...steps);
    current.fences.push({ index: thisFenceIndex, startLine, endLine: Math.min(index + 1, lines.length), steps });
  }

  current.endLine = lines.length;
  return buckets.filter((bucket) => bucket.steps.length > 0);
}

function sectionBonus(section: string | null): number {
  if (!section) return 0;
  if (/\b(?:development|develop|run|serve|local|quick ?start|getting started)\b/i.test(section)) return 30;
  if (/\b(?:installation|install|setup|environment|prerequisites?|requirements?)\b/i.test(section)) return 15;
  return 0;
}

function startBucketScore(bucket: SectionBucket): number {
  const starts = bucket.steps.filter((step) => step.role === "start").length;
  const installs = bucket.steps.filter((step) => step.role === "install").length;
  return starts * 100 + installs * 10 + sectionBonus(bucket.section);
}

function isSetupBucket(bucket: SectionBucket): boolean {
  if (!bucket.section) return bucket.steps.some((step) => step.role === "install" || step.role === "preparation");
  return /\b(?:installation|install|setup|environment|prerequisites?|requirements?|getting started|quick ?start)\b/i.test(bucket.section);
}

function explicitVariantFamily(bucket: SectionBucket): string | null {
  const section = bucket.section?.toLowerCase() ?? "";
  if (!section) return null;
  const families = ["npm", "pnpm", "yarn", "bun", "pip", "poetry", "uv"];
  for (const family of families) {
    const variant = new RegExp(`(?:\\b(?:with|using|for)\\s+${family}\\b|\\b${family}\\s+(?:installation|install|setup)\\b|^(?:${family})$)`, "i");
    if (variant.test(section)) return family;
  }
  return null;
}

function proseThroughStartFence(markdown: string, bucket: SectionBucket, terminalFence: ParsedFence): string[] {
  const lines = markdown.split("\n");
  let endLine = terminalFence.endLine;
  for (let lineNumber = terminalFence.endLine + 1; lineNumber <= bucket.endLine; lineNumber += 1) {
    const text = lines[lineNumber - 1] ?? "";
    if (HEADING.test(text) || FENCE_START.test(text)) break;
    endLine = lineNumber;
  }
  return bucket.lines.filter((item) => item.line <= endLine).map((item) => item.text);
}

function selectOnboardingFlow(markdown: string): SelectedFlow | null {
  const buckets = parseSections(markdown);
  if (!buckets.length) return null;

  const startBuckets = buckets.filter((bucket) => bucket.steps.some((step) => step.role === "start"));
  const terminal = (startBuckets.length ? startBuckets : buckets)
    .slice()
    .sort((a, b) => {
      const score = startBucketScore(b) - startBucketScore(a);
      if (score !== 0) return score;
      return a.startLine - b.startLine;
    })[0];
  if (!terminal) return null;

  const terminalFence = terminal.fences.find((fence) => fence.steps.some((step) => step.role === "start"))
    ?? terminal.fences[terminal.fences.length - 1];
  const terminalStarts = terminalFence.steps.filter((step) => step.role === "start");
  const terminalStart = terminalStarts[0] ?? terminal.steps.find((step) => step.role === "start") ?? null;

  if (!terminalStart) {
    const terminalSteps = terminal.fences
      .filter((fence) => fence.index <= terminalFence.index)
      .flatMap((fence) => fence.steps);
    return {
      steps: terminalSteps,
      text: proseThroughStartFence(markdown, terminal, terminalFence).join("\n"),
      sections: terminal.section ? [terminal.section] : [],
      issue: null,
    };
  }

  const setupCandidates = buckets.filter((bucket) => (
    bucket.startLine < terminal.startLine && isSetupBucket(bucket)
  ));
  const installBuckets = setupCandidates.filter((bucket) => bucket.steps.some((step) => step.role === "install"));
  const variantBuckets = installBuckets.filter((bucket) => explicitVariantFamily(bucket) !== null);
  const terminalFamily = commandToolFamily(terminalStart.command);
  let selectedVariant: SectionBucket | null = null;
  let flowIssue: string | null = null;

  if (variantBuckets.length > 1) {
    const matching = variantBuckets.filter((bucket) => explicitVariantFamily(bucket) === terminalFamily);
    if (matching.length === 1) {
      selectedVariant = matching[0];
    } else {
      flowIssue = `ROD found multiple explicit setup variants before the selected start flow and could not choose exactly one for ${terminalFamily ?? "the start command"}.`;
    }
  }

  if (terminalStarts.length > 1) {
    flowIssue = "ROD found multiple start commands in the same README shell fence and cannot safely infer which alternative onboarding path to execute.";
  }

  const setupBuckets = setupCandidates.filter((bucket) => {
    if (variantBuckets.length <= 1) return true;
    if (!variantBuckets.includes(bucket)) return true;
    return bucket === selectedVariant;
  });
  const setupSteps = setupBuckets.flatMap((bucket) => bucket.steps);
  const terminalSteps = terminal.fences
    .filter((fence) => fence.index <= terminalFence.index)
    .flatMap((fence) => fence.steps);
  const steps = [...setupSteps, ...terminalSteps];
  const textParts = [
    ...setupBuckets.flatMap((bucket) => bucket.lines.map((item) => item.text)),
    ...proseThroughStartFence(markdown, terminal, terminalFence),
  ];
  const sections = [...setupBuckets, terminal]
    .map((bucket) => bucket.section)
    .filter((section): section is string => Boolean(section));
  return { steps, text: textParts.join("\n"), sections, issue: flowIssue };
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

    if (/\b(?:or\s+(?:newer|later)|and\s+(?:newer|later))\b/i.test(tail) || /\+$/.test(matches[0])) {
      return `>=${matches[0].replace(/\+$/, "").replace(/^[=\s]+/, "")}`;
    }

    const alternatives = tail.split(/\s*(?:\|\||\bor\b)\s*/i);
    if (alternatives.length > 1) {
      const groups = alternatives.map((alternative) => (
        [...alternative.matchAll(token)].map((match) => match[0].trim()).filter(Boolean).join(" ")
      ));
      if (groups.every(Boolean)) return groups.join(" || ");
    }
    return matches.join(" ").replace(/\s+/g, " ");
  }
  return null;
}

export function extractReadmePlan(markdown: string): ReadmePlan {
  const flow = selectOnboardingFlow(markdown);
  const steps = flow?.steps ?? [];
  const installStep = steps.find((step) => step.role === "install") ?? null;
  const startStep = steps.find((step) => step.role === "start") ?? null;
  const flowText = flow?.text ?? markdown;
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
    nodeRequirement: extractRuntime(flowText, "node"),
    pythonRequirement: extractRuntime(flowText, "python"),
    copiesEnvExample: steps.some((step) => parseOnboardingCommand(step.command, step.malformed).envCopySource !== null),
    flowSections: flow?.sections ?? [],
    flowIssue: flow?.issue ?? null,
  };
}

export function readmeRuntimeKind(plan: ReadmePlan): RuntimeKind | null {
  const start = plan.steps.find((step) => step.role === "start");
  const startRuntime = start ? parseOnboardingCommand(start.command, start.malformed).runtime : null;
  if (startRuntime) return startRuntime;
  const install = plan.steps.find((step) => step.role === "install");
  return install ? parseOnboardingCommand(install.command, install.malformed).runtime : null;
}

export function npmScriptReferencedByCommand(command: string): string | null {
  const body = stripLeadingEnvAssignments(command);
  const match = body.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)(?:\s|$)/);
  if (!match) return null;
  const script = match[1];
  if (["install", "i", "ci", "add", "exec", "dlx"].includes(script)) return null;
  return script;
}

export function isSafeOnboardingCommand(command: string): boolean {
  return parseOnboardingCommand(command).safe;
}
