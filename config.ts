import { parse } from "@std/yaml";
import { dirname, fromFileUrl, resolve } from "@std/path";
import { z } from "@zod/zod";

export type Provider = "openai" | "openrouter";

export type OpenRouterServerTool = {
  type: "openrouter:web_search";
  parameters?: {
    engine?: "auto" | "native" | "exa" | "firecrawl" | "parallel" | "perplexity";
    max_results?: number;
    max_total_results?: number;
    search_context_size?: "low" | "medium" | "high";
    max_characters?: number;
  };
};

export type OpenRouterConfig = {
  server_tools?: OpenRouterServerTool[];
};

export type ModelConfig = {
  name: string;
  provider: Provider;
  reasoning_effort?: "low" | "medium" | "high";
  openrouter?: OpenRouterConfig;
};

export type ModelRoute = {
  model: string;
  trigger: string;
};

export type ChannelConfig = {
  models: ModelRoute[];
  prompt?: string;
};

export type GuildConfig = {
  prompt?: string;
  channels: Record<string, ChannelConfig>;
};

export type Config = {
  models: Record<string, ModelConfig>;
  guilds: Record<string, GuildConfig>;
  system_prompt?: string;
};

const OpenRouterServerToolSchema = z.object({
  type: z.literal("openrouter:web_search"),
  parameters: z.object({
    engine: z.enum(["auto", "native", "exa", "firecrawl", "parallel", "perplexity"]).optional(),
    max_results: z.number().int().min(1).max(25).optional(),
    max_total_results: z.number().int().min(1).optional(),
    search_context_size: z.enum(["low", "medium", "high"]).optional(),
    max_characters: z.number().int().min(1).max(100000).optional(),
  }).optional(),
});

const OpenRouterConfigSchema = z.object({
  server_tools: z.array(OpenRouterServerToolSchema).optional(),
});

const ModelConfigSchema = z.object({
  name: z.string(),
  provider: z.enum(["openai", "openrouter"]),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  openrouter: OpenRouterConfigSchema.optional(),
});

const ModelRouteSchema = z.object({
  model: z.string(),
  trigger: z.string().refine(
    (t) => {
      try {
        new RegExp(t);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid regex pattern" },
  ),
});

const ChannelConfigSchema = z.object({
  models: z.array(ModelRouteSchema).min(1),
  prompt: z.string().optional(),
});

const GuildConfigSchema = z.object({
  prompt: z.string().optional(),
  channels: z.record(z.string(), ChannelConfigSchema).default({}),
});

const ConfigSchema = z.object({
  models: z.record(z.string(), ModelConfigSchema).default({}),
  guilds: z.record(z.string(), GuildConfigSchema).default({}),
  system_prompt: z.string().optional(),
});

export const DEFAULT_SYSTEM_PROMPT = `
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

const CONFIG_DIR = dirname(fromFileUrl(import.meta.url));

// Resolve @./path and @/path directives by inlining file contents.
// @parent is left as-is for the parent-chain resolution step.
// Any other @directive is a fatal error.
function resolveFileDirectives(text: string): string {
  return text.replace(/@(\S+)/g, (match, directive: string) => {
    if (directive.startsWith(".") || directive.startsWith("/")) {
      const filePath = resolve(CONFIG_DIR, directive);
      try {
        return Deno.readTextFileSync(filePath);
      } catch {
        console.error(`config.yaml: prompt file not found: ${filePath}`);
        Deno.exit(1);
      }
    }
    if (directive === "parent") return match;
    console.error(`config.yaml: unknown prompt directive: @${directive}`);
    Deno.exit(1);
  });
}

function loadConfig(): Config {
  let text: string;
  try {
    text = Deno.readTextFileSync(new URL("./config.yaml", import.meta.url));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(
        "config.yaml not found. Copy config.example.yaml to config.yaml and fill in your settings.",
      );
      Deno.exit(1);
    }
    throw err;
  }

  const result = ConfigSchema.safeParse(parse(text) ?? {});
  if (!result.success) {
    console.error("config.yaml validation failed:", result.error.format());
    Deno.exit(1);
  }

  // Step 1: resolve @file directives in all prompt fields
  if (result.data.system_prompt) {
    result.data.system_prompt = resolveFileDirectives(result.data.system_prompt);
  }
  for (const [guildId, guild] of Object.entries(result.data.guilds)) {
    if (guild.prompt) guild.prompt = resolveFileDirectives(guild.prompt);
    for (const [channelId, channel] of Object.entries(guild.channels)) {
      if (channel.prompt) {
        channel.prompt = resolveFileDirectives(channel.prompt);
      }
      for (const route of channel.models) {
        if (!result.data.models[route.model]) {
          console.error(
            `config.yaml: guild ${guildId} channel ${channelId}: model "${route.model}" not found in models section`,
          );
          Deno.exit(1);
        }
      }
    }
  }

  // Step 2: resolve @parent chain (global → guild → channel)
  const globalPrompt = result.data.system_prompt ?? DEFAULT_SYSTEM_PROMPT;
  for (const guild of Object.values(result.data.guilds)) {
    const guildPrompt = guild.prompt
      ? guild.prompt.replace("@parent", globalPrompt)
      : undefined;
    if (guild.prompt) guild.prompt = guildPrompt;
    const parentForChannel = guildPrompt ?? globalPrompt;
    for (const channel of Object.values(guild.channels)) {
      if (channel.prompt) {
        channel.prompt = channel.prompt.replace("@parent", parentForChannel);
      }
    }
  }

  return result.data;
}

export const config: Config = loadConfig();

// flat map: channelId -> { guildId, channelCfg }
export const channelMap: Map<string, { guildId: string; channelCfg: ChannelConfig }> =
  new Map(
    Object.entries(config.guilds).flatMap(([guildId, guild]) =>
      Object.entries(guild.channels).map(([channelId, channelCfg]) => [
        channelId,
        { guildId, channelCfg },
      ])
    ),
  );
