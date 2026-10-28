import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types/command.js";

const ping: Command = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Replies with Pong!"),
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const sent = await interaction.reply({
      content: "Pinging...",
      withResponse: true,
    });
    const latency = (sent.resource?.message?.createdTimestamp ?? Date.now()) - interaction.createdTimestamp;
    await interaction.editReply(`Pong! Latency: ${latency}ms | WebSocket: ${interaction.client.ws.ping}ms`);
  },
};

export default ping;
