import { z } from "zod";

export const searchQuerySchema = z.object({
    q: z.string().trim().min(1).max(100),
    limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const reverseQuerySchema = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    limit: z.coerce.number().int().min(1).max(20).default(1),
});

export const radiusQuerySchema = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radius_km: z.coerce.number().positive().max(500),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});
