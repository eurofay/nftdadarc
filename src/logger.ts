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

export function createLogger(sink?: LogSink): Logger {
  // `info`/`highlight` are the routine, high-volume lines (per-sighting scan
  // output, per-field summaries) — a busy chain can produce several a
  // minute. Forwarding those to Telegram would flood the chat and risk
  // hitting Telegram's flood limits, so only the headline events (a mint
  // firing, a result, a stop) get forwarded. Everything still prints
  // locally either way.
  const emit = (styled: string, forward = true) => {
    console.log(styled);
    if (sink && forward) sink(stripAnsi(styled));
  };
  return {
    raw: (msg) => emit(msg),
    title: (msg) => emit(chalk.bold.magenta(msg)),
    info: (msg) => emit(chalk.gray(msg), false),
    success: (msg) => emit(chalk.green(msg)),
    successBold: (msg) => emit(chalk.bold.green(msg)),
    warn: (msg) => emit(chalk.yellow(msg)),
    warnBold: (msg) => emit(chalk.bold.yellow(msg)),
    error: (msg) => emit(chalk.red(msg)),
    errorBold: (msg) => emit(chalk.bold.red(msg)),
    highlight: (msg) => emit(chalk.cyan(msg), false),
    done: (msg) => emit(chalk.bold.white(msg)),
  };
}

export const defaultLogger: Logger = createLogger();
