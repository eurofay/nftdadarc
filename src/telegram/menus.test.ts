import { describe, it, expect } from "vitest";
import {
  mainMenu,
  walletsMenu,
  walletDetailMenu,
  walletHoldingsMenu,
  walletCollectionMenu,
  sellCollectionMenu,
  sellActionConfirmMenu,
  portfolioWalletsMenu,
  fundTargetsMenu,
  schedWalletsMenu,
} from "./menus";
import { WalletRecord } from "./store";

// Telegram rejects any inline button whose callback_data exceeds 64 bytes
// with BUTTON_DATA_INVALID — and it fails when the menu is *sent*, so a menu
// built from long values breaks the handler that opened it, not the button.
const LIMIT = 64;

function callbackData(markup: any): string[] {
  const rows = markup?.reply_markup?.inline_keyboard ?? [];
  return rows.flat().map((b: any) => b.callback_data).filter((d: any) => typeof d === "string");
}

function expectWithinLimit(markup: any) {
  for (const data of callbackData(markup)) {
    expect(
      Buffer.byteLength(data, "utf8"),
      `callback_data too long (${Buffer.byteLength(data, "utf8")}B): ${data}`
    ).toBeLessThanOrEqual(LIMIT);
  }
}

// Deliberately hostile inputs: a full-length address, and a slug far longer
// than anything seen in practice.
const ADDRESS = "0xE607f2b18daE93e1f5D4c5a5C71b1d1070823ba0";
const LONG_SLUG = "builder-bots-ai-robinhood-extended-edition-2026-collection";

const WALLETS: WalletRecord[] = [
  { label: "a-very-long-wallet-label-here", address: ADDRESS, encryptedKey: "x", addedAt: 0 },
];

// Mirrors the real tokenizer: short, monotonic ids.
function tokenizer() {
  const map: Record<string, string> = {};
  let n = 0;
  return (payload: string) => {
    for (const [k, v] of Object.entries(map)) if (v === payload) return k;
    const id = (++n).toString(36);
    map[id] = payload;
    return id;
  };
}

describe("inline keyboards stay within Telegram's 64-byte callback_data limit", () => {
  it("main menu", () => expectWithinLimit(mainMenu()));
  it("wallet list", () => expectWithinLimit(walletsMenu(WALLETS)));
  it("wallet detail", () => expectWithinLimit(walletDetailMenu(WALLETS[0])));
  it("portfolio wallet picker", () => expectWithinLimit(portfolioWalletsMenu(WALLETS)));
  it("fund targets", () => expectWithinLimit(fundTargetsMenu(WALLETS, new Set())));
  it("scheduled-mint wallets", () => expectWithinLimit(schedWalletsMenu(WALLETS, new Set())));

  it("wallet holdings — address + long slug, the case that actually broke", () => {
    const collections = [{ slug: LONG_SLUG, count: 33 }];
    expectWithinLimit(walletHoldingsMenu(ADDRESS, collections, tokenizer()));
  });

  it("wallet collection view", () => {
    expectWithinLimit(walletCollectionMenu(ADDRESS, LONG_SLUG, tokenizer(), "https://opensea.io/x"));
  });

  it("sell collection menu", () => {
    expectWithinLimit(sellCollectionMenu(ADDRESS, LONG_SLUG, true, tokenizer()));
  });

  it("sell confirm menu", () => {
    expectWithinLimit(sellActionConfirmMenu("accept", ADDRESS, LONG_SLUG, tokenizer()));
  });
});

describe("tokenized menus", () => {
  it("reuses one id for the same address+slug pair across a menu", () => {
    const tok = tokenizer();
    const data = callbackData(sellCollectionMenu(ADDRESS, LONG_SLUG, true, tok));
    // Accept / List / Refresh / Back all reference the same pair, so they
    // should share a single token rather than minting four.
    const ids = data.map((d) => d.split(":").pop());
    expect(new Set(ids).size).toBe(1);
  });

  it("still encodes the wallet address directly where it fits", () => {
    const data = callbackData(walletHoldingsMenu(ADDRESS, [], tokenizer()));
    expect(data.some((d) => d.includes(ADDRESS))).toBe(true);
  });
});
