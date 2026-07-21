import { z } from "zod";

const queryNumber = z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().finite()
);

export const searchQuerySchema = z.object({
    q: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[^%_\\]*$/),
    limit: queryNumber.pipe(z.number().int().min(1).max(50)).default(10),
});

export const reverseQuerySchema = z.object({
    lat: queryNumber.pipe(z.number().min(-90).max(90)),
    lng: queryNumber.pipe(z.number().min(-180).max(180)),
    limit: queryNumber.pipe(z.number().int().min(1).max(20)).default(1),
});

export const radiusQuerySchema = z.object({
    lat: queryNumber.pipe(z.number().min(-90).max(90)),
    lng: queryNumber.pipe(z.number().min(-180).max(180)),
    radius_km: queryNumber.pipe(z.number().positive().max(500)),
    limit: queryNumber.pipe(z.number().int().min(1).max(50)).default(20),
    cursor: z.string().trim().min(1).max(1024).optional(),
});
