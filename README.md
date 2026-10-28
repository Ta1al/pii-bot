# PII Bot

A simple Discord bot built with [discord.js](https://discord.js.org/) and TypeScript.

## Features

- Slash commands with automatic command loading
- Event handler system
- TypeScript support
- ESLint for code linting
- Command deployment utility

## Setup

1. Clone the repository
2. Install dependencies:
```bash
npm install
```
3. Copy `.env.example` to `.env` and fill in your values:
```bash
cp .env.example .env
```
- `DISCORD_TOKEN`: Your Discord bot token
- `CLIENT_ID`: Your Discord application client ID
- `GUILD_ID`: (Optional) Your test server ID for faster guild-specific command deployment

4. Deploy commands:
```bash
npm run deploy
```

5. Start the bot:
```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Commands

- `/ping` - Replies with bot latency

## Adding Commands

Create a new file in `src/commands/` with the following structure:

```typescript
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

## Linting

```bash
npm run lint
npm run lint:fix
```
