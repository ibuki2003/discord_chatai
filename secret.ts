export const Secret = {
  DISCORD_TOKEN: Deno.env.get("DISCORD_TOKEN") || "",
  OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") || "",
  OPENROUTER_API_KEY: Deno.env.get("OPENROUTER_API_KEY") || "",
};
