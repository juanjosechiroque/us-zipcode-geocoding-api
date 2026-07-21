import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { DATABASE_URL } from "../src/config.js";
import logger from "../src/utils/logger.js";
import {
    DatasetValidationError,
    parseAndValidateCsv,
    type ValidatedZipRow,
} from "./ingest-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_PATH = path.join(__dirname, "..", "data", "us_zip_codes.csv");
const BATCH_SIZE = 500;

const INGEST_LOCK_ID = 947_215_806;

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

async function insertStagingBatch(client: PoolClient, batch: ValidatedZipRow[]) {
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
                row.county,
                row.latitude,
                row.longitude
            );
            return `(${columns.map((_, colIndex) => `$${base + colIndex + 1}`).join(", ")})`;
        })
        .join(", ");

    const query = `
        INSERT INTO incoming_zip_codes (${columns.join(", ")})
        VALUES ${placeholders}
    `;

    await client.query(query, values);
}

interface SnapshotChanges {
    inserted: number;
    updated: number;
    deleted: number;
}

async function calculateSnapshotChanges(client: PoolClient): Promise<SnapshotChanges> {
    const result = await client.query<SnapshotChanges>(`
        SELECT
            count(*) FILTER (WHERE existing.zip_code IS NULL)::integer AS inserted,
            count(*) FILTER (
                WHERE incoming.zip_code IS NOT NULL
                  AND existing.zip_code IS NOT NULL
                  AND (
                    existing.city IS DISTINCT FROM incoming.city OR
                    existing.state_code IS DISTINCT FROM incoming.state_code OR
                    existing.state_name IS DISTINCT FROM incoming.state_name OR
                    existing.county IS DISTINCT FROM incoming.county OR
                    existing.latitude IS DISTINCT FROM incoming.latitude OR
                    existing.longitude IS DISTINCT FROM incoming.longitude
                  )
            )::integer AS updated,
            count(*) FILTER (WHERE incoming.zip_code IS NULL)::integer AS deleted
        FROM incoming_zip_codes AS incoming
        FULL OUTER JOIN zip_codes AS existing
          ON existing.zip_code = incoming.zip_code
    `);

    return result.rows[0] ?? { inserted: 0, updated: 0, deleted: 0 };
}

async function publishSnapshot(client: PoolClient) {
    await client.query(`
        INSERT INTO zip_codes (
            zip_code, city, state_code, state_name, county, latitude, longitude
        )
        SELECT
            zip_code, city, state_code, state_name, county, latitude, longitude
        FROM incoming_zip_codes
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
    `);

    await client.query(`
        DELETE FROM zip_codes AS existing
        WHERE NOT EXISTS (
            SELECT 1
            FROM incoming_zip_codes AS incoming
            WHERE incoming.zip_code = existing.zip_code
        )
    `);
}

export async function reconcileSnapshotAtomically(
    client: PoolClient,
    batches: ValidatedZipRow[][]
) {
    const incomingRows = batches.reduce((total, batch) => total + batch.length, 0);

    await client.query("BEGIN");
    try {
        await client.query(`
            CREATE TEMP TABLE incoming_zip_codes (
                zip_code TEXT PRIMARY KEY,
                city TEXT NOT NULL,
                state_code TEXT NOT NULL,
                state_name TEXT NOT NULL,
                county TEXT,
                latitude DOUBLE PRECISION NOT NULL,
                longitude DOUBLE PRECISION NOT NULL
            ) ON COMMIT DROP
        `);

        for (const [index, batch] of batches.entries()) {
            await insertStagingBatch(client, batch);
            logger.info(
                { batch: index + 1, of: batches.length, rows: batch.length },
                "Staging batch loaded"
            );
        }

        const changes = await calculateSnapshotChanges(client);
        const unchanged = incomingRows - changes.inserted - changes.updated;
        const totals = { ...changes, unchanged };

        logger.info(totals, "Snapshot changes calculated");
        await publishSnapshot(client);
        await client.query("COMMIT");
        return totals;
    } catch (error) {
        await client.query("ROLLBACK");
        logger.error({ err: error }, "Ingestion transaction rolled back");
        throw error;
    }
}

export async function ingestRows(
    client: PoolClient,
    rows: ValidatedZipRow[],
    batchSize = BATCH_SIZE
) {
    const batches = chunk(rows, batchSize);
    const totals = await reconcileSnapshotAtomically(client, batches);

    return {
        ...totals,
        total: rows.length,
    };
}

export async function ingestCsv(client: PoolClient, csv: string, batchSize = BATCH_SIZE) {
    const dataset = parseAndValidateCsv(csv);
    const totals = await ingestRows(client, dataset.rows, batchSize);
    return {
        ...totals,
        rawRowCount: dataset.rawRowCount,
        identicalDuplicates: dataset.identicalDuplicates,
    };
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

        const csv = readFileSync(dataPath, "utf8");
        logger.info({ dataPath }, "Starting ingestion validation");

        const result = await ingestCsv(lockHolder, csv);

        logger.info(result, "Ingestion complete");
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
        if (err instanceof DatasetValidationError) {
            logger.error(
                {
                    code: err.code,
                    totalIssues: err.totalIssues,
                    issues: err.issues,
                },
                "Ingestion validation failed"
            );
        } else {
            logger.error({ err }, "Ingestion failed");
        }
        process.exit(1);
    });
}
