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

返答を作成するとき、長期記憶の情報を参考にすることができます。
また、長期記憶はいつでも更新し、以後の返答時に活用することができます。長期記憶を更新するには、次のコマンドを使います。
コマンドは、改行の直後に1行で出力してください。複数のコマンドを出力することもできます。

MEMORY_ADD (記憶内容)
MEMORY_UPDATE (記憶番号) (新しい記憶内容)
MEMORY_FORGET (記憶番号)

例:
- MEMORY_FORGET 2
- MEMORY_ADD 返答は敬語ではなく、フレンドリーな口調で行う

# 長期記憶

{{MEMORY}}

# 過去の会話履歴

{{HISTORY}}
`;

export const MODEL_ID = "gpt-4.1-mini";

const client = new OpenAI({
  apiKey: Secret.OPENAI_API_KEY,
});

// split into n+1 parts
function splitn(str: string, delim: string, n: number): string[] {
  const result: string[] = [];
  let start = 0;
  while (result.length + 1 < n) {
    const index = str.indexOf(delim, start);
    if (index === -1) {
      break;
    }
    result.push(str.substring(start, index));
    start = index + delim.length;
  }
  result.push(str.substring(start));
  return result;
}

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
      .then((messages) => Promise.all(messages))
      .then((messages) => messages.reverse())
      .catch(() => []);
    this.history = history;
    this.trimHistory();
  }

  private async addMessage(message: Message | MyMsg) {
    if ("member" in message && message.author.id !== bot.id) {
      if (message.member?.nick) {
        this.nick_cache.set(message.author.id.toString(), message.member.nick);
      } else {
        this.nick_cache.delete(message.author.id.toString());
      }
    }

    const content = await formatMessage(message, this.nick_cache);
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
      await this.addMessage(message);
    }

    // only response to message with "AI" call
    if (!(["AI", "ＡＩ"].some((word) => message.content.toUpperCase().includes(word)))) {
      return null;
    }

    const memory_str = Object.entries(this.memory).map(([key, value]) => `${key}: ${value}`).join("\n");
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: SYSTEM_PROMPT
          .replace("{{MEMORY}}", memory_str)
          .replace("{{HISTORY}}", this.history.slice(0, this.history.length - 1).join("\n")),
      },
      {
        role: "user",
        content: this.history[this.history.length - 1],
      },
    ];
    try {
      const response = await client.chat.completions.create({
        messages,
        model: MODEL_ID,
        stream: false,
      });
      console.log("Response:", response);
      const content = response.choices[0].message.content;
      if (content === null) return null;

      const lines = content.split("\n");

      const memory_entries = Object.fromEntries(Object.entries(this.memory));
      const memory_adds: string[] = [];
      let memory_updated = false;

      const lines_response = lines.map((line) => {
          if (line.startsWith("MEMORY_ADD")) {
            const newmem = line.substring(11).trim();
            memory_adds.push(newmem);
            memory_updated = true;
            console.log("Memory add:", newmem);
            return null;
          }
          if (line.startsWith("MEMORY_UPDATE")) {
            const [_, idx, newmem] = splitn(line, " ", 3);
            if (memory_entries[idx]) {
              memory_entries[idx] = newmem.trim();
              memory_updated = true;
              console.log("Memory update:", idx, newmem);
            } else {
              console.warn(`Memory index ${idx} not found for update.`);
            }
            return null;
          }
          if (line.startsWith("MEMORY_FORGET")) {
            const [_, idx] = splitn(line, " ", 2);
            if (memory_entries[idx]) {
              delete memory_entries[idx];
              memory_updated = true;
              console.log("Memory forget:", idx);
            } else {
              console.warn(`Memory index ${idx} not found for forget.`);
            }
            return null;
          }
          return line;
        })
        .filter(Boolean)
        .join("\n")
        .trim();

      if (memory_updated) {
        this.memory = [
          ...Object.values(memory_entries),
          ...memory_adds,
        ];
        setChatMemory(this.guildId, this.memory.join("\n"));
        console.log("Updated memory:", this.memory);
      }

      if (lines_response.length > 0) {
        this.addMessage({
          author: MY_NAME,
          content: lines_response,
          date: new Date(),
        });

        return lines_response;
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

async function formatMessage(message: Message | MyMsg, nickcache: Map<string, string>): Promise<string> {
  let content = message.content;

  if ("date" in message) {
    return `[${formatDate(message.date)}] ${message.author}: ${content}`;
  }

  const mentions_nicks = await Promise.all(
    message.mentions?.map(
      (mention) => [
        mention.id.toString(),
        nickcache.get(mention.id.toString()),
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


