import { Database } from "sqlite";

const db = new Database("db.sqlite");

interface ChatMemory {
  guildId: string;
  memory: string;
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_memory (
      guildId TEXT PRIMARY KEY,
      memory TEXT
    );
  `);
}

runMigrations();

export function getChatMemory(guildId: string): ChatMemory | null {
  const result = db
    .prepare(
      `SELECT * FROM chat_memory WHERE guildId = ?`,
    )
    .value<[string, string]>(guildId);
  return result ? { guildId: result[0], memory: result[1] } : null;
}

export function setChatMemory(guildId: string, memory: string): void {
  // update or insert
  db.prepare(
    `INSERT INTO chat_memory (guildId, memory) VALUES (?, ?) ON CONFLICT(guildId) DO UPDATE SET memory = ?`,
  ).run(guildId, memory, memory);
}
