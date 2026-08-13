function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function requiredPositiveInteger(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function githubConfig() {
  return {
    appId: requiredPositiveInteger("GITHUB_APP_ID"),
    privateKey: required("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
  };
}
