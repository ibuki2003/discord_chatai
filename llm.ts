import OpenAI from "openai";
import OpenRouter from "@openrouter/api";
import { Secret } from "./secret.ts";
import type { ModelConfig } from "./config.ts";

export type ToolDefinition = {
  schema: OpenAI.Chat.Completions.ChatCompletionFunctionTool;
  callback: (argsJson: string) => Promise<string>;
};

export type UserTurnContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "auto" } };

export type ResultItem =
  | { type: "text"; content: string }
  | { type: "tool_call"; tool_name: string; content: string };

const openai_client = new OpenAI({
  apiKey: Secret.OPENAI_API_KEY,
});

const openrouter_client = new OpenRouter({
  apiKey: Secret.OPENROUTER_API_KEY,
});

export async function* run_llm(
  userTurn: UserTurnContent[],
  systemPrompt: string,
  modelConfig: ModelConfig,
  tools?: Record<string, ToolDefinition>,
): AsyncGenerator<ResultItem> {
  switch (modelConfig.provider) {
    case "openai":
      yield* run_responses_api(userTurn, systemPrompt, modelConfig, tools);
      break;
    case "openrouter":
      yield* run_chat_completion(userTurn, systemPrompt, modelConfig, tools);
      break;
    default:
      throw new Error(`Unsupported provider: ${(modelConfig as { provider: string }).provider}`);
  }
}

async function* run_responses_api(
  userTurn: UserTurnContent[],
  systemPrompt: string,
  modelConfig: ModelConfig,
  tools?: Record<string, ToolDefinition>,
): AsyncGenerator<ResultItem> {
  const tool_schemas = tools
    ? Object.values(tools).map((t) => convert_tool_to_responses(t.schema))
    : undefined;

  const input: OpenAI.Responses.ResponseInputItem[] = [
    {
      type: "message",
      role: "user",
      content: userTurn.map((item): OpenAI.Responses.ResponseInputContent => {
        if (item.type === "text") {
          return { type: "input_text", text: item.text };
        } else {
          return {
            type: "input_image",
            image_url: item.image_url.url,
            detail: item.image_url.detail,
          };
        }
      }),
    },
  ];

  const response = await openai_client.responses.create({
    instructions: systemPrompt,
    input,
    model: modelConfig.name,
    store: false,
    ...(tool_schemas
      ? { parallel_tool_calls: true, tool_choice: "auto", tools: tool_schemas }
      : {}),
    ...(modelConfig.reasoning_effort
      ? { reasoning: { effort: modelConfig.reasoning_effort, summary: "auto" } }
      : {}),
  });

  for (const part of response.output) {
    if (part.type === "message") {
      for (const msg of part.content) {
        if (msg.type === "output_text" && msg.text) {
          yield { type: "text", content: msg.text };
        }
      }
    } else if (part.type === "function_call" && tools) {
      yield { type: "tool_call", tool_name: part.name, content: part.arguments };
      const tool = tools[part.name];
      if (tool) {
        await tool.callback(part.arguments);
      }
    }
  }
}

async function* run_chat_completion(
  userTurn: UserTurnContent[],
  systemPrompt: string,
  modelConfig: ModelConfig,
  tools?: Record<string, ToolDefinition>,
): AsyncGenerator<ResultItem> {
  const tool_schemas = tools
    ? Object.values(tools).map((t) => t.schema)
    : undefined;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: userTurn.map((item): OpenAI.Chat.Completions.ChatCompletionContentPart => {
        if (item.type === "text") {
          return { type: "text", text: item.text };
        } else {
          return {
            type: "image_url",
            image_url: { url: item.image_url.url, detail: item.image_url.detail },
          };
        }
      }),
    },
  ];

  while (true) {
    const res = await openrouter_client.chat.completions.create({
      model: modelConfig.name,
      messages,
      ...(tool_schemas ? { tools: tool_schemas, tool_choice: "auto" as const } : {}),
      stream: false,
    }) as OpenAI.Chat.Completions.ChatCompletion;

    const choice = res.choices[0];
    if (!choice) break;

    messages.push(choice.message as OpenAI.Chat.Completions.ChatCompletionMessageParam);

    if (choice.message.content) {
      yield { type: "text", content: choice.message.content };
    }

    if (
      choice.finish_reason !== "tool_calls" ||
      !choice.message.tool_calls?.length
    ) {
      break;
    }

    for (const call of choice.message.tool_calls) {
      if (call.type !== "function") continue;
      yield { type: "tool_call", tool_name: call.function.name, content: call.function.arguments };
      const tool = tools?.[call.function.name];
      const result = tool
        ? await tool.callback(call.function.arguments)
        : `[ERROR] No tool found for function ${call.function.name}`;
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
}

function convert_tool_to_responses(
  tool: OpenAI.Chat.Completions.ChatCompletionFunctionTool,
): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters ?? null,
    strict: tool.function.strict ?? null,
  };
}
