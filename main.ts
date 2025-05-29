import { Secret } from "./secret.ts";
import { AiWithMemory } from "./llm.ts";
import { bot } from "./discord.ts";
import { AsyncValue } from "@core/asyncutil/async-value";
import { Lock } from "@core/asyncutil/lock";

const TARGET_GUILD_ID = Secret.TARGET_GUILD_ID;
const TARGET_CHANNEL_ID = Secret.TARGET_CHANNEL_ID;

const ChannelAI = new Map<string, Lock<AsyncValue<AiWithMemory>>>();

function getAi(guildId: string, channelId: string): Lock<AsyncValue<AiWithMemory>> {
  if (ChannelAI.has(channelId)) {
    return ChannelAI.get(channelId)!;
  }
  const ai = new AiWithMemory(guildId, channelId);
  const lock = new Lock(new AsyncValue(ai));
  ChannelAI.set(channelId, lock);
  return lock;
}


bot.events.messageCreate = async (message) => {
  if (message.guildId?.toString() !== TARGET_GUILD_ID) return;
  if (message.channelId.toString() !== TARGET_CHANNEL_ID) return;
  if (message.author.id === bot.id) return;

  console.log("got message", {content: message.content})

  const ai = getAi(message.guildId?.toString(), message.channelId.toString());

  // show typing indicator
  let t = setTimeout(() => {
    t = setInterval(async () => {
      await bot.helpers.triggerTypingIndicator(message.channelId);
    }, 10000); // every 10 seconds
  }, 500);

  const resp_content = await ai.lock(async (ai) => {
    return await (await ai.get()).getResponse(message);
  });

  clearTimeout(t);

  if (resp_content !== null) {
    await bot.helpers.sendMessage(message.channelId, {
      content: resp_content,
    })
  }
};

await bot.start()

