import OpenAI from "openai";
import { OpenRouter } from "@openrouter/sdk";
import type {
  ChatFunctionToolFunction,
  ChatMessages,
} from "@openrouter/sdk/models";
import { Secret } from "./secret.ts";
import type { ModelConfig } from "./config.ts";

type ChatCompletionItem = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type LlmMessage = ChatCompletionItem;

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
  input: ChatCompletionItem[],
  systemPrompt: string,
  modelConfig: ModelConfig,
  tools?: Record<string, ToolDefinition>,
): AsyncGenerator<ResultItem> {
  switch (modelConfig.provider) {
    case "openai":
      yield* run_responses_api(input, systemPrompt, modelConfig, tools);
      break;
    case "openrouter":
      yield* run_chat_completion(input, systemPrompt, modelConfig, tools);
      break;
    default:
      throw new Error(
        `Unsupported provider: ${
          (modelConfig as { provider: string }).provider
        }`,
      );
  }
}

async function* run_responses_api(
  input: ChatCompletionItem[],
  systemPrompt: string,
  modelConfig: ModelConfig,
  tools?: Record<string, ToolDefinition>,
): AsyncGenerator<ResultItem> {
  const tool_schemas = tools
    ? Object.values(tools).map((t) => convert_tool_to_responses(t.schema))
    : undefined;

  const input_resp: OpenAI.Responses.ResponseInputItem[] = input.map(
    convert_item_to_responses,
  ).flat();

  const response = await openai_client.responses.create({
    instructions: systemPrompt,
    input: input_resp,
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
      yield {
        type: "tool_call",
        tool_name: part.name,
        content: part.arguments,
      };
      const tool = tools[part.name];
      if (tool) {
        await tool.callback(part.arguments);
      }
    }
  }
}

async function* run_chat_completion(
  input: ChatCompletionItem[],
  systemPrompt: string,
  modelConfig: ModelConfig,
  tools?: Record<string, ToolDefinition>,
): AsyncGenerator<ResultItem> {
  const tool_schemas: ChatFunctionToolFunction[] | undefined = tools
    ? Object.values(tools).map((t) =>
      t.schema as unknown as ChatFunctionToolFunction
    )
    : undefined;

  const all_tools = [
    ...(tool_schemas ?? []),
    ...(modelConfig.openrouter?.server_tools ?? []),
  ] as unknown as ChatFunctionToolFunction[];

  const messages: ChatMessages[] = [
    { role: "system", content: systemPrompt },
    ...(input as unknown as ChatMessages[]), // openai and openrouter incompatibility (but it works)
  ];

  while (true) {
    const res = await openrouter_client.chat.send({
      chatRequest: {
        model: modelConfig.name,
        messages,
        ...(all_tools.length > 0
          ? { tools: all_tools, tool_choice: "auto" }
          : {}),
        ...(modelConfig.reasoning_effort
          ? { reasoning: { effort: modelConfig.reasoning_effort } }
          : {}),
        stream: false,
      },
    });

    const choice = res.choices[0];
    if (!choice) break;

    messages.push(choice.message as unknown as ChatMessages);

    if (choice.message.content) {
      yield { type: "text", content: choice.message.content as string };
    }

    if (
      choice.finishReason !== "tool_calls" || !choice.message.toolCalls?.length
    ) {
      break;
    }

    for (const call of choice.message.toolCalls) {
      yield {
        type: "tool_call",
        tool_name: call.function.name,
        content: call.function.arguments,
      };
      const tool = tools?.[call.function.name];
      const result = tool
        ? await tool.callback(call.function.arguments)
        : `[ERROR] No tool found for function ${call.function.name}`;
      messages.push(
        {
          role: "tool",
          content: result,
          toolCallId: call.id,
        } as unknown as ChatMessages,
      );
    }
  }
}

function convert_item_to_responses(
  item: ChatCompletionItem,
): OpenAI.Responses.ResponseInputItem[] {
  // ensure content is an array
  const content = item.content
    ? Array.isArray(item.content) ? item.content : [item.content]
    : [];

  const result: OpenAI.Responses.ResponseInputItem[] = [];

  switch (item.role) {
    case "developer":
    case "system":
    case "user":
    case "assistant":
      result.push(
        <OpenAI.Responses.EasyInputMessage> {
          type: "message",
          role: item.role,
          content: content.map((c): OpenAI.Responses.ResponseInputContent => {
            // NOTE: TypeScript annotation allows only "input_text"
            // but openai api will only accept "output_text" for assistant messages
            const text_type = (item.role === "assistant"
              ? "output_text"
              : "input_text") as "input_text";
            if (typeof c === "string") {
              return { type: text_type, text: c };
            } else {
              switch (c.type) {
                case "text":
                  return { type: text_type, text: c.text };

                case "image_url":
                  return {
                    type: "input_image",
                    image_url: c.image_url.url,
                    detail: c.image_url.detail ?? "auto",
                  };

                case "input_audio":
                case "file":
                case "refusal":
                  throw new Error(
                    `Unsupported content type in Responses API: ${c.type}`,
                  );
              }
            }
          }),
        },
      );

      if (item.role === "assistant" && item.tool_calls) {
        for (const call of item.tool_calls) {
          if (call.type !== "function") continue;
          result.push({
            type: "function_call",
            name: call.function.name,
            arguments: call.function.arguments,
            call_id: call.id,
          });
        }
      }
      break;

    case "tool":
      result.push({
        type: "function_call_output",
        call_id: item.tool_call_id,
        output: content.map((c) => ({
          type: "input_text",
          text: typeof c === "string"
            ? c
            : (c as OpenAI.Chat.Completions.ChatCompletionContentPartText)
              .text,
        })),
      });
      break;

    default:
      // return [];
  }
  return result;
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
