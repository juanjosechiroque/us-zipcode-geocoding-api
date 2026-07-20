import { sql } from "kysely";
import { db } from "../../database.js";
import type { LocationDto } from "./locations.types.js";

const SELECT_COLUMNS = [
    "zip_code",
    "city",
    "state_code",
    "state_name",
    "county",
    "latitude",
    "longitude",
] as const;

function geographyPoint(lat: number, lng: number) {
    return sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
}

export async function findNearest(lat: number, lng: number, limit: number): Promise<LocationDto[]> {
    const point = geographyPoint(lat, lng);
    return db
        .selectFrom("zip_codes")
        .select(SELECT_COLUMNS)
        .select(sql<number>`ST_Distance(location, ${point})`.as("distance_meters"))
        .orderBy(sql`location <-> ${point}`)
        .limit(limit)
        .execute();
}

export async function findByZipPrefix(prefix: string, limit: number): Promise<LocationDto[]> {
    return db
        .selectFrom("zip_codes")
        .select(SELECT_COLUMNS)
        .where("zip_code", "like", `${prefix}%`)
        .orderBy("zip_code")
        .limit(limit)
        .execute();
}

export async function findByCity(
    query: string,
    stateCode: string | null,
    limit: number
): Promise<LocationDto[]> {
    let builder = db
        .selectFrom("zip_codes")
        .select(SELECT_COLUMNS)
        .where(sql<boolean>`(city ILIKE ${query + "%"} OR city % ${query})`)
        .orderBy(sql`similarity(city, ${query})`, "desc")
        .orderBy("city", "asc")
        .orderBy("zip_code", "asc")
        .limit(limit);

    if (stateCode) {
        builder = builder.where("state_code", "=", stateCode);
    }

    return builder.execute();
}
