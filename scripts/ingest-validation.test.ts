import { describe, expect, it } from "vitest";
import { DatasetValidationError, parseAndValidateCsv } from "./ingest-validation.js";

const headers = "zip_code,city,state_code,state_name,county,latitude,longitude";
const validRow = "00501,Holtsville,ny,New York,,40.8154,-73.0451";

function validationError(csv: string): DatasetValidationError {
    try {
        parseAndValidateCsv(csv);
    } catch (error) {
        expect(error).toBeInstanceOf(DatasetValidationError);
        return error as DatasetValidationError;
    }
    throw new Error("Expected dataset validation to fail");
}

describe("CSV ingestion validation", () => {
    it("normalizes a valid row while preserving a leading-zero ZIP", () => {
        const result = parseAndValidateCsv([headers, validRow].join("\n"));

        expect(result).toEqual({
            rows: [
                {
                    zip_code: "00501",
                    city: "Holtsville",
                    state_code: "NY",
                    state_name: "New York",
                    county: null,
                    latitude: 40.8154,
                    longitude: -73.0451,
                },
            ],
            rawRowCount: 1,
            identicalDuplicates: 0,
        });
    });

    it("accepts headers in a different order", () => {
        const csv = [
            "city,zip_code,longitude,latitude,county,state_name,state_code",
            "Holtsville,00501,-73.0451,40.8154,,New York,NY",
        ].join("\n");

        expect(parseAndValidateCsv(csv).rows[0]).toMatchObject({
            zip_code: "00501",
            city: "Holtsville",
            latitude: 40.8154,
            longitude: -73.0451,
        });
    });

    it.each([
        [
            "missing",
            "zip_code,city,state_code,state_name,county,latitude",
            "00501,Holtsville,NY,New York,,40.8154",
        ],
        ["unexpected", `${headers},population`, `${validRow},100`],
        [
            "duplicate",
            "zip_code,city,city,state_code,state_name,county,latitude,longitude",
            "00501,Holtsville,Holtsville,NY,New York,,40.8154,-73.0451",
        ],
    ])("rejects %s headers", (_case, invalidHeaders, matchingRow) => {
        const error = validationError([invalidHeaders, matchingRow].join("\n"));

        expect(error.issues).toEqual(
            expect.arrayContaining([expect.objectContaining({ field: "headers" })])
        );
    });

    it.each([
        ["ZIP", "501,Holtsville,NY,New York,Suffolk,40.8154,-73.0451", "zip_code"],
        ["city", "00501,,NY,New York,Suffolk,40.8154,-73.0451", "city"],
        ["latitude empty", "00501,Holtsville,NY,New York,Suffolk,,-73.0451", "latitude"],
        ["latitude range", "00501,Holtsville,NY,New York,Suffolk,91,-73.0451", "latitude"],
        ["longitude range", "00501,Holtsville,NY,New York,Suffolk,40.8154,-181", "longitude"],
    ])("rejects an invalid %s", (_case, invalidRow, field) => {
        const error = validationError([headers, invalidRow].join("\n"));

        expect(error.issues).toEqual(
            expect.arrayContaining([expect.objectContaining({ row: 2, field })])
        );
    });

    it("requires state code and name together", () => {
        const error = validationError(
            [headers, "00501,Holtsville,NY,,Suffolk,40.8154,-73.0451"].join("\n")
        );

        expect(error.issues).toContainEqual(
            expect.objectContaining({ field: "state", message: expect.stringContaining("both") })
        );
    });

    it("allows empty state fields only for military and diplomatic locations", () => {
        const military = parseAndValidateCsv([headers, "09002,APO AE,,,,49.0,8.0"].join("\n"));
        expect(military.rows[0]).toMatchObject({ state_code: "", state_name: "" });

        const error = validationError(
            [headers, "00501,Holtsville,,,Suffolk,40.8154,-73.0451"].join("\n")
        );
        expect(error.issues).toEqual(
            expect.arrayContaining([expect.objectContaining({ field: "state" })])
        );
    });

    it("collapses identical duplicate rows and reports their count", () => {
        const result = parseAndValidateCsv([headers, validRow, validRow].join("\n"));

        expect(result.rows).toHaveLength(1);
        expect(result.rawRowCount).toBe(2);
        expect(result.identicalDuplicates).toBe(1);
    });

    it("rejects conflicting rows for the same ZIP", () => {
        const conflict = "00501,Another City,NY,New York,,40.8154,-73.0451";
        const error = validationError([headers, validRow, conflict].join("\n"));

        expect(error.issues).toContainEqual(
            expect.objectContaining({
                row: 3,
                field: "zip_code",
                message: expect.stringContaining("row 2"),
            })
        );
    });

    it("counts every issue while retaining only the first 20 details", () => {
        const invalidRows = Array.from(
            { length: 25 },
            (_, index) => `bad-${index},City,NY,New York,,40,-73`
        );
        const error = validationError([headers, ...invalidRows].join("\n"));

        expect(error.totalIssues).toBe(25);
        expect(error.issues).toHaveLength(20);
        expect(error.issues[0]).toMatchObject({ row: 2, field: "zip_code" });
        expect(error.issues[19]).toMatchObject({ row: 21, field: "zip_code" });
    });

    it("rejects empty files, header-only files, and malformed row widths", () => {
        expect(validationError("").issues).toContainEqual(
            expect.objectContaining({ message: "Dataset is empty" })
        );
        expect(validationError(headers).issues).toContainEqual(
            expect.objectContaining({ message: "Dataset contains no data rows" })
        );
        expect(() => parseAndValidateCsv([headers, "00501,Holtsville"].join("\n"))).toThrow(
            "Dataset validation failed"
        );
    });
});
