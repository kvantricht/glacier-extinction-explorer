"""
Build PMTiles artifacts from a global GeoParquet dataset.

Outputs (written to <repo>/data/ by default):
  glaciers_points.pmtiles     – vector tiles for overview rendering (z0–z10)
  glaciers_polygons.pmtiles   – vector tiles for detail rendering (z10–z16)
  search_index.json           – lightweight typeahead index
  build_metadata.json         – scenario definitions, extents, field names

Intermediates written to a temp directory and deleted automatically:
  glaciers_points.fgb         – FlatGeobuf point layer (compact binary)
  glaciers_polygons.fgb       – FlatGeobuf polygon layer (compact binary)
  glaciers_points.mbtiles     – ogr2ogr MBTiles intermediate (points)
  glaciers_polygons.mbtiles   – ogr2ogr MBTiles intermediate (polygons)

Usage:
  python scripts/build_pmtiles.py [path/to/global_glaciers.parquet] [--out ./data]

Requirements:
  pip install geopandas pyarrow shapely numpy pyogrio

  ogr2ogr must be on PATH – it ships with GDAL, which geopandas depends on.
    conda: already available after `conda install geopandas`
    pip:   install GDAL separately, e.g. via OSGeo4W on Windows or `apt install gdal-bin`

  pmtiles CLI must be on PATH – single Go binary, no compilation required.
    Download from: https://github.com/protomaps/go-pmtiles/releases
    Extract the binary and place it on PATH (or in the repo root).

The script is idempotent – re-running overwrites previous outputs.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import geopandas as gpd
    import numpy as np
    import pandas as pd
    from shapely.geometry import Point
except ImportError as exc:
    sys.exit(
        f"Missing dependency: {exc}.\n"
        "Install with: pip install geopandas pyarrow shapely numpy"
    )

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCENARIO_PATTERN = re.compile(
    r"^all_extinction_perglacier(?:_volume)?_(median|Q1|Q3)_([0-9]+)$",
    re.IGNORECASE,
)
CURRENT_YEAR = 2026  # hard-coded for reproducibility; update as needed
STUDY_HORIZON = 2100  # values >= this are treated as "survives"
SURVIVES_SENTINEL = 9999  # encoded in tiles as "survives through 2100"
EXTINCT_SENTINEL = -1  # encoded in tiles as "already extinct"
VALID_YEAR_MIN = 1850  # below this treated as bad data → survives

# Attributes always written to tiles (subset of full parquet schema).
# Tile attributes should be compact – we drop everything else from the vector tile.
TILE_PASSTHROUGH_FIELDS = [
    "Name",
    "RGIId",
    "GLIMSId",
    "Area",
    "Zmin",
    "Zmax",
    "CenLat",
    "CenLon",
    "Inventory year",
    "Glacier volume",
]

# Field priority lists (first found in data wins)
GEOMETRY_FIELD_CANDIDATES = ["geometry", "geom", "wkb_geometry", "GEOMETRY"]
ID_FIELD_CANDIDATES = ["RGIId", "GLIMSId", "fid", "id"]
NAME_FIELD_CANDIDATES = ["Name", "name", "GLACIER_NAME"]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def find_column(columns: list[str], candidates: list[str]) -> str | None:
    col_lower = {c.lower(): c for c in columns}
    for candidate in candidates:
        if candidate in columns:
            return candidate
        if candidate.lower() in col_lower:
            return col_lower[candidate.lower()]
    return None


def normalize_year(value, current_year: int = CURRENT_YEAR) -> int:
    """
    Encode an extinction-year value into the integer sentinel scheme used in
    vector tiles:
      SURVIVES_SENTINEL (9999) – survives through 2100, missing, or no-data
      EXTINCT_SENTINEL  (-1)   – already extinct (value < current_year)
      YYYY                     – projected future extinction year
    """
    if value is None:
        return SURVIVES_SENTINEL

    try:
        v = float(value)
    except (TypeError, ValueError):
        return SURVIVES_SENTINEL

    if math.isnan(v) or math.isinf(v):
        return SURVIVES_SENTINEL
    if v <= 0 or v < VALID_YEAR_MIN:
        return SURVIVES_SENTINEL
    if v >= STUDY_HORIZON or v >= 9000:
        return SURVIVES_SENTINEL
    if v < current_year:
        return EXTINCT_SENTINEL

    return int(round(v))


def detect_scenarios(columns: list[str]) -> list[dict]:
    """
    Detect scenario column groups matching
    all_extinction_perglacier[_volume]_{stat}_{code}.
    Returns a sorted list of scenario dicts.
    """
    scenario_map: dict[str, dict] = {}
    for col in columns:
        m = SCENARIO_PATTERN.match(col)
        if not m:
            continue
        stat, code = m.group(1).lower(), m.group(2)
        key = f"all:{code}"
        entry = scenario_map.setdefault(key, {"code": code, "key": key, "fields": {}})
        entry["fields"][stat] = col

    scenarios = [
        e
        for e in scenario_map.values()
        if any(s in e["fields"] for s in ("median", "q1", "q3"))
    ]
    scenarios.sort(key=lambda e: int(e["code"]))
    return scenarios


def format_scenario_label(code: str) -> str:
    if code.isdigit():
        numeric = int(code)
        # e.g. 15 → 1.5°C, 20 → 2.0°C, 27 → 2.7°C, 40 → 4.0°C
        return f"{numeric // 10}.{numeric % 10}\u00b0C warming"
    return code


def make_tile_field_name(code: str, stat: str) -> str:
    """Short field name for use in vector tiles, e.g. ext_27, ext_27_q1."""
    if stat == "median":
        return f"ext_{code}"
    return f"ext_{code}_{stat}"


# Default fallback path for pmtiles.exe on Windows when not on PATH
_PMTILES_DEFAULT_PATHS = [
    r"C:\Users\VTRICHTK\Downloads\pmtiles.exe",
]


def resolve_tool(
    name: str, override: str | None, fallback_paths: list[str], install_hint: str
) -> str:
    """
    Resolve an external CLI tool to its full path.
    Priority: explicit --override > PATH lookup > known fallback paths.
    Exits with a helpful message if nothing is found.
    """
    if override:
        p = Path(override)
        if not p.exists():
            sys.exit(f"\n  ERROR: '{name}' not found at specified path: {override}\n")
        return str(p)

    import shutil as _shutil

    found = _shutil.which(name)
    if found:
        return found

    for fb in fallback_paths:
        if Path(fb).exists():
            print(f"      Using {name} from fallback path: {fb}")
            return fb

    sys.exit(
        f"\n  ERROR: '{name}' not found on PATH and no fallback located.\n"
        f"  Install it from: {install_hint}\n"
        f"  Or pass --pmtiles /path/to/pmtiles.exe\n"
    )


# ---------------------------------------------------------------------------
# Core build
# ---------------------------------------------------------------------------


def build(
    parquet_path: Path,
    out_dir: Path,
    *,
    pmtiles_exe: str | None = None,
    force: bool = False,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[1/6] Reading GeoParquet: {parquet_path}")
    gdf = gpd.read_parquet(parquet_path)

    # Ensure WGS-84
    if gdf.crs is None:
        print("      WARNING: no CRS found, assuming EPSG:4326")
        gdf = gdf.set_crs("EPSG:4326")
    elif gdf.crs.to_epsg() != 4326:
        print(f"      Reprojecting from {gdf.crs} → EPSG:4326")
        gdf = gdf.to_crs("EPSG:4326")

    columns = list(gdf.columns)
    print(f"      {len(gdf):,} features, {len(columns)} columns")

    # ------------------------------------------------------------------
    print("[2/6] Detecting scenario columns")
    scenarios = detect_scenarios(columns)
    if not scenarios:
        sys.exit(
            "No extinction scenario fields detected. "
            "Expected columns matching: "
            "all_extinction_perglacier[_volume]_{median|Q1|Q3}_{code}"
        )
    print(f"      {len(scenarios)} scenarios: {[s['key'] for s in scenarios]}")

    # ------------------------------------------------------------------
    print("[3/6] Normalising extinction years and computing display geometry")

    name_field = find_column(columns, NAME_FIELD_CANDIDATES) or "Name"

    # Compute scenario tile fields
    scenario_meta = []
    for s in scenarios:
        tile_fields = {}
        for stat, src_col in s["fields"].items():
            tile_field = make_tile_field_name(s["code"], stat)
            gdf[tile_field] = gdf[src_col].apply(normalize_year)
            tile_fields[stat] = tile_field
        scenario_meta.append(
            {
                "code": s["code"],
                "key": s["key"],
                "label": format_scenario_label(s["code"]),
                "tileFields": tile_fields,
                "styleField": tile_fields.get("median")
                or next(iter(tile_fields.values())),
            }
        )

    # Compute log_area for MapLibre circle-radius interpolation
    area_col = find_column(columns, ["Area", "area", "AREA"]) or None
    if area_col and area_col in gdf.columns:
        areas = pd.to_numeric(gdf[area_col], errors="coerce")
        areas = areas.clip(lower=1e-6)
        gdf["log_area"] = np.log(areas).round(4)
        valid_areas = areas[areas > 0]
        area_extent = {
            "min": float(valid_areas.min()),
            "max": float(valid_areas.max()),
        }
        log_area_extent = {
            "min": float(np.log(valid_areas.min())),
            "max": float(np.log(valid_areas.max())),
        }
    else:
        gdf["log_area"] = 0.0
        area_extent = {"min": 0, "max": 1}
        log_area_extent = {"min": 0, "max": 1}

    # Use CenLat / CenLon directly – they are already in the dataset.
    # Fall back to computing the polygon centroid only for any rows where
    # CenLat/CenLon are missing or non-numeric.
    cen_lat = pd.to_numeric(gdf.get("CenLat"), errors="coerce")
    cen_lon = pd.to_numeric(gdf.get("CenLon"), errors="coerce")
    missing = cen_lat.isna() | cen_lon.isna()
    if missing.any():
        print(
            f"      {missing.sum():,} rows missing CenLat/CenLon – computing polygon centroid for those."
        )
        centroids = gdf.geometry[missing].centroid
        cen_lat[missing] = centroids.y
        cen_lon[missing] = centroids.x
    gdf["disp_lat"] = cen_lat.round(6)
    gdf["disp_lon"] = cen_lon.round(6)

    # Compute global year extent (across all scenarios, for color ramp calibration)
    all_years = []
    for s in scenario_meta:
        field = s["styleField"]
        if field in gdf.columns:
            vals = gdf[field]
            future = vals[(vals > CURRENT_YEAR) & (vals < STUDY_HORIZON)]
            all_years.extend(future.tolist())
    year_extent = (
        {"min": int(min(all_years)), "max": int(max(all_years))}
        if all_years
        else {"min": CURRENT_YEAR, "max": STUDY_HORIZON - 1}
    )
    print(f"      Year extent: {year_extent['min']}–{year_extent['max']}")

    # ------------------------------------------------------------------
    print("[4/6] Writing FlatGeobuf intermediates")

    # Columns to include in point layer (geometry replaced by display centroid)
    passthrough = [f for f in TILE_PASSTHROUGH_FIELDS if f in gdf.columns]
    ext_fields = [f for f in gdf.columns if f.startswith("ext_")]
    point_cols = passthrough + ext_fields + ["log_area", "disp_lat", "disp_lon"]

    # Sort descending by area so large glaciers are written first.
    # ogr2ogr drops later features when a tile overflows max size, so this
    # ensures large glaciers are preferentially kept at low zoom levels.
    area_col_name = area_col if area_col and area_col in gdf.columns else None

    # --- Point layer: one Point per glacier at the display coordinate ---
    point_gdf = gdf[point_cols].copy()
    point_gdf["geometry"] = [
        Point(lon, lat) for lon, lat in zip(gdf["disp_lon"], gdf["disp_lat"])
    ]
    point_gdf = gpd.GeoDataFrame(point_gdf, geometry="geometry", crs="EPSG:4326")
    point_gdf = point_gdf[point_gdf.geometry.is_valid & ~point_gdf.geometry.is_empty]
    if area_col_name and area_col_name in point_gdf.columns:
        point_gdf = point_gdf.sort_values(area_col_name, ascending=False)

    # --- Polygon layer: original polygon geometry ---
    poly_cols = passthrough + ext_fields + ["log_area"]
    poly_gdf = gdf[poly_cols + ["geometry"]].copy()
    poly_gdf = poly_gdf[poly_gdf.geometry.is_valid & ~poly_gdf.geometry.is_empty]
    if area_col_name and area_col_name in poly_gdf.columns:
        poly_gdf = poly_gdf.sort_values(area_col_name, ascending=False)

    # Persistent work directory – survives between runs so completed steps are skipped.
    # Lives at <out_dir>/_work/  (git-ignored).
    work_dir = out_dir / "_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    print(f"      Work directory: {work_dir}")
    print("      (delete it or pass --force to redo any step from scratch)")

    points_fgb = work_dir / "glaciers_points.fgb"
    polys_fgb = work_dir / "glaciers_polygons.fgb"
    points_mbtiles = work_dir / "glaciers_points.mbtiles"
    polys_mbtiles = work_dir / "glaciers_polygons.mbtiles"
    points_pmtiles = out_dir / "glaciers_points.pmtiles"
    polygons_pmtiles = out_dir / "glaciers_polygons.pmtiles"

    def _skip(path: Path, label: str, min_bytes: int = 1024) -> bool:
        if not force and path.exists():
            if path.is_file() and path.stat().st_size < min_bytes:
                print(
                    f"      WARN {label} exists but is too small ({path.stat().st_size} bytes) – regenerating"
                )
                path.unlink()
                return False
            print(f"      SKIP {label} (already exists – pass --force to regenerate)")
            return True
        return False

    # ------------------------------------------------------------------
    print("[4/6] Writing FlatGeobuf intermediates")

    passthrough = [f for f in TILE_PASSTHROUGH_FIELDS if f in gdf.columns]
    ext_fields = [f for f in gdf.columns if f.startswith("ext_")]
    area_col_name = area_col if area_col and area_col in gdf.columns else None

    if not _skip(points_fgb, points_fgb.name):
        point_cols = passthrough + ext_fields + ["log_area", "disp_lat", "disp_lon"]
        point_gdf = gdf[point_cols].copy()
        point_gdf["geometry"] = [
            Point(lon, lat) for lon, lat in zip(gdf["disp_lon"], gdf["disp_lat"])
        ]
        point_gdf = gpd.GeoDataFrame(point_gdf, geometry="geometry", crs="EPSG:4326")
        point_gdf = point_gdf[
            point_gdf.geometry.is_valid & ~point_gdf.geometry.is_empty
        ]
        if area_col_name and area_col_name in point_gdf.columns:
            point_gdf = point_gdf.sort_values(area_col_name, ascending=False)
        print(f"      Writing {points_fgb.name} ({len(point_gdf):,} points) …")
        point_gdf.to_file(str(points_fgb), driver="FlatGeobuf", engine="pyogrio")

    if not _skip(polys_fgb, polys_fgb.name):
        poly_cols = passthrough + ext_fields + ["log_area"]
        poly_gdf = gdf[poly_cols + ["geometry"]].copy()
        # Repair invalid geometries before filtering so we don't silently drop
        # glaciers that have a valid centroid point but a slightly invalid polygon.
        invalid_mask = ~poly_gdf.geometry.is_valid
        if invalid_mask.any():
            print(
                f"      Repairing {invalid_mask.sum():,} invalid polygon geometries …"
            )
            poly_gdf.loc[invalid_mask, "geometry"] = poly_gdf.geometry[
                invalid_mask
            ].make_valid()
        poly_gdf = poly_gdf[~poly_gdf.geometry.is_empty]
        if area_col_name and area_col_name in poly_gdf.columns:
            poly_gdf = poly_gdf.sort_values(area_col_name, ascending=False)
        print(f"      Writing {polys_fgb.name} ({len(poly_gdf):,} polygons) …")
        poly_gdf.to_file(str(polys_fgb), driver="FlatGeobuf", engine="pyogrio")

    # ------------------------------------------------------------------
    print("[5/6] Generating PMTiles via ogr2ogr + pmtiles")

    resolve_tool(
        "ogr2ogr",
        None,
        [],
        "https://gdal.org  (ships with geopandas/conda; on Windows also via OSGeo4W)",
    )
    pmtiles_bin = resolve_tool(
        "pmtiles",
        pmtiles_exe,
        _PMTILES_DEFAULT_PATHS,
        "https://github.com/protomaps/go-pmtiles/releases",
    )

    # ogr2ogr MBTiles: vector tiles for point and polygon layers.
    # -nln sets the vector tile layer name (must match POINTS_SOURCE_LAYER / POLYGONS_SOURCE_LAYER in config.js).
    # MAX_FEATURES: must be >= 1; set high to prevent truncation of dense tiles.
    # MAX_SIZE: raise from default 500 KB – needed when many features cluster in one tile.
    # -progress prints a 0..10..20..100 progress bar to stdout.

    if not _skip(points_mbtiles, "glaciers_points.mbtiles"):
        ogr_points_cmd = [
            "ogr2ogr",
            "-f",
            "MBTiles",
            str(points_mbtiles),
            str(points_fgb),
            "-progress",
            "-nln",
            "points",
            "-dsco",
            "MINZOOM=0",
            "-dsco",
            "MAXZOOM=10",
            "-dsco",
            "COMPRESS=YES",
            "-dsco",
            "MAX_FEATURES=500000",  # high limit; prevents truncation of dense tiles
            "-dsco",
            "MAX_SIZE=5000000",  # 5 MB per tile – needed for low-zoom global coverage
        ]
        print("      ogr2ogr → glaciers_points.mbtiles …")
        subprocess.run(ogr_points_cmd, check=True)

    if not _skip(points_pmtiles, points_pmtiles.name):
        print("      pmtiles convert → glaciers_points.pmtiles …")
        subprocess.run(
            [pmtiles_bin, "convert", str(points_mbtiles), str(points_pmtiles)],
            check=True,
        )

    if not _skip(polys_mbtiles, "glaciers_polygons.mbtiles"):
        # Run each zoom band in a separate ogr2ogr process in parallel, then
        # merge the per-band MBTiles into one via SQLite.
        poly_bands = [(9, 9), (10, 11), (12, 12), (13, 13)]
        num_workers = 2

        def _ogr2ogr_poly_band(zmin: int, zmax: int) -> Path:
            band_path = work_dir / f"glaciers_polygons_z{zmin}_{zmax}.mbtiles"
            if not force and band_path.exists() and band_path.stat().st_size > 1024:
                print(f"      SKIP polygon band z{zmin}-{zmax} (already exists)")
                return band_path
            cmd = [
                "ogr2ogr",
                "-f",
                "MBTiles",
                str(band_path),
                str(polys_fgb),
                "-nln",
                "polygons",
                "-dsco",
                f"MINZOOM={zmin}",
                "-dsco",
                f"MAXZOOM={zmax}",
                "-dsco",
                "COMPRESS=YES",
                "-dsco",
                "MAX_FEATURES=500000",
                "-dsco",
                "MAX_SIZE=5000000",
            ]
            print(f"      ogr2ogr polygon band z{zmin}-{zmax} …")
            subprocess.run(cmd, check=True)
            return band_path

        band_paths = []
        print(f"      Running {num_workers} polygon zoom bands in parallel …")
        with ThreadPoolExecutor(max_workers=num_workers) as pool:
            futures = {
                pool.submit(_ogr2ogr_poly_band, zmin, zmax): (zmin, zmax)
                for zmin, zmax in poly_bands
            }
            for fut in as_completed(futures):
                zmin, zmax = futures[fut]
                try:
                    band_paths.append(fut.result())
                except Exception as exc:
                    sys.exit(f"\n  ERROR in polygon band z{zmin}-{zmax}: {exc}\n")

        # Merge band MBTiles into one via SQLite
        print("      Merging polygon bands into glaciers_polygons.mbtiles …")
        import shutil

        first, *rest = sorted(band_paths, key=lambda p: p.name)
        shutil.copy2(first, polys_mbtiles)
        # Use isolation_level=None (autocommit) to avoid transaction lock on ATTACH/DETACH
        dst = sqlite3.connect(str(polys_mbtiles), isolation_level=None)
        try:
            for src_path in rest:
                src_uri = str(src_path).replace("\\", "/")
                dst.execute(f"ATTACH DATABASE '{src_uri}' AS src")
                dst.execute(
                    "INSERT OR REPLACE INTO tiles "
                    "SELECT zoom_level, tile_column, tile_row, tile_data FROM src.tiles"
                )
                dst.execute("DETACH DATABASE src")
        finally:
            dst.close()
        print("      Merge done.")

    if not _skip(polygons_pmtiles, polygons_pmtiles.name):
        print("      pmtiles convert → glaciers_polygons.pmtiles …")
        subprocess.run(
            [pmtiles_bin, "convert", str(polys_mbtiles), str(polygons_pmtiles)],
            check=True,
        )

    # ------------------------------------------------------------------
    print("[6/6] Writing metadata and search index")

    # Search index – one entry per glacier (minimal fields for typeahead)
    search_records = []
    id_col = find_column(columns, ID_FIELD_CANDIDATES)
    for _, row in gdf.iterrows():
        record = {
            "id": str(row.get(id_col or "RGIId", "") or ""),
            "name": str(row.get(name_field or "Name", "") or ""),
            "rgi_id": str(row.get("RGIId", "") or ""),
            "glims_id": str(row.get("GLIMSId", "") or ""),
            "lat": float(row.get("CenLat") or 0),
            "lon": float(row.get("CenLon") or 0),
        }
        search_records.append(record)

    search_index_path = out_dir / "search_index.json"
    print(f"      Writing {search_index_path.name} ({len(search_records):,} entries) …")
    with open(search_index_path, "w", encoding="utf-8") as fh:
        json.dump(search_records, fh, ensure_ascii=False, separators=(",", ":"))

    # Build metadata
    build_metadata = {
        "scenarios": scenario_meta,
        "yearExtent": year_extent,
        "areaExtent": area_extent,
        "logAreaExtent": log_area_extent,
        "defaultScenarioCode": "27",
        "idField": id_col or "RGIId",
        "nameField": name_field or "Name",
        "searchFields": ["name", "rgi_id", "glims_id"],
        "surviveSentinel": SURVIVES_SENTINEL,
        "extinctSentinel": EXTINCT_SENTINEL,
        "studyHorizon": STUDY_HORIZON,
        "currentYear": CURRENT_YEAR,
        "metadataFields": {
            "Area": "Area (km²)",
            "CenLat": "Centroid latitude",
            "CenLon": "Centroid longitude",
            "Glacier volume": "Glacier volume",
            "GLIMSId": "GLIMS ID",
            "Inventory year": "Inventory year",
            "Name": "Name",
            "RGIId": "RGI ID",
            "Zmax": "Max elevation (m)",
            "Zmin": "Min elevation (m)",
        },
        "metadataFieldOrder": [
            "Area",
            "Glacier volume",
            "Zmin",
            "Zmax",
            "Inventory year",
            "CenLat",
            "CenLon",
        ],
    }

    metadata_path = out_dir / "build_metadata.json"
    print(f"      Writing {metadata_path.name} …")
    with open(metadata_path, "w", encoding="utf-8") as fh:
        json.dump(build_metadata, fh, indent=2, ensure_ascii=False)

    print("\n✓ Build complete.")
    print(f"  PMTiles:      {out_dir}/glaciers_points.pmtiles")
    print(f"                {out_dir}/glaciers_polygons.pmtiles")
    print(f"  Search index: {out_dir}/search_index.json")
    print(f"  Metadata:     {out_dir}/build_metadata.json")
    print(f"\n  Intermediates kept in: {out_dir}/_work/")
    print("  Re-run without --force to skip completed steps.")
    print("  Delete _work/ or pass --force to redo everything from scratch.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    default_parquet = Path(
        r"C:\Users\VTRICHTK\OneDrive - VITO\Documents\git\GlacierViz\data\global_glaciers_processed.parquet"
    )

    parser = argparse.ArgumentParser(
        description="Build PMTiles artifacts from a global GeoParquet dataset."
    )
    parser.add_argument(
        "parquet",
        nargs="?",
        default=str(default_parquet),
        help=f"Path to input GeoParquet file (default: {default_parquet})",
    )
    parser.add_argument(
        "--out",
        default=str(repo_root / "data"),
        help="Output directory (default: <repo>/data)",
    )
    parser.add_argument(
        "--pmtiles",
        default=None,
        metavar="PATH",
        help="Path to the pmtiles executable (optional if it is on PATH or at the default fallback path)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Redo all steps even if outputs already exist in data/_work/",
    )
    args = parser.parse_args()

    parquet_path = Path(args.parquet)
    if not parquet_path.exists():
        sys.exit(f"Input file not found: {parquet_path}")

    build(
        parquet_path=parquet_path,
        out_dir=Path(args.out),
        pmtiles_exe=args.pmtiles,
        force=args.force,
    )


if __name__ == "__main__":
    main()
