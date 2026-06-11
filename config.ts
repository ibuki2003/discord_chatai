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
  channelId: string;
  guildId?: string;
  models: ModelRoute[];
  prompt?: string;
};

export type Config = {
  models: Record<string, ModelConfig>;
  channels: ChannelConfig[];
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
  channelId: z.string(),
  guildId: z.string().optional(),
  models: z.array(ModelRouteSchema).min(1),
});

const ConfigSchema = z.object({
  models: z.record(z.string(), ModelConfigSchema).default({}),
  channels: z.array(ChannelConfigSchema).default([]),
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

  for (const channel of result.data.channels) {
    for (const route of channel.models) {
      if (!result.data.models[route.model]) {
        console.error(
          `config.yaml: channel ${channel.channelId}: model "${route.model}" not found in models section`,
        );
        Deno.exit(1);
      }
    }
  }

  return result.data;
}

export const config: Config = loadConfig();

export const channelMap: Map<string, ChannelConfig> = new Map(
  config.channels.map((ch) => [ch.channelId, ch]),
);
