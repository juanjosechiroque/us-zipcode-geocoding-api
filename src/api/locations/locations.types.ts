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
