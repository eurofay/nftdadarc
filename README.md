# NFT Public Mint Sniper

A command-line tool for sniping **public** NFT mints on OpenSea's SeaDrop, across
Ethereum, Base and Robinhood Chain.

It builds the mint transaction from **on-chain data only** - price, fee recipient
and per-wallet limit all come straight from the SeaDrop contract. That means:

- **No OpenSea account, login, or access token.**
- **No API rate limits** to lose a mint to.
- **Faster.** Every transaction is signed and serialised *before* the stage opens,
  so at the exact start time the only work left is writing bytes to the network.

Multi-wallet: paste as many keys as you like and they all fire in parallel.

---

## Requirements

- **Node.js 18 or newer** — check with `node --version`. Get it from
  [nodejs.org](https://nodejs.org) if you don't have it.
- A wallet with some ETH on the chain you're minting on.

---

## Step 1 — Install

Run these **one line at a time**, pressing Enter after each:

```bash
git clone https://github.com/morsyxbt/nft-public-mint.git
cd nft-public-mint
npm install
npm run build
```

Before running `npm install`, check your prompt ends in `nft-public-mint` — if the
`cd` didn't take, everything after it fails.

Then confirm the build worked:

```bash
npm start -- --help
```

<details>
<summary>Install errors</summary>

**`Set-Location : A positional parameter cannot be found`** (Windows PowerShell)
Two commands got pasted onto one line — you'll see something like
`cd nft-public-mintnpm install`. Run each line separately.

**`Could not read package.json` / `Missing script: build`**
You're in the wrong folder. Run `cd nft-public-mint` first.

**`npm` or `git` is not recognised**
Install [Node.js 18+](https://nodejs.org) and [Git](https://git-scm.com/downloads),
then reopen your terminal.

</details>

## Step 2 — Configure (optional but recommended)

```bash
cp .env.example .env
```

Open `.env` and add a private RPC URL for the chain you'll mint on, e.g.:

```
RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

A free [Alchemy](https://alchemy.com) key takes two minutes and is the single
biggest factor in whether you win a contested mint. You can also paste it at the
prompt instead — the tool works without any `.env` at all, falling back to public
nodes.

> **Never put private keys in `.env`.** You paste them into the CLI at run time.
> They're held in memory for that run only and never written to disk.

## Step 3 — Run it

```bash
npm start
```

The wizard asks you seven things:

| Step | What it wants |
|---|---|
| **1. Private keys** | Paste one per line, hidden as you type. Blank line to finish. Each key is confirmed back to you by its wallet address, so you can check you pasted the right one. |
| **2. Chain** | Ethereum, Base, or Robinhood. |
| **3. Quantity** | How many NFTs **per wallet**. |
| **4. NFT link** | An OpenSea collection link, an item link, a slug, or the raw `0x` contract address. A contract address or item link always works with no API key; a collection slug needs a lookup that usually works unauthenticated. |
| **5. RPC** | Paste a full URL, or just your Alchemy key and it expands automatically. Blank uses `.env`, or public nodes. |
| **6. Gas** | Ceiling and tip. The live base fee is shown right above the prompt. |
| **7. Timing** | Wait for the stage to open, or fire now if it's already live. |

Then it shows a summary and asks `Fire?`. **Nothing is sent until you type `y`.**

## Step 4 — Set it and walk away

If the drop opens later, choose **"Wait for the stage"**. It pre-signs everything,
holds, and fires at the exact start time — no supervision needed. The `Fire?`
confirmation comes *before* the wait, so there's no second prompt at mint time.

Two things to get right if you're leaving it running:

- **Stop your computer from sleeping.** A sleeping machine suspends the process
  and the countdown freezes.
- **Leave the terminal window open.** Closing it kills the run.

---

## Step 5 — Auto mode: unattended free-mint watcher

```bash
npm start -- --auto
```

Instead of minting one collection you point it at, this watches the whole
chain and mints **any** SeaDrop collection the moment its public stage goes
live at `mintPrice = 0` — fully autonomous, no `Fire?` prompt.

Discovery is entirely on-chain: every SeaDrop collection shares one singleton
contract, and that contract emits an event with the full stage (price,
window, per-wallet cap) whenever any project configures its public drop.
Watching that one contract's event log is a complete, real-time feed of
every SeaDrop drop on the chain — no OpenSea dependency, and it can't be
spoofed by an unrelated contract. `OPENSEA_API_KEY` is optionally used to
label sightings with a collection name in the log, nothing more.

Because nothing prompts, everything comes from `.env` (see the `AUTO_*`
block in `.env.example`):

| Variable | What it does |
|---|---|
| `AUTO_WALLET_KEYS` | Comma-separated private keys. **Required.** |
| `AUTO_CHAIN` | Which chain to watch (defaults to `CHAIN`, then `base`). |
| `AUTO_POLL_MS` | How often to check for new blocks. Default 4000. |
| `AUTO_MAX_QUANTITY` | Optional cap if you don't want the literal per-wallet max. |
| `AUTO_MAX_MINTS_PER_RUN` | Optional cap on distinct collections auto-fired before it stops itself. |

Every fire re-reads the drop on-chain immediately before signing — the event
only proves a stage *was* configured; if the price or window has changed by
the time it's checked, it skips rather than trusts stale data. `Ctrl+C` stops
it cleanly and prints how many collections it fired on.

**This is meaningfully riskier than the wizard**, not because "free" mints
cost ETH — they don't — but because it spends gas automatically, with no
review, on every SeaDrop drop matching the filter, including low-quality or
spam collections a human would skip. See Security below before running it.

---

## Step 6 — Telegram bot: control it from anywhere

```bash
npm run bot
```

A remote control surface for everything above, running as a long-lived
process (your own always-on machine, a VPS, wherever) so you interact with it
from Telegram instead of a terminal:

- **Wallets** — add/remove from a chat, list shows masked addresses only.
- **Settings** — chain, gas ceiling/tip, gas limit, quantity caps — all editable
  via inline buttons.
- **`/mint <link-or-address> <quantity>`** — one-off manual mint, same engine
  as the wizard.
- **Auto mint** — start/stop the [free-mint watcher](#step-5--auto-mode-unattended-free-mint-watcher)
  from a button instead of a terminal flag.
- **Copy mint** — watch one or more wallets, and copy any `mintPublic` call
  they make using your own wallets. Unlike auto mode this isn't restricted to
  free drops (the point is following a wallet's judgment, paid or not), so a
  `copyMintMaxPriceEth` cap in Settings is the one guardrail against blindly
  following it into an expensive mint. It never replays the watched wallet's
  raw transaction — it treats their mint as a signal, then independently
  rebuilds the plan from fresh on-chain state via the same `buildLocalMintPlan`
  everything else uses.
- **Fund Wallets** — batch-send native currency from one wallet you pick to
  several others you've already added, e.g. topping up sniper wallets before
  a multi-wallet mint. Pick the source, multi-select targets, enter an amount
  per wallet, confirm — unlike auto/copy mint this always asks for
  confirmation first, since it's a deliberate one-off action rather than
  something time-critical.

**Setup** (see the `TELEGRAM_*` / `WALLET_ENCRYPTION_KEY` block in
`.env.example`): create a bot with [@BotFather](https://t.me/BotFather), get
your numeric Telegram user id from [@userinfobot](https://t.me/userinfobot),
and generate a random `WALLET_ENCRYPTION_KEY` (`openssl rand -hex 32`) — a
server-side secret, separate from anything Telegram sees, that encrypts
wallet keys at rest in the bot's local store (`data/`, git-ignored).
`TELEGRAM_OWNER_ID` is the only access control: every update from anyone else,
or from a group chat, is silently ignored.

**Read this before adding a wallet.** Wallets are added by pasting a private
key directly into the chat. The bot deletes that message the instant it
reads it — but Telegram is not end-to-end encrypted for bots, so the key
still passes through Telegram's servers to get there and briefly exists in
your own client-side chat history before the delete lands. Use a wallet
**dedicated to this bot only**, funded with only what you're willing to
risk if your Telegram account or the bot's server were ever compromised.
This is a real, deliberate tradeoff for the convenience of managing wallets
from your phone — if that tradeoff doesn't sit right with you, keep using
`.env`-configured keys via the CLI or [auto mode](#step-5--auto-mode-unattended-free-mint-watcher)
instead, which never puts a key through Telegram at all.

---

## Understanding gas

Three different numbers, and mixing them up is the most common way to lose a mint:

| Term | What it is | Who sets it |
|---|---|---|
| **Base fee** | The network's price. Burned. | The chain |
| **Priority fee** (tip) | Paid on top, to the block producer | You |
| **Max fee** | The ceiling you'll tolerate | You |

**You pay base fee + tip.** The max fee is only a cap — if the base fee is
0.006 gwei and your tip is 0.05, you pay 0.056 gwei no matter whether your
ceiling is 2 or 200.

**But the ceiling is not free.** Before a node will even accept your transaction,
it checks that your wallet holds `gasLimit × maxFee + mint price`. So a high
ceiling with a thin wallet gets rejected outright, even though the real cost is
tiny. The tool checks this before firing and tells you the highest ceiling your
balance can support.

A SeaDrop mint uses roughly **135,000 gas** for quantity 1.

---

## What it protects you from

Each of these is checked *before* anything is broadcast:

- **Ceiling below the base fee** — rejected by every node. Can't be entered.
- **Tip above the ceiling** — invalid under EIP-1559. Can't be entered.
- **Wallet can't cover the upfront reservation** — refuses to fire and tells you
  the ceiling you *can* afford.
- **Firing before the stage opens** — SeaDrop reverts with `NotActive` and burns
  gas. "Fire now" isn't offered when the stage opens later.
- **Wrong network** — every RPC is checked for its chain ID; any on the wrong
  chain is dropped rather than blasted at.
- **Quantity above the per-wallet cap** — warned before you fire.

If a transaction is rejected by every endpoint, it says so plainly instead of
waiting for a receipt that will never exist.

---

## Supported chains

| Chain | Chain ID | Explorer |
|---|---|---|
| Ethereum | 1 | etherscan.io |
| Base | 8453 | basescan.org |
| Robinhood Chain | 4663 | robinhoodchain.blockscout.com |

To add another, append one entry to [`src/chains.ts`](src/chains.ts) — no other
code changes needed.

---

## Security

- Private keys are pasted at run time, kept in memory, and **never written to
  disk or transmitted anywhere** except as a locally-signed transaction.
  **Exception: auto mode** ([Step 5](#step-5--auto-mode-unattended-free-mint-watcher))
  has no prompt to paste a key into, so `AUTO_WALLET_KEYS` has to live in
  `.env` on disk. Use a wallet dedicated to that mode only, funded with just
  what you're willing to lose to gas on unattended, unreviewed mints.
  **Exception: the Telegram bot** ([Step 6](#step-6--telegram-bot-control-it-from-anywhere))
  goes further still — keys are pasted directly into a Telegram chat, which
  passes through Telegram's servers before the bot deletes the message.
  Encrypted at rest with `WALLET_ENCRYPTION_KEY` once stored, but in transit
  it's only as safe as your Telegram account and the bot's server. Wallet
  dedicated to the bot only, non-negotiably.
- `.env`, `wallets/`, `*.key` and the bot's `data/` store are all git-ignored.
- Use dedicated hot wallets funded with only what you intend to spend.
- Read [`src/local-mint.ts`](src/local-mint.ts) if you want to verify exactly what
  gets signed and sent — it's about 150 lines.

---

## Allowlist / FCFS mints

Not supported here, and it isn't an oversight. An allowlist stage uses SeaDrop's
`mintSigned()`, which needs a signature that OpenSea generates per wallet — that
genuinely requires an authenticated OpenSea session. There's no way to build it
from on-chain data, which is the whole premise of this tool.

## License

MIT
