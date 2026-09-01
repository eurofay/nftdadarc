#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { createBot } from "./telegram/bot";
import { UserStores } from "./telegram/user-stores";
import { AccessControl } from "./telegram/access-control";

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
  const stores = new UserStores(dataDir, encryptionKey);

  // One-time move of the pre-multi-user store to its owner. Refuses to
  // overwrite an existing per-user store, so running this twice is safe.
  const legacy = path.join(dataDir, "telegram-store.json");
  if (stores.migrateLegacy(legacy, ownerId)) {
    console.log(`Migrated ${legacy} to the per-user store for owner ${ownerId}.`);
    console.log("The original file was left in place; delete it once you've confirmed everything is there.");
  }

  // Global for the whole bot, not per user: one password, one revoke.
  const access = new AccessControl(path.join(dataDir, "access.json"));

  const bot = createBot({ token, ownerId, stores, access });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  // launch()'s own promise only resolves after stop() is called — it never
  // resolves while long-polling is active — so "started successfully" has
  // to come from the onLaunch callback, not an awaited return. The promise
  // still rejects on a genuine startup failure (bad token, network), which
  // is what the catch below is for.
  bot
    .launch(() => {
      console.log(
        `Telegram bot running. Owner: ${ownerId}. ` +
          `Other users get their own isolated wallets and settings. ` +
          (access.isConfigured()
            ? "Access password is set."
            : "No access password set yet — /password <new> to open the bot to others.")
      );
    })
    .catch((err: any) => {
      console.error(`Failed to start: ${err.description || err.message}`);
      if (err.response?.error_code === 401) {
        console.error("That's an invalid bot token — check TELEGRAM_BOT_TOKEN against what @BotFather gave you.");
      }
      process.exit(1);
    });
}

void main();
