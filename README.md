# Global Glacier Extinction Explorer

A browser-based interactive map for exploring glacier extinction projections worldwide, built with **MapLibre GL JS** and backed by **PMTiles** vector tiles.

Scalable to ~200 000 glaciers: the browser streams only the tiles needed for the current map view rather than loading a monolithic GeoJSON file.

---

## Architecture overview

```
global_glaciers.parquet          ← canonical source-of-truth (external, not in repo)
         │
         ▼
scripts/build_pmtiles.py         ← preprocessing pipeline (Python)
         │
         ├── data/glaciers_points.pmtiles    ← overview points, z0–z10
         ├── data/glaciers_polygons.pmtiles  ← detailed polygons, z10–z16
         ├── data/search_index.json          ← lightweight typeahead index
         └── data/build_metadata.json        ← scenario defs, extents, field names
                  │
                  ▼
         index.html + src/       ← MapLibre GL JS frontend (pure static files)
```

The **GeoParquet** is the single source of truth.  Generated artifacts (`*.pmtiles`, `search_index.json`, `build_metadata.json`) are **build outputs** – they are `.gitignore`d and should be hosted separately (e.g. on object storage, a CDN, or a local server) rather than committed to the repo.

---

## Source-of-truth: GeoParquet schema

The pipeline expects a GeoParquet file with at least:

| Column | Type | Description |
|---|---|---|
| geometry | WKB / GeoArrow | Glacier polygon or multipolygon (any CRS; reprojected to WGS-84 automatically) |
| `RGIId` | string | Stable RGI glacier ID (used as tile feature ID) |
| `GLIMSId` | string | GLIMS ID |
| `Name` | string | Display name |
| `Area` | float | Glacier area in km² |
| `CenLat`, `CenLon` | float | Centroid (fallback display point) |
| `Extinction_{family}_{stat}_{code}` | float / int | Per-scenario extinction year fields, e.g. `Extinction_SSP_median_26` |

Additional attribute columns (`Zmin`, `Zmed`, `Zmax`, `Slope`, `Status`, …) are passed through to tile attributes and shown in popups.

### Extinction-year encoding

The build script normalises all extinction-year values into an integer sentinel scheme used inside the vector tiles:

| Raw value | Tile encoding | Meaning |
|---|---|---|
| `null`, `NaN`, `""` | `9999` | No data → treated as "survives through 2100" |
| `>= 2100` or `>= 9000` | `9999` | Projected survival beyond study horizon |
| `< 1850` | `9999` | Implausible value → treated as survives |
| `< current year` | `-1` | Already extinct |
| `2026–2099` | year as-is | Future projected extinction |

---

## Preprocessing: generating build artifacts

### Requirements

```bash
pip install geopandas pyarrow shapely numpy pyogrio
```

**`ogr2ogr`** (GDAL) must be on PATH. It ships with GDAL, which is a geopandas dependency:

```bash
# conda – already available
conda install geopandas

# Ubuntu / Debian
sudo apt-get install gdal-bin

# Windows – use OSGeo4W installer: https://trac.osgeo.org/osgeo4w/
# or install via conda (recommended)
```

**`pmtiles`** CLI must be on PATH – a single Go binary, no compilation required:

```bash
# Download the binary for your platform from:
# https://github.com/protomaps/go-pmtiles/releases
# Extract and place on PATH (or in the repo root).

# macOS (Homebrew)
brew install protomaps/go-pmtiles/go-pmtiles

# Linux (download release binary)
curl -L https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles_Linux_x86_64.tar.gz | tar xz
sudo mv pmtiles /usr/local/bin/
```

### Run the build

```bash
# Default: reads from the canonical path, writes to ./data/
python scripts/build_pmtiles.py

# Explicit paths
python scripts/build_pmtiles.py /path/to/global_glaciers.parquet --out ./data
```

The script:
1. Reads the GeoParquet and reprojects to WGS-84 if needed
2. Normalises extinction years to integer sentinels
3. Writes **FlatGeobuf** intermediates to a temp directory (compact binary, ~10× smaller than GeoJSON)
4. Runs `ogr2ogr` (GDAL MVT driver) to generate z/x/y tile directory trees
5. Runs `pmtiles convert` to package each tile directory into a PMTiles archive
6. Cleans up all temp files automatically
7. Writes `search_index.json` and `build_metadata.json` to `data/`

After a successful run `data/` will contain only the final artifacts:

```
data/
  glaciers_points.pmtiles      ← loaded by the browser at zoom 0–10
  glaciers_polygons.pmtiles    ← loaded by the browser at zoom 11–16
  search_index.json            ← typeahead search index
  build_metadata.json          ← scenario definitions and extents
```

### Hosting assumptions

The four generated files in `data/` must be served over HTTP with CORS headers that allow the browser to read them.  Options:

- **Local dev**: a static file server in this directory (see below).
- **Cloud storage**: upload to S3 / Azure Blob / GCS with public read and permissive CORS, then point `POINTS_PMTILES_URL` / `POLYGONS_PMTILES_URL` / etc. in `src/config.js` to the public URLs.
- **CDN-fronted object storage**: same as above, ideal for production.
- **Static hosting (Netlify, GitHub Pages, Vercel)**: commit only the generated `data/` files to a deployment branch or upload them as release assets.

PMTiles are self-contained archives; the browser fetches only the tile chunks it needs via HTTP range requests.  No tile server process is required.

---

## Local development

Serve the repo root over HTTP (any static server works):

```bash
# Python
python -m http.server 8080

# Node (npx)
npx serve .

# Or use the included helper (Windows)
run-local.cmd
```

Then open [http://localhost:8080](http://localhost:8080).

> **Note:** The app uses ES modules (`type="module"`), so it must be served over HTTP – opening `index.html` directly as a `file://` URL will not work.

---

## Frontend overview

| File | Role |
|---|---|
| `index.html` | App shell, CDN imports for MapLibre GL JS and PMTiles |
| `src/config.js` | Asset URLs, sentinel constants, color ramp, helpers |
| `src/main.js` | Map init, PMTiles sources, layer styling, interactions, search |
| `src/style.css` | Dark-themed UI, MapLibre popup/control overrides, hover tooltip |

### Layer strategy

| Zoom | Layer shown | Source |
|---|---|---|
| 0–10 | `glaciers-points` (circles) | `glaciers_points.pmtiles` |
| 11–16 | `glaciers-polygons-fill` + `glaciers-polygons-line` | `glaciers_polygons.pmtiles` |

Point size scales logarithmically with glacier area.  Larger glaciers are rendered above smaller ones (`circle-sort-key`).  At low zoom, tippecanoe drops smaller glaciers first to keep tile sizes manageable.

### Styling

Colors are computed from MapLibre GL data-driven expressions at render time:

- **Already extinct** (`-1`): dark red `#7f0000`
- **Survives through 2100** (`9999` / missing): blue `#5aa9d6`  
- **Future extinction year**: continuous 6-stop ramp from warm red (earliest) to cool blue (latest), interpolated across the observed year range

Switching scenarios calls `map.setPaintProperty` – no layer rebuild needed.

### Search

The `search_index.json` is loaded once at startup.  Typeahead search uses substring matching across name, RGI ID, and GLIMS ID fields, ranked by match position.  Selecting a result calls `map.flyTo` and then queries rendered features to open a full popup.

---

## Updating with new glacier data

1. Replace / update the source GeoParquet.
2. Re-run `python scripts/build_pmtiles.py`.
3. Upload the new `data/*.pmtiles`, `data/search_index.json`, and `data/build_metadata.json` to your hosting location.
4. No changes to the frontend HTML/JS/CSS are needed unless the schema or scenario naming convention changes.

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/build_pmtiles.py` | Main preprocessing pipeline |
| `scripts/build_geojson.py` | Legacy Swiss-glacier GeoJSON builder (kept for reference) |
| `scripts/inspect_parquet_metadata.py` | Inspect GeoParquet schema without modifying data |
