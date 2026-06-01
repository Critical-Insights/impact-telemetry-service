import { pino } from 'pino';
import { config } from '../config.js';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }),
});

export type Logger = typeof logger;
