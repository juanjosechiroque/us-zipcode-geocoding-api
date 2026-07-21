import * as locationsRepository from "./locations.repository.js";
import type {
    LocationDto,
    PaginatedLocations,
    RadiusQueryInput,
    ReverseQueryInput,
    SearchQueryInput,
} from "./locations.types.js";
import { decodeRadiusCursor, encodeRadiusCursor } from "./locations.cursor.js";

const ZIP_ONLY_PATTERN = /^\d{1,5}$/;
const ZIP_ANYWHERE_PATTERN = /\b\d{5}\b/;
const STATE_CODE_PATTERN = /^[A-Za-z]{2}$/;

export async function searchLocations({ q, limit }: SearchQueryInput): Promise<LocationDto[]> {
    if (ZIP_ONLY_PATTERN.test(q)) {
        return locationsRepository.findByZipPrefix(q, limit);
    }

    const zipMatch = q.match(ZIP_ANYWHERE_PATTERN);
    if (zipMatch) {
        return locationsRepository.findByZipPrefix(zipMatch[0], limit);
    }

    const segments = q
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    const lastSegment = segments.at(-1);
    const lastSegmentIsStateCode =
        segments.length > 1 && lastSegment != null && STATE_CODE_PATTERN.test(lastSegment);

    const stateCode = lastSegmentIsStateCode ? lastSegment.toUpperCase() : null;
    const cityPart = stateCode ? segments.at(-2)! : (segments[0] ?? q);

    return locationsRepository.findByCity(cityPart, stateCode, limit);
}

export async function getNearestLocations({
    lat,
    lng,
    limit,
}: ReverseQueryInput): Promise<LocationDto[]> {
    return locationsRepository.findNearest(lat, lng, limit);
}

export async function getLocationsWithinRadius(
    query: RadiusQueryInput
): Promise<PaginatedLocations> {
    const { lat, lng, radius_km, limit, cursor } = query;
    const position = cursor ? decodeRadiusCursor(cursor, query) : null;
    const rows = await locationsRepository.findWithinRadius(
        lat,
        lng,
        radius_km,
        limit + 1,
        position
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const last = data.at(-1);

    return {
        data,
        meta: {
            limit,
            has_more: hasMore,
            next_cursor:
                hasMore && last
                    ? encodeRadiusCursor(query, {
                          distance_meters: last.distance_meters,
                          zip_code: last.zip_code,
                      })
                    : null,
        },
    };
}
