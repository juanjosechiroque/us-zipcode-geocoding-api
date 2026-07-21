import { describe, expect, it } from "vitest";
import { decodeRadiusCursor, encodeRadiusCursor } from "./locations.cursor.js";

const query = { lat: 34.0901, lng: -118.4065, radius_km: 5 };
const position = { distance_meters: 1842.53, zip_code: "90211" };

describe("radius cursor", () => {
    it("round-trips a position through a URL-safe opaque token", () => {
        const cursor = encodeRadiusCursor(query, position);

        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeRadiusCursor(cursor, query)).toEqual(position);
    });

    it("rejects malformed cursors", () => {
        expect(() => decodeRadiusCursor("not+a+valid+cursor", query)).toThrow("Invalid cursor");
    });

    it("rejects a cursor generated for different radius parameters", () => {
        const cursor = encodeRadiusCursor(query, position);

        expect(() => decodeRadiusCursor(cursor, { ...query, radius_km: 10 })).toThrow(
            "Invalid cursor"
        );
    });
});
