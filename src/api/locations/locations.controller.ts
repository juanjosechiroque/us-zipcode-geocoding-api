import type { Request, Response } from "express";
import {
    getLocationsWithinRadius,
    getNearestLocations,
    searchLocations,
} from "./locations.service.js";
import { sendResponse } from "../../utils/response.js";
import type { RadiusQueryInput, ReverseQueryInput, SearchQueryInput } from "./locations.types.js";

type RequestWithValidatedQuery<T> = Request & { validatedQuery: T };

export async function searchLocationsHandler(
    req: RequestWithValidatedQuery<SearchQueryInput>,
    res: Response
) {
    const results = await searchLocations(req.validatedQuery);
    sendResponse(res, 200, results);
}

export async function reverseLocationsHandler(
    req: RequestWithValidatedQuery<ReverseQueryInput>,
    res: Response
) {
    const results = await getNearestLocations(req.validatedQuery);
    sendResponse(res, 200, results);
}

export async function radiusLocationsHandler(
    req: RequestWithValidatedQuery<RadiusQueryInput>,
    res: Response
) {
    const results = await getLocationsWithinRadius(req.validatedQuery);
    sendResponse(res, 200, results);
}
