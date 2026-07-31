/**
 * Fastify's built-in Pino logger config.
 *
 * Pretty output would need an extra dependency and a TTY; in Docker we want
 * plain JSON on stdout so `docker compose logs` stays greppable.
 */
import { config } from '../config.js';

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? (config.isProduction ? 'info' : 'debug'),
  // Request logging is noise for a dashboard that polls every 60s.
  redact: ['req.headers.authorization', 'req.headers.cookie'],
};
