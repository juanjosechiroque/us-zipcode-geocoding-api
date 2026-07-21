import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, type PoolClient } from "pg";
import { DATABASE_URL } from "../src/config.js";
import { ingestCsv, ingestRows, upsertBatchesAtomically } from "./ingest.js";
import type { ValidatedZipRow } from "./ingest-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");

const row: ValidatedZipRow = {
    zip_code: "90210",
    city: "Beverly Hills",
    state_code: "CA",
    state_name: "California",
    county: "Los Angeles",
    latitude: 34.0901,
    longitude: -118.4065,
};

describe("atomic ingestion", () => {
    it("rolls back every batch and never commits when a later batch fails", async () => {
        const statements: string[] = [];
        let upsertCount = 0;
        const query = vi.fn((statement: string) => {
            statements.push(statement);
            if (statement.includes("INSERT INTO zip_codes")) {
                upsertCount += 1;
                if (upsertCount === 2) throw new Error("invalid second batch");
                return { rows: [{ inserted: true }] };
            }
            return { rows: [] };
        });
        const client = { query } as unknown as PoolClient;

        await expect(upsertBatchesAtomically(client, [[row], [row]])).rejects.toThrow(
            "invalid second batch"
        );

        expect(statements[0]).toBe("BEGIN");
        expect(statements.at(-1)).toBe("ROLLBACK");
        expect(statements).not.toContain("COMMIT");
    });

    it("commits once after every batch succeeds", async () => {
        const statements: string[] = [];
        const query = vi.fn((statement: string) => {
            statements.push(statement);
            return statement.includes("INSERT INTO zip_codes")
                ? { rows: [{ inserted: true }] }
                : { rows: [] };
        });
        const client = { query } as unknown as PoolClient;

        await expect(upsertBatchesAtomically(client, [[row], [row]])).resolves.toEqual({
            inserted: 2,
            updated: 0,
            unchanged: 0,
        });

        expect(statements[0]).toBe("BEGIN");
        expect(statements.at(-1)).toBe("COMMIT");
        expect(statements).not.toContain("ROLLBACK");
    });

    it("does not open a transaction when CSV validation fails", async () => {
        const query = vi.fn();
        const client = { query } as unknown as PoolClient;
        const invalidCsv = [
            "zip_code,city,state_code,state_name,county,latitude,longitude",
            "90210,Beverly Hills,CA,California,Los Angeles,, -118.4065",
        ].join("\n");

        await expect(ingestCsv(client, invalidCsv)).rejects.toThrow("Dataset validation failed");
        expect(query).not.toHaveBeenCalled();
    });
});

describe("ingestion idempotency against PostgreSQL", () => {
    const schema = `ingest_test_${randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString: DATABASE_URL });
    let connected = false;

    beforeAll(async () => {
        await client.connect();
        connected = true;
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET search_path TO ${schema}, public`);
        await client.query(schemaSql);
    });

    beforeEach(async () => {
        await client.query("TRUNCATE TABLE zip_codes");
    });

    afterAll(async () => {
        if (!connected) return;
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
        await client.end();
    });

    it("inserts once and leaves identical rows unchanged on the second run", async () => {
        const rows: ValidatedZipRow[] = [
            row,
            {
                zip_code: "10001",
                city: "New York",
                state_code: "NY",
                state_name: "New York",
                county: "New York",
                latitude: 40.7506,
                longitude: -73.9972,
            },
        ];

        await expect(ingestRows(client as unknown as PoolClient, rows, 1)).resolves.toEqual({
            inserted: 2,
            updated: 0,
            unchanged: 0,
            total: 2,
        });

        await expect(ingestRows(client as unknown as PoolClient, rows, 1)).resolves.toEqual({
            inserted: 0,
            updated: 0,
            unchanged: 2,
            total: 2,
        });

        const count = await client.query<{ count: string }>("SELECT count(*) FROM zip_codes");
        expect(Number(count.rows[0]?.count)).toBe(2);
    });

    it("updates only the changed row without creating duplicates", async () => {
        const rows: ValidatedZipRow[] = [
            row,
            {
                zip_code: "10001",
                city: "New York",
                state_code: "NY",
                state_name: "New York",
                county: "New York",
                latitude: 40.7506,
                longitude: -73.9972,
            },
        ];
        await ingestRows(client as unknown as PoolClient, rows, 1);

        const changedRows = rows.map((item) =>
            item.zip_code === "90210" ? { ...item, city: "Beverly Hills Updated" } : item
        );
        await expect(ingestRows(client as unknown as PoolClient, changedRows, 1)).resolves.toEqual({
            inserted: 0,
            updated: 1,
            unchanged: 1,
            total: 2,
        });

        const stored = await client.query<{ city: string }>(
            "SELECT city FROM zip_codes WHERE zip_code = '90210'"
        );
        const count = await client.query<{ count: string }>("SELECT count(*) FROM zip_codes");

        expect(stored.rows[0]?.city).toBe("Beverly Hills Updated");
        expect(Number(count.rows[0]?.count)).toBe(2);
    });
});
