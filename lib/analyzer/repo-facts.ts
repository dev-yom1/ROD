import type { PackageManager, RepoFacts } from "./types";

export interface RepoMetadataInput {
  packageJson: string | null;
  pyproject: string | null;
  nvmrc: string | null;
  nodeVersion: string | null;
  pythonVersion: string | null;
  lockfiles: string[];
  envExample: string | null;
  requiredEnv?: string[];
}

interface PackageJsonShape {
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
}

function safeJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function detectPackageManager(pkg: PackageJsonShape | null, lockfiles: string[]): PackageManager {
  const declared = pkg?.packageManager?.split("@")[0];
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") return declared;
  if (lockfiles.includes("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.includes("yarn.lock")) return "yarn";
  if (lockfiles.includes("bun.lock") || lockfiles.includes("bun.lockb")) return "bun";
  if (lockfiles.includes("package-lock.json")) return "npm";
  return null;
}

function inferInstallCommand(manager: PackageManager, hasPackageJson: boolean, hasPyproject: boolean, lockfiles: string[]): string | null {
  if (hasPackageJson) {
    if (manager === "pnpm") return "pnpm install --frozen-lockfile";
    if (manager === "yarn") return "yarn install --immutable";
    if (manager === "bun") return "bun install --frozen-lockfile";
    return lockfiles.includes("package-lock.json") ? "npm ci" : "npm install";
  }
  if (hasPyproject) {
    if (manager === "poetry") return "poetry install";
    if (manager === "uv") return "uv sync";
    return "python -m pip install -e .";
  }
  return null;
}

function extractPythonRequirement(pyproject: string | null, pythonVersion: string | null): string | null {
  if (pythonVersion?.trim()) return pythonVersion.trim();
  return pyproject?.match(/requires-python\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
}

function parseEnvExample(text: string | null): string[] {
  if (!text) return [];
  const vars = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (match) vars.add(match[1]);
  }
  return [...vars].sort();
}

export function buildRepoFacts(input: RepoMetadataInput): RepoFacts {
  const pkg = safeJson<PackageJsonShape>(input.packageJson);
  let manager = detectPackageManager(pkg, input.lockfiles);
  if (!pkg && input.pyproject) {
    if (/\[tool\.poetry\]/.test(input.pyproject)) manager = "poetry";
    else if (/\[tool\.uv\]|uv\.lock/.test(input.pyproject) || input.lockfiles.includes("uv.lock")) manager = "uv";
    else manager = "pip";
  }

  const scripts = pkg?.scripts ?? {};
  const effectiveManager = manager ?? "npm";
  const scriptCommand = (script: string) => `${effectiveManager}${effectiveManager === "npm" ? " run" : ""} ${script}`;
  const inferredStartCommand = scripts.dev
    ? scriptCommand("dev")
    : scripts.start
      ? scriptCommand("start")
      : null;

  return {
    packageManager: manager,
    scripts,
    nodeRequirement: input.nvmrc?.trim() || input.nodeVersion?.trim() || pkg?.engines?.node || null,
    pythonRequirement: extractPythonRequirement(input.pyproject, input.pythonVersion),
    inferredInstallCommand: inferInstallCommand(manager, Boolean(pkg), Boolean(input.pyproject), input.lockfiles),
    inferredStartCommand,
    requiredEnv: [...new Set(input.requiredEnv ?? [])].sort(),
    envExampleVars: parseEnvExample(input.envExample),
  };
}
