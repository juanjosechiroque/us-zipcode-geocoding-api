import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { DATABASE_URL } from "../src/config.js";
import logger from "../src/utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "db", "schema.sql");

async function migrate() {
    const schemaSql = readFileSync(schemaPath, "utf8");
    const client = new Client({ connectionString: DATABASE_URL });

    await client.connect();
    logger.info({ schemaPath }, "Applying schema");

    try {
        await client.query(schemaSql);
        logger.info("Schema applied successfully");
    } finally {
        await client.end();
    }
}

migrate().catch((err: unknown) => {
    logger.error({ err }, "Migration failed");
    process.exit(1);
});
