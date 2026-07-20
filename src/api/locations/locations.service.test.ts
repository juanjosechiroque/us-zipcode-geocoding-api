import { describe, expect, it, vi } from "vitest";
import * as locationsRepository from "./locations.repository.js";
import { searchLocations } from "./locations.service.js";

vi.mock("./locations.repository.js", () => ({
    findByZipPrefix: vi.fn(),
    findByCity: vi.fn(),
}));

describe("searchLocations", () => {
    it("falls back to the raw query string as the city when q has no usable segments", async () => {
        vi.mocked(locationsRepository.findByCity).mockResolvedValueOnce([]);

        await searchLocations({ q: ",,,", limit: 10 });

        expect(locationsRepository.findByCity).toHaveBeenCalledWith(",,,", null, 10);
    });
});
