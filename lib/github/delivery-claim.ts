export interface DeliveryClaimConfig {
  restUrl: string;
  restToken: string;
  pendingTtlSeconds: number;
  retentionTtlSeconds: number;
}

export type GitHubDeliveryClaim = {
  deliveryId: string;
  token: string;
};

type RedisResponse = {
  result?: unknown;
  error?: string;
};

type FetchLike = typeof fetch;

const KEY_PREFIX = "rod:github-delivery:";

function claimKey(deliveryId: string): string {
  const normalized = deliveryId.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("Invalid GitHub delivery ID");
  }
  return `${KEY_PREFIX}${normalized}`;
}

function pendingValue(token: string): string {
  return JSON.stringify({ state: "pending", token });
}

function startedValue(workflowRunId: string): string {
  return JSON.stringify({ state: "started", workflowRunId });
}

async function redisCommand(
  config: DeliveryClaimConfig,
  command: Array<string | number>,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const response = await fetchImpl(config.restUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.restToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Delivery claim store returned HTTP ${response.status}`);
  }

  const payload = await response.json() as RedisResponse;
  if (payload.error) throw new Error(`Delivery claim store error: ${payload.error}`);
  return payload.result;
}

export async function claimGitHubDelivery(
  deliveryId: string,
  config: DeliveryClaimConfig,
  options: {
    fetchImpl?: FetchLike;
    tokenFactory?: () => string;
  } = {},
): Promise<{ claimed: true; claim: GitHubDeliveryClaim } | { claimed: false }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = (options.tokenFactory ?? (() => crypto.randomUUID()))();
  const result = await redisCommand(
    config,
    [
      "SET",
      claimKey(deliveryId),
      pendingValue(token),
      "EX",
      config.pendingTtlSeconds,
      "NX",
    ],
    fetchImpl,
  );

  if (result === "OK") {
    return { claimed: true, claim: { deliveryId: deliveryId.trim(), token } };
  }
  if (result === null) return { claimed: false };
  throw new Error(`Unexpected delivery claim response: ${String(result)}`);
}

export async function confirmGitHubDeliveryClaim(
  claim: GitHubDeliveryClaim,
  workflowRunId: string,
  config: DeliveryClaimConfig,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const script = [
    'if redis.call("GET", KEYS[1]) == ARGV[1] then',
    '  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])',
    "  return 1",
    "end",
    "return 0",
  ].join("\n");

  const result = await redisCommand(
    config,
    [
      "EVAL",
      script,
      1,
      claimKey(claim.deliveryId),
      pendingValue(claim.token),
      startedValue(workflowRunId),
      config.retentionTtlSeconds,
    ],
    fetchImpl,
  );
  return result === 1 || result === "1";
}

export async function releaseGitHubDeliveryClaim(
  claim: GitHubDeliveryClaim,
  config: DeliveryClaimConfig,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const script = [
    'if redis.call("GET", KEYS[1]) == ARGV[1] then',
    '  return redis.call("DEL", KEYS[1])',
    "end",
    "return 0",
  ].join("\n");

  const result = await redisCommand(
    config,
    ["EVAL", script, 1, claimKey(claim.deliveryId), pendingValue(claim.token)],
    fetchImpl,
  );
  return result === 1 || result === "1";
}
