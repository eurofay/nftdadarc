# Running the bot 24/7

The bot long-polls Telegram, so it needs a process that stays up — not a
serverless function and not your laptop. Any host that runs a container works;
Railway is used below because it's the cheapest thing that does volumes well.

## The one thing you must not skip

**Attach a persistent volume mounted at `/data`.**

Wallets, seed-derived keys, watchlists and history all live in that directory.
Container filesystems are ephemeral: without a volume, every redeploy — and
every automatic restart — silently deletes every wallet in the bot. There is no
warning and no recovery. The encrypted store is the only copy of those keys
unless you separately kept the seed phrase.

Note: the Dockerfile deliberately contains no `VOLUME` instruction — Railway
rejects an image that declares one. The mount is created by attaching a volume
in the dashboard, which is the step below.

## Railway

1. Push this repo to GitHub, then **New Project → Deploy from GitHub repo**.
   `railway.json` selects the Dockerfile, so no build config is needed.

2. **Add a Volume**, mount path `/data`. Do this *before* the first deploy that
   you add wallets to.

3. Set variables (Settings → Variables):

   | Variable | Notes |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | from @BotFather |
   | `TELEGRAM_OWNER_ID` | your numeric id; you keep admin, others get their own space |
   | `WALLET_ENCRYPTION_KEY` | **the same value as local**, or existing wallets won't decrypt |
   | `RPC_URL_ROBINHOOD` | public endpoint first, then a fallback |
   | `RPC_URL_ETHEREUM` | optional |
   | `OPENSEA_API_KEY` | optional; only for names, art and floors |
   | `DATA_DIR` | leave unset — the image sets `/data` |

   Do **not** set `AUTO_WALLET_KEYS` in the cloud. It's for the local CLI's
   headless mode and would put a raw private key in a dashboard.

4. Deploy. The log should say `Telegram bot running.`

### Run exactly one instance

Telegram allows a single long-polling consumer per token. A second instance
(a scaled replica, or your laptop still running `npm run bot`) makes both
fight over updates and drop messages. Keep replicas at 1 and stop the local
process once the cloud one is live.

## Moving an existing install

Copy `data/telegram-store.json` into the volume at `/data/telegram-store.json`
once. On the next start the bot migrates it to `/data/users/<ownerId>.json` and
leaves the original in place — delete it yourself after confirming your wallets
are there. Migration will not overwrite an existing per-user store, so a repeat
start is harmless.

`WALLET_ENCRYPTION_KEY` must match the machine the store came from. A different
key leaves the file readable but every private key in it undecryptable.

## Now that other people can use it

Each Telegram user gets their own isolated store, but the keys still sit on
**your** server, encrypted with **your** key. You are holding other people's
funds. Practical consequences:

- A leaked `WALLET_ENCRYPTION_KEY` plus a copy of the volume exposes everyone.
- Back up the volume, and treat that backup as if it were the funds themselves.
- Tell users to fund these wallets with only what they can afford to lose;
  keys arrive over Telegram, which is not end-to-end encrypted for bots.

## Letting other people in

The bot is closed until you set a password:

    /password <something long>

Share that with testers. Anyone who messages the bot is asked for it before
they can do anything, gets five tries, then a 15-minute lockout. Each person
who gets in has their own wallets, settings and history — nobody sees anyone
else's.

If the password leaks:

    /revokeall <a different password>

That removes everyone in one step AND replaces the password. Both halves
matter: a new password alone leaves the people already inside, and kicking
people out alone leaves the leaked password working. Nobody's wallets are
deleted — they're locked out, and get everything back by entering the new
password.

`/users` lists who has a store and who currently has access.

You are never gated by your own door — the owner id skips the password, so a
forgotten one can't strand the wallets.

## Cost

One always-on container plus a small volume. The RPC calls, not the host, are
the thing that scales with users: each user's copy-mint watcher polls
independently, and public nodes throttle sustained `eth_getLogs` (measured:
5 rapid calls fine, 15 fail). A handful of users is fine on the current design;
many more needs one shared scan fanned out to all users rather than one scan
each.
