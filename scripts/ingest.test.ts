import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { upsertBatchesAtomically, type ZipRow } from "./ingest.js";

const row: ZipRow = {
    zip_code: "90210",
    city: "Beverly Hills",
    state_code: "CA",
    state_name: "California",
    county: "Los Angeles",
    latitude: "34.0901",
    longitude: "-118.4065",
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
});
