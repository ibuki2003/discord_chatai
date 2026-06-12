import { parse } from "@std/yaml";
import { z } from "@zod/zod";

export type Provider = "openai" | "openrouter";

export type ModelConfig = {
  name: string;
  provider: Provider;
  reasoning_effort?: "low" | "medium" | "high";
};

export type ModelRoute = {
  model: string;
  trigger: string;
};

export type ChannelConfig = {
  models: ModelRoute[];
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

const ModelConfigSchema = z.object({
  name: z.string(),
  provider: z.enum(["openai", "openrouter"]),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
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

  for (const [guildId, guild] of Object.entries(result.data.guilds)) {
    for (const [channelId, channel] of Object.entries(guild.channels)) {
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
