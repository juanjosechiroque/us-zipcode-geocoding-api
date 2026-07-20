import type { ColumnType } from "kysely";

export interface ZipCodesTable {
    zip_code: string;
    city: string;
    state_code: string;
    state_name: string;
    county: string | null;
    latitude: number;
    longitude: number;
    updated_at: ColumnType<Date, string | undefined, never>;
}

export interface Database {
    zip_codes: ZipCodesTable;
}
