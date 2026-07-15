---
summary: "Fireworks setup (auth + model selection)"
title: "Fireworks"
read_when:
  - You want to use Fireworks with OpenClaw
  - You need the Fireworks API key env var or default model id
  - You are debugging Fireworks reasoning levels or Kimi reasoning replay
---

[Fireworks](https://fireworks.ai) exposes open-weight and routed models through an OpenAI-compatible API. The official provider plugin ships a curated catalog of verified serverless chat bases plus fixed-target Fast and US-only routers.

| Property        | Value                                         |
| --------------- | --------------------------------------------- |
| Provider id     | `fireworks` (alias: `fireworks-ai`)           |
| Package         | `@openclaw/fireworks-provider`                |
| Auth env var    | `FIREWORKS_API_KEY`                           |
| Onboarding flag | `--auth-choice fireworks-api-key`             |
| Direct CLI flag | `--fireworks-api-key <key>`                   |
| API             | OpenAI-compatible (`openai-completions`)      |
| Base URL        | `https://api.fireworks.ai/inference/v1`       |
| Default model   | `fireworks/accounts/fireworks/models/kimi-k3` |
| Default alias   | `Kimi K3`                                     |

## Getting started

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/fireworks-provider
    ```
  </Step>
  <Step title="Set the Fireworks API key">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice fireworks-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice fireworks-api-key \
  --fireworks-api-key "$FIREWORKS_API_KEY"
```

```bash Env only
export FIREWORKS_API_KEY=fw-...
```

    </CodeGroup>

    Onboarding stores the key against the `fireworks` provider in your auth profiles. It sets Kimi K3 as the default model only when no primary model is already configured.

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider fireworks
    ```

    With a usable credential, the list includes the curated serverless chat bases plus the fixed-target router selectors below. If `FIREWORKS_API_KEY` is unresolved, `openclaw models status --json` reports the missing credential under `auth.unusableProfiles`.

  </Step>
</Steps>

## Non-interactive setup

For scripted or CI installs, pass everything on the command line:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice fireworks-api-key \
  --fireworks-api-key "$FIREWORKS_API_KEY" \
  --skip-health \
  --accept-risk
```

## Serverless catalog

The plugin ships a curated catalog of models verified against Fireworks' authenticated [List Models API](https://docs.fireworks.ai/api-reference/list-models). It includes serverless chat models and excludes embedding, reranking, dedicated-deployment-only, and meta-router rows.

The catalog contains these serverless chat bases:

- DeepSeek V4 Flash and Pro
- GLM 5.1 and 5.2
- GPT-OSS 120B and 20B
- Inkling
- Kimi K2.6, K2.7 Code, and K3
- MiniMax M2.7 and M3
- NVIDIA Nemotron 3 Ultra NVFP4
- Qwen 3.7 Plus

It also contains each accepted fixed-target router:

| Router id                                        | Contract source |
| ------------------------------------------------ | --------------- |
| `accounts/fireworks/routers/glm-5p2-fast`        | GLM 5.2         |
| `accounts/fireworks/routers/kimi-k2p6-fast`      | Kimi K2.6       |
| `accounts/fireworks/routers/kimi-k2p6-turbo`     | Kimi K2.6       |
| `accounts/fireworks/routers/kimi-k2p7-code-fast` | Kimi K2.7 Code  |
| `accounts/fireworks/routers/kimi-k3-fast`        | Kimi K3         |
| `accounts/fireworks/routers/kimi-k3-us`          | Kimi K3         |

The moving `kimi-fast-latest` and `glm-fast-latest` selectors are not advertised because Fireworks can retarget them to a model with a different reasoning contract. The retired `kimi-k2p5-turbo` selector and unavailable `glm-5p1-fast` selector are also excluded.

## Reasoning levels

OpenClaw stores the canonical `/think` level in the session and maps it to the selected Fireworks model immediately before dispatch. Labels such as `medium → high` in the thinking picker disclose when a model has fewer native tiers than OpenClaw's portable level set.

| Fireworks model family          | Effective mapping                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| DeepSeek V4                     | `low\|medium\|high → high`; `xhigh\|max → max`; `off → none`                             |
| GLM 5.1                         | every non-off level enables reasoning; `off → none`                                      |
| GLM 5.2                         | `low\|medium\|high → high`; `xhigh\|max → max`; `off → none`                             |
| GPT-OSS 120B/20B                | `low`, `medium`, and `high` stay native; `xhigh\|max → high`; no off mode                |
| Inkling                         | all five levels stay native; `off → none`                                                |
| Kimi K2.6                       | every non-off level enables thinking at a 4,096-token budget; `off` disables it          |
| Kimi K2.7 Code                  | thinking is always enabled; all levels select the same mode                              |
| Kimi K3                         | `low → low`; `medium\|high → high`; `xhigh\|max → max`; no off mode                      |
| MiniMax M2.7                    | `low`, `medium`, and `high` stay native; `xhigh\|max → high`; no off mode                |
| MiniMax M3                      | `low\|medium → adaptive`; `high\|xhigh\|max → enabled` at 4,096 tokens; `off → disabled` |
| Nemotron 3 Ultra, Qwen 3.7 Plus | every non-off level enables reasoning; `off → none`                                      |

Kimi K3 defaults to `max`. Inkling deliberately defaults to `high`, matching OpenClaw's portable default while leaving `xhigh` and `max` as explicit higher-cost choices. Inkling, Kimi K2.7 Code, and K3 preserve historical `reasoning_content`; Kimi K2.6, DeepSeek V4, GLM 5.2, and MiniMax M2.7 use their Fireworks interleaved-history mode. Fixed routers inherit their base model's mapping.

Inkling retains its advertised 1,048,576-token context window, but OpenClaw caps a single completion at 262,144 tokens. Advertising the full context window as output capacity leaves no safe headroom for the system prompt, tool schemas, and tokenizer variance.

## Custom Fireworks model ids

OpenClaw accepts any Fireworks model or router id at runtime. Use the exact id shown by Fireworks and prefix it with `fireworks/`. Dynamic resolution clones the Kimi K3 template (text + image input, OpenAI-compatible API, default cost zero). Known model families receive their provider-owned reasoning profile. GLM dynamic ids are marked text-only unless you configure a custom model entry with image input.

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "fireworks/accounts/fireworks/models/<your-model-id>",
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="How model id prefixing works">
    Every Fireworks model ref in OpenClaw starts with `fireworks/` followed by the exact id or router path from the Fireworks platform. For example:

    - Router model: `fireworks/accounts/fireworks/routers/kimi-k3-fast`
    - Direct model: `fireworks/accounts/fireworks/models/<model-name>`

    OpenClaw strips the `fireworks/` prefix when constructing the API request and sends the remaining path to the Fireworks endpoint as the OpenAI-compatible `model` field.

  </Accordion>

  <Accordion title="How Kimi reasoning stays safe">
    The Fireworks stream wrapper marks reasoning-capable requests as reasoning streams before parsing, sends the model-specific effort or thinking control, and reapplies that contract after generic payload hooks. Inkling, Kimi K2.7 Code, and K3 keep `reasoning_content` in replayed assistant tool-call messages and request preserved reasoning history.

  </Accordion>

  <Accordion title="Environment availability for the daemon">
    If the Gateway runs as a managed service (launchd, systemd, Docker), the Fireworks key must be visible to that process — not just to your interactive shell.

    <Warning>
      A key exported only in an interactive shell will not help a launchd or systemd daemon unless that environment is imported there too. Set the key in `~/.openclaw/.env` or via `env.shellEnv` to make it readable from the gateway process.
    </Warning>

    OpenClaw loads `~/.openclaw/.env` when it loads config, so keys stored there reach managed gateway services on every platform. Restart the gateway (or re-run `openclaw doctor --fix`) after rotating the key.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    `/think` levels, provider policies, and routing reasoning-capable models.
  </Card>
  <Card title="Moonshot" href="/providers/moonshot" icon="moon">
    Run Kimi with native thinking output through Moonshot's own API.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
