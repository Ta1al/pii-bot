import type { Message } from "discord.js";

const WINDOW_MS = 5_000;
const MAX_REACTIONS = 5;

const timestamps: number[] = [];
let tail = Promise.resolve();

function waitForSlot(): Promise<void> {
  const now = Date.now();
  while (timestamps[0] !== undefined && timestamps[0] <= now - WINDOW_MS) {
    timestamps.shift();
  }

  if (timestamps.length < MAX_REACTIONS) {
    timestamps.push(now);
    return Promise.resolve();
  }

  const delay = timestamps[0] + WINDOW_MS - now;
  return new Promise((resolve) => {
    setTimeout(() => {
      timestamps.push(Date.now());
      resolve();
    }, delay);
  });
}

/** Queues reactions globally so Discord's reaction rate limit is not exceeded. */
export function queueReaction(message: Message, emoji: string): Promise<void> {
  const run = tail.then(async () => {
    await waitForSlot();
    await message.react(emoji);
  });

  // Keep the queue usable after an individual reaction fails.
  tail = run.catch(() => undefined);
  return run;
}
