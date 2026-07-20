import { describe, expect, it } from "vitest";
import {
    radiusQuerySchema,
    reverseQuerySchema,
    searchQuerySchema,
} from "./locations.validation.js";

describe("location query validation", () => {
    it.each([
        { lat: "", lng: "-118.4065" },
        { lat: "   ", lng: "-118.4065" },
        { lat: "34.0901", lng: "" },
        { lat: "Infinity", lng: "-118.4065" },
        { lat: "NaN", lng: "-118.4065" },
    ])("rejects invalid reverse coordinates: $lat, $lng", (query) => {
        expect(reverseQuerySchema.safeParse(query).success).toBe(false);
    });

    it("rejects empty numeric radius parameters", () => {
        expect(
            radiusQuerySchema.safeParse({ lat: "34.0901", lng: "-118.4065", radius_km: "" }).success
        ).toBe(false);
    });

    it("applies the documented defaults", () => {
        expect(searchQuerySchema.parse({ q: "Beverly" }).limit).toBe(10);
        expect(reverseQuerySchema.parse({ lat: "34.0901", lng: "-118.4065" }).limit).toBe(1);
        expect(
            radiusQuerySchema.parse({ lat: "34.0901", lng: "-118.4065", radius_km: "5" }).limit
        ).toBe(20);
    });

    it("rejects a radius limit above 50", () => {
        expect(
            radiusQuerySchema.safeParse({
                lat: "34.0901",
                lng: "-118.4065",
                radius_km: "5",
                limit: "51",
            }).success
        ).toBe(false);
    });
});
