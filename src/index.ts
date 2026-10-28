import { Client, Collection, GatewayIntentBits } from "discord.js";
import { config } from "dotenv";
import { readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Command } from "./types/command.js";

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class PiiBot extends Client {
  commands: Collection<string, Command> = new Collection();
}

const client = new PiiBot({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.commands.clear();

// Load commands
const commandsPath = join(__dirname, "commands");
const commandFiles = readdirSync(commandsPath).filter(
  (file) => file.endsWith(".js") || file.endsWith(".ts")
);

for (const file of commandFiles) {
  const filePath = join(commandsPath, file);
  const commandModule = await import(filePath);
  const command = commandModule.default || commandModule.command;
  if ("data" in command && "execute" in command) {
    client.commands.set(command.data.name, command);
    console.log(`Loaded command: ${command.data.name}`);
  } else {
    console.log(`[WARNING] The command at ${filePath} is missing "data" or "execute" property.`);
  }
}

// Load events
const eventsPath = join(__dirname, "events");
const eventFiles = readdirSync(eventsPath).filter(
  (file) => file.endsWith(".js") || file.endsWith(".ts")
);

for (const file of eventFiles) {
  const filePath = join(eventsPath, file);
  const eventModule = await import(filePath);
  const event = eventModule.default || eventModule.event;
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
  console.log(`Loaded event: ${event.name}`);
}

client.login(process.env.DISCORD_TOKEN);
