import assert from "node:assert/strict";
import test from "node:test";
import {
  claimGitHubDelivery,
  confirmGitHubDeliveryClaim,
  releaseGitHubDeliveryClaim,
  type DeliveryClaimConfig,
} from "../lib/github/delivery-claim";

const CONFIG: DeliveryClaimConfig = {
  restUrl: "https://redis.example.test",
  restToken: "secret",
  pendingTtlSeconds: 120,
  retentionTtlSeconds: 604800,
};

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly commands: Array<Array<string | number>> = [];

  readonly fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const command = JSON.parse(String(init?.body ?? "[]")) as Array<string | number>;
    this.commands.push(command);

    if (command[0] === "SET") {
      const key = String(command[1]);
      const value = String(command[2]);
      if (this.values.has(key)) return Response.json({ result: null });
      this.values.set(key, value);
      return Response.json({ result: "OK" });
    }

    if (command[0] === "EVAL") {
      const script = String(command[1]);
      const key = String(command[3]);
      const expected = String(command[4]);
      if (this.values.get(key) !== expected) return Response.json({ result: 0 });

      if (script.includes('redis.call("DEL"')) {
        this.values.delete(key);
        return Response.json({ result: 1 });
      }

      this.values.set(key, String(command[5]));
      return Response.json({ result: 1 });
    }

    return Response.json({ error: `Unsupported command ${String(command[0])}` });
  };
}

test("two concurrent requests can claim one GitHub delivery only once", async () => {
  const redis = new FakeRedis();
  const [first, second] = await Promise.all([
    claimGitHubDelivery("delivery-1", CONFIG, {
      fetchImpl: redis.fetch,
      tokenFactory: () => "token-a",
    }),
    claimGitHubDelivery("delivery-1", CONFIG, {
      fetchImpl: redis.fetch,
      tokenFactory: () => "token-b",
    }),
  ]);

  assert.equal([first.claimed, second.claimed].filter(Boolean).length, 1);
  assert.equal(redis.commands[0][4], CONFIG.pendingTtlSeconds);
  assert.equal(redis.commands[0][5], "NX");
});

test("confirmed delivery keeps blocking redelivery for the retention window", async () => {
  const redis = new FakeRedis();
  const claimed = await claimGitHubDelivery("delivery-2", CONFIG, {
    fetchImpl: redis.fetch,
    tokenFactory: () => "owner-token",
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;

  assert.equal(
    await confirmGitHubDeliveryClaim(claimed.claim, "wrun_123", CONFIG, redis.fetch),
    true,
  );

  const duplicate = await claimGitHubDelivery("delivery-2", CONFIG, {
    fetchImpl: redis.fetch,
    tokenFactory: () => "new-token",
  });
  assert.equal(duplicate.claimed, false);

  const stored = redis.values.get("rod:github-delivery:delivery-2") ?? "";
  assert.match(stored, /"state":"started"/);
  assert.match(stored, /"workflowRunId":"wrun_123"/);
  const confirmCommand = redis.commands.find(
    (command) => command[0] === "EVAL" && String(command[1]).includes('redis.call("SET"'),
  );
  assert.equal(confirmCommand?.[6], CONFIG.retentionTtlSeconds);
});

test("a failed start can release only its own pending claim", async () => {
  const redis = new FakeRedis();
  const claimed = await claimGitHubDelivery("delivery-3", CONFIG, {
    fetchImpl: redis.fetch,
    tokenFactory: () => "owner-token",
  });
  assert.equal(claimed.claimed, true);
  if (!claimed.claimed) return;

  assert.equal(
    await releaseGitHubDeliveryClaim(
      { deliveryId: "delivery-3", token: "other-token" },
      CONFIG,
      redis.fetch,
    ),
    false,
  );
  assert.equal(await releaseGitHubDeliveryClaim(claimed.claim, CONFIG, redis.fetch), true);

  const retry = await claimGitHubDelivery("delivery-3", CONFIG, {
    fetchImpl: redis.fetch,
    tokenFactory: () => "retry-token",
  });
  assert.equal(retry.claimed, true);
});
