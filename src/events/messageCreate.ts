import { Events, Message } from "discord.js";

export default {
  name: Events.MessageCreate,
  execute(message: Message) {
    console.log(`Message created: ${message.content}`);
  },
};
