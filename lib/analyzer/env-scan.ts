export function parseEnvScanOutput(output: string): string[] {
  const vars = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /(?:os\.)?getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
    /os\.environ(?:\.get)?\(?['"]([A-Z][A-Z0-9_]*)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) vars.add(match[1]);
  }
  return [...vars].sort();
}
