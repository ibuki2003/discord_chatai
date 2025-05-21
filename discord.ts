import * as Discordeno from "discordeno";
import { Intents } from "discordeno";
import { Secret } from "./secret.ts";

export const bot = Discordeno.createBot({
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
      user: true,
      nick: true,
    },
  },
  desiredPropertiesBehavior: Discordeno.DesiredPropertiesBehavior.ChangeType,

  events: {
    ready: ({ shardId }) => console.log(`Shard ${shardId} ready`),
  },
})

export type Bot = typeof bot;
export type Message = Bot["transformers"]["$inferredTypes"]["message"];
export type User = Bot["transformers"]["$inferredTypes"]["user"];

