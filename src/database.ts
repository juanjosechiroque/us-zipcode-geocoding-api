import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { DATABASE_URL } from "./config.js";
import type { Database } from "./db/types.js";
import logger from "./utils/logger.js";

const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 10,
});

pool.on("error", (err) => {
    logger.error({ err }, "Unexpected Postgres pool error");
});

export const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
});

export async function isDbHealthy(): Promise<boolean> {
    try {
        await sql`select 1`.execute(db);
        return true;
    } catch (error) {
        logger.error({ err: error }, "Postgres health check failed");
        return false;
    }
}

export async function disconnectDB() {
    try {
        await db.destroy();
        logger.info("Postgres disconnected");
    } catch (error) {
        logger.error({ err: error }, "Postgres disconnect failed");
    }
}
