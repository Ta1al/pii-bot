import { Events, Message } from "discord.js";
import { assessRisk } from "../pii/classify.js";

const DEBUG = 1;

export default {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot) return;
    if (!message.content.trim()) return;

    try {
      let time1 = new Date().getTime();
      const result = await assessRisk(message.content);
      let time2 = new Date().getTime();
      if (DEBUG) {
        console.log("[risk] raw", {
          messageId: message.id,
          tier: result.tier,
          score: result.score,
          kind: result.kind,
          kindScore: result.kindScore,
          scores: result.scores,
        });
        console.log(`[risk] assessment took ${time2 - time1} ms`);
      }

      if (!result.flagged) return;

      console.log(
        `[risk] ${result.tier} (${result.kind}, p=${result.score.toFixed(2)}) ` +
          `message ${message.id} from ${message.author.tag}: ` +
          JSON.stringify(message.content.slice(0, 160))
      );

      await message.react("⚠️");
    } catch (error) {
      console.error("[risk] Assessment failed:", error);
    }
  },
};
