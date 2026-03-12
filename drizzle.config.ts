import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  dbCredentials: {
    host: process.env.DATABASE_HOST_NAME ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DATABASE_USER_NAME ?? 'root',
    password: process.env.DATABASE_USER_PASSWORD ?? '',
    database: process.env.DATABASE_DB_NAME ?? 'wolfe_trading',
  },
} satisfies Config;
