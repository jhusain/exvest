/**
 * Tiny scoped console logger. Main-process output is inherited by the terminal
 * that launched Electron (vite-plugin-electron spawns with stdio: 'inherit'),
 * so these land in the same shell as `npm run electron:dev`.
 *
 * info/warn/error always print. debug() is gated behind EXVEST_DEBUG=1 so the
 * per-tick IB chatter stays out of the way unless you ask for it.
 */

// Reached via globalThis rather than the `process` global directly: this
// module is in shared/ and is typechecked by the renderer config, which has no
// Node types (and no `process` at runtime in the web build).
const debugEnabled = (() => {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return !!g.process?.env?.EXVEST_DEBUG;
})();

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  const tag = `[exvest:${scope}]`;
  return {
    info: (...args) => console.log(tag, ...args),
    warn: (...args) => console.warn(tag, ...args),
    error: (...args) => console.error(tag, ...args),
    debug: (...args) => {
      if (debugEnabled) console.log(`${tag}[debug]`, ...args);
    }
  };
}

/**
 * IB reports codes 2100-2199 as warnings/status notices ("Market data farm
 * connection is OK", "HMDS data farm connected", …) over the same `error`
 * event it uses for real failures. Treating those as errors both spams the UI
 * and — worse — can abort a perfectly good connection attempt.
 * @see https://interactivebrokers.github.io/tws-api/message_codes.html
 */
export function isIbWarningCode(code: number): boolean {
  return Number.isFinite(code) && code >= 2100 && code <= 2199;
}
