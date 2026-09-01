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
   | `ANTHROPIC_API_KEY` | optional; enables 🛠 Admin -> Ask the assistant |
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

The bot is closed until you issue an invite:

    /invite alice

That prints a single-use code. Send it to one person. It is shown **once** —
only its hash is stored, so it cannot be read back, and a copy of the volume
gives nobody a way in.

A new user messaging the bot sees what it does and what they're risking, then
is asked for their code. Five wrong tries locks that user out for 15 minutes.
Everyone who gets in has their own wallets, settings and history.

    /invites            list codes and who holds them
    /revoke <id>        lock out one person, nobody else affected
    /revokeall          lock out everyone and kill every code
    /users              who has a store, and who currently has access

`/revoke` is the one to reach for: with a code per person you can remove
exactly whoever leaked theirs. `/revokeall` is for when you don't know which
code got out — it marks every code revoked, so re-sending a leaked one does
nothing, and you issue fresh invites afterwards.

Revoking never deletes anything. A locked-out user's wallets and settings sit
untouched; a fresh invite gives them everything back.

You are never gated by your own door — the owner id skips the invite check, so
there is no way to lock yourself away from the wallets.

## The admin panel

The owner sees a 🛠 Admin row on the main menu that nobody else does: issue an
invite, list invites, revoke one person, revoke everyone, and ask the
assistant. Everything there is also a command (`/invite`, `/invites`,
`/revoke`, `/revokeall`, `/users`, `/ask`).

**Ask the assistant** answers questions against the bot's live state - wallet
balances, whether the watcher is actually running, recent copy attempts and
why each was skipped. It needs `ANTHROPIC_API_KEY` set, and it costs per
question at normal API rates.

It is read-only by design: it is handed a snapshot and returns prose. It
cannot move funds, change a setting, or touch a wallet. An assistant with
authority over money is a much larger thing to get right than one that
explains what it sees, and the explaining is the useful part.

## Cost

One always-on container plus a small volume. The RPC calls, not the host, are
the thing that scales with users: each user's copy-mint watcher polls
independently, and public nodes throttle sustained `eth_getLogs` (measured:
5 rapid calls fine, 15 fail). A handful of users is fine on the current design;
many more needs one shared scan fanned out to all users rather than one scan
each.
