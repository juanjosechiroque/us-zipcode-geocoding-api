import type { z } from "zod";
import type {
    radiusQuerySchema,
    reverseQuerySchema,
    searchQuerySchema,
} from "./locations.validation.js";

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
export type ReverseQueryInput = z.infer<typeof reverseQuerySchema>;
export type RadiusQueryInput = z.infer<typeof radiusQuerySchema>;

export interface LocationDto {
    zip_code: string;
    city: string;
    state_code: string;
    state_name: string;
    county: string | null;
    latitude: number;
    longitude: number;
    distance_meters?: number;
}

export interface LocationWithDistanceDto extends LocationDto {
    distance_meters: number;
}

export interface RadiusCursorPosition {
    distance_meters: number;
    zip_code: string;
}

export interface PaginationMeta {
    limit: number;
    has_more: boolean;
    next_cursor: string | null;
}

export interface PaginatedLocations {
    data: LocationWithDistanceDto[];
    meta: PaginationMeta;
}
