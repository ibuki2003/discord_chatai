import { bot, Message } from "./discord.ts";
import {
  channelMap,
  config,
  DEFAULT_SYSTEM_PROMPT,
  type ModelConfig,
  type ModelRoute,
} from "./config.ts";
import { getChatMemory, setChatMemory } from "./db.ts";
import {
  LlmMessage,
  run_llm,
  type ToolDefinition,
} from "./llm.ts";
import { splitForDiscord } from "./util.ts";
import { format } from "@std/datetime/format";
import { AsyncValue } from "@core/asyncutil/async-value";
import { Lock } from "@core/asyncutil/lock";
import { OpenAI } from "openai";

const HISTORY_SIZE = 50;
const HISTORY_ALL_MAX = 30000;

interface MyMsg {
  author: string | null; // null if message is from AI
  content: string;
  timestamp: string;
}

type ChannelState = {
  guildId: string;
  channelId: string;
  history: MyMsg[];
  memory: string[];
  nickCache: Map<string, string>;
};

const channelLocks = new Map<string, Lock<AsyncValue<ChannelState>>>();

function getChannelLock(
  guildId: string,
  channelId: string,
): Lock<AsyncValue<ChannelState>> {
  if (channelLocks.has(channelId)) return channelLocks.get(channelId)!;
  const mem = getChatMemory(guildId)?.memory ?? "";
  const state: ChannelState = {
    guildId,
    channelId,
    history: [],
    memory: mem.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
    nickCache: new Map(),
  };
  const lock = new Lock(new AsyncValue(state));
  channelLocks.set(channelId, lock);
  return lock;
}

async function refreshHistory(state: ChannelState): Promise<void> {
  const members = await bot.helpers.getMembers(state.guildId, { limit: 100 });
  for (const member of members) {
    if (member.nick && member.user?.id) {
      state.nickCache.set(member.user.id.toString(), member.nick);
    }
  }
  // state.nickCache.set(bot.id.toString(), MY_NAME);

  const history = await bot.helpers.getMessages(state.channelId, {
    limit: HISTORY_SIZE,
  })
    .then((messages) =>
      messages.map((message) => formatRawMessage(message, state.nickCache))
    )
    .then((messages) => messages.reverse())
    .catch(() => []);
  state.history = history;
  trimHistory(state);
}

function addRawMessage(state: ChannelState, message: Message): void {
  if ("member" in message && message.author.id !== bot.id) {
    if (message.member?.nick) {
      state.nickCache.set(message.author.id.toString(), message.member.nick);
    } else {
      state.nickCache.delete(message.author.id.toString());
    }
  }
  state.history.push(formatRawMessage(message, state.nickCache));
  trimHistory(state);
}

function trimHistory(state: ChannelState): void {
  while (state.history.length > HISTORY_SIZE) {
    state.history.shift();
  }
  let length = state.history.join("\n").length;
  while (length > HISTORY_ALL_MAX) {
    const e = state.history.shift();
    if (!e) break;
    length -= e.content.length;
  }
}

function buildSystemPrompt(state: ChannelState): string {
  const memoryStr = state.memory
    .map((val, idx) => `${idx}: ${val}`)
    .join("\n") || "(何も記憶していません)";

  // @parent and @file directives are already resolved at config load time
  const globalPrompt = config.system_prompt ?? DEFAULT_SYSTEM_PROMPT;
  const guildPrompt = config.guilds[state.guildId]?.prompt ?? globalPrompt;
  const prompt = channelMap.get(state.channelId)?.channelCfg.prompt ??
    guildPrompt;

  return prompt
    .replace("{{MEMORY}}", memoryStr);
}

function makeMemoryTools(state: ChannelState): Record<string, ToolDefinition> {
  return {
    memory_add: {
      schema: {
        type: "function",
        function: {
          name: "memory_add",
          description: "長期記憶を1つ追加",
          parameters: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      callback: async (argsJson: string) => {
        const { content } = JSON.parse(argsJson);
        state.memory.push(content.trim());
        setChatMemory(state.guildId, state.memory.join("\n"));
        return "OK";
      },
    },
    memory_update: {
      schema: {
        type: "function",
        function: {
          name: "memory_update",
          description: "長期記憶を1つ更新",
          parameters: {
            type: "object",
            properties: {
              index: { type: "integer" },
              content: { type: "string" },
            },
            required: ["index", "content"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      callback: async (argsJson: string) => {
        const { index, content } = JSON.parse(argsJson);
        if (index >= 0 && index < state.memory.length) {
          state.memory[index] = content.trim();
          setChatMemory(state.guildId, state.memory.join("\n"));
          return "OK";
        }
        return `[ERROR] Index ${index} out of range`;
      },
    },
    memory_forget: {
      schema: {
        type: "function",
        function: {
          name: "memory_forget",
          description: "長期記憶を削除",
          parameters: {
            type: "object",
            properties: {
              indices: { type: "array", items: { type: "integer" } },
            },
            required: ["indices"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      callback: async (argsJson: string) => {
        const { indices } = JSON.parse(argsJson);
        const invalid = indices.filter((i: number) =>
          i < 0 || i >= state.memory.length
        );
        if (invalid.length > 0) {
          return `[ERROR] Indices out of range: ${invalid.join(", ")}`;
        }
        const toRemove = new Set<number>(indices);
        state.memory = state.memory.filter((_, i) => !toRemove.has(i));
        setChatMemory(state.guildId, state.memory.join("\n"));
        return "OK";
      },
    },
  };
}

function selectModel(
  content: string,
  routes: ModelRoute[],
): ModelConfig | null {
  for (const route of routes) {
    if (new RegExp(route.trigger, "i").test(content)) {
      return config.models[route.model];
    }
  }
  return null;
}

const formatDate = (date: Date): string => format(date, "yyyy/MM/dd HH:mm:ss");

function formatRawMessage(
  message: Message,
  nickCache: Map<string, string>,
): MyMsg {
  let content = message.content;

  const mentionsNicks = message.mentions?.map((mention) => [
    mention.id.toString(),
    nickCache.get(mention.id.toString()),
  ]) ?? [];

  content = content.replace(/<@!?(\d+)>/g, (match, userId) => {
    const user = message.mentions?.find((mention) => mention.id === userId);
    const nick = mentionsNicks.find((mention) => mention[0] === userId)?.[1];
    if (user) {
      return `@${nick ?? user.username}`;
    }
    return match;
  });

  const date = message.timestamp ? new Date(message.timestamp) : new Date();
  const username = message.member?.nick ??
    nickCache.get(message.author.id.toString()) ?? message.author.username;
  return {
    author: username,
    timestamp: formatDate(date),
    content,
  };
}

bot.events.messageCreate = async (message) => {
  if (message.author.id === bot.id) return;

  const channelIdStr = message.channelId.toString();
  const channelEntry = channelMap.get(channelIdStr);
  if (!channelEntry) return;

  const { guildId, channelCfg } = channelEntry;
  if (message.guildId?.toString() !== guildId) return;

  console.log("got message", { content: message.content });

  const lock = getChannelLock(guildId, channelIdStr);

  let cleanupTyping: () => void = () => {};
  const typingTimeout = setTimeout(() => {
    bot.helpers.triggerTypingIndicator(message.channelId);
    const interval = setInterval(() => {
      bot.helpers.triggerTypingIndicator(message.channelId);
    }, 10000);
    cleanupTyping = () => clearInterval(interval);
  }, 500);

  await lock.lock(async (stateVal) => {
    const state = await stateVal.get();

    if (state.history.length === 0) {
      await refreshHistory(state);
    } else {
      addRawMessage(state, message);
    }

    const modelConfig = selectModel(message.content, channelCfg.models);
    if (!modelConfig) return;

    const systemPrompt = buildSystemPrompt(state);
    const tools = makeMemoryTools(state);

    const attachments = [
      ...(message.attachments ?? []),
      ...(message.referencedMessage?.attachments ?? []),
    ];
    const messages: LlmMessage[] = state.history.map<LlmMessage>((msg) => (
      msg.author === null
        ? { role: "assistant", content: [{ type: "text", text: msg.content }] }
        : {
          role: "user",
          content: [{
            type: "text",
            text: `${msg.timestamp} <${msg.author}> ${msg.content}`,
          }],
        }
    ));
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && Array.isArray(messages[i].content)) {
        (messages[i].content as OpenAI.ChatCompletionContentPart[]).push(
          ...attachments
            .filter((att) => att.contentType?.startsWith("image/"))
            .map((att) => ({
              type: "image_url" as const,
              image_url: { url: att.url, detail: "auto" as const },
            })),
        );
      }
    }

    let outputText = "";
    try {
      for await (
        const item of run_llm(messages, systemPrompt, modelConfig, tools)
      ) {
        if (item.type === "text") {
          outputText += item.content;
          for (const segment of splitForDiscord(item.content)) {
            if (segment.trim()) {
              await bot.helpers.sendMessage(message.channelId, {
                content: segment,
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("Error from LLM:", err);
      return;
    }

    if (outputText) {
      state.history.push({
        author: null,
        content: outputText,
        timestamp: formatDate(new Date()),
      });
    }
  });

  clearTimeout(typingTimeout);
  cleanupTyping();
};

await bot.start();
