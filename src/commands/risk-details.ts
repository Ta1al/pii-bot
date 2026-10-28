import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
} from "discord.js";
import type { Command } from "../types/command.js";
import { getRiskAssessment } from "../pii/results.js";

const riskDetails: Command = {
  data: new ContextMenuCommandBuilder()
    .setName("Risk details")
    .setType(ApplicationCommandType.Message),
  async execute(interaction) {
    if (!interaction.isMessageContextMenuCommand()) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const assessment = getRiskAssessment(interaction.targetId);
    if (!assessment) {
      await interaction.editReply(
        "No assessment is stored for this message. It may have been sent before the bot started, or assessment may have failed."
      );
      return;
    }

    await interaction.editReply(formatAssessment(assessment));
  },
};

function formatAssessment(assessment: ReturnType<typeof getRiskAssessment>): string {
  if (!assessment) return "No assessment is stored for this message.";

  const { result, input, timings } = assessment;
  const history = input.history ?? [];
  const context = [
    ...history.map((message) => `${message.authorId}: ${message.content}`),
    ...(input.reply
      ? [`reply ${input.reply.authorId}: ${input.reply.content}`]
      : []),
    `me: ${input.current}`,
  ].join("\n");
  const details =
    `**Risk assessment**\n` +
    `Flagged: **${result.flagged ? "yes" : "no"}**\n` +
    `Tier: **${result.tier}** (${result.score.toFixed(2)})\n` +
    `Kind: **${result.kind}** (${result.kindScore.toFixed(2)})\n` +
    `Scores: ${Object.entries(result.scores)
      .map(([tier, score]) => `${tier} ${score.toFixed(2)}`)
      .join(" · ")}\n` +
    `Inference: queued ${timings.queueMs} ms · processed ${timings.processMs} ms\n` +
    `\n**Context**\n\`\`\`\n${context}\n\`\`\``;

  return details.length <= 2_000
    ? details
    : `${details.slice(0, 1_940)}\n…\n\`\`\``;
}

export default riskDetails;
