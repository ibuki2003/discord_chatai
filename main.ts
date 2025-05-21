import { Secret } from "./secret.ts";
import { AiWithMemory } from "./llm.ts";
import { bot } from "./discord.ts";

const TARGET_GUILD_ID = Secret.TARGET_GUILD_ID;
const TARGET_CHANNEL_ID = Secret.TARGET_CHANNEL_ID;

const ChannelAI = new Map<string, AiWithMemory>();

function getAi(guildId: string, channelId: string): AiWithMemory {
  if (ChannelAI.has(channelId)) {
    return ChannelAI.get(channelId)!;
  }
  const ai = new AiWithMemory(guildId, channelId);
  ChannelAI.set(channelId, ai);
  return ai;
}


bot.events.messageCreate = async (message) => {
  if (message.guildId?.toString() !== TARGET_GUILD_ID) return;
  if (message.channelId.toString() !== TARGET_CHANNEL_ID) return;
  if (message.author.id === bot.id) return;

  console.log("got message", {content: message.content})

  const ai = getAi(message.guildId?.toString(), message.channelId.toString());

  // show typing indicator
  const t = setTimeout(async () => {
    await bot.helpers.triggerTypingIndicator(message.channelId);
  }, 1000);

  const resp_content = await ai.getResponse(message);

  clearTimeout(t);

  if (resp_content !== null) {
    await bot.helpers.sendMessage(message.channelId, {
      content: resp_content,
    })
  }
};

await bot.start()

