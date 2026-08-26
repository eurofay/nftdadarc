#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { createBot } from "./telegram/bot";
import { TelegramStore } from "./telegram/store";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const ownerId = Number(required("TELEGRAM_OWNER_ID"));
  if (!Number.isFinite(ownerId)) {
    console.error("TELEGRAM_OWNER_ID must be a numeric Telegram user id.");
    process.exit(1);
  }
  const encryptionKey = required("WALLET_ENCRYPTION_KEY");

  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  const store = new TelegramStore(path.join(dataDir, "telegram-store.json"), encryptionKey);

  const bot = createBot({ token, ownerId, store });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  try {
    await bot.launch();
  } catch (err: any) {
    console.error(`Failed to start: ${err.description || err.message}`);
    if (err.response?.error_code === 401) {
      console.error("That's an invalid bot token — check TELEGRAM_BOT_TOKEN against what @BotFather gave you.");
    }
    process.exit(1);
  }
  console.log(`Telegram bot running. Only replies to owner id ${ownerId} in a private chat.`);
}

void main();
