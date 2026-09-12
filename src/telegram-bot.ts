#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { createBot } from "./telegram/bot";
import { startAlertsBot } from "./telegram/alerts-bot";
import { startWebServer } from "./web/server";
import { startRadarBot } from "./telegram/radar-bot";
import { startSmartAlertsBot } from "./telegram/smart-alerts-bot";
import { cleanToken } from "./telegram/token";
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
  // The main token gets the same cleaning as the companion one. A dashboard
  // field stores quotes literally, and the resulting 401 says nothing about
  // why -- worth catching for the bot that cannot start without it.
  const rawToken = required("TELEGRAM_BOT_TOKEN");
  const cleanedToken = cleanToken(rawToken);
  for (const note of cleanedToken.notes) console.warn(`TELEGRAM_BOT_TOKEN: ${note}.`);
  if (!cleanedToken.looksValid) {
    console.error(
      "TELEGRAM_BOT_TOKEN is not shaped like a bot token (digits, a colon, then the secret). " +
        "Paste only the value @BotFather gave you -- no quotes, no NAME= prefix."
    );
  }
  const token = cleanedToken.token;
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

  // Optional: a second bot carrying the activity alerts and the wallet
  // filter, so neither buries the menus in the main thread. Absent by
  // default, in which case both stay on the main bot.
  const alerts = startAlertsBot(process.env.TELEGRAM_ALERTS_BOT_TOKEN, ownerId, stores);

  // Read at click time, not at startup: Telegram only tells us the username
  // after launch, and the radar's deep link is built long after that.
  let mainUsername: string | undefined;
  const hooks: { armScheduled?: (userId: number, id: string) => void } = {};
  const bot = createBot({ token, ownerId, stores, access, alerts, hooks });

  // Two more chats, and the split is about attention rather than capability.
  // The radar carries what is COMING -- drops announcing themselves before
  // they open. The alerts bot carries what watched wallets just DID. Each is
  // its own notification setting, which is the entire reason they are not one
  // bot with two menus.
  //
  // Smart is declared first so the radar can link into it; the username is
  // read at click time, by which point both have introduced themselves.
  //
  // Neither can spend. Both link back here to arm, behind this bot's access
  // control, because two front doors onto a key store is two to guard.
  const smart = startSmartAlertsBot(
    process.env.TELEGRAM_SMART_BOT_TOKEN,
    ownerId,
    stores,
    () => mainUsername
  );

  const radar = startRadarBot(
    process.env.TELEGRAM_RADAR_BOT_TOKEN,
    ownerId,
    stores,
    () => mainUsername,
    () => smart?.username
  );

  // Optional web UI. Same store and engine as the bot -- the point of it is
  // that a browser has no 90-second handler timeout, so a scan that takes
  // minutes can just stream its progress instead of racing a clock.
  //
  // Silent when unconfigured, loud when misconfigured: a weak token on a door
  // to a key store should stop the door opening, not be discovered later.
  startWebServer({
    stores,
    ownerId,
    token: process.env.WEB_ACCESS_TOKEN,
    port: Number(process.env.PORT) || 8080,
    secureCookies: (process.env.WEB_PUBLIC_URL ?? "").startsWith("https://"),
    // So a mint armed in a browser fires without waiting for a restart.
    onScheduled: (id) => hooks.armScheduled?.(ownerId, id),
  });

  process.once("SIGINT", () => {
    bot.stop("SIGINT");
    alerts?.stop("SIGINT");
    radar?.stop("SIGINT");
    smart?.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    bot.stop("SIGTERM");
    alerts?.stop("SIGTERM");
    radar?.stop("SIGTERM");
    smart?.stop("SIGTERM");
  });

  // launch()'s own promise only resolves after stop() is called — it never
  // resolves while long-polling is active — so "started successfully" has
  // to come from the onLaunch callback, not an awaited return. The promise
  // still rejects on a genuine startup failure (bad token, network), which
  // is what the catch below is for.
  bot.telegram
    .getMe()
    .then((me) => (mainUsername = me.username))
    .catch(() => {
      /* the radar's Arm button degrades to no button, which beats not starting */
    });

  bot
    .launch(() => {
      console.log(
        `Telegram bot running. Owner: ${ownerId}. ` +
          `Other users get their own isolated wallets and settings. ` +
          (access.isConfigured()
            ? `${access.listCodes().length} invite(s) issued.`
            : "No invites issued yet — /invite [name] to let someone in.")
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
