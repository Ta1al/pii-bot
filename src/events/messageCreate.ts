import { Events, Message } from "discord.js";
import { assessRisk, describeRisk } from "../pii/classify.js";
import { getHistory, getReply, remember } from "../pii/history.js";

const DEBUG = true;

export default {
  name: Events.MessageCreate,
  async execute(message: Message) {
    // Ignore bots (including ourselves) and messages with no text.
    if (message.author.bot) return;
    if (!message.content.trim()) return;

    try {
      const history = await getHistory(message);
      const reply = await getReply(message);

      const time1 = new Date().getTime();
      const result = await assessRisk({
        current: message.content,
        currentAuthorId: message.author.id,
        history: history.map((entry) => ({
          authorId: entry.authorId,
          content: entry.content,
        })),
        reply: reply
          ? { authorId: reply.authorId, content: reply.content }
          : null,
      });
      const time2 = new Date().getTime();

      // The message is context for whatever comes next.
      remember(message);

      if (DEBUG) {
        console.log("[risk] raw", {
          messageId: message.id,
          contextMessages: history.length,
          hasReply: reply !== null,
          tier: result.tier,
          score: result.score,
          kind: result.kind,
          kindScore: result.kindScore,
          scores: result.scores,
        });
        console.log(`[risk] assessment took ${time2 - time1} ms`);
      }

      console.log(
        `[risk] ${result.flagged ? "FLAGGED" : "clear"} ` +
          `${result.tier} (${result.kind}, p=${result.score.toFixed(2)}) ` +
          `message ${message.id} from ${message.author.tag}: ` +
          JSON.stringify(message.content.slice(0, 160))
      );

      if (result.flagged) {
        await message.react("⚠️");
      }

      await message.reply({
        content: describeRisk(result) + `\n\nTook ${time2 - time1} ms to assess.`,
        allowedMentions: { repliedUser: false },
      });
    } catch (error) {
      console.error("[risk] Assessment failed:", error);
    }
  },
};
