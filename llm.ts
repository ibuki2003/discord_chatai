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

長期記憶はいつでも更新し、以後の返答時に活用することができます。
長期記憶を更新する場合は、改行ののち、次のフォーマットで1行で、記憶しておくべき内容をすべて出力してください。今後も記憶しておきたい内容も出力する必要があります。出力しなかった記憶は失われます。

UPDATE_MEMORY: 記憶内容

# 過去の会話履歴

{{HISTORY}}
`;

const MODEL_ID = "gpt-4.1-mini";

const client = new OpenAI({
  apiKey: Secret.OPENAI_API_KEY,
});

export class AiWithMemory {
  guildId: string;
  memory: string;

  constructor(guildId: string) {
    this.guildId = guildId;
    this.memory = getChatMemory(guildId)?.memory ?? "(何も記憶していません)";
  }

  async getResponse(history: string[]): Promise<string | null> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: SYSTEM_PROMPT
          .replace("{{MEMORY}}", this.memory)
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

      const lines_memory = lines.filter((line) => line.startsWith("UPDATE_MEMORY:"));
      const lines_response = lines
        .filter((line) => !line.startsWith("UPDATE_MEMORY:"))
        .join("\n")
        .trim();

      if (lines_memory.length > 0) {
        this.memory = lines_memory[0].replace("UPDATE_MEMORY:", "").trim();
        setChatMemory(this.guildId, this.memory);
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

