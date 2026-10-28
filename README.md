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

Each message is judged in a single forward pass, with the surrounding
conversation as context: the **last 20 messages** in the channel plus the
message it **replies to**, if it is a reply. Two questions are asked:

1. **Tier** — `none` / `weak` / `medium` / `strong`, how much the current
   message narrows down its author, on its own or together with what was said
   earlier.
2. **Kind** — what sort of detail it is: `contact`, `location`, `demographic`,
   `affiliation`, `routine`, `appearance`, `credential`, `relationship`, or
   `sensitive`.
A message is flagged when:

- the tier is `strong`, or
- the tier is `medium` with probability `>= RISK_MEDIUM_THRESHOLD` (0.65), or
- the tier undersells the detail but the kind question is very confident
  (`>= RISK_KIND_RESCUE`, 0.9) and the tier has at least some medium-risk
  support (`>= RISK_KIND_RESCUE_MEDIUM_SUPPORT`, 0.2). This still catches
  useful details such as a distinctive vehicle without flagging every ordinary
  mention of a relationship, demographic, or possession.

Context lets the model combine details and resolve short follow-up fragments:
"I'm a nurse at St Mary's in Leeds" followed later by "my shift starts at 6
tomorrow" is flagged as `medium` `routine`, while either line alone is weaker.
All questions are scoped to
*me*, the author of the current message, so somebody else's email in the
history does not get attributed to the author.

Every message gets a reply with the tier, kind, and tier breakdown,
for example:

```
tier: medium (0.56) · kind: location (0.37)
none 0.35 · weak 0.07 · medium 0.56 · strong 0.01
```

The reply also reports the inference queue size when the message was received
(including that message when it had to wait), plus time spent waiting separately
from time spent processing the model request.

Flagged messages also get a ⚠️ reaction. Context is held in memory only, capped
at 20 messages per channel and 200 channels, and is seeded from the channel once
on first use. Bot messages are excluded from the buffer, so it holds the last 20
messages written by people; the seed pages back up to 3×100 messages to fill it.

### Measured accuracy

On a 39-message regression set (23 benign, 10 quasi-identifier, 6 direct
identifier), with the current prompts: **39/39 correct, 0 false positives, 0
false negatives**. Context composition was verified separately on travel,
schedule, opinion, standalone trivia, and direct identifier cases.

Representative scores:

| message | tier | kind |
| --- | --- | --- |
| `pizza at 8 tonight?` | none | none |
| `we should refactor this module` | none | none |
| `I'm a 34-year-old nurse at St Mary's in Leeds` | medium | demographic |
| `I work nights at the Amazon warehouse in Coventry` | medium | affiliation |
| `just moved to a flat above the bakery on Mill Road` | medium | location |
| `I'm going some place tomorrow` → `the one with the eiffel tower` | medium | location |
| `email me at jane.doe@acme.com` | strong | contact |

Composed location evidence is evaluated by the same context-aware tier and kind
questions as every other identifying detail.

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

The bot also needs the **Read Message History** permission in each channel it
scans, for the 20-message context and for fetching replied-to messages. Without
it the bot logs a warning and falls back to judging the message alone.

## Configuration

All optional, set in `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODEL_PATH` | `models/d1-2B-Q8_0.gguf` | GGUF to load |
| `LLAMA_SERVER_BIN` | `vendor/llama/llama-server` | llama.cpp server binary |
| `LLAMA_PORT` | `8080` | Local port for the server |
| `LLAMA_CTX_SIZE` | `8192` | Context and batch size; one question is one batch |
| `RISK_MEDIUM_THRESHOLD` | `0.65` | Confidence needed to flag a `medium` tier |
| `RISK_KIND_RESCUE` | `0.9` | Kind confidence needed for a rescue promotion |
| `RISK_KIND_RESCUE_MEDIUM_SUPPORT` | `0.2` | Minimum medium-tier probability needed for a rescue promotion |
| `RISK_TIMEOUT_MS` | `120000` | Per-request timeout; CPU inference can take 30 s |
| `RISK_MAX_PENDING` | `200` | Max queued messages before skipping |
| `RISK_DEBUG` | `0` | Log raw scores for every message |
| `LLAMA_SERVER_VERBOSE` | `0` | Show llama.cpp's own logs |

If a server is already listening on `LLAMA_PORT`, the bot reuses it instead of
spawning another.

## Tuning the taxonomy

Both questions live in `QUESTIONS` in `src/pii/classify.ts`. To make the bot
stricter, raise `RISK_MEDIUM_THRESHOLD` or
`RISK_KIND_RESCUE_MEDIUM_SUPPORT`. To catch more, lower the thresholds
cautiously; setting `RISK_KIND_RESCUE_MEDIUM_SUPPORT` to `0` restores
kind-only rescue behavior and is likely to increase false positives.

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
- Replying to every message is chatty and will hit Discord's per-channel rate
  limit (about 5 messages per 5 s) in active channels. If that becomes a problem,
  reply only when `flagged`, or only for tiers above `weak`.
- The current message is judged together with the last 20 messages and any
  replied-to message. "I'm 34" is flagged as `demographic` medium even though it
  is harmless by itself — that is intentional, since the point is what it
  enables when combined with other posts.
- History is cached per channel in memory and seeded with one API fetch. If the
  bot misses messages (offline, or no Read Message History), that gap stays
  until the channel cache is evicted.
- Treat the tier as a hint, not a verdict. 2B parameters is small; expect
  borderline calls to wobble.
