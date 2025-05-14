import OpenAI from "openai";
import { Secret } from "./secret.ts";
import { getChatMemory, setChatMemory } from "./db.ts";

const SYSTEM_PROMPT = `
# 指示
あなたはグループチャットに参加しているAIです。名前は「AI」と呼ばれます。
フレンドリーな性格で振る舞ってください。
ユーザーの発言に対して、必要ならば返答してください。参考として、過去の会話履歴もユーザー名とともに与えられます。

また、長期記憶として以下の情報が与えられています。

【長期記憶】
{{MEMORY}}

返答を作成するとき、この長期記憶の情報を参考にすることができます。
また、長期記憶はいつでも更新し、以後の返答時に活用することができます。長期記憶を更新するには、次のコマンドを使います。
コマンドは、改行の直後に1行で出力してください。複数のコマンドを出力することもできます。

MEMORY_ADD (記憶内容)
MEMORY_UPDATE (記憶番号) (新しい記憶内容)
MEMORY_FORGET (記憶番号)

例:
- MEMORY_FORGET 2
- MEMORY_ADD 返答は敬語ではなく、フレンドリーな口調で行う

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

export class AiWithMemory {
  guildId: string;
  memory: string[];

  constructor(guildId: string) {
    this.guildId = guildId;
    const mem = getChatMemory(guildId)?.memory ?? "(何も記憶していません)";
    this.memory = mem.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  }

  async getResponse(history: string[]): Promise<string | null> {
    const memory_str = Object.entries(this.memory).map(([key, value]) => `${key}: ${value}`).join("\n");
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: SYSTEM_PROMPT
          .replace("{{MEMORY}}", memory_str)
          .replace("{{HISTORY}}", history.slice(0, history.length - 1).join("\n")),
      },
      {
        role: "user",
        content: history[history.length - 1],
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
        return lines_response;
      }

      return null;
    } catch (error) {
      console.error("Error getting response:", error);
      return null;
    }
  }

}

