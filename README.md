# Global Glacier Extinction Explorer

A browser-based interactive map for exploring glacier extinction projections worldwide. Pan and zoom across ~200 000 glaciers, switch between warming scenarios, and click any glacier to inspect its projected extinction year and physical attributes.

Built with **MapLibre GL JS** and **PMTiles**.

---

## Background

Glacier changes are traditionally quantified in terms of total (regional) mass and area loss, but such metrics do not fully capture the disappearance of individual glaciers. Yet every glacier, no matter how small, can matter. Beyond their contribution to sea-level rise or regional water resources, glaciers hold important cultural, ecological, and societal value, often deeply rooted in local landscapes and communities. In the context of the UN International Year of Glacier Preservation (2025), this study therefore shifts the focus towards the fate of individual glaciers worldwide.

To assess glacier extinction, two complementary criteria are used. A glacier is considered disappeared (extinct) when its area drops below 0.01 km², consistent with commonly used inventory thresholds, or when its remaining volume falls below 1% of its initial value, indicating that only a negligible ice body persists. To derive volume and area trajectories for each glacier, three global glacier models (GloGEM, OGGM, PyGEM) are used, combined with multiple General Circulation Models and emission scenarios corresponding to projected temperature increases of +1.5°C, +2.0°C, +2.7°C, and +4.0°C. All trajectories are then combined to determine median extinction years, as well as Q25 and Q75 ranges (i.e. the 25% and 75% probability intervals). These results are shown on the map.

It is important to note that extinction is defined relative to the initial glacier outlines from the Randolph Glacier Inventory (RGI v6.0). As such, glacier fragmentation during retreat is not accounted for, which could temporarily increase the number of individual glacier entities. Instead, all remaining ice within the original glacier extent is treated as part of the same glacier.

---

## Data sources

- **Extinction projections** — Van Tricht, L., Zekollari, H., Huss, M. et al. Peak glacier extinction in the mid-twenty-first century. *Nature Climate Change* 16, 143–147 (2026). <https://doi.org/10.1038/s41558-025-02513-9>
- **Regional and glacier-specific results** (including those shown here) are publicly available on Zenodo: <https://doi.org/10.5281/zenodo.17371641>
- **Glacier outlines** — Randolph Glacier Inventory v6.0 (RGI Consortium)
- **Ice volume** — Farinotti et al. (2019) consensus estimate (km³)

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
