import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/src/db/schema.ts',
  // Deliberately outside src/: these are .sql files, so `tsc` would not copy
  // them into dist/ and the container would boot with no migrations to run.
  out: './server/migrations',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/krembonet.db',
  },
});
