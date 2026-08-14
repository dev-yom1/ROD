function isNonRuntimePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)(?:test|tests|__tests__|examples?|fixtures?)(?:\/|$)/.test(normalized)
    || /\.(?:test|spec)\.[^.\/]+$/.test(normalized);
}

function sourceFragment(line: string): { path: string | null; source: string } {
  const match = line.match(/^(.+?):\d+:(.*)$/);
  if (!match) return { path: null, source: line };
  return { path: match[1], source: match[2] };
}

function isCommentOnly(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.startsWith("//")
    || trimmed.startsWith("#")
    || trimmed.startsWith("/*")
    || trimmed.startsWith("*");
}

export function parseEnvScanOutput(output: string): string[] {
  const vars = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /(?:os\.)?getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
    /os\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
    /os\.environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  ];

  for (const line of output.split("\n")) {
    const { path, source } = sourceFragment(line);
    if (path && isNonRuntimePath(path)) continue;
    if (isCommentOnly(source)) continue;
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) vars.add(match[1]);
    }
  }
  return [...vars].sort();
}
