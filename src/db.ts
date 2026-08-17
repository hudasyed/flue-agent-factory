import { postgres, type PostgresQuery } from '@flue/postgres';
import { Pool, type PoolClient } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
});
pool.on('error', (error) => console.error('[postgres] idle client error', error));

async function transaction<T>(fn: (runner: { query: PostgresQuery }) => Promise<T>) {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: async (text, params) => (await client.query(text, params)).rows as Record<string, unknown>[],
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction,
  close: () => pool.end(),
});
