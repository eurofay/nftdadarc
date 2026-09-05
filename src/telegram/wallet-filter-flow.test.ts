import { describe, it, expect } from "vitest";
import { registerWalletFilter } from "./wallet-filter-flow";

/**
 * A stand-in for Telegraf that records what got registered and hands back
 * the middleware, so the flow can be exercised without a network or a token.
 */
function stubBot() {
  const actions: string[] = [];
  const handlers: any[] = [];
  const commands: string[] = [];
  const bot: any = {
    action: (name: any) => actions.push(String(name)),
    on: (_filter: any, handler: any) => handlers.push(handler),
    command: (name: string) => commands.push(name),
    start: () => {},
  };
  return { bot, actions, handlers, commands };
}

const deps = {
  ownerId: 1,
  stores: { for: () => ({ getSettings: () => ({ chainKey: "robinhood" }) }) } as any,
};

const ctx = (over: Record<string, unknown> = {}) => ({
  chat: { id: 99 },
  from: { id: 1 },
  reply: async () => ({ chat: { id: 99 }, message_id: 1 }),
  telegram: { editMessageText: async () => {} },
  ...over,
});

describe("registerWalletFilter", () => {
  it("registers every action the flow needs to be usable", () => {
    const { bot, actions } = stubBot();
    registerWalletFilter(bot, deps);
    expect(actions).toEqual(expect.arrayContaining(["menu:filter", "filter:cancel", "filter:run"]));
  });

  it("registers a document and a text handler", () => {
    const { bot, handlers } = stubBot();
    registerWalletFilter(bot, deps);
    expect(handlers).toHaveLength(2);
  });

  describe("pass-through", () => {
    // The flow mounts alongside the host bot's own handlers. If it consumed
    // messages while idle it would silently break every other conversation on
    // that bot — wallet entry, settings, the lot.
    it("lets an unrelated text message reach the host", async () => {
      const { bot, handlers } = stubBot();
      registerWalletFilter(bot, deps);
      let reachedHost = false;
      await handlers[1](ctx({ message: { text: "add a wallet" } }), async () => {
        reachedHost = true;
      });
      expect(reachedHost).toBe(true);
    });

    it("lets an unrelated document reach the host", async () => {
      // A backup file uploaded to the main bot must still restore, not be
      // read as a wallet list.
      const { bot, handlers } = stubBot();
      registerWalletFilter(bot, deps);
      let reachedHost = false;
      await handlers[0](ctx({ message: { document: { file_id: "x" } } }), async () => {
        reachedHost = true;
      });
      expect(reachedHost).toBe(true);
    });

    it("ignores a document from anyone but the owner", async () => {
      const { bot, handlers } = stubBot();
      registerWalletFilter(bot, deps);
      let reachedHost = false;
      await handlers[0](
        ctx({ from: { id: 999 }, message: { document: { file_id: "x" } } }),
        async () => {
          reachedHost = true;
        }
      );
      expect(reachedHost).toBe(true);
    });
  });

  describe("beginFor", () => {
    // The deep link from the main bot arrives as ?start=filter and must land
    // on "upload your file". Without this the button would open a welcome
    // screen and you would go looking for the thing you just clicked.
    it("arms a chat so the next upload is taken as a wallet list", async () => {
      const { bot, handlers } = stubBot();
      const handle = registerWalletFilter(bot, deps);
      handle.beginFor(99);

      let reachedHost = false;
      let replied = "";
      await handlers[0](
        ctx({
          message: { document: { file_id: "x", file_size: 99 * 1024 * 1024 } },
          reply: async (t: string) => {
            replied = t;
          },
        }),
        async () => {
          reachedHost = true;
        }
      );
      expect(reachedHost).toBe(false);
      expect(replied).toContain("20 MB");
    });

    it("arms only the chat it was given", async () => {
      const { bot, handlers } = stubBot();
      const handle = registerWalletFilter(bot, deps);
      handle.beginFor(1234);

      let reachedHost = false;
      await handlers[0](ctx({ message: { document: { file_id: "x" } } }), async () => {
        reachedHost = true;
      });
      expect(reachedHost).toBe(true);
    });
  });

  it("keeps conversations separate per chat", async () => {
    // Two chats filtering at once must not share a wallet list.
    const { bot, actions } = stubBot();
    registerWalletFilter(bot, deps);
    expect(actions.filter((a) => a === "menu:filter")).toHaveLength(1);
  });
});
