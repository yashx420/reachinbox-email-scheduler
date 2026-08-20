type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

const configuredLevel = (process.env.LOG_LEVEL as Level) ?? 'info';
const threshold = LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.info;
const pretty = process.env.NODE_ENV !== 'production';

function write(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const time = new Date().toISOString();
  if (pretty) {
    const tail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    // eslint-disable-next-line no-console
    console.log(`${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} ${time} [${scope}] ${message}${tail}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level, time, scope, message, ...meta }));
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(childScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => write('debug', scope, m, meta),
    info: (m, meta) => write('info', scope, m, meta),
    warn: (m, meta) => write('warn', scope, m, meta),
    error: (m, meta) => write('error', scope, m, meta),
    child: (childScope: string) => createLogger(`${scope}:${childScope}`),
  };
}

/** Normalises anything thrown into something safe to log or persist. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const logger = createLogger('app');
