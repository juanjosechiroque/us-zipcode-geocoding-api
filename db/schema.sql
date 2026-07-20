CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS zip_codes (
    zip_code TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    state_code TEXT NOT NULL,
    state_name TEXT NOT NULL,
    county TEXT,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    location GEOGRAPHY(Point, 4326) GENERATED ALWAYS AS (
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
    ) STORED,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zip_codes_location_gist_idx ON zip_codes USING GIST (location);

CREATE INDEX IF NOT EXISTS zip_codes_city_trgm_idx ON zip_codes USING GIN (city gin_trgm_ops);

CREATE INDEX IF NOT EXISTS zip_codes_zip_prefix_idx ON zip_codes (zip_code text_pattern_ops);

CREATE INDEX IF NOT EXISTS zip_codes_state_code_idx ON zip_codes (state_code);
