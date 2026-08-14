export function parseEnvScanOutput(output: string): string[] {
  const vars = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /(?:os\.)?getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
    /os\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
    /os\.environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) vars.add(match[1]);
  }
  return [...vars].sort();
}
