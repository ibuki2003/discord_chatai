import { Secret } from "./secret.ts";
import * as Discordeno from "discordeno";
import { Intents } from "discordeno";
import { CachedMap } from "./caches.ts";
import { AiWithMemory } from "./llm.ts";
import { format } from "@std/datetime/format";

const TARGET_GUILD_ID = Secret.TARGET_GUILD_ID;
const TARGET_CHANNEL_ID = Secret.TARGET_CHANNEL_ID;

const HISTORY_SIZE = 50;
const HISTORY_LINE_MAX = 100; // chars
const HISTORY_ALL_MAX = 1000; // chars

const bot = Discordeno.createBot({
  token: Secret.DISCORD_TOKEN,
  intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent | Intents.GuildMembers,
  desiredProperties: {
    message: {
      id: true,
      author: true,
      guildId: true,
      channelId: true,
      content: true,
      mentions: true,
      components: true,
      member: true,
      timestamp: true,
    },
    user: {
      id: true,
      username: true,
      globalName: true,
      bot: true,
    },
    member: {
      nick: true,
    },
  },
  desiredPropertiesBehavior: Discordeno.DesiredPropertiesBehavior.ChangeType,

  events: {
    ready: ({ shardId }) => console.log(`Shard ${shardId} ready`),
  },
})

// const MY_NAME = (await bot.helpers.getUser(bot.id)).username;
const MY_NAME = "AI";

const memberNickCache = new CachedMap(async (id) => (await bot.helpers.getMember(TARGET_GUILD_ID, id)).nick);

type Bot = typeof bot;
type Message = Bot["transformers"]["$inferredTypes"]["message"];
type User = Bot["transformers"]["$inferredTypes"]["user"];

const ChannelHistory = new Map<string, string[]>();
const ChannelAI = new Map<string, AiWithMemory>();

type MyMsg = { author: string; content: string; date: Date; };

const formatDate = (date: Date): string => format(date, "yyyy/MM/dd HH:mm:ss")

async function formatMessage(message: Message | MyMsg): Promise<string> {
  let content = message.content;

  if ("date" in message) {
    return `[${formatDate(message.date)}] ${message.author}: ${content}`;
  }

  const mentions_nicks = await Promise.all(
    message.mentions?.map(
      async (mention) => [
        mention.id.toString(),
        await memberNickCache.get(mention.id.toString()),
      ]
    ) ?? []
  );

  content = content.replace(/<@!?(\d+)>/g, (match, userId) => {
    const user = message.mentions?.find((mention) => mention.id === userId);
    const nick = mentions_nicks.find((mention) => mention[0] === userId)?.[1];
    if (user) {
      return `@${nick ?? user.username}`;
    }
    return match;
  });

  const date = message.timestamp ? new Date(message.timestamp) : new Date();
  const username = message.member?.nick ?? message.author.username;
  // trim up to 100 characters
  return `[${formatDate(date)}] ${username}: ${content}`.substring(0, HISTORY_LINE_MAX);
}

function trimHistory(history: string[]) {
  while (history.length > HISTORY_SIZE) {
    history.shift();
  }
  let length = history.join("\n").length;
  while (length > HISTORY_ALL_MAX) {
    const e = history.shift();
    if (!e) break;
    length -= e.length;
  }
}

async function getChannelHistory(channelId: string, bot: Bot): Promise<string[]> {
  if (ChannelHistory.has(channelId)) {
    return ChannelHistory.get(channelId)!;
  }
  // const history: string[] = [];
  const history = await bot.helpers.getMessages(channelId, { limit: HISTORY_SIZE })
    .then((messages) => messages.map((message) => formatMessage(message)))
    .then((messages) => Promise.all(messages))
    .then((messages) => messages.reverse())
    .catch(() => []);

  trimHistory(history);

  ChannelHistory.set(channelId, history);
  return history;
}

async function putChannelHistory(channelId: string, message: Message | MyMsg, bot: Bot) {
  const history_fetching = !ChannelHistory.has(channelId);
  const history = await getChannelHistory(channelId, bot);

  // NOTE: if the history is being fetched, new message is already in the history
  if (history_fetching) return;

  const content = await formatMessage(message);

  history.push(content);

  trimHistory(history);
}

function getAi(guildId: string, channelId: string): AiWithMemory {
  if (ChannelAI.has(channelId)) {
    return ChannelAI.get(channelId)!;
  }
  const ai = new AiWithMemory(guildId);
  ChannelAI.set(channelId, ai);
  return ai;
}


bot.events.messageCreate = async (message) => {
  if (message.guildId?.toString() !== TARGET_GUILD_ID) return;
  if (message.channelId.toString() !== TARGET_CHANNEL_ID) return;
  if (message.author.id === bot.id) return;

  console.log("got message", {content: message.content})

  message.member && memberNickCache.set(message.author.id.toString(), message.member.nick);

  await putChannelHistory(message.channelId.toString(), message, bot);

  // only response to message with "AI" call
  if (!(["AI", "ＡＩ"].some((word) => message.content.toUpperCase().includes(word)))) {
    return;
  }

  const ai = getAi(message.guildId?.toString(), message.channelId.toString());

  // show typing indicator
  const t = setTimeout(async () => {
    await bot.helpers.triggerTypingIndicator(message.channelId);
  }, 1000);

  const resp_content = await ai.getResponse(await getChannelHistory(message.channelId.toString(), bot));

  clearTimeout(t);

  if (!resp_content) {
    return;
  }

  await putChannelHistory(message.channelId.toString(), {
    author: MY_NAME,
    content: resp_content,
    date: new Date(),
  }, bot);
  await bot.helpers.sendMessage(message.channelId, {
    content: resp_content,
  })
};

await bot.start()

