import OpenAI from "openai";
import { Secret } from "./secret.ts";
import { getChatMemory, setChatMemory } from "./db.ts";
import { format } from "@std/datetime/format";
import { bot, Message } from "./discord.ts";

const HISTORY_SIZE = 50;
const HISTORY_LINE_MAX = 100; // chars
const HISTORY_ALL_MAX = 1000; // chars

// const MY_NAME = (await bot.helpers.getUser(bot.id)).username;
const MY_NAME = "AI";

// NOTE: system prompt should have constant prefix, so that we can use "cached" input for speedup and cost
const SYSTEM_PROMPT = `
# 指示
あなたはグループチャットに参加しているAIです。名前は「AI」と呼ばれます。
フレンドリーな性格で振る舞ってください。
ユーザーの発言に対して、必要ならば返答してください。参考として、過去の会話履歴もユーザー名とともに与えられます。

返答を作成するとき、過去に保存された長期記憶の情報を参照することができます。
また、長期記憶は今後の返答に活用するため、必要に応じて更新してください。
ユーザーの要求に応じて、または自分で必要と判断した場合、長期記憶を更新することができます。
記憶の更新は、返答を作成した後に行ってください。

# 長期記憶

{{MEMORY}}

# 過去の会話履歴

{{HISTORY}}
`;

export const MODEL_MAP: Record<string, (content: string) => boolean> = {
  "o4-mini": (content: string) => content.startsWith("!ai-boost"),
  "gpt-4.1-mini": (content: string) => ["AI", "ＡＩ"].some((word) => content.toUpperCase().includes(word)),
};

const MEMORY_TOOLS: OpenAI.Responses.ResponseCreateParams['tools'] = [
  {
    type: "function",
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
  {
    type: "function",
    name: "memory_update",
    description: "長期記憶を1つ更新",
    parameters: {
      type: "object",
      properties: { index: { type: "integer" }, content: { type: "string" } },
      required: ["index", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "memory_forget",
    description: "長期記憶を1つ削除",
    parameters: {
      type: "object",
      properties: { index: { type: "integer" } },
      required: ["index"],
      additionalProperties: false,
    },
    strict: true,
  },
]

type MemoryToolCall = OpenAI.Responses.ResponseFunctionToolCall & (
  | { name: "memory_add"; arguments: { content: string } }
  | { name: "memory_update"; arguments: { index: number; content: string } }
  | { name: "memory_forget"; arguments: { index: number } }
);


const client = new OpenAI({
  apiKey: Secret.OPENAI_API_KEY,
});

export type MyMsg = { author: string; content: string; date: Date; };

export class AiWithMemory {
  guildId: string;
  channelId: string;
  memory: string[];
  history: string[];
  nick_cache: Map<string, string>;

  constructor(guildId: string, channelId: string) {
    this.guildId = guildId;
    this.channelId = channelId;
    const mem = getChatMemory(guildId)?.memory ?? "(何も記憶していません)";
    this.memory = mem.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    this.history = [];
    this.nick_cache = new Map();
  }

  private async refreshHistory() {
    // refresh nick cache
    const members = await bot.helpers.getMembers(this.guildId, {limit: 100});
    for (const member of members) {
      if (member.nick && member.user?.id) {
        this.nick_cache.set(member.user.id.toString(), member.nick);
      }
    }
    this.nick_cache.set(bot.id.toString(), MY_NAME);

    // and then get history
    const history = await bot.helpers.getMessages(this.channelId, { limit: HISTORY_SIZE })
      .then((messages) => messages.map((message) => formatMessage(message, this.nick_cache)))
      .then((messages) => messages.reverse())
      .catch(() => []);
    this.history = history;
    this.trimHistory();
  }

  private addMessage(message: Message | MyMsg) {
    if ("member" in message && message.author.id !== bot.id) {
      if (message.member?.nick) {
        this.nick_cache.set(message.author.id.toString(), message.member.nick);
      } else {
        this.nick_cache.delete(message.author.id.toString());
      }
    }

    const content = formatMessage(message, this.nick_cache);
    this.history.push(content);
    this.trimHistory();
  }

  private trimHistory() {
    while (this.history.length > HISTORY_SIZE) {
      this.history.shift();
    }
    let length = this.history.join("\n").length;
    while (length > HISTORY_ALL_MAX) {
      const e = this.history.shift();
      if (!e) break;
      length -= e.length;
    }
  }

  async getResponse(message: Message): Promise<string | null> {
    if (this.history.length === 0) {
      await this.refreshHistory();
    } else {
      this.addMessage(message);
    }

    // select model based on content predicates
    const selectedModel = Object.entries(MODEL_MAP).find(([_, predicate]) => predicate(message.content))?.[0];
    if (!selectedModel) {
      return null;
    }

    const memory_str = Object.entries(this.memory).map(([key, value]) => `${key}: ${value}`).join("\n");
    const system_instructions = SYSTEM_PROMPT
      .replace("{{MEMORY}}", memory_str)
      .replace("{{HISTORY}}", this.history.slice(0, this.history.length - 1).join("\n"));
    const user_input = this.history[this.history.length - 1];
    try {
      // call the responses API with a single input
      const response = await client.responses.create({
        instructions: system_instructions,
        input: user_input,
        model: selectedModel,
        parallel_tool_calls: true,
        tool_choice: "auto",
        tools: MEMORY_TOOLS,
        store: false,
      });
      console.log("Response:", response.output);

      const memory_entries = Object.fromEntries(Object.entries(this.memory));
      const memory_adds: string[] = [];
      let memory_updated = false;

      let outputText = "";
      response.output.forEach((part) => {
          if (part.type === "message") {
            part.content.forEach((msg) => {
              if (msg.type === "output_text") {
                outputText += msg.text;
              }
            });
          } else if (part.type === "function_call") {
            // Handle tool calls here if needed
            console.log("Tool call:", part);
            const call = { name: part.name, arguments: JSON.parse(part.arguments) } as MemoryToolCall;
            switch (call.name) {
              case 'memory_add': {
                const newmem = call.arguments.content.trim();
                memory_adds.push(newmem);
                memory_updated = true;
                console.log("Memory add:", newmem);
                return null;
              }
              case 'memory_update': {
                const { index: idx, content: newmem } = call.arguments;
                if (memory_entries[idx]) {
                  memory_entries[idx] = newmem.trim();
                  memory_updated = true;
                  console.log("Memory update:", idx, newmem);
                } else {
                  console.warn(`Memory index ${idx} not found for update.`);
                }
                return null;
              }
              case 'memory_forget': {
                const idx = call.arguments.index;
                if (memory_entries[idx]) {
                  delete memory_entries[idx];
                  memory_updated = true;
                  console.log("Memory forget:", idx);
                } else {
                  console.warn(`Memory index ${idx} not found for forget.`);
                }
                return null;
              }
            }
          }
      });

      if (memory_updated) {
        this.memory = [
          ...Object.values(memory_entries),
          ...memory_adds,
        ];
        setChatMemory(this.guildId, this.memory.join("\n"));
        console.log("Updated memory:", this.memory);
      }

      if (outputText.length > 0) {
        this.addMessage({
          author: MY_NAME,
          content: outputText,
          date: new Date(),
        });

        return outputText || null;
      }

      return null;
    } catch (error) {
      console.error("Error getting response:", error);
      return null;
    }
  }

}

const formatDate = (date: Date): string => format(date, "yyyy/MM/dd HH:mm:ss")

// const memberNickCache = new CachedMap(async (id) => (await bot.helpers.getMember(TARGET_GUILD_ID, id)).nick);

function formatMessage(message: Message | MyMsg, nickcache: Map<string, string>): string {
  let content = message.content;

  if ("date" in message) {
    return `[${formatDate(message.date)}] ${message.author}: ${content}`;
  }

  const mentions_nicks = message.mentions?.map((mention) => [
    mention.id.toString(),
    nickcache.get(mention.id.toString()),
  ]) ?? [];

  content = content.replace(/<@!?(\d+)>/g, (match, userId) => {
    const user = message.mentions?.find((mention) => mention.id === userId);
    const nick = mentions_nicks.find((mention) => mention[0] === userId)?.[1];
    if (user) {
      return `@${nick ?? user.username}`;
    }
    return match;
  });

  const date = message.timestamp ? new Date(message.timestamp) : new Date();
  const username = message.member?.nick ?? nickcache.get(message.author.id.toString()) ?? message.author.username;
  // trim up to 100 characters
  return `[${formatDate(date)}] ${username}: ${content}`.substring(0, HISTORY_LINE_MAX);
}


