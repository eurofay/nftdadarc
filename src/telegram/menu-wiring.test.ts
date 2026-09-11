import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mainMenu, mintOpsMenu, walletOpsMenu, insightsMenu, gasMenu } from "./menus";

// A button whose callback nothing handles is silent: Telegram shows the tap,
// the spinner clears, and nothing happens. Regrouping seventeen buttons into
// four is exactly the change that produces one, so this walks every button on
// every menu and checks something answers it.
const BOT = readFileSync(join(__dirname, "bot.ts"), "utf8");

function callbacks(markup: ReturnType<typeof mainMenu>): string[] {
  const rows = (markup as any).reply_markup.inline_keyboard as { callback_data?: string }[][];
  return rows.flat().map((b) => b.callback_data).filter((d): d is string => typeof d === "string");
}

/** Matches an exact action registration, or a template-literal family. */
function isHandled(id: string): boolean {
  if (BOT.includes(`bot.action("${id}"`)) return true;
  // e.g. gas:today / gas:week / gas:all registered from a loop over a list.
  const [prefix, suffix] = id.split(":");
  if (suffix && BOT.includes("bot.action(`" + prefix + ":${")) return true;
  return false;
}

const MENUS: [string, string[]][] = [
  ["main (owner)", callbacks(mainMenu(true))],
  ["main (guest)", callbacks(mainMenu(false))],
  ["minting (owner)", callbacks(mintOpsMenu(true))],
  ["minting (guest)", callbacks(mintOpsMenu(false))],
  ["wallets", callbacks(walletOpsMenu())],
  ["insights", callbacks(insightsMenu())],
  ["gas", callbacks(gasMenu())],
];

describe("every button goes somewhere", () => {
  for (const [name, ids] of MENUS) {
    it(`${name}`, () => {
      const dead = ids.filter((id) => !isHandled(id));
      expect(dead).toEqual([]);
    });
  }
});

describe("the start screen stays short", () => {
  it("fits without scrolling, which was the whole point", () => {
    // Fourteen buttons meant scrolling past everything to reach the one thing
    // used most. If this ever climbs back, the grouping has been undone.
    expect(callbacks(mainMenu(true)).length).toBeLessThanOrEqual(6);
    expect(callbacks(mainMenu(false)).length).toBeLessThanOrEqual(4);
  });

  it("keeps Smart Mint on the front page", () => {
    // It is the one that needs no prior knowledge, so burying it a tap deep
    // would be optimising for the rare case.
    expect(callbacks(mainMenu(true))).toContain("menu:smart");
  });

  it("shows no owner-only button to a guest", () => {
    const guest = callbacks(mainMenu(false));
    for (const ownerOnly of ["menu:smart", "menu:admin"]) {
      expect(guest).not.toContain(ownerOnly);
    }
    expect(callbacks(mintOpsMenu(false))).not.toContain("menu:fcfs");
    expect(callbacks(mintOpsMenu(false))).not.toContain("menu:osmint");
  });
});

describe("nothing was lost in the regrouping", () => {
  it("still reaches every feature that used to be on the start screen", () => {
    const reachable = new Set([
      ...callbacks(mainMenu(true)),
      ...callbacks(mintOpsMenu(true)),
      ...callbacks(walletOpsMenu()),
      ...callbacks(insightsMenu()),
    ]);
    for (const id of [
      "menu:wallets", "menu:settings", "menu:auto", "menu:copy", "menu:fund",
      "menu:sched", "menu:portfolio", "menu:activity", "menu:quick",
      "menu:consolidate", "menu:pnl", "menu:find", "menu:gas", "menu:filter",
      "menu:status", "menu:fcfs", "menu:admin", "menu:smart",
      // menu:osmint is deliberately gone. It asked the operator to know in
      // advance that a collection used a signed stage, which a contract
      // address does not tell you -- Smart Mint tries that route itself, so
      // the separate door was a way to get the answer wrong by hand.
    ]) {
      expect(reachable.has(id), `${id} is no longer reachable from the menus`).toBe(true);
    }
  });

  it("gives every group a way back", () => {
    for (const menu of [mintOpsMenu(true), walletOpsMenu(), insightsMenu(), gasMenu()]) {
      expect(callbacks(menu)).toContain("menu:main");
    }
  });
});
