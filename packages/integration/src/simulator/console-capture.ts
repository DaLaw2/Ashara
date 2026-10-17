import { AsyncLocalStorage } from "node:async_hooks";

type ConsoleLevel = "log" | "info" | "warn" | "error";
const LEVELS: readonly ConsoleLevel[] = ["log", "info", "warn", "error"];

/** Where one capture's console output goes: the level written to and the arguments it was given. */
export type ConsoleSink = (level: ConsoleLevel, args: readonly unknown[]) => void;

const scope = new AsyncLocalStorage<ConsoleSink>();
let active = 0;
let originals: Readonly<Record<ConsoleLevel, (...args: unknown[]) => void>> | null = null;

function install(): void {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  originals = saved;
  for (const level of LEVELS) {
    console[level] = (...args: unknown[]): void => {
      const sink = scope.getStore();
      if (sink === undefined) saved[level](...args);
      else sink(level, args);
    };
  }
}

function uninstall(): void {
  if (originals === null) return;
  for (const level of LEVELS) console[level] = originals[level];
  originals = null;
}

/**
 * Runs `body` with the console output of everything it starts, its later async work included, sent
 * to `sink`. The sink is chosen by async context, never by a global binding: two captures that
 * overlap, as when one run outlives its test and the next starts, each keep their own output, and
 * output from outside every capture reaches the console as it would. The console's own functions are
 * replaced while any capture is open and put back when the last one ends.
 */
export async function capturingConsole<T>(sink: ConsoleSink, body: () => Promise<T>): Promise<T> {
  if (active === 0) install();
  active += 1;
  try {
    return await scope.run(sink, body);
  } finally {
    active -= 1;
    if (active === 0) uninstall();
  }
}
