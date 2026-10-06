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

  // A registry whose openai-codex provider records its calls and yields one event.
  function fakeRegistry(
    auth: Record<string, unknown> = { ok: true, apiKey: "codex-token" },
  ) {
    const calls: any[] = [];
    const codex = {
      streamSimple: vi.fn((...args: any[]) => {
        calls.push(args);
        return (async function* () {
          yield done;
        })();
      }),
    };
    const registry = {
      getApiKeyAndHeaders: vi.fn(async () => auth),
      getProvider: vi.fn((provider: string) =>
        provider === "openai-codex" ? codex : undefined,
      ),
    } as any;
    return { registry, codex, calls };
  }

  async function drain(stream: AsyncIterable<unknown>) {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it("streams through openai-codex with its login and puts every request on priority", async () => {
    const { registry, calls } = fakeRegistry({
      ok: true,
      apiKey: "codex-token",
      headers: { "x-login": "1", "x-shared": "login" },
      env: { LOGIN_ENV: "1" },
    });
    const piHook = vi.fn(async (payload: any) => ({
      ...payload,
      hooked: true,
    }));
    const stream = createFastCodexStream(registry);

    expect(
      await drain(
        stream(model, { messages: [] } as any, {
          apiKey: "placeholder",
          headers: { "x-shared": "request" },
          onPayload: piHook,
        }),
      ),
    ).toEqual([done]);

    // Auth is resolved for openai-codex, not the fast provider.
    expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-codex", id: "gpt-6.1-sol" }),
    );
    const [calledModel, , options] = calls[0];
    expect(calledModel).toBe(model);
    expect(options.apiKey).toBe("codex-token");
    expect(options.headers).toEqual({ "x-login": "1", "x-shared": "request" });
    expect(options.env).toEqual({ LOGIN_ENV: "1" });
    // Pi's hooks run first, then the tier goes on.
    expect(await options.onPayload({ model: "gpt-6.1-sol" }, model)).toEqual({
      model: "gpt-6.1-sol",
      hooked: true,
      service_tier: "priority",
    });
  });

  it("adds priority without Pi's hook, as compaction requests do", async () => {
    const { registry, calls } = fakeRegistry();
    const stream = createFastCodexStream(registry);

    await drain(stream(model, { messages: [] } as any));

    expect(
      await calls[0][2].onPayload({ model: "gpt-6.1-sol" }, model),
    ).toEqual({ model: "gpt-6.1-sol", service_tier: "priority" });
  });

  it("uses the endpoint the login resolves", async () => {
    const { registry, calls } = fakeRegistry({
      ok: true,
      apiKey: "codex-token",
      baseUrl: "https://proxy.example/backend-api",
    });

    await drain(
      createFastCodexStream(registry)(model, { messages: [] } as any),
    );

    expect(calls[0][0]).toEqual({
      ...model,
      baseUrl: "https://proxy.example/backend-api",
    });
  });

  it("ends with the login error instead of streaming", async () => {
    const { registry, codex } = fakeRegistry({
      ok: false,
      error: "Token refresh failed: invalid_grant",
    });

    const events: any[] = await drain(
      createFastCodexStream(registry)(model, { messages: [] } as any),
    );

    expect(codex.streamSimple).not.toHaveBeenCalled();
    expect(events.at(-1).type).toBe("error");
    expect(events.at(-1).error.errorMessage).toBe(
      "openai-codex-fast uses your openai-codex login: Token refresh failed: invalid_grant",
    );
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
