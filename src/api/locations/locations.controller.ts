import type { Request, Response } from "express";
import { searchLocations } from "./locations.service.js";
import { sendResponse } from "../../utils/response.js";
import type { SearchQueryInput } from "./locations.types.js";

type RequestWithValidatedQuery<T> = Request & { validatedQuery: T };

export async function searchLocationsHandler(
    req: RequestWithValidatedQuery<SearchQueryInput>,
    res: Response
) {
    const results = await searchLocations(req.validatedQuery);
    sendResponse(res, 200, results);
}
