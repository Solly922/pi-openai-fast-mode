import { describe, expect, it, vi } from "vitest";
import {
  createFastCodexStream,
  fastCodexModels,
  registerFastCodexProvider,
} from "../src/fast-provider";

function codexModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai-codex",
    id,
    name: id.toUpperCase(),
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    thinkingLevelMap: { high: "high", xhigh: "xhigh" },
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    contextWindow: 272000,
    maxTokens: 128000,
    ...overrides,
  } as any;
}

describe("fastCodexModels", () => {
  it("lists GPT 5.4+ Codex chat models with priority pricing", () => {
    const models = fastCodexModels({
      getAll: () => [
        codexModel("gpt-6.1-sol"),
        codexModel("gpt-5.5"),
        codexModel("gpt-5.3"),
        codexModel("gpt-6-astra", { provider: "openai" }),
        codexModel("gpt-6-luna", { api: "codex-images" }),
        codexModel("gpt-6-sol", {
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            tiers: [
              {
                inputTokensAbove: 272000,
                input: 2,
                output: 4,
                cacheRead: 0,
                cacheWrite: 0,
              },
            ],
          },
        }),
      ],
    });

    expect(models.map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-5.5",
      "gpt-6-sol",
    ]);
    expect(models[0]).toEqual({
      id: "gpt-6.1-sol",
      name: "GPT-6.1-SOL (fast)",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      thinkingLevelMap: { high: "high", xhigh: "xhigh" },
      input: ["text", "image"],
      inputLimits: undefined,
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      promptCache: undefined,
      contextWindow: 272000,
      maxTokens: 128000,
      compat: undefined,
    });
    // pi-ai bills gpt-5.5 priority at 2.5x.
    expect(models[1]!.cost).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.25,
      cacheWrite: 6.25,
    });
    expect(models[2]!.cost).toEqual({
      input: 2,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [
        {
          inputTokensAbove: 272000,
          input: 4,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    });
  });
});

describe("createFastCodexStream", () => {
  const model = codexModel("gpt-6.1-sol", { provider: "openai-codex-fast" });
  const done = { type: "done", reason: "stop", message: { role: "assistant" } };

  // A Codex API stand-in that records its options and yields one event.
  function fakeCodex() {
    const calls: any[] = [];
    const codex = {
      streamSimple: vi.fn((...args: any[]) => {
        calls.push(args);
        return (async function* () {
          yield done;
        })();
      }),
      stream: vi.fn(),
    } as any;
    return { codex, calls };
  }

  async function drain(stream: AsyncIterable<unknown>) {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it("uses the Codex login and puts every request on priority", async () => {
    const { codex, calls } = fakeCodex();
    const piHook = vi.fn(async (payload: any) => ({
      ...payload,
      hooked: true,
    }));
    const stream = createFastCodexStream(
      { getApiKeyForProvider: async (provider) => `${provider}-token` },
      codex,
    );

    expect(
      await drain(
        stream(model, { messages: [] } as any, {
          apiKey: "placeholder",
          onPayload: piHook,
        }),
      ),
    ).toEqual([done]);

    const [calledModel, , options] = calls[0];
    expect(calledModel).toBe(model);
    expect(options.apiKey).toBe("openai-codex-token");
    // Pi's hooks run first, then the tier goes on.
    expect(await options.onPayload({ model: "gpt-6.1-sol" }, model)).toEqual({
      model: "gpt-6.1-sol",
      hooked: true,
      service_tier: "priority",
    });
  });

  it("adds priority without Pi's hook, as compaction requests do", async () => {
    const { codex, calls } = fakeCodex();
    const stream = createFastCodexStream(
      { getApiKeyForProvider: async () => "token" },
      codex,
    );

    await drain(
      stream(model, { messages: [] } as any, { apiKey: "placeholder" }),
    );

    expect(
      await calls[0][2].onPayload({ model: "gpt-6.1-sol" }, model),
    ).toEqual({ model: "gpt-6.1-sol", service_tier: "priority" });
  });

  it("ends with an error event when there is no Codex login", async () => {
    const { codex } = fakeCodex();
    const stream = createFastCodexStream(
      { getApiKeyForProvider: async () => undefined },
      codex,
    );

    const events: any[] = await drain(stream(model, { messages: [] } as any));

    expect(codex.streamSimple).not.toHaveBeenCalled();
    expect(events.at(-1).type).toBe("error");
    expect(events.at(-1).error.errorMessage).toMatch(/openai-codex login/);
  });
});

describe("registerFastCodexProvider", () => {
  it("registers the fast models with a placeholder key", () => {
    const pi = { registerProvider: vi.fn() };
    const registry = {
      getAll: () => [codexModel("gpt-6.1-sol")],
      getApiKeyForProvider: async () => "token",
    } as any;

    registerFastCodexProvider(pi, registry);

    expect(pi.registerProvider).toHaveBeenCalledWith("openai-codex-fast", {
      name: "OpenAI Codex (Fast)",
      api: "openai-codex-responses",
      apiKey: "openai-codex-login-resolved-per-request",
      models: [expect.objectContaining({ id: "gpt-6.1-sol" })],
      streamSimple: expect.any(Function),
    });
  });

  it("registers nothing when no Codex model qualifies", () => {
    const pi = { registerProvider: vi.fn() };
    registerFastCodexProvider(pi, {
      getAll: () => [codexModel("gpt-5.3")],
    } as any);
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });
});
