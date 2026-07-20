import { describe, expect, it } from "vitest";

const { api, V1 } = await import("../../tests/helpers.js");

describe("GET /v1/locations/search", () => {
    it("returns an exact match for a full ZIP code", async () => {
        const response = await api.get(`${V1}/locations/search?q=90210`);

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1);
        expect(response.body.data[0]).toMatchObject({
            zip_code: "90210",
            city: "Beverly Hills",
            state_code: "CA",
            state_name: "California",
        });
    });

    it("returns a response envelope of { status, message, data }", async () => {
        const response = await api.get(`${V1}/locations/search?q=90210`);

        expect(Object.keys(response.body).sort()).toEqual(["data", "message", "status"]);
        expect(response.body.status).toBe(200);
        expect(response.body.message).toBe("success");
    });

    it("prefix-matches a partial ZIP code and respects the limit", async () => {
        const response = await api.get(`${V1}/locations/search?q=902&limit=3`);

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(3);
        for (const row of response.body.data) {
            expect(row.zip_code.startsWith("902")).toBe(true);
        }
    });

    it("defaults to limit=10 when limit is omitted", async () => {
        const response = await api.get(`${V1}/locations/search?q=York`);

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(10);
    });

    it("fuzzy-matches a city name", async () => {
        const response = await api.get(`${V1}/locations/search?q=Beverly&limit=5`);

        expect(response.status).toBe(200);
        expect(response.body.data.length).toBeGreaterThan(0);
        for (const row of response.body.data) {
            expect(row.city.toLowerCase()).toContain("beverly");
        }
    });

    it("scopes a city match by state when q looks like 'City, ST'", async () => {
        const response = await api.get(`${V1}/locations/search?q=Springfield,IL&limit=10`);

        expect(response.status).toBe(200);
        expect(response.body.data.length).toBeGreaterThan(0);
        for (const row of response.body.data) {
            expect(row.city).toBe("Springfield");
            expect(row.state_code).toBe("IL");
        }
    });

    it("resolves a full address string via the embedded ZIP, ignoring the street", async () => {
        const response = await api.get(
            `${V1}/locations/search?q=${encodeURIComponent("123 Main St, Beverly Hills, CA 90210")}`
        );

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1);
        expect(response.body.data[0]).toMatchObject({ zip_code: "90210", city: "Beverly Hills" });
    });

    it("resolves a street+city+state string (no ZIP) via the last two comma segments", async () => {
        const response = await api.get(
            `${V1}/locations/search?q=${encodeURIComponent("123 Main St, Beverly Hills, CA")}`
        );

        expect(response.status).toBe(200);
        // Other "___ Hills, CA" cities can rank below the exact match (see Known
        // Limitations) — assert the best match wins the top spot, not every row.
        expect(response.body.data[0]).toMatchObject({ city: "Beverly Hills", state_code: "CA" });
        for (const row of response.body.data) {
            expect(row.state_code).toBe("CA");
        }
    });

    it("degrades to an unscoped city search when the state is a full name, not a 2-letter code", async () => {
        const response = await api.get(
            `${V1}/locations/search?q=${encodeURIComponent("Springfield, Illinois")}`
        );

        expect(response.status).toBe(200);
        // Must not misread "Illinois" as the city name (a real, previously-found bug).
        expect(response.body.data.length).toBeGreaterThan(0);
        for (const row of response.body.data) {
            expect(row.city).toBe("Springfield");
        }
    });

    it("resolves a ZIP+4 formatted code by extracting the base ZIP", async () => {
        const response = await api.get(`${V1}/locations/search?q=90210-1234`);

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1);
        expect(response.body.data[0]).toMatchObject({ zip_code: "90210", city: "Beverly Hills" });
    });

    it("returns 200 with an empty array when nothing matches", async () => {
        const response = await api.get(`${V1}/locations/search?q=Zzzxxqqqnotarealplace`);

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([]);
    });

    it("returns identical, deterministic ordering across repeated identical requests", async () => {
        const first = await api.get(`${V1}/locations/search?q=York&limit=5`);
        const second = await api.get(`${V1}/locations/search?q=York&limit=5`);

        expect(first.body.data).toEqual(second.body.data);
    });

    it("returns 400 when q is missing", async () => {
        const response = await api.get(`${V1}/locations/search`);

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ status: 400, code: "BadRequestError" });
        expect(response.body.details).toEqual(
            expect.arrayContaining([expect.objectContaining({ field: "q" })])
        );
    });

    it("returns 400 when q is empty", async () => {
        const response = await api.get(`${V1}/locations/search?q=`);

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ status: 400, code: "BadRequestError" });
    });

    it("returns 400 when q exceeds 100 characters", async () => {
        const response = await api.get(`${V1}/locations/search?q=${"a".repeat(101)}`);

        expect(response.status).toBe(400);
    });

    it("returns 400 when limit is out of range", async () => {
        const tooHigh = await api.get(`${V1}/locations/search?q=Beverly&limit=999`);
        const tooLow = await api.get(`${V1}/locations/search?q=Beverly&limit=0`);

        expect(tooHigh.status).toBe(400);
        expect(tooLow.status).toBe(400);
    });

    it("returns 400 when limit is not a number", async () => {
        const response = await api.get(`${V1}/locations/search?q=Beverly&limit=abc`);

        expect(response.status).toBe(400);
    });
});
