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

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requiredHttpsUrl(name: string): string {
  const raw = required(name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use https`);
  return url.toString().replace(/\/$/, "");
}

export function githubConfig() {
  return {
    appId: requiredPositiveInteger("GITHUB_APP_ID"),
    privateKey: required("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
  };
}

export function deliveryClaimConfig() {
  const pendingTtlSeconds = positiveInteger("ROD_DELIVERY_PENDING_TTL_SECONDS", 120);
  const retentionTtlSeconds = positiveInteger("ROD_DELIVERY_CLAIM_TTL_SECONDS", 604800);
  if (retentionTtlSeconds <= pendingTtlSeconds) {
    throw new Error("ROD_DELIVERY_CLAIM_TTL_SECONDS must exceed ROD_DELIVERY_PENDING_TTL_SECONDS");
  }

  return {
    restUrl: requiredHttpsUrl("UPSTASH_REDIS_REST_URL"),
    restToken: required("UPSTASH_REDIS_REST_TOKEN"),
    pendingTtlSeconds,
    retentionTtlSeconds,
  };
}
