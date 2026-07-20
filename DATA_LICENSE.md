# Data attribution

The file `data/us_zip_codes.csv` is derived from the GeoNames `US.zip` postal-code
dataset:

- Source: https://download.geonames.org/export/zip/US.zip
- Publisher: GeoNames — https://www.geonames.org/
- License: Creative Commons Attribution 4.0 International —
  https://creativecommons.org/licenses/by/4.0/
- Repository CSV SHA-256:
  `eec5dbbd0be486730dd3d000da7f9739e492a89024963e566241818c07a8f0d4`

The source rows were converted to CSV, restricted to the fields used by this service,
renamed to the repository's column names, and deduplicated by `zip_code`. GeoNames does
not endorse this project. The data is provided without warranties of accuracy,
timeliness, or completeness.

When refreshing the committed snapshot, record the retrieval date and source checksum
in the pull request so the exact input remains auditable.
