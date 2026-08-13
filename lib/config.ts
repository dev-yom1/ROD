function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function githubConfig() {
  return {
    appId: required("GITHUB_APP_ID"),
    privateKey: required("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
  };
}
