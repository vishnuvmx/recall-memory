import { redactSecrets } from '../security/secrets.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return redactSecrets(obj).redacted;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      // If key indicates a credential, always mask
      if (/password|secret|token|key|credential|auth/i.test(key) && typeof val === 'string') {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeObject(val);
      }
    }
    return sanitized;
  }
  return obj;
}

export class Logger {
  constructor(private level: LogLevel = 'info') {}

  private shouldLog(level: LogLevel): boolean {
    const priority: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    return priority[level] >= priority[this.level];
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const sanitizedMessage = redactSecrets(message).redacted;
    const sanitizedContext = context ? (sanitizeObject(context) as Record<string, unknown>) : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitizedMessage,
      ...(sanitizedContext ? { context: sanitizedContext } : {}),
    };

    const out = JSON.stringify(entry);
    if (level === 'error') {
      console.error(out);
    } else if (level === 'warn') {
      console.warn(out);
    } else {
      console.log(out);
    }
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.write('debug', msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    this.write('info', msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.write('warn', msg, ctx);
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    this.write('error', msg, ctx);
  }
}

export const logger = new Logger(process.env.RECALL_LOG_LEVEL === 'debug' ? 'debug' : 'info');
