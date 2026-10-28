import { Events, Message } from "discord.js";
import {
  assessRisk,
  formatContext,
  getRiskNumber,
} from "../pii/classify.js";
import { queueReaction } from "../discord/reactionQueue.js";
import { getHistory, getReply, remember } from "../pii/history.js";
import { storeRiskAssessment } from "../pii/results.js";

const DEBUG = true;
const KIND_EMOJIS: Record<string, string> = {
  contact: "📞",
  location: "📍",
  demographic: "🧑",
  affiliation: "🏢",
  routine: "🕒",
  appearance: "👀",
  credential: "🔐",
  relationship: "🤝",
  sensitive: "🧩",
  none: "❔",
};

export default {
  name: Events.MessageCreate,
  async execute(message: Message) {
    // Ignore bots (including ourselves) and messages with no text.
    if (message.author.bot) return;
    if (!message.content.trim()) return;

    try {
      const history = await getHistory(message);
      const reply = await getReply(message);

      const riskInput = {
        current: message.content,
        currentAuthorId: message.author.id,
        history: history.map((entry) => ({
          authorId: entry.authorId,
          content: entry.content,
        })),
        reply: reply
          ? { authorId: reply.authorId, content: reply.content }
          : null,
      };

      // Record the message before inference so messages arriving while this
      // request is queued see it in their own history snapshot.
      remember(message);

      const assessment = await assessRisk(riskInput);
      const { result, timings } = assessment;
      storeRiskAssessment(message.id, {
        result,
        input: riskInput,
        timings,
      });

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
          context: formatContext(riskInput),
        });
        console.log("[risk] timings", timings);
      }

      console.log(
        `[risk] ${result.flagged ? "FLAGGED" : "clear"} ` +
          `${result.tier} (${result.kind}, p=${result.score.toFixed(2)}) ` +
          `message ${message.id} from ${message.author.tag}: ` +
          JSON.stringify(message.content.slice(0, 160))
      );

      if (result.flagged) await queueReaction(message, "⚠️");
      await queueReaction(message, riskEmoji(getRiskNumber(result)));
      await queueReaction(message, KIND_EMOJIS[result.kind] ?? KIND_EMOJIS.none);
    } catch (error) {
      console.error("[risk] Assessment failed:", error);
    }
  },
};

function riskEmoji(number: number): string {
  const digits = [
    "0️⃣",
    "1️⃣",
    "2️⃣",
    "3️⃣",
    "4️⃣",
    "5️⃣",
    "6️⃣",
    "7️⃣",
    "8️⃣",
    "9️⃣",
  ];
  return number === 10 ? "🔟" : digits[number] ?? digits[0];
}
