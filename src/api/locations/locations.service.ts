import * as locationsRepository from "./locations.repository.js";
import type { LocationDto, SearchQueryInput } from "./locations.types.js";

const ZIP_ONLY_PATTERN = /^\d{1,5}$/;
const ZIP_ANYWHERE_PATTERN = /\b\d{5}\b/;
const STATE_CODE_PATTERN = /^[A-Za-z]{2}$/;

// Not a street-address parser (see ARCHITECTURE.md) — extracts only a ZIP or a
// city/state pair from the input; any street/unit text is ignored, not misread as a city.
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

    // Fall back to the first segment (not the last) when there's no recognized state
    // code — otherwise a full state name like "Illinois" gets misread as the city.
    const stateCode = lastSegmentIsStateCode ? lastSegment.toUpperCase() : null;
    // segments.at(-2) is always defined here: lastSegmentIsStateCode already proved
    // segments.length > 1.
    const cityPart = stateCode ? segments.at(-2)! : (segments[0] ?? q);

    return locationsRepository.findByCity(cityPart, stateCode, limit);
}
