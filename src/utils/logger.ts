const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

function fmt(level: Level, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const metaStr = meta !== undefined ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

function log(level: Level, message: string, meta?: unknown) {
  if (LEVELS[level] >= LEVELS[currentLevel]) {
    const line = fmt(level, message, meta);
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
};
