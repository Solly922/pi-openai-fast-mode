# pi-openai-fast-mode

Pi package that adds a Fast Mode toggle for OpenAI GPT 5.4 and newer models.

<img style="width: 100%; height: auto;" alt="fast mode" src="https://raw.githubusercontent.com/johncmunson/pi-openai-fast-mode/refs/heads/main/preview-img.png" />

## Features

- Registers `/fast [on|off|toggle]`.
- Registers `--fast` to enable Fast Mode at startup.
- Injects `service_tier: "priority"` into matching OpenAI/OpenAI-Codex provider payloads.
- Shows a compact right-aligned TUI `fast` indicator only when enabled and the current model is configured.
- Persists state in user or project scope depending on how the package is loaded.

> View on the [Pi Package Registry](https://pi.dev/packages/pi-openai-fast-mode)

## Install

```bash
pi install npm:pi-openai-fast-mode
# or project-local
pi install -l npm:pi-openai-fast-mode
```

For local development:

```bash
pi -e ./src/index.ts
```

## Usage

```text
/fast          # toggle
/fast toggle   # toggle
/fast on       # enable
/fast off      # disable
```

Start Pi with Fast Mode enabled and persisted:

```bash
pi --fast
```

## Default configuration

Fast Mode starts disabled and applies to OpenAI GPT model IDs version 5.4 or newer. The version rule includes named variants such as `gpt-6-luna` and `gpt-6-sol`, preview or dated variants, and future numbered GPT versions without requiring an extension update. It applies to the `openai` and `openai-codex` providers.

```json
{
  "enabled": false,
  "targets": [
    { "provider": "openai", "model": "gpt-5.4+", "serviceTier": "priority" },
    { "provider": "openai-codex", "model": "gpt-5.4+", "serviceTier": "priority" }
  ]
}
```

The `+` suffix denotes a GPT model version range: `gpt-5.4+` matches version 5.4 and later, including model-name suffixes. Targets always come from the installed package, so saved targets are ignored on load and upgrades apply automatically. The config file is only written when Fast Mode is turned on or off with `/fast` or `--fast`, so Pi subagents sharing the file cannot undo a toggle.

User-scoped state is stored under `~/.pi/agent/extensions/pi-openai-fast-mode/config.json`.
Project-scoped state is stored under `./.pi/pi-openai-fast-mode/config.json`.

## Always-fast models: `openai-codex-fast`

On every session start the extension also registers an `openai-codex-fast` provider that lists each GPT 5.4+ `openai-codex` model again, named `<model> (fast)`. These models always run on the priority tier, whatever `/fast` says, so choosing one selects Fast Mode for that session only. Pick them in `/model`, pass them to subagents, or set `fast: true` on a model in [pi-jev-router](https://github.com/Solly922/pi-jev-router) to launch its fast twin.

- Requests use your existing `openai-codex` login and Pi's built-in Codex implementation. No separate login is needed.
- The tier is applied inside the provider, so every request gets it, including compaction summaries, which skip the `before_provider_request` hook `/fast` relies on.
- Listed costs are doubled (2.5x for gpt-5.5), matching how pi-ai prices the priority tier, so cost estimates reflect the extra usage.
- Pi subagents share the parent session's model runtime, so they can use these models even when their `extensions:` list leaves this extension out. The provider is never unregistered, because a subagent's shutdown would remove it from the parent.
- The list is rebuilt at each session start. A Codex model added later appears after the next `/new`, `/resume` or restart.

## Development

```bash
npm install
npm run check
```
