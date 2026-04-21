# Swiss Glacier Extinction Explorer

Minimal browser-based web app for exploring Swiss glacier geometries stored in `test_swiss.parquet`.

## What it does

- Converts the source GeoParquet file into GeoJSON for browser use.
- Detects the geometry column automatically.
- Detects extinction-year scenario fields from the parquet schema.
- Styles glacier polygons by extinction year for the selected scenario.
- Shows hover highlighting, click popups, a legend, search, and reset-view control.

## Stack

- Leaflet for mapping
- Vanilla JavaScript modules
- Small Python preprocessing step using `pyarrow`
- Plain GeoJSON in the browser

## Run locally

From this folder, run:

```bat
run-local.cmd
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The first run builds `data/swiss_glaciers.geojson` and `data/swiss_glaciers.meta.json` from `test_swiss.parquet`, then starts a local static server.

If you prefer, you can also run the preprocessing step yourself:

```bat
set PYTHONPATH=C:\Users\VTRICHTK\OneDrive - VITO\Documents\git\GlacierViz\.vendor\pyarrow
C:\Users\VTRICHTK\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe scripts\build_geojson.py
```

After that, any static file server will work as long as it serves this folder over HTTP.

## Files

- [index.html](C:/Users/VTRICHTK/OneDrive%20-%20VITO/Documents/git/GlacierViz/index.html) bootstraps the app shell
- [src/main.js](C:/Users/VTRICHTK/OneDrive%20-%20VITO/Documents/git/GlacierViz/src/main.js) initializes the map and UI
- [src/data.js](C:/Users/VTRICHTK/OneDrive%20-%20VITO/Documents/git/GlacierViz/src/data.js) loads the parquet and detects scenario fields
- [scripts/build_geojson.py](C:/Users/VTRICHTK/OneDrive%20-%20VITO/Documents/git/GlacierViz/scripts/build_geojson.py) converts GeoParquet WKB geometry into GeoJSON
- [src/config.js](C:/Users/VTRICHTK/OneDrive%20-%20VITO/Documents/git/GlacierViz/src/config.js) centralizes scenario detection and styling config
- [scripts/inspect_parquet_metadata.py](C:/Users/VTRICHTK/OneDrive%20-%20VITO/Documents/git/GlacierViz/scripts/inspect_parquet_metadata.py) prints embedded GeoParquet/GDAL metadata without modifying the dataset

## Schema assumptions used

The parquet file embeds enough metadata to identify the structure without mutating it:

- CRS is geographic WGS84 / EPSG:4326
- geometry column is `geometry`
- geometry encoding is WKB
- geometry type is `MultiPolygon`
- likely identifier/name fields are `Name`, `RGIId`, `GLIMSId`, and `fid`
- scenario-related fields follow this pattern:

```text
Extinction_<family>_<stat>_<scenario-code>
```

For the provided file, the detected fields are:

- `Extinction_Alps_median_15`
- `Extinction_Alps_Q1_15`
- `Extinction_Alps_Q3_15`
- `Extinction_Alps_median_20`
- `Extinction_Alps_Q1_20`
- `Extinction_Alps_Q3_20`
- `Extinction_Alps_median_27`
- `Extinction_Alps_Q1_27`
- `Extinction_Alps_Q3_27`
- `Extinction_Alps_median_40`
- `Extinction_Alps_Q1_40`
- `Extinction_Alps_Q3_40`

The selector uses the `median` field for each scenario code and keeps `Q1`/`Q3` visible in popups.

## Scenario detection

Scenario detection is automatic and driven by the regex in [src/config.js](C:/Users/VTRICHTK/OneDrive%20-%20VITO/Documents/git/GlacierViz/src/config.js):

```js
/^Extinction_(.+)_(median|Q1|Q3)_([0-9]+)$/i
```

If a future dataset uses different naming, update that regex or replace it with an explicit mapping in `src/config.js`.

## Color ramp and legend

- Warmer colors indicate earlier extinction years.
- Cooler/lighter colors indicate later extinction years.
- Dark red marks glaciers already extinct before the current year.
- Pale blue marks glaciers that survive beyond the study horizon.
- Gray marks missing values.

The year bins are computed automatically from the valid extinction years found across all detected scenarios, then kept stable while the user switches scenario.

## Notes on scaling this up

For the 7 MB Swiss test file, preprocessing to GeoJSON is simple and reliable. For a larger glacier archive, the main changes would be:

1. Preconvert GeoParquet to vector tiles or chunked GeoJSON for faster rendering.
2. Move schema inspection and scenario-field normalization into a build/preprocessing step.
3. Use map-side tiling or server-side filtering instead of loading the full dataset at once.
4. Consider MapLibre GL JS if dynamic styling at larger feature counts becomes important.

## Optional metadata inspection

You can print the embedded GeoParquet/GDAL schema with:

```bat
C:\Users\VTRICHTK\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe scripts\inspect_parquet_metadata.py test_swiss.parquet
```
