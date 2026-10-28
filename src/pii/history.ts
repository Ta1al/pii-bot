import type { Message } from "discord.js";

export interface HistoryEntry {
  authorId: string;
  content: string;
}

const MAX_HISTORY = 20;
const MAX_CHANNELS = 200;
const MAX_ENTRY_CHARS = 300;
const FETCH_PAGE = 100;
const MAX_PAGES = 3;

/** Recent messages per channel, so we do not fetch history on every message. */
const buffers = new Map<string, HistoryEntry[]>();

function normalize(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_CHARS);
}

function touch(channelId: string, entries: HistoryEntry[]): void {
  buffers.delete(channelId);
  buffers.set(channelId, entries);
  if (buffers.size > MAX_CHANNELS) {
    const oldest = buffers.keys().next().value;
    if (oldest !== undefined) buffers.delete(oldest);
  }
}

async function seed(message: Message): Promise<HistoryEntry[]> {
  const collected: HistoryEntry[] = [];
  let before = message.id;

  try {
    // The bot replies to every message, so a single page of 20 would be mostly
    // bot output. Page back until there are MAX_HISTORY messages from humans.
    for (let page = 0; page < MAX_PAGES && collected.length < MAX_HISTORY; page++) {
      const fetched = await message.channel.messages.fetch({
        limit: FETCH_PAGE,
        before,
      });
      if (fetched.size === 0) break;

      const batch = [...fetched.values()]
        .reverse() // oldest first within the page
        .filter((m) => !m.author.bot && m.content.trim())
        .map((m) => ({ authorId: m.author.id, content: normalize(m.content) }));

      collected.unshift(...batch);

      const oldest = fetched.last()?.id;
      if (!oldest) break;
      before = oldest;

      if (fetched.size < FETCH_PAGE) break;
    }

    const entries = collected.slice(-MAX_HISTORY);
    touch(message.channelId, entries);
    return entries;
  } catch (error) {
    // Missing Read Message History, or a channel we cannot read.
    console.warn(
      `[risk] could not read history for channel ${message.channelId}:`,
      error instanceof Error ? error.message : error
    );
    touch(message.channelId, []);
    return [];
  }
}

/** Messages before `message`, oldest first. Seeds from the API on first use. */
export async function getHistory(message: Message): Promise<HistoryEntry[]> {
  const cached = buffers.get(message.channelId);
  const entries = cached ?? (await seed(message));
  return entries.filter((entry) => entry.content.length > 0);
}

/** Record a message so it is context for the next one. */
export function remember(message: Message): void {
  if (message.author.bot || !message.content.trim()) return;
  const entries = buffers.get(message.channelId) ?? [];
  entries.push({ authorId: message.author.id, content: normalize(message.content) });
  if (entries.length > MAX_HISTORY) entries.splice(0, entries.length - MAX_HISTORY);
  touch(message.channelId, entries);
}

/** The message this one replies to, if it is still available. */
export async function getReply(message: Message): Promise<HistoryEntry | null> {
  if (!message.reference) return null;
  try {
    const referenced = await message.fetchReference();
    if (referenced.author.bot || !referenced.content.trim()) return null;
    return {
      authorId: referenced.author.id,
      content: normalize(referenced.content),
    };
  } catch (error) {
    console.warn(
      `[risk] could not fetch replied message for ${message.id}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
