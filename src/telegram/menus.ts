// Inline keyboard builders. Kept separate from bot.ts purely for readability.

import { Markup } from "telegraf";
import { CHAINS } from "../chains";
import { WalletRecord, CopyTarget, BotSettings, MintRecord } from "./store";

export function maskAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// isAdmin adds the owner-only row; everyone else never sees it exists.
export function mainMenu(isAdmin = false) {
  const rows = [
    [Markup.button.callback("💼 Wallets", "menu:wallets"), Markup.button.callback("⚙️ Settings", "menu:settings")],
    [Markup.button.callback("🎯 Auto Mint", "menu:auto"), Markup.button.callback("👀 Copy Mint", "menu:copy")],
    [Markup.button.callback("💸 Fund Wallets", "menu:fund"), Markup.button.callback("⏰ Scheduled Mint", "menu:sched")],
    [Markup.button.callback("🖼 Portfolio", "menu:portfolio"), Markup.button.callback("🔔 Activity Alerts", "menu:activity")],
    [Markup.button.callback("⚡ Quick Mint", "menu:quick"), Markup.button.callback("📦 Consolidate", "menu:consolidate")],
    [Markup.button.callback("📊 P&L", "menu:pnl"), Markup.button.callback("🔎 Find NFT", "menu:find")],
    [Markup.button.callback("🧮 Wallet Filter", "menu:filter")],
    [Markup.button.callback("📊 Status", "menu:status")],
  ];
  if (isAdmin) {
    rows.push([Markup.button.callback("⚡ FCFS / Allowlist", "menu:fcfs")]);
    rows.push([Markup.button.callback("🔐 OpenSea Mint", "menu:osmint")]);
    rows.push([Markup.button.callback("🛠 Admin", "menu:admin")]);
  }
  return Markup.inlineKeyboard(rows);
}

// Armed allow-list mints. Kept apart from Scheduled Mint on purpose: that one
// fires the public stage and is the path with a real speed edge, and mixing a
// pasted-proof flow into it would put risk on the path that already works.
export function fcfsMenu(armed: { id: string; name?: string; nftContract: string; targetStartMs: number }[]) {
  const rows = armed.slice(0, 10).map((a) => [
    Markup.button.callback(
      `⚡ ${a.name || maskAddress(a.nftContract)} — ${new Date(a.targetStartMs).toISOString().slice(11, 16)}Z`,
      `fcfs:view:${a.id}`
    ),
  ]);
  rows.push([Markup.button.callback("➕ Arm a collection", "fcfs:add")]);
  rows.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

export function fcfsArmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⏰ Arm for stage start", "fcfs:arm")],
    [Markup.button.callback("🔥 Mint now instead", "allowlist:fire")],
    [Markup.button.callback("Cancel", "menu:fcfs")],
  ]);
}

export function fcfsViewMenu(id: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🗑 Cancel this", `fcfs:cancel:${id}`)],
    [Markup.button.callback("⬅ Back", "menu:fcfs")],
  ]);
}

// Wallet picker for Quick Mint. Only wallets that can actually mint are
// selectable — offering one that will revert is worse than not offering it.
export function quickWalletsMenu(
  rows: { address: string; label: string; canMint: number; reason?: string }[],
  chosen: Set<string>
) {
  const buttons = rows.map((r) => {
    const mark = r.canMint === 0 ? "⛔" : chosen.has(r.address.toLowerCase()) ? "✅" : "⬜";
    const tail = r.canMint === 0 ? (r.reason ?? "can't mint") : `${r.canMint} available`;
    return [Markup.button.callback(`${mark} ${r.label} — ${tail}`, `quick:w:${r.address}`)];
  });
  // Select-all is the common intent for a public mint, and tapping ten
  // wallets while a stage is live is the wrong use of those seconds.
  const eligible = rows.filter((r) => r.canMint > 0);
  if (eligible.length > 1) {
    const allOn = eligible.every((r) => chosen.has(r.address.toLowerCase()));
    buttons.push([
      Markup.button.callback(allOn ? "◻️ Select none" : "☑️ Select all", "quick:all"),
    ]);
  }
  buttons.push([Markup.button.callback("➡️ Continue", "quick:go")]);
  buttons.push([Markup.button.callback("Cancel", "menu:main")]);
  return Markup.inlineKeyboard(buttons);
}

export function quickConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔥 MINT NOW", "quick:fire")],
    [Markup.button.callback("Cancel", "menu:main")],
  ]);
}

// Stages OpenSea says these wallets may mint. Only eligible rows are
// selectable — offering one OpenSea has already refused just wastes a tap and
// ends in a protocol error.
export function osMintStagesMenu(
  rows: { wallet: string; label: string; stageType: string; canMint: number; reason?: string }[]
) {
  const buttons = rows.map((r) => [
    Markup.button.callback(
      r.canMint > 0
        ? `✅ ${r.label} — ${r.stageType} ×${r.canMint}`
        : `⛔ ${r.label} — ${r.reason ?? "not eligible"}`,
      r.canMint > 0 ? `osmint:go:${r.wallet}` : "osmint:noop"
    ),
  ]);
  buttons.push([Markup.button.callback("🔥 Mint with all eligible", "osmint:all")]);
  buttons.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(buttons);
}

export function adminMenu(inviteCount: number, userCount: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎟 New invite code", "admin:invite")],
    [Markup.button.callback(`📋 Invites (${inviteCount})`, "admin:invites")],
    [Markup.button.callback(`👥 Users (${userCount})`, "admin:users")],
    [Markup.button.callback("🚫 Revoke everyone", "admin:revokeall")],
    [Markup.button.callback("🤖 Ask the assistant", "admin:ask")],
    [Markup.button.callback("💾 Backup", "admin:backup"), Markup.button.callback("♻️ Restore", "admin:restore")],
    [Markup.button.callback("⬅ Back", "menu:main")],
  ]);
}

// A restore destroys whatever is there now, so it asks first — and says what
// is about to be lost rather than a generic "are you sure".
export function allowlistConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔥 Mint now", "allowlist:fire")],
    [Markup.button.callback("Cancel", "menu:main")],
  ]);
}

export function restoreConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Yes, replace everything", "admin:restore:confirm")],
    [Markup.button.callback("Cancel", "menu:admin")],
  ]);
}

export function adminRevokeConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Yes, revoke everyone", "admin:revokeall:confirm")],
    [Markup.button.callback("Cancel", "menu:admin")],
  ]);
}

/** One button per redeemed invite, so a single person can be removed. */
export function adminInvitesMenu(codes: { id: string; label?: string; redeemedBy?: number; revoked?: boolean }[]) {
  const rows = codes
    .filter((c) => !c.revoked)
    .slice(0, 20)
    .map((c) => [
      Markup.button.callback(
        `🚫 ${c.label || c.id}${c.redeemedBy ? ` · ${c.redeemedBy}` : " · unused"}`,
        `admin:revoke:${c.id}`
      ),
    ]);
  rows.push([Markup.button.callback("⬅ Back", "menu:admin")]);
  return Markup.inlineKeyboard(rows);
}

export function activityMenu(enabled: boolean, s: BotSettings) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(enabled ? "⏸ Turn off" : "▶️ Turn on", "activity:toggle")],
    [Markup.button.callback(`Sweep = ${s.activitySweepSales}+ sales`, "setting:activitySweepSales")],
    [Markup.button.callback(`Floor move alert: ${s.activityFloorMovePct}%`, "setting:activityFloorMovePct")],
    [Markup.button.callback(`Offer alert: ${s.activityOfferVsFloorPct}% of floor`, "setting:activityOfferVsFloorPct")],
    [Markup.button.callback("⬅ Back", "menu:main")],
  ]);
}

// Portfolio and activity are both sectioned per wallet: pick a wallet, then
// see what IT holds / what happened to IT. Holdings come live from OpenSea so
// they include NFTs acquired before or outside this bot.
export function portfolioWalletsMenu(wallets: WalletRecord[]) {
  const rows = wallets.map((w) => [
    Markup.button.callback(`${w.label} (${maskAddress(w.address)})`, `pf:wallet:${w.address}`),
  ]);
  rows.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

// Telegram caps callback_data at 64 bytes. An address (42) plus a collection
// slug blows straight past that, so anything carrying both is stashed and
// referenced by a short token instead.
export type Tokenizer = (payload: string) => string;

export function walletHoldingsMenu(
  address: string,
  collections: { slug: string; count: number }[],
  tok: Tokenizer
) {
  const rows = collections.slice(0, 20).map((c) => [
    Markup.button.callback(`${c.slug} ×${c.count}`, `pf:col:${tok(`${address}|${c.slug}`)}`),
  ]);
  rows.push([Markup.button.callback("📈 This wallet's activity", `pf:wactivity:${address}`)]);
  rows.push([Markup.button.callback("🔄 Refresh", `pf:wallet:${address}`)]);
  rows.push([Markup.button.callback("⬅ Back", "menu:portfolio")]);
  return Markup.inlineKeyboard(rows);
}

export function walletCollectionMenu(address: string, slug: string, tok: Tokenizer, openseaUrl?: string) {
  const pair = tok(`${address}|${slug}`);
  const rows: any[] = [];
  if (openseaUrl) rows.push([Markup.button.url("🌊 View on OpenSea", openseaUrl)]);
  rows.push([Markup.button.callback("📈 Collection activity", `pf:colact:${tok(slug)}`)]);
  rows.push([Markup.button.callback("🖼 Mint card", `card:col:${pair}`)]);
  rows.push([Markup.button.callback("💵 Sell / offers", `sell:col:${pair}`)]);
  rows.push([Markup.button.callback("⬅ Back", `pf:wallet:${address}`)]);
  return Markup.inlineKeyboard(rows);
}

export function sellCollectionMenu(address: string, slug: string, canAccept: boolean, tok: Tokenizer) {
  const pair = tok(`${address}|${slug}`);
  const rows: any[] = [];
  if (canAccept) rows.push([Markup.button.callback("✅ Accept best offer", `sell:ask:${pair}`)]);
  rows.push([Markup.button.callback("🏷 List at a price", `sell:list:${pair}`)]);
  rows.push([Markup.button.callback("🔄 Refresh", `sell:col:${pair}`)]);
  rows.push([Markup.button.callback("⬅ Back", `pf:col:${pair}`)]);
  return Markup.inlineKeyboard(rows);
}

export function sellActionConfirmMenu(action: string, address: string, slug: string, tok: Tokenizer) {
  const pair = tok(`${address}|${slug}`);
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirm", `sell:go:${action}:${pair}`)],
    [Markup.button.callback("❌ Cancel", `sell:col:${pair}`)],
  ]);
}

export function portfolioMenu(mints: MintRecord[]) {
  const rows = mints.slice(0, 20).map((m) => [
    Markup.button.callback(
      `${m.name || maskAddress(m.nftContract)} ×${m.quantity}`,
      `pf:view:${m.nftContract}`
    ),
  ]);
  rows.push([Markup.button.callback("🔄 Refresh floors", "menu:portfolio")]);
  rows.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

export function portfolioItemMenu(record: MintRecord, openseaUrl?: string) {
  const rows: any[] = [];
  if (openseaUrl) rows.push([Markup.button.url("🌊 View on OpenSea", openseaUrl)]);
  rows.push([Markup.button.callback("📈 Recent activity", `pf:activity:${record.nftContract}`)]);
  rows.push([Markup.button.callback("💵 Sell / offers", `pf:sell:${record.nftContract}`)]);
  rows.push([Markup.button.callback("🗑 Remove from portfolio", `pf:remove:${record.nftContract}`)]);
  rows.push([Markup.button.callback("⬅ Back", "menu:portfolio")]);
  return Markup.inlineKeyboard(rows);
}

// Tapping a wallet now opens its detail view (walletDetailMenu) instead of
// removing it directly, since there's a home needed for the Auto/Copy Mint
// participation toggles. The suffix is an at-a-glance summary of which
// watchers this wallet currently participates in.
export function sellMenu(contract: string, canAccept: boolean) {
  const rows: any[] = [];
  if (canAccept) rows.push([Markup.button.callback("✅ Accept best offer", `sell:accept:${contract}`)]);
  rows.push([Markup.button.callback("🔄 Refresh", `pf:sell:${contract}`)]);
  rows.push([Markup.button.callback("⬅ Back", `pf:view:${contract}`)]);
  return Markup.inlineKeyboard(rows);
}

export function sellConfirmMenu(contract: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, sell it", `sell:confirm:${contract}`)],
    [Markup.button.callback("❌ Cancel", `pf:sell:${contract}`)],
  ]);
}

export function walletsMenu(wallets: WalletRecord[]) {
  const rows = wallets.map((w) => {
    const flags = `${w.includeInAutoMint === false ? "" : "🎯"}${w.includeInCopyMint === false ? "" : "👀"}` || "—";
    return [Markup.button.callback(`${w.label} (${maskAddress(w.address)}) [${flags}]`, `wallet:manage:${w.address}`)];
  });
  rows.push([Markup.button.callback("➕ Add wallet (private key)", "wallet:add")]);
  rows.push([Markup.button.callback("🌱 Generate seed + wallets", "wallet:seed:new")]);
  rows.push([Markup.button.callback("📥 Import seed phrase", "wallet:seed:import")]);
  rows.push([Markup.button.callback("🌱 Seed phrases", "menu:seeds")]);
  rows.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

export function walletDetailMenu(wallet: WalletRecord) {
  const autoOn = wallet.includeInAutoMint !== false;
  const copyOn = wallet.includeInCopyMint !== false;
  return Markup.inlineKeyboard([
    [Markup.button.callback(`🎯 Auto Mint: ${autoOn ? "✅ ON" : "⛔ OFF"}`, `wallet:toggle:auto:${wallet.address}`)],
    [Markup.button.callback(`👀 Copy Mint: ${copyOn ? "✅ ON" : "⛔ OFF"}`, `wallet:toggle:copy:${wallet.address}`)],
    [Markup.button.callback("💰 Refresh balance", `wallet:bal:${wallet.address}`)],
    [Markup.button.callback("🔑 Show private key", `wallet:key:${wallet.address}`)],
    [Markup.button.callback("🗑 Remove wallet", `wallet:remove:${wallet.address}`)],
    [Markup.button.callback("⬅ Back", "menu:wallets")],
  ]);
}

// Seed phrases live under Wallets, beside the wallets they produced.
export function seedsMenu(seeds: { id: string; label?: string; createdAt: number }[], counts: Record<string, number>) {
  const rows = seeds.map((s) => [
    Markup.button.callback(
      `🌱 ${s.label || new Date(s.createdAt).toISOString().slice(0, 10)} · ${counts[s.id] ?? 0} wallet(s)`,
      `seed:view:${s.id}`
    ),
  ]);
  rows.push([Markup.button.callback("⬅ Back", "menu:wallets")]);
  return Markup.inlineKeyboard(rows);
}

export function seedDetailMenu(seedId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🌱 Show seed phrase", `seed:reveal:${seedId}`)],
    [Markup.button.callback("➕ Derive more wallets", `seed:more:${seedId}`)],
    [Markup.button.callback("⬅ Back", "menu:seeds")],
  ]);
}

export function copyMenu(enabled: boolean, targets: CopyTarget[]) {
  const rows = targets.map((t) => [
    Markup.button.callback(`🗑 ${t.label} (${maskAddress(t.address)})`, `copy:remove:${t.address}`),
  ]);
  rows.push([Markup.button.callback(enabled ? "⏸ Turn off" : "▶️ Turn on", "copy:toggle")]);
  rows.push([Markup.button.callback("➕ Watch a wallet", "copy:add")]);
  rows.push([Markup.button.callback("📜 Copy-mint history", "copy:history")]);
  rows.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

// History is sectioned by the watched wallet that triggered each copy —
// "what has this wallet led me into" is the question being asked.
export function copyHistoryMenu(
  wallets: { address: string; label: string; count: number }[],
  tok: Tokenizer
) {
  const rows = wallets.slice(0, 20).map((w) => [
    Markup.button.callback(
      `${w.label} (${w.count})`,
      `copy:hist:${tok(w.address)}`
    ),
  ]);
  if (wallets.length > 0) rows.push([Markup.button.callback("🗑 Clear history", "copy:hist:clear")]);
  rows.push([Markup.button.callback("⬅ Back", "menu:copy")]);
  return Markup.inlineKeyboard(rows);
}

export function copyHistoryWalletMenu(
  address: string,
  copied: { nftContract: string; label: string }[],
  tok: Tokenizer
) {
  // A card only means anything for an attempt that actually minted.
  const rows = copied.slice(0, 8).map((c) => [
    Markup.button.callback(`🖼 ${c.label}`, `card:hist:${tok(c.nftContract)}`),
  ]);
  rows.push([Markup.button.callback("🔄 Refresh", `copy:hist:${tok(address)}`)]);
  rows.push([Markup.button.callback("⬅ Back", "copy:history")]);
  return Markup.inlineKeyboard(rows);
}

export function autoMenu(enabled: boolean) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(enabled ? "⏸ Turn off" : "▶️ Turn on", "auto:toggle")],
    [Markup.button.callback("⬅ Back", "menu:main")],
  ]);
}

export function settingsMenu(s: BotSettings) {
  const autoChainsLabel =
    s.autoChainKeys && s.autoChainKeys.length > 0 ? s.autoChainKeys.join(", ") : `${s.chainKey} (default)`;
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Chain: ${s.chainKey}`, "setting:chain")],
    [Markup.button.callback(`Auto-mint chains: ${autoChainsLabel}`, "setting:autoChains")],
    [Markup.button.callback(
      `Max fee: ${s.maxFeeGwei > 0 ? `${s.maxFeeGwei} gwei` : "auto (follows the chain)"}`,
      "setting:maxFeeGwei"
    )],
    [Markup.button.callback(`Priority fee: ${s.priorityGwei} gwei`, "setting:priorityGwei")],
    [Markup.button.callback(`Gas limit: ${s.gasLimit > 0 ? s.gasLimit : "auto (sized per quantity)"}`, "setting:gasLimit")],
    [Markup.button.callback(`Auto max qty: ${s.autoMaxQuantity ?? "unlimited (true max)"}`, "setting:autoMaxQuantity")],
    [Markup.button.callback(`Copy-mint price cap: ${s.copyMintMaxPriceEth} ETH`, "setting:copyMintMaxPriceEth")],
    [Markup.button.callback(`Copy-mint max qty: ${s.copyMintMaxQuantity ?? "unlimited (true max)"}`, "setting:copyMintMaxQuantity")],
    [Markup.button.callback(`Copy-mint backfill: ${s.copyBackfillHours === 0 ? "off (head only)" : s.copyBackfillHours + "h"}`, "setting:copyBackfillHours")],
    [Markup.button.callback("⬅ Back", "menu:main")],
  ]);
}

export function chainPickerMenu() {
  return Markup.inlineKeyboard(CHAINS.map((c) => [Markup.button.callback(c.name, `setting:chain:${c.key}`)]).concat([
    [Markup.button.callback("⬅ Back", "menu:settings")],
  ]));
}

// Multi-select for which chain(s) Auto Mint watches. Saves on every tap —
// unlike the Fund Wallets flow this isn't a one-shot action with a confirm
// step, it's an ongoing setting, so there's nothing to "cancel".
export function autoChainsMenu(selected: Set<string>) {
  const rows = CHAINS.map((c) => {
    const checked = selected.has(c.key);
    return [Markup.button.callback(`${checked ? "✅" : "⬜"} ${c.name}`, `setting:autoChains:toggle:${c.key}`)];
  });
  rows.push([Markup.button.callback("⬅ Back", "menu:settings")]);
  return Markup.inlineKeyboard(rows);
}

// Pick the ONE wallet to send from.
// Only wallets that actually hold the collection, each with how many it has.
// Picking sources out of the full wallet list would mean guessing which ones
// minted, which is the thing the scan just answered.
export function consolidateSourcesMenu(
  found: { address: string; label: string; count: number }[],
  selected: Set<string>
) {
  const rows = found.map((h) => {
    const checked = selected.has(h.address.toLowerCase());
    return [
      Markup.button.callback(
        `${checked ? "✅" : "⬜"} ${h.label} — ${h.count}`,
        `consol:src:toggle:${h.address}`
      ),
    ];
  });
  const allSelected = selected.size === found.length;
  rows.push([
    Markup.button.callback(allSelected ? "⬜ Select none" : "✅ Select all", "consol:src:all"),
  ]);
  const total = found
    .filter((h) => selected.has(h.address.toLowerCase()))
    .reduce((sum, h) => sum + h.count, 0);
  rows.push([Markup.button.callback(`➡️ Done (${total} NFT${total === 1 ? "" : "s"})`, "consol:src:done")]);
  rows.push([Markup.button.callback("❌ Cancel", "consol:cancel")]);
  return Markup.inlineKeyboard(rows);
}

// Any wallet can receive, including one that was selected as a source — that
// is the common case, sweeping the rest into whichever wallet already holds
// the most. Its own tokens simply stay put.
export function consolidateDestMenu(wallets: WalletRecord[]) {
  const rows = wallets.map((w) => [
    Markup.button.callback(`${w.label} (${maskAddress(w.address)})`, `consol:dest:${w.address}`),
  ]);
  rows.push([Markup.button.callback("❌ Cancel", "consol:cancel")]);
  return Markup.inlineKeyboard(rows);
}

export function consolidateConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Move them", "consol:confirm"), Markup.button.callback("❌ Cancel", "consol:cancel")],
  ]);
}

export function fundSourceMenu(wallets: WalletRecord[]) {
  const rows = wallets.map((w) => [
    Markup.button.callback(`${w.label} (${maskAddress(w.address)})`, `fund:source:${w.address}`),
  ]);
  rows.push([Markup.button.callback("⬅ Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

// Multi-select targets, excluding whichever wallet is the source. Selected
// ones show a checkmark; tapping toggles membership.
export function fundTargetsMenu(candidates: WalletRecord[], selected: Set<string>) {
  const rows = candidates.map((w) => {
    const checked = selected.has(w.address.toLowerCase());
    return [
      Markup.button.callback(
        `${checked ? "✅" : "⬜"} ${w.label} (${maskAddress(w.address)})`,
        `fund:target:toggle:${w.address}`
      ),
    ];
  });
  rows.push([Markup.button.callback(`➡️ Done (${selected.size} selected)`, "fund:targets:done")]);
  rows.push([Markup.button.callback("❌ Cancel", "fund:cancel")]);
  return Markup.inlineKeyboard(rows);
}

export function fundConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirm", "fund:confirm"), Markup.button.callback("❌ Cancel", "fund:cancel")],
  ]);
}

// Multi-select wallets to mint from — same toggle-and-redraw pattern as
// fundTargetsMenu, but over the whole wallet list (nothing to exclude).
export function schedWalletsMenu(wallets: WalletRecord[], selected: Set<string>) {
  const rows = wallets.map((w) => {
    const checked = selected.has(w.address.toLowerCase());
    return [
      Markup.button.callback(
        `${checked ? "✅" : "⬜"} ${w.label} (${maskAddress(w.address)})`,
        `sched:wallet:toggle:${w.address}`
      ),
    ];
  });
  rows.push([Markup.button.callback(`➡️ Done (${selected.size} selected)`, "sched:wallets:done")]);
  rows.push([Markup.button.callback("❌ Cancel", "sched:cancel")]);
  return Markup.inlineKeyboard(rows);
}

export function schedTimingMenu(startsInFuture: boolean) {
  const rows = startsInFuture
    ? [[Markup.button.callback("⏳ Wait for the stage", "sched:timing:wait")]]
    : [[Markup.button.callback("🚀 Fire now", "sched:timing:now")]];
  rows.push([Markup.button.callback("✏️ Custom time (HH:MM IST)", "sched:timing:custom")]);
  rows.push([Markup.button.callback("❌ Cancel", "sched:cancel")]);
  return Markup.inlineKeyboard(rows);
}

export function schedConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧪 Dry Run", "sched:dryrun")],
    [Markup.button.callback("✅ Confirm", "sched:confirm"), Markup.button.callback("❌ Cancel", "sched:cancel")],
  ]);
}
