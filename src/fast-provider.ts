import {
  lazyStream,
  type Api,
  type Model,
  type ModelCost,
  type ModelCostRates,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./config";
import { findMatchingTarget, isRecord } from "./payload";
import { DEFAULT_SERVICE_TIER } from "./types";

/**
 * Lists every Fast Mode-capable OpenAI Codex model a second time, always on
 * the priority tier, so a model choice alone selects Fast Mode. pi-jev-router
 * launches these for models configured with `fast: true`.
 */
export const FAST_CODEX_PROVIDER = "openai-codex-fast";
const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
// Pi only dispatches to a provider with a key. This one is never sent: every
// request resolves the user's openai-codex login instead.
const PLACEHOLDER_API_KEY = "openai-codex-login-resolved-per-request";

type ModelRegistry = ExtensionContext["modelRegistry"];

/**
 * pi-ai bills priority at 2x (2.5x for gpt-5.5) only when the request option
 * or the response names that tier. Neither happens here: the tier is set in
 * the payload, and Codex responses report "default" even for priority
 * requests (checked 2026-10-06). Listing the higher rates keeps Pi's cost
 * estimates honest.
 */
function priorityCost(model: Model<Api>): ModelCost {
  const factor = model.id === "gpt-5.5" ? 2.5 : 2;
  const scale = <T extends ModelCostRates>(rates: T): T => ({
    ...rates,
    input: rates.input * factor,
    output: rates.output * factor,
    cacheRead: rates.cacheRead * factor,
    cacheWrite: rates.cacheWrite * factor,
  });
  const { tiers } = model.cost;
  return { ...scale(model.cost), ...(tiers && { tiers: tiers.map(scale) }) };
}

/** The registry's Fast Mode-capable Codex chat models, under the fast provider. */
export function fastCodexModels(
  registry: Pick<ModelRegistry, "getAll">,
): ProviderModelConfig[] {
  return registry
    .getAll()
    .filter(
      (model) =>
        model.provider === CODEX_PROVIDER &&
        model.api === CODEX_API &&
        findMatchingTarget(model, DEFAULT_CONFIG.targets) !== undefined,
    )
    .map((model) => ({
      id: model.id,
      name: `${model.name} (fast)`,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
      inputLimits: model.inputLimits,
      cost: priorityCost(model),
      promptCache: model.promptCache,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: model.compat,
    }));
}

/**
 * Streams through Pi's own openai-codex provider with its login. pi-ai's
 * Codex streamSimple drops a `serviceTier` option, so the tier is set in
 * `onPayload`, which it keeps and calls on every request. That includes
 * compaction summaries, which skip Pi's before_provider_request hook.
 */
export function createFastCodexStream(
  registry: Pick<ModelRegistry, "getApiKeyAndHeaders" | "getProvider">,
) {
  return (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) =>
    lazyStream(model, async () => {
      // Resolve per request, so Pi refreshes the OAuth token near expiry and
      // applies any openai-codex headers, endpoint or env from models.json.
      const auth = await registry.getApiKeyAndHeaders({
        ...model,
        provider: CODEX_PROVIDER,
      });
      if (!auth.ok) {
        throw new Error(
          `${FAST_CODEX_PROVIDER} uses your ${CODEX_PROVIDER} login: ${auth.error}`,
        );
      }
      const codex = registry.getProvider(CODEX_PROVIDER);
      if (!codex) throw new Error(`${CODEX_PROVIDER} is not registered.`);

      const target = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
      return codex.streamSimple(target, context, {
        ...options,
        apiKey: auth.apiKey,
        // Same precedence as Pi: per-request options win over login defaults.
        headers: { ...auth.headers, ...options?.headers },
        env:
          auth.env || options?.env
            ? { ...auth.env, ...options?.env }
            : undefined,
        // Pi's hooks run first; the tier goes on last so none can drop it.
        onPayload: async (payload, payloadModel) => {
          const next =
            (await options?.onPayload?.(payload, payloadModel)) ?? payload;
          return isRecord(next)
            ? { ...next, service_tier: DEFAULT_SERVICE_TIER }
            : next;
        },
      });
    });
}

/**
 * Register per bound session, as codex-images does. pi-subagents children
 * share the parent's model runtime, so the parent's registration already
 * covers them, and the stream needs a live registry for the login. Never
 * unregister: a child's shutdown would remove the parent's provider.
 */
export function registerFastCodexProvider(
  pi: Pick<ExtensionAPI, "registerProvider">,
  registry: ModelRegistry,
): void {
  const models = fastCodexModels(registry);
  if (!models.length) return;

  pi.registerProvider(FAST_CODEX_PROVIDER, {
    name: "OpenAI Codex (Fast)",
    api: CODEX_API,
    apiKey: PLACEHOLDER_API_KEY,
    models,
    streamSimple: createFastCodexStream(registry),
  });
}
