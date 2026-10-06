import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getFastCommandCompletions, parseFastCommand } from "./commands";
import {
  cloneConfig,
  loadConfigForScope,
  saveConfigToPath,
  syncSupportedTargets,
} from "./config";
import {
  getFastModePayload,
  getFastVariantPayload,
  toModelRef,
} from "./payload";
import { clearFastStatus, updateFastStatus } from "./status";
import type { FastModeConfig, ModelRef } from "./types";

export type FastModeExtensionOptions = {
  /** Directory containing the extension entry point; used to detect project-local package installs. */
  extensionDir?: string;
  /** Test/advanced override for Pi's user-level agent directory. */
  agentDir?: string;
};

const DEFAULT_EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function notifyError(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  error: unknown,
): void {
  if (!ctx.hasUI) return;
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(message, "error");
}

export function createPiFastModeExtension(
  options: FastModeExtensionOptions = {},
): ExtensionFactory {
  const extensionDir = options.extensionDir ?? DEFAULT_EXTENSION_DIR;
  const agentDir = options.agentDir;

  return function piFastModeExtension(pi: ExtensionAPI): void {
    let config: FastModeConfig = cloneConfig();
    let configPath: string | undefined;
    let loadedCwd: string | undefined;
    let currentModel: ModelRef | undefined;

    async function loadForContext(
      ctx: Pick<ExtensionContext, "cwd">,
    ): Promise<void> {
      const loaded = await loadConfigForScope({
        cwd: ctx.cwd,
        extensionDir,
        agentDir,
      });

      // Targets always come from this package, so upgrades apply without
      // touching the file. Loading never saves: Pi subagents load their own
      // copy against the same file, and a save here could write a stale
      // enabled value over a /fast toggle made after this read.
      config = syncSupportedTargets(loaded.config);
      configPath = loaded.path;
      loadedCwd = ctx.cwd;
    }

    async function ensureLoaded(
      ctx: Pick<ExtensionContext, "cwd">,
    ): Promise<void> {
      if (!configPath || loadedCwd !== ctx.cwd) {
        await loadForContext(ctx);
      }
    }

    async function saveCurrent(
      ctx: Pick<ExtensionContext, "cwd">,
      next: FastModeConfig,
    ): Promise<void> {
      if (!configPath || loadedCwd !== ctx.cwd) {
        await loadForContext(ctx);
      }

      if (!configPath) {
        throw new Error("Fast Mode config path was not resolved");
      }

      await saveConfigToPath(configPath, next);
      // Adopt the change only once it is saved, so a failed save leaves
      // requests and the status indicator agreeing on the previous state.
      config = next;
    }

    function refreshCurrentModel(ctx: Pick<ExtensionContext, "model">): void {
      currentModel = toModelRef(ctx.model) ?? currentModel;
    }

    pi.registerFlag("fast", {
      description: "Start with Fast Mode enabled",
      type: "boolean",
      default: false,
    });

    pi.registerCommand("fast", {
      description: "Toggle Fast Mode. Usage: /fast [on|off|toggle]",
      getArgumentCompletions: getFastCommandCompletions,
      handler: async (
        args: string,
        ctx: ExtensionCommandContext,
      ): Promise<void> => {
        try {
          await ensureLoaded(ctx);
          refreshCurrentModel(ctx);
          const enabled = parseFastCommand(args, config.enabled);
          await saveCurrent(ctx, { ...config, enabled });
          updateFastStatus(ctx, config, currentModel);
        } catch (error) {
          notifyError(ctx, error);
        }
      },
    });

    pi.on("session_start", async (event, ctx) => {
      try {
        currentModel = toModelRef(ctx.model);
        await loadForContext(ctx);

        // Pi keeps CLI flags for the whole process and fires session_start
        // again on /new, /resume, /fork and /reload. Apply --fast only at
        // startup so it cannot override a later /fast off.
        if (event.reason === "startup" && pi.getFlag("fast") === true) {
          await saveCurrent(ctx, { ...config, enabled: true });
        }

        updateFastStatus(ctx, config, currentModel);
      } catch (error) {
        notifyError(ctx, error);
      }
    });

    pi.on("model_select", async (event, ctx) => {
      currentModel = toModelRef(event.model) ?? toModelRef(ctx.model);
      updateFastStatus(ctx, config, currentModel);
    });

    pi.on("before_provider_request", (event, ctx) => {
      const model = toModelRef(ctx.model) ?? currentModel;
      return (
        getFastVariantPayload(ctx.model, event.payload) ??
        getFastModePayload(config, model, event.payload)
      );
    });

    // No save here: /fast and --fast persist immediately. Saving on shutdown
    // would write this session's possibly stale enabled state over a toggle
    // made since by another session sharing the file, such as a Pi subagent.
    pi.on("session_shutdown", (_event, ctx) => {
      clearFastStatus(ctx);
    });
  };
}

const piFastModeExtension = createPiFastModeExtension();

export default piFastModeExtension;
