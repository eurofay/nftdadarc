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

### If the container starts and immediately exits

A log that lists the package's scripts and stops:

    Lifecycle scripts included in nft-public-mint@1.0.0:
      start
        node dist/telegram-bot.js
      ...

is `npm run` being run with **no script name**. That prints the script list,
exits 0, and Railway treats it as a clean run — no error anywhere, and the bot
never polls.

The cause is a **Custom Start Command** on the service, which overrides both
the Dockerfile's CMD and railway.json. Clear it, or set it to:

    node dist/telegram-bot.js

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
   | `WEB_ACCESS_TOKEN` | optional; enables the web UI. See below before setting it |
   | `WEB_PUBLIC_URL` | your Railway URL, if the web UI is on — `https://` turns on Secure cookies |

   Do **not** set `AUTO_WALLET_KEYS` in the cloud. It's for the local CLI's
   headless mode and would put a raw private key in a dashboard.

4. Deploy. The log should say `Telegram bot running.`

### If you turn the web UI on

`WEB_ACCESS_TOKEN` publishes a login page, on Railway's public URL, in front
of the same encrypted key store the bot uses. Nothing else in this deployment
is reachable without a Telegram account id that can't be forged — this is.

Generate the token with `openssl rand -hex 32`, set `WEB_PUBLIC_URL` to your
Railway URL so cookies get `Secure`, and use it nowhere else. A weak token is
refused at startup rather than accepted, so a failed boot here means the token,
not the deploy. Leave `WEB_ACCESS_TOKEN` unset and no web UI is served at all.

Turning it on does **not** change the one-instance rule below — the web UI
runs inside the same process as the bot.

### Run exactly one instance

Telegram allows a single long-polling consumer per token. A second instance
(a scaled replica, or your laptop still running `npm run bot`) makes both
fight over updates and drop messages. Keep replicas at 1 and stop the local
process once the cloud one is live.

## Backups

Admin -> 💾 Backup sends the whole store as a file: wallets, watchlist,
settings, seed phrases and history.

The secrets inside are encrypted with `WALLET_ENCRYPTION_KEY`, which lives in
the environment and is **not** in the file — so the backup alone can't spend
anything. That also means the two halves must be kept apart and both must
survive: the file without the key is unreadable, permanently.

Admin -> ♻️ Restore takes one back. Every key is decrypted and checked against
the address it's filed under *before* anything is written, so a backup from an
install with a different encryption key is refused rather than silently
restoring wallets nobody can spend from. The store being replaced is kept
alongside it as `*.pre-restore`.

Take one before any redeploy that touches the volume, and after adding wallets.

## Moving an existing install

Simplest route is Backup and Restore: 💾 Backup on the old deployment, create
the new one with the **same `WALLET_ENCRYPTION_KEY`**, then ♻️ Restore. This is
also how you move between Railway regions, since a volume is pinned to its
region and does not travel with the service.

Alternatively, copy `data/telegram-store.json` into the volume at
`/data/telegram-store.json` once. On the next start the bot migrates it to
`/data/users/<ownerId>.json` and leaves the original in place. Migration will
not overwrite an existing per-user store, so a repeat start is harmless.

`WALLET_ENCRYPTION_KEY` must match the machine the store came from. A different
key leaves the file readable but every private key in it undecryptable.

## Getting closer to the sequencer

The sequencer for Robinhood Chain sits in AWS `us-east-2` (Ohio). At fire time
the bot's critical path is a single round trip — the transaction is signed
before the wait and the socket is held warm through it — so the only remaining
lever is how long that one round trip takes.

Measured round trips to the sequencer:

| From | Round trip | In flight one way |
| --- | --- | --- |
| Europe | ~103ms | ~52ms |
| Railway US East | ~15ms | ~7.5ms |
| AWS `us-east-2`, same region | ~1ms | ~0.5ms |

### Read this before moving anything

Early fire (Settings → Early fire → `auto`) already recovers most of the
distance without moving hosts. It measures the round trip seconds before the
stage opens and sends a little early, so the transaction *arrives* as the stage
opens instead of a flight time afterwards:

| Setup | Transaction arrives |
| --- | --- |
| Railway, early fire off | stage open + 7.5ms |
| Railway, early fire auto | stage open + 2.5ms |
| `us-east-2`, early fire auto | stage open + 0.5ms |

So the move is worth about **2ms of arrival time**, not the 15ms it looks like
on paper. Turn early fire on first and see whether that is enough.

The better argument for moving is **jitter**, not the average. Early fire leads
by three quarters of the measured flight time, and that quarter is margin for
the network varying between the measurement and the send. In-region, that
variance is far smaller, so the timing is not just faster but more predictable —
which is what decides a contested mint.

### If you do move

The bot is a container with one volume, so nothing about it is Railway-specific.

1. **Pick the compute.** `us-east-2` is the target region. EC2 with Docker and
   an EBS volume is the direct route and lets you pin the availability zone.
   App Runner has no persistent volume and is the wrong shape for this.
2. **Copy `WALLET_ENCRYPTION_KEY` first.** Same value, exactly. A different key
   leaves the store readable and every private key in it undecryptable — the
   backup file will not save you.
3. **Move the wallets** with 💾 Backup on the old host, then ♻️ Restore on the
   new one. See *Moving an existing install* above.
4. **Mount the volume at `/data`.** The Dockerfile sets `DATA_DIR=/data` and
   declares no `VOLUME`; the host has to attach one. On an ephemeral filesystem
   every redeploy destroys every stored wallet.
5. **Run exactly one instance.** Two bots polling the same Telegram token fight
   over updates, and two watchers on the same wallets double-mint.
6. **Re-measure.** Settings → Status shows the RPC latency. If the number is not
   close to 1ms you are not as near the sequencer as you think — check the
   region and the availability zone before assuming the move worked.

Keep the old deployment stopped but not deleted until the new one has fired a
mint successfully.

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
