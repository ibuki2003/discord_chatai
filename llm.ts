import OpenAI from "openai";
import { Secret } from "./secret.ts";
import { getChatMemory, setChatMemory } from "./db.ts";

const SYSTEM_PROMPT = `
あなたはグループチャットに参加しているAIです。フレンドリーな性格で振る舞ってください。
過去の会話履歴がユーザー名とともに与えられます。あなたの名前は「AI」です。
また、長期記憶として以下の情報が与えられています。

【長期記憶】
{{MEMORY}}

返答を作成するとき、この長期記憶の情報を参考にすることができます。

返答するかどうか検討し、しないならfalseとだけ出力し、するならtrueと出力してください。
trueと出力した場合は、改行して、あなたの返答を出力してください。

また、長期記憶はいつでも更新し、以後の返答時に活用することができます。
長期記憶を更新する場合は、改行ののち、次のフォーマットで1行で、記憶しておくべき内容をすべて出力してください。古い内容も出力しないと、消去されてしまうことに注意してください。

UPDATE_MEMORY: 記憶内容
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
        content: SYSTEM_PROMPT.replace("{{MEMORY}}", this.memory),
      },
      {
        role: "user",
        content: history.join("\n"),
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
      const has_response = (lines[0].indexOf("true") !== -1);
      lines.shift();

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

      if (has_response && lines_response.length > 0) {
        return lines_response;
      }

      return null;
    } catch (error) {
      console.error("Error getting response:", error);
      return null;
    }
  }

}

