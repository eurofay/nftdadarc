// A pluggable logger so execution code (local-mint.ts, auto-mint.ts,
// copy-mint.ts) can run under the CLI *or* the Telegram bot without knowing
// which. The default behaves exactly like the old hardcoded console.log/chalk
// calls it replaced. The Telegram bot supplies a logger whose sink forwards
// the plain (ANSI-stripped) text to a chat instead of — or as well as —
// printing locally.

import chalk from "chalk";

export type LogSink = (plainText: string) => void;

export interface Logger {
  raw(msg: string): void;
  title(msg: string): void;
  info(msg: string): void;
  success(msg: string): void;
  successBold(msg: string): void;
  warn(msg: string): void;
  warnBold(msg: string): void;
  error(msg: string): void;
  errorBold(msg: string): void;
  highlight(msg: string): void;
  done(msg: string): void;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * How much of a run reaches the sink.
 *
 * "all"       — the user pressed a button and is waiting for this. Every
 *               result line goes, because the result IS what they asked for.
 * "headlines" — nobody asked. A watcher fired on its own, so only the moments
 *               worth a push notification go: a mint dispatched, a receipt, a
 *               rejection. The running commentary stays in the terminal.
 */
export type ForwardLevel = "all" | "headlines";

export function createLogger(sink?: LogSink, level: ForwardLevel = "all"): Logger {
  // These same calls drive two very different places. A terminal is a running
  // log: scrollback is free, indentation lines things up, and a banner marks
  // where a run began. A chat is a notification feed, where twenty lines for
  // one mint is not detail — it is noise burying the one line that mattered.
  //
  // Two things are suppressed no matter what. Furniture (title, and the
  // high-volume info/highlight tiers) is meaningless on a phone: rules,
  // banners, config dumps, per-field commentary. And under "headlines", so is
  // everything that is not a bold tier.
  //
  // What is NOT suppressed by default is a result. A consolidation reports
  // what it moved through done() and success(); silencing those would mean
  // asking the bot to sweep 200 NFTs and being told nothing at all.
  const headlinesOnly = level === "headlines";
  const emit = (styled: string, tier: "furniture" | "detail" | "headline") => {
    console.log(styled);
    if (!sink || tier === "furniture") return;
    if (headlinesOnly && tier !== "headline") return;
    sink(stripAnsi(styled));
  };
  return {
    raw: (msg) => emit(msg, "detail"),
    title: (msg) => emit(chalk.bold.magenta(msg), "furniture"),
    info: (msg) => emit(chalk.gray(msg), "furniture"),
    success: (msg) => emit(chalk.green(msg), "detail"),
    successBold: (msg) => emit(chalk.bold.green(msg), "headline"),
    warn: (msg) => emit(chalk.yellow(msg), "detail"),
    warnBold: (msg) => emit(chalk.bold.yellow(msg), "headline"),
    error: (msg) => emit(chalk.red(msg), "detail"),
    errorBold: (msg) => emit(chalk.bold.red(msg), "headline"),
    highlight: (msg) => emit(chalk.cyan(msg), "furniture"),
    done: (msg) => emit(chalk.bold.white(msg), "detail"),
  };
}

export const defaultLogger: Logger = createLogger();

// Prefixes every line with a label — e.g. running --auto against several
// chains at once in one process, where interleaved output would otherwise
// be unreadable without saying which chain each line is about.
export function withPrefix(label: string, base: Logger = defaultLogger): Logger {
  const wrap = (fn: (msg: string) => void) => (msg: string) => fn(`[${label}] ${msg}`);
  return {
    raw: wrap(base.raw),
    title: wrap(base.title),
    info: wrap(base.info),
    success: wrap(base.success),
    successBold: wrap(base.successBold),
    warn: wrap(base.warn),
    warnBold: wrap(base.warnBold),
    error: wrap(base.error),
    errorBold: wrap(base.errorBold),
    highlight: wrap(base.highlight),
    done: wrap(base.done),
  };
}
