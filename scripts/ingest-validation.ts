import { parse } from "csv-parse/sync";

const EXPECTED_HEADERS = [
    "zip_code",
    "city",
    "state_code",
    "state_name",
    "county",
    "latitude",
    "longitude",
] as const;
const MAX_REPORTED_ISSUES = 20;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MILITARY_CITY_PATTERN = /^(?:APO|FPO|DPO)(?:\s|$)/i;

type Header = (typeof EXPECTED_HEADERS)[number];

export interface ValidatedZipRow {
    zip_code: string;
    city: string;
    state_code: string;
    state_name: string;
    county: string | null;
    latitude: number;
    longitude: number;
}

export interface DatasetValidationIssue {
    row: number;
    field: string;
    value?: string;
    message: string;
}

export class DatasetValidationError extends Error {
    readonly code = "DatasetValidationError";

    constructor(
        readonly totalIssues: number,
        readonly issues: DatasetValidationIssue[]
    ) {
        super(`Dataset validation failed with ${totalIssues} issue(s)`);
        this.name = "DatasetValidationError";
    }
}

export interface ValidatedDataset {
    rows: ValidatedZipRow[];
    rawRowCount: number;
    identicalDuplicates: number;
}

interface IssueCollector {
    issues: DatasetValidationIssue[];
    total: number;
}

function addIssue(collector: IssueCollector, issue: DatasetValidationIssue) {
    collector.total += 1;
    if (collector.issues.length < MAX_REPORTED_ISSUES) {
        collector.issues.push({
            ...issue,
            ...(issue.value == null ? {} : { value: issue.value.slice(0, 200) }),
        });
    }
}

function validateHeaders(headers: string[], collector: IssueCollector): Map<Header, number> {
    const positions = new Map<string, number>();
    const duplicates = new Set<string>();

    headers.forEach((header, index) => {
        if (positions.has(header)) duplicates.add(header);
        else positions.set(header, index);
    });

    const expected = new Set<string>(EXPECTED_HEADERS);
    const missing = EXPECTED_HEADERS.filter((header) => !positions.has(header));
    const unexpected = [...positions.keys()].filter((header) => !expected.has(header));

    for (const header of duplicates) {
        addIssue(collector, {
            row: 1,
            field: "headers",
            value: header,
            message: "Duplicate header",
        });
    }
    for (const header of missing) {
        addIssue(collector, { row: 1, field: "headers", value: header, message: "Missing header" });
    }
    for (const header of unexpected) {
        addIssue(collector, {
            row: 1,
            field: "headers",
            value: header,
            message: "Unexpected header",
        });
    }

    return new Map(EXPECTED_HEADERS.map((header) => [header, positions.get(header) ?? -1]));
}

function parseCoordinate(
    value: string,
    field: "latitude" | "longitude",
    row: number,
    min: number,
    max: number,
    collector: IssueCollector
): number | null {
    if (!value || !DECIMAL_PATTERN.test(value)) {
        addIssue(collector, { row, field, value, message: "Expected a finite number" });
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        addIssue(collector, { row, field, value, message: "Expected a finite number" });
        return null;
    }
    if (parsed < min || parsed > max) {
        addIssue(collector, {
            row,
            field,
            value,
            message: `Expected a value from ${min} to ${max}`,
        });
        return null;
    }
    return parsed;
}

function rowsAreEqual(left: ValidatedZipRow, right: ValidatedZipRow): boolean {
    return (
        left.zip_code === right.zip_code &&
        left.city === right.city &&
        left.state_code === right.state_code &&
        left.state_name === right.state_name &&
        left.county === right.county &&
        left.latitude === right.latitude &&
        left.longitude === right.longitude
    );
}

export function parseAndValidateCsv(csv: string): ValidatedDataset {
    let records: string[][];
    try {
        records = parse(csv, {
            bom: true,
            skip_empty_lines: true,
            trim: true,
            relax_column_count: false,
        }) as string[][];
    } catch (error) {
        const message = error instanceof Error ? error.message : "Malformed CSV";
        throw new DatasetValidationError(1, [{ row: 0, field: "file", message }]);
    }

    if (!records[0]) {
        throw new DatasetValidationError(1, [
            { row: 0, field: "file", message: "Dataset is empty" },
        ]);
    }

    const collector: IssueCollector = { issues: [], total: 0 };
    const positions = validateHeaders(records[0], collector);
    if (collector.total > 0) {
        throw new DatasetValidationError(collector.total, collector.issues);
    }

    const dataRecords = records.slice(1);
    if (dataRecords.length === 0) {
        throw new DatasetValidationError(1, [
            { row: 2, field: "file", message: "Dataset contains no data rows" },
        ]);
    }

    const uniqueRows = new Map<string, { row: ValidatedZipRow; sourceRow: number }>();
    let identicalDuplicates = 0;

    dataRecords.forEach((record, index) => {
        const sourceRow = index + 2;
        const value = (header: Header) => record[positions.get(header)!]?.trim() ?? "";
        const issuesBeforeRow = collector.total;

        const zipCode = value("zip_code");
        const city = value("city");
        const stateCode = value("state_code").toUpperCase();
        const stateName = value("state_name");
        const countyValue = value("county");

        if (!/^\d{5}$/.test(zipCode)) {
            addIssue(collector, {
                row: sourceRow,
                field: "zip_code",
                value: zipCode,
                message: "Expected exactly 5 digits",
            });
        }
        if (!city || city.length > 150) {
            addIssue(collector, {
                row: sourceRow,
                field: "city",
                value: city,
                message: city ? "Expected at most 150 characters" : "City is required",
            });
        }

        const hasStateCode = stateCode.length > 0;
        const hasStateName = stateName.length > 0;
        if (hasStateCode !== hasStateName) {
            addIssue(collector, {
                row: sourceRow,
                field: "state",
                message: "state_code and state_name must both be present or both be empty",
            });
        } else if (hasStateCode && !/^[A-Z]{2}$/.test(stateCode)) {
            addIssue(collector, {
                row: sourceRow,
                field: "state_code",
                value: stateCode,
                message: "Expected a 2-letter state code",
            });
        } else if (!hasStateCode && !MILITARY_CITY_PATTERN.test(city)) {
            addIssue(collector, {
                row: sourceRow,
                field: "state",
                message: "Empty state fields are allowed only for APO, FPO, or DPO locations",
            });
        }
        if (stateName.length > 150) {
            addIssue(collector, {
                row: sourceRow,
                field: "state_name",
                value: stateName,
                message: "Expected at most 150 characters",
            });
        }
        if (countyValue.length > 150) {
            addIssue(collector, {
                row: sourceRow,
                field: "county",
                value: countyValue,
                message: "Expected at most 150 characters",
            });
        }

        const latitude = parseCoordinate(
            value("latitude"),
            "latitude",
            sourceRow,
            -90,
            90,
            collector
        );
        const longitude = parseCoordinate(
            value("longitude"),
            "longitude",
            sourceRow,
            -180,
            180,
            collector
        );

        if (collector.total !== issuesBeforeRow || latitude == null || longitude == null) return;

        const validated: ValidatedZipRow = {
            zip_code: zipCode,
            city,
            state_code: stateCode,
            state_name: stateName,
            county: countyValue || null,
            latitude,
            longitude,
        };
        const previous = uniqueRows.get(zipCode);
        if (!previous) {
            uniqueRows.set(zipCode, { row: validated, sourceRow });
        } else if (rowsAreEqual(previous.row, validated)) {
            identicalDuplicates += 1;
        } else {
            addIssue(collector, {
                row: sourceRow,
                field: "zip_code",
                value: zipCode,
                message: `Conflicts with duplicate ZIP from row ${previous.sourceRow}`,
            });
        }
    });

    if (collector.total > 0) {
        throw new DatasetValidationError(collector.total, collector.issues);
    }

    return {
        rows: [...uniqueRows.values()].map(({ row }) => row),
        rawRowCount: dataRecords.length,
        identicalDuplicates,
    };
}
