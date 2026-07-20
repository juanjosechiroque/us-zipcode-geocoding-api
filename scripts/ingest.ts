import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { Pool, type PoolClient } from "pg";
import { DATABASE_URL } from "../src/config.js";
import logger from "../src/utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_PATH = path.join(__dirname, "..", "data", "us_zip_codes.csv");
const BATCH_SIZE = 500;

const INGEST_LOCK_ID = 947_215_806;

export interface ZipRow {
    zip_code: string;
    city: string;
    state_code: string;
    state_name: string;
    county: string;
    latitude: string;
    longitude: string;
}

function loadRows(dataPath: string): ZipRow[] {
    const raw = readFileSync(dataPath, "utf8");
    return parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as ZipRow[];
}

function dedupeByZip(rows: ZipRow[]): { unique: ZipRow[]; duplicates: number } {
    const byZip = new Map<string, ZipRow>();
    for (const row of rows) {
        byZip.set(row.zip_code, row);
    }
    return { unique: [...byZip.values()], duplicates: rows.length - byZip.size };
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

async function upsertBatch(client: PoolClient, batch: ZipRow[]) {
    const columns = [
        "zip_code",
        "city",
        "state_code",
        "state_name",
        "county",
        "latitude",
        "longitude",
    ];
    const values: unknown[] = [];
    const placeholders = batch
        .map((row, rowIndex) => {
            const base = rowIndex * columns.length;
            values.push(
                row.zip_code,
                row.city,
                row.state_code,
                row.state_name,
                row.county || null,
                Number(row.latitude),
                Number(row.longitude)
            );
            return `(${columns.map((_, colIndex) => `$${base + colIndex + 1}`).join(", ")})`;
        })
        .join(", ");

    const query = `
        INSERT INTO zip_codes (${columns.join(", ")})
        VALUES ${placeholders}
        ON CONFLICT (zip_code) DO UPDATE SET
            city = EXCLUDED.city,
            state_code = EXCLUDED.state_code,
            state_name = EXCLUDED.state_name,
            county = EXCLUDED.county,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            updated_at = now()
        WHERE
            zip_codes.city IS DISTINCT FROM EXCLUDED.city OR
            zip_codes.state_code IS DISTINCT FROM EXCLUDED.state_code OR
            zip_codes.state_name IS DISTINCT FROM EXCLUDED.state_name OR
            zip_codes.county IS DISTINCT FROM EXCLUDED.county OR
            zip_codes.latitude IS DISTINCT FROM EXCLUDED.latitude OR
            zip_codes.longitude IS DISTINCT FROM EXCLUDED.longitude
        RETURNING (xmax = 0) AS inserted
    `;

    const result = await client.query<{ inserted: boolean }>(query, values);
    const inserted = result.rows.filter((row) => row.inserted).length;
    const updated = result.rows.length - inserted;
    const unchanged = batch.length - result.rows.length;
    return { inserted, updated, unchanged };
}

export async function upsertBatchesAtomically(client: PoolClient, batches: ZipRow[][]) {
    const totals = { inserted: 0, updated: 0, unchanged: 0 };

    await client.query("BEGIN");
    try {
        for (const [index, batch] of batches.entries()) {
            const result = await upsertBatch(client, batch);
            totals.inserted += result.inserted;
            totals.updated += result.updated;
            totals.unchanged += result.unchanged;
            logger.info({ batch: index + 1, of: batches.length, ...result }, "Batch upserted");
        }
        await client.query("COMMIT");
        return totals;
    } catch (error) {
        await client.query("ROLLBACK");
        logger.error({ err: error }, "Ingestion transaction rolled back");
        throw error;
    }
}

async function ingest() {
    const dataPath = process.argv[2] ?? DEFAULT_DATA_PATH;

    const pool = new Pool({ connectionString: DATABASE_URL });
    const lockHolder = await pool.connect();

    try {
        const {
            rows: [lockResult],
        } = await lockHolder.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock($1) AS locked",
            [INGEST_LOCK_ID]
        );

        if (!lockResult?.locked) {
            logger.warn("Another ingestion is already running — exiting");
            return;
        }

        const rawRows = loadRows(dataPath);
        const { unique: rows, duplicates } = dedupeByZip(rawRows);

        logger.info(
            { dataPath, rawRowCount: rawRows.length, uniqueRowCount: rows.length, duplicates },
            "Starting ingestion"
        );

        const batches = chunk(rows, BATCH_SIZE);
        const totals = await upsertBatchesAtomically(lockHolder, batches);

        logger.info({ ...totals, total: rows.length }, "Ingestion complete");
    } finally {
        await lockHolder.query("SELECT pg_advisory_unlock($1)", [INGEST_LOCK_ID]);
        lockHolder.release();
        await pool.end();
    }
}

const isMainModule =
    process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
    ingest().catch((err: unknown) => {
        logger.error({ err }, "Ingestion failed");
        process.exit(1);
    });
}
