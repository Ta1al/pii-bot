import { Events, Interaction } from "discord.js";
import type { Client } from "discord.js";
import { MessageFlags } from "discord.js";
import type { Command } from "../types/command.js";

interface ExtendedClient extends Client {
  commands: Map<string, Command>;
}

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction, client: ExtendedClient) {
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) {
      return;
    }

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      if (isUnknownInteraction(error)) {
        console.warn(
          `[interaction] ${interaction.commandName} expired before it could be acknowledged`
        );
        return;
      }

      console.error(error);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: "There was an error while executing this command!",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: "There was an error while executing this command!",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (responseError) {
        if (isUnknownInteraction(responseError)) {
          console.warn(
            `[interaction] ${interaction.commandName} expired before the error response could be sent`
          );
          return;
        }
        console.error("[interaction] Error response failed:", responseError);
      }
    }
  },
};

function isUnknownInteraction(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 10062
  );
}
