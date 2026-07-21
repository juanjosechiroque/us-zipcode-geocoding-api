import { sql } from "kysely";
import { db } from "../../database.js";
import type {
    LocationDto,
    LocationWithDistanceDto,
    RadiusCursorPosition,
} from "./locations.types.js";

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

function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, "\\$&");
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

export async function findWithinRadius(
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number,
    cursor: RadiusCursorPosition | null
): Promise<LocationWithDistanceDto[]> {
    const point = geographyPoint(lat, lng);
    const radiusMeters = radiusKm * 1000;
    const distance = sql<number>`ST_Distance(location, ${point})`;
    let builder = db
        .selectFrom("zip_codes")
        .select(SELECT_COLUMNS)
        .select(distance.as("distance_meters"))
        .where(sql<boolean>`ST_DWithin(location, ${point}, ${radiusMeters})`)
        .orderBy(distance, "asc")
        .orderBy("zip_code", "asc")
        .limit(limit);

    if (cursor) {
        builder = builder.where(
            sql<boolean>`(
                ${distance} > ${cursor.distance_meters}
                OR (${distance} = ${cursor.distance_meters} AND zip_code > ${cursor.zip_code})
            )`
        );
    }

    return builder.execute();
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
    const prefixPattern = `${escapeLikePattern(query)}%`;

    if (query.length < 3) {
        let shortQueryBuilder = db
            .selectFrom("zip_codes")
            .select(SELECT_COLUMNS)
            .where(sql<boolean>`city ILIKE ${prefixPattern} ESCAPE E'\\\\'`)
            .orderBy(sql<number>`CASE WHEN lower(city) = lower(${query}) THEN 0 ELSE 1 END`, "asc")
            .orderBy("city", "asc")
            .orderBy("state_code", "asc")
            .orderBy("zip_code", "asc")
            .limit(limit);

        if (stateCode) {
            shortQueryBuilder = shortQueryBuilder.where("state_code", "=", stateCode);
        }

        return shortQueryBuilder.execute();
    }

    const relevance = sql<number>`
        CASE
            WHEN lower(city) = lower(${query}) THEN 0
            WHEN city ILIKE ${prefixPattern} ESCAPE E'\\\\' THEN 1
            ELSE 2
        END
    `;
    let builder = db
        .selectFrom("zip_codes")
        .select(SELECT_COLUMNS)
        .where(sql<boolean>`(city ILIKE ${prefixPattern} ESCAPE E'\\\\' OR city % ${query})`)
        .orderBy(relevance, "asc")
        .orderBy(sql`similarity(city, ${query})`, "desc")
        .orderBy("city", "asc")
        .orderBy("state_code", "asc")
        .orderBy("zip_code", "asc")
        .limit(limit);

    if (stateCode) {
        builder = builder.where("state_code", "=", stateCode);
    }

    return builder.execute();
}
