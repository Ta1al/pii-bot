# PII Bot

A Discord bot that flags messages which narrow down **who the author is or where
they are** — not just traditional PII. It catches direct identifiers (email,
phone, address, ID numbers, credentials) and quasi-identifiers (age, job,
employer, school, city, neighbourhood, shift pattern, distinctive possessions),
because those combine with other posts to re-identify someone.

Runs entirely locally: no API keys, no cloud inference. Detection uses
[LiquidAI d1-2B](https://huggingface.co/LiquidAI/d1-2B-GGUF), a decision model
served by [llama.cpp](https://github.com/ggml-org/llama.cpp). The bot starts the
model itself on boot.

## How it works

Each message is judged on its own, in a single forward pass, by two questions:

1. **Tier** — `none` / `weak` / `medium` / `strong`, how much the message
   narrows down its author.
2. **Kind** — what sort of detail it is: `contact`, `location`, `demographic`,
   `affiliation`, `routine`, `appearance`, `credential`, `relationship`.

A message is flagged when:

- the tier is `strong`, or
- the tier is `medium` with probability `>= RISK_MEDIUM_THRESHOLD` (0.6), or
- the tier undersells the detail but the kind question is confident
  (`>= RISK_KIND_RESCUE`, 0.8). This catches things like "I drive a yellow 2019
  Mini Cooper", which scores 0.46 on tier but 0.98 on `appearance`.

Flagged messages get a ⚠️ reaction and a console line naming the tier, kind and
score. Messages are not stored, and no state accumulates across messages.

### Measured accuracy

On a 41-message set (23 benign, 10 quasi-identifier, 8 direct identifier), on
CPU: **40/41 correct, 0 false positives**, 1 false negative ("our team of four
in the Berlin office is hiring", tier 0.52).

Representative scores:

| message | tier | kind |
| --- | --- | --- |
| `pizza at 8 tonight?` | none 0.81 | none |
| `we should refactor this module` | none 0.99 | none |
| `I'm a 34-year-old nurse at St Mary's in Leeds` | medium 0.98 | demographic |
| `I work nights at the Amazon warehouse in Coventry` | medium 0.88 | affiliation |
| `just moved to a flat above the bakery on Mill Road` | medium 0.78 | location |
| `my sister Rachel is picking me up after dialysis` | medium 0.52 | relationship |
| `email me at jane.doe@acme.com` | strong 0.91 | contact |
| `my badge id is EMP-4471` | strong 0.88 | credential |

## Requirements

- Node.js 22+
- A Discord bot token with the **Message Content** privileged intent enabled
  in the [Developer Portal](https://discord.com/developers/applications)
- ~2 GB disk for the model

## Setup

```bash
npm install
cp .env.example .env   # then fill in your token
```

### 1. Download the model

```bash
pip install -U "huggingface_hub[cli]"
npm run model:download
```

This writes `models/d1-2B-Q8_0.gguf` (1.85 GB).

### 2. Download llama.cpp

d1-2B needs a build that includes
[PR #31275](https://github.com/ggml-org/llama.cpp/pull/31275) — merged
2026-10-27, first shipped in build `b11946`.

```bash
mkdir -p vendor && cd vendor
curl -sL -o llama.tar.gz \
  https://github.com/ggml-org/llama.cpp/releases/download/b11946/llama-b11946-bin-ubuntu-x64.tar.gz
mkdir -p llama && tar -xzf llama.tar.gz -C llama --strip-components=1
```

Expected layout: `vendor/llama/llama-server` with its `.so` files beside it.

### 3. Register slash commands and run

```bash
npm run deploy
npm run dev
```

## Bot intents

```ts
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,  // privileged: required to read message text
GatewayIntentBits.DirectMessages,  // only if you want to scan DMs too
```

`MessageContent` must also be enabled for your application in the Discord
Developer Portal, otherwise `message.content` is always empty.

## Configuration

All optional, set in `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODEL_PATH` | `models/d1-2B-Q8_0.gguf` | GGUF to load |
| `LLAMA_SERVER_BIN` | `vendor/llama/llama-server` | llama.cpp server binary |
| `LLAMA_PORT` | `8080` | Local port for the server |
| `LLAMA_CTX_SIZE` | `8192` | Context and batch size; one question is one batch |
| `RISK_MEDIUM_THRESHOLD` | `0.6` | Confidence needed to flag a `medium` tier |
| `RISK_KIND_RESCUE` | `0.8` | Kind confidence that promotes a low tier to `medium` |
| `RISK_MAX_PENDING` | `200` | Max queued messages before skipping |
| `RISK_DEBUG` | `0` | Log raw scores for every message |
| `LLAMA_SERVER_VERBOSE` | `0` | Show llama.cpp's own logs |

If a server is already listening on `LLAMA_PORT`, the bot reuses it instead of
spawning another.

## Tuning the taxonomy

Both questions live in `QUESTIONS` in `src/pii/classify.ts`. To make the bot
stricter, remove `weak` from the tier criteria or raise
`RISK_MEDIUM_THRESHOLD`. To catch more, lower it toward `0.45` and drop
`RISK_KIND_RESCUE` to `0.7`.

Adding a kind is a single entry in the `kind` criteria map; the model returns a
probability for every key, so no retraining is involved.

## Commands

- `/ping` — replies with bot and websocket latency

## Adding commands

```ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import type { Command } from "../types/command.js";

const mycommand: Command = {
  data: new SlashCommandBuilder()
    .setName("mycommand")
    .setDescription("Description here"),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply("Hello!");
  },
};

export default mycommand;
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run with hot reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled bot |
| `npm run deploy` | Register slash commands |
| `npm run model:download` | Fetch the GGUF |
| `npm run lint` / `lint:fix` | ESLint |

## Notes

- Model weights (`models/`) and llama.cpp binaries (`vendor/llama/`) are
  git-ignored; they are large and platform specific.
- Inference is CPU-bound: roughly 1–3 s per message on a laptop. Requests are
  queued, so a burst in a busy channel will lag rather than fail.
- A single message is judged alone. "I'm 34" is flagged as `demographic`
  medium even though it is harmless by itself — that is intentional, since the
  point is what it enables when combined with other posts.
- Treat the tier as a hint, not a verdict. 2B parameters is small; expect
  borderline calls to wobble.
