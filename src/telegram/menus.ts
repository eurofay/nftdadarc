// Inline keyboard builders. Kept separate from bot.ts purely for readability.

import { Markup } from "telegraf";
import { CHAINS } from "../chains";
import { WalletRecord, CopyTarget, BotSettings } from "./store";

export function maskAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💼 Wallets", "menu:wallets"), Markup.button.callback("⚙️ Settings", "menu:settings")],
    [Markup.button.callback("🎯 Auto Mint", "menu:auto"), Markup.button.callback("👀 Copy Mint", "menu:copy")],
    [Markup.button.callback("📊 Status", "menu:status")],
  ]);
}

export function walletsMenu(wallets: WalletRecord[]) {
  const rows = wallets.map((w) => [
    Markup.button.callback(`🗑 ${w.label} (${maskAddress(w.address)})`, `wallet:remove:${w.address}`),
  ]);
  rows.push([Markup.button.callback("➕ Add wallet", "wallet:add")]);
  rows.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

export function copyMenu(enabled: boolean, targets: CopyTarget[]) {
  const rows = targets.map((t) => [
    Markup.button.callback(`🗑 ${t.label} (${maskAddress(t.address)})`, `copy:remove:${t.address}`),
  ]);
  rows.push([Markup.button.callback(enabled ? "⏸ Turn off" : "▶️ Turn on", "copy:toggle")]);
  rows.push([Markup.button.callback("➕ Watch a wallet", "copy:add")]);
  rows.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

export function autoMenu(enabled: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(enabled ? "⏸ Turn off" : "▶️ Turn on", "auto:toggle")],
    [Markup.button.callback("⬅ Back", "menu:main")],
  ]);
}

export function settingsMenu(s: BotSettings) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Chain: ${s.chainKey}`, "setting:chain")],
    [Markup.button.callback(`Max fee: ${s.maxFeeGwei} gwei`, "setting:maxFeeGwei")],
    [Markup.button.callback(`Priority fee: ${s.priorityGwei} gwei`, "setting:priorityGwei")],
    [Markup.button.callback(`Gas limit: ${s.gasLimit}`, "setting:gasLimit")],
    [Markup.button.callback(`Auto max qty: ${s.autoMaxQuantity ?? "unlimited (true max)"}`, "setting:autoMaxQuantity")],
    [Markup.button.callback(`Copy-mint price cap: ${s.copyMintMaxPriceEth} ETH`, "setting:copyMintMaxPriceEth")],
    [Markup.button.callback("⬅ Back", "menu:main")],
  ]);
}

export function chainPickerMenu() {
  return Markup.inlineKeyboard(CHAINS.map((c) => [Markup.button.callback(c.name, `setting:chain:${c.key}`)]).concat([
    [Markup.button.callback("⬅ Back", "menu:settings")],
  ]));
}
