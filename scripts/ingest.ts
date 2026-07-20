import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { Pool } from "pg";
import { DATABASE_URL } from "../src/config.js";
import logger from "../src/utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_PATH = path.join(__dirname, "..", "data", "us_zip_codes.csv");
const BATCH_SIZE = 500;

interface ZipRow {
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

/**
 * Defensive dedup by zip_code (the conflict target). A single INSERT ... ON
 * CONFLICT DO UPDATE statement errors ("cannot affect row a second time") if
 * two input rows share the conflict key, so we collapse duplicates in memory
 * regardless of whether the source file was already cleaned.
 */
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

async function upsertBatch(pool: Pool, batch: ZipRow[]) {
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

    const result = await pool.query<{ inserted: boolean }>(query, values);
    const inserted = result.rows.filter((row) => row.inserted).length;
    const updated = result.rows.length - inserted;
    const unchanged = batch.length - result.rows.length;
    return { inserted, updated, unchanged };
}

async function ingest() {
    const dataPath = process.argv[2] ?? DEFAULT_DATA_PATH;
    const rawRows = loadRows(dataPath);
    const { unique: rows, duplicates } = dedupeByZip(rawRows);

    logger.info(
        { dataPath, rawRowCount: rawRows.length, uniqueRowCount: rows.length, duplicates },
        "Starting ingestion"
    );

    const pool = new Pool({ connectionString: DATABASE_URL });
    const totals = { inserted: 0, updated: 0, unchanged: 0 };

    try {
        const batches = chunk(rows, BATCH_SIZE);
        for (const [index, batch] of batches.entries()) {
            const result = await upsertBatch(pool, batch);
            totals.inserted += result.inserted;
            totals.updated += result.updated;
            totals.unchanged += result.unchanged;
            logger.info({ batch: index + 1, of: batches.length, ...result }, "Batch upserted");
        }

        logger.info({ ...totals, total: rows.length }, "Ingestion complete");
    } finally {
        await pool.end();
    }
}

ingest().catch((err: unknown) => {
    logger.error({ err }, "Ingestion failed");
    process.exit(1);
});
