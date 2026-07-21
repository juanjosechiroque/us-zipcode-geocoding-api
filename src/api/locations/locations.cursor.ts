import { z } from "zod";
import { BadRequestError } from "../../errors.js";
import type { RadiusCursorPosition, RadiusQueryInput } from "./locations.types.js";

const cursorPayloadSchema = z
    .object({
        version: z.literal(1),
        lat: z.number().finite().min(-90).max(90),
        lng: z.number().finite().min(-180).max(180),
        radius_km: z.number().finite().positive().max(500),
        distance_meters: z.number().finite().nonnegative(),
        zip_code: z.string().regex(/^\d{5}$/),
    })
    .strict();

type RadiusCursorPayload = z.infer<typeof cursorPayloadSchema>;

function invalidCursor(reason: string) {
    const error = BadRequestError("Invalid cursor");
    error.details = [{ field: "cursor", error: reason }];
    return error;
}

export function encodeRadiusCursor(
    query: Pick<RadiusQueryInput, "lat" | "lng" | "radius_km">,
    position: RadiusCursorPosition
): string {
    const payload: RadiusCursorPayload = {
        version: 1,
        lat: query.lat,
        lng: query.lng,
        radius_km: query.radius_km,
        ...position,
    };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeRadiusCursor(
    cursor: string,
    query: Pick<RadiusQueryInput, "lat" | "lng" | "radius_km">
): RadiusCursorPosition {
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor("Malformed cursor");

        const decoded = Buffer.from(cursor, "base64url").toString("utf8");
        if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
            throw invalidCursor("Malformed cursor");
        }

        const payload = cursorPayloadSchema.parse(JSON.parse(decoded) as unknown);
        if (
            payload.lat !== query.lat ||
            payload.lng !== query.lng ||
            payload.radius_km !== query.radius_km
        ) {
            throw invalidCursor("Cursor does not belong to this radius query");
        }

        return {
            distance_meters: payload.distance_meters,
            zip_code: payload.zip_code,
        };
    } catch (error) {
        if (
            error != null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "BadRequestError"
        ) {
            throw error;
        }
        throw invalidCursor("Malformed cursor");
    }
}
