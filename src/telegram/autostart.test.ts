import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bot 3's radar and bot 4's watcher now run without being asked. Two things
// have to hold for that to be an improvement rather than a nuisance:
// it must actually start, and STOP must survive the next deploy — otherwise
// the off switch only means "until the next push".

const radar = readFileSync(join(__dirname, "radar-bot.ts"), "utf8");
const smart = readFileSync(join(__dirname, "smart-alerts-bot.ts"), "utf8");

describe("starting on their own", () => {
  it("bot 3 begins watching at launch", () => {
    const afterLaunch = radar.slice(radar.indexOf(".launch("));
    expect(afterLaunch).toContain("startWatching(ownerId)");
  });

  it("bot 4 begins watching at launch", () => {
    const afterLaunch = smart.slice(smart.indexOf(".launch("));
    expect(afterLaunch).toContain("beginWatching(ownerId)");
  });

  it("both address the owner's own chat, which needs no prior interaction", () => {
    // A Telegram private chat carries the same id as the user, so there is a
    // chat to report into before anyone has tapped anything.
    for (const [name, src] of [["radar", radar], ["smart", smart]] as const) {
      expect(src.slice(src.indexOf(".launch(")), name).toContain("ownerId");
    }
  });
});

describe("stopping stays stopped", () => {
  it("bot 3 writes the choice down", () => {
    expect(radar).toContain("radarWatchOn: false");
    expect(radar).toContain("radarWatchOn !== false");
  });

  it("bot 4 writes the choice down", () => {
    expect(smart).toContain("smartWatchOn: false");
    expect(smart).toContain("smartWatchOn !== false");
  });

  it("treats an absent setting as ON, so nothing has to be enabled first", () => {
    // `!== false` rather than `=== true`: a store written before these
    // existed has neither field, and watching is what these bots are for.
    for (const [name, src] of [["radar", radar], ["smart", smart]] as const) {
      expect(src.includes("WatchOn === true"), `${name} should not require an explicit true`).toBe(false);
    }
  });
});

describe("an unreachable chat does not stop the watcher", () => {
  it("bot 4's opening message is best-effort", () => {
    // Telegram refuses to let a bot write to someone who has not pressed
    // Start. At boot that is likely, and it must not abort the watch.
    const announce = smart.slice(smart.indexOf("Watching ${store.listSmartWallets().length}"));
    expect(announce.slice(0, 200)).toContain("catch(() => {})");
  });
});

describe("one start path, not two", () => {
  it("bot 4's button and its launch share it", () => {
    // The rejection guard is easy to add in one place and forget in the
    // other, and forgetting it stops the PROCESS rather than the watcher.
    expect((smart.match(/void watch\(/g) ?? []).length).toBe(1);
  });
});
