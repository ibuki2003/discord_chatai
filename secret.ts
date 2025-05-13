export const Secret = {
  DISCORD_TOKEN: Deno.env.get("DISCORD_TOKEN") || "",
  OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") || "",
  OPENAI_API_URL: Deno.env.get("OPENAI_API_URL") || "https://api.openai.com/v1",
  TARGET_GUILD_ID: Deno.env.get("TARGET_GUILD_ID") || "",
  TARGET_CHANNEL_ID: Deno.env.get("TARGET_CHANNEL_ID") || "",
};
