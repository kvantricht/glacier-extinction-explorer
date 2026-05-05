# Global Glacier Extinction Explorer

A browser-based interactive map for exploring glacier extinction projections worldwide. Pan and zoom across ~200 000 glaciers, switch between warming scenarios, and click any glacier to inspect its projected extinction year and physical attributes.

Built with **MapLibre GL JS** and **PMTiles** — no backend or tile server required. The browser streams only the tiles it needs for the current view.

---

## Features

- **Global coverage** — all ~200 000 glaciers from the Randolph Glacier Inventory (RGI)
- **Multiple warming scenarios** — switch between SSP/temperature targets to see how projections change
- **Per-glacier detail** — hover for a quick tooltip; click for full metadata (area, elevation range, slope, extinction year)
- **Search** — find any glacier by name or RGI ID
- **3D terrain** — toggle a terrain mode for mountainous regions
- **Satellite basemap** — Esri World Imagery base layer

---

## Running locally

The app is a set of static files. Any HTTP server works — you cannot open `index.html` directly as a `file://` URL because the app uses ES modules.

```bash
# Python
python -m http.server 8080

# Node.js
npx serve .

# Windows helper included in the repo
run-local.cmd
```

Then open [http://localhost:8080](http://localhost:8080).

The tile data (`*.pmtiles`) is served from Cloudflare R2 by default, so no local data setup is needed just to view the map.

---

## Building the tile data

If you want to run the full pipeline from source data (e.g. to update glacier projections), you will need the source GeoParquet file and a few command-line tools.

### Prerequisites

**Python packages:**

```bash
pip install geopandas pyarrow shapely numpy pyogrio
```

**`ogr2ogr`** (GDAL) must be on `PATH`:

```bash
# conda (recommended on Windows/macOS)
conda install geopandas   # brings GDAL with it

# Ubuntu / Debian
sudo apt-get install gdal-bin
```

**`pmtiles`** CLI — a single binary, no compilation needed:

```bash
# macOS (Homebrew)
brew install protomaps/go-pmtiles/go-pmtiles

# Linux
curl -L https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles_Linux_x86_64.tar.gz | tar xz
sudo mv pmtiles /usr/local/bin/

# Windows — download from https://github.com/protomaps/go-pmtiles/releases and place on PATH
```

### Run the build

```bash
# Default source path
python scripts/build_pmtiles.py

# Explicit input/output paths
python scripts/build_pmtiles.py /path/to/global_glaciers.parquet --out ./data
```

This produces four files in `data/`:

```
data/
  glaciers_points.pmtiles      ← overview point layer (zoom 0–10)
  glaciers_polygons.pmtiles    ← full polygon layer (zoom 11+)
  search_index.json            ← typeahead search index
  build_metadata.json          ← scenario definitions and year extents
```

### Expected input schema

The pipeline expects a GeoParquet file with at least the following columns:

| Column | Type | Description |
|---|---|---|
| `geometry` | polygon / multipolygon | Glacier outline (any CRS; reprojected automatically) |
| `RGIId` | string | Stable RGI glacier ID |
| `GLIMSId` | string | GLIMS ID |
| `Name` | string | Display name |
| `Area` | float | Glacier area in km² |
| `CenLat`, `CenLon` | float | Centroid coordinates |
| `Extinction_{family}_{stat}_{code}` | float / int | Per-scenario projected extinction year (e.g. `Extinction_SSP_median_26`) |

Additional attribute columns (`Zmin`, `Zmed`, `Zmax`, `Slope`, `Status`, …) are passed through and shown in the detail popup.

### Hosting the tile files

The four generated files must be accessible over HTTP with CORS enabled. Options:

- **Local dev** — the static server described above serves them automatically.
- **Cloud storage** — upload to S3, Azure Blob, GCS, or Cloudflare R2 with public read access and a permissive CORS policy, then update `PMTILES_BASE_URL` in `src/config.js`.
- **Static hosting** — Netlify, GitHub Pages, Vercel, etc. (commit or deploy the `data/` directory).

PMTiles archives support HTTP range requests, so the browser only downloads the chunks it needs — no tile server process is required.

---

## Updating with new data

1. Update or replace the source GeoParquet file.
2. Re-run `python scripts/build_pmtiles.py`.
3. Upload the new `data/` files to your hosting location.
4. No changes to the frontend are needed unless the column naming convention changes.

---

## Project structure

```
index.html          ← app entry point
src/
  config.js         ← asset URLs, color scheme, scenario helpers
  main.js           ← map initialisation, layer logic, search, interactions
  style.css         ← UI styles
scripts/
  build_pmtiles.py  ← data pipeline: GeoParquet → PMTiles + JSON indexes
data/               ← generated tile files (not committed to the repo)
```

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/build_pmtiles.py` | Main preprocessing pipeline |
| `scripts/build_geojson.py` | Legacy Swiss-glacier GeoJSON builder (kept for reference) |
| `scripts/inspect_parquet_metadata.py` | Inspect GeoParquet schema without modifying data |
