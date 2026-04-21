from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENDORED_PYARROW = ROOT / ".vendor" / "pyarrow"
if str(VENDORED_PYARROW) not in sys.path:
    sys.path.insert(0, str(VENDORED_PYARROW))

import pyarrow.parquet as pq


SCENARIO_PATTERN = re.compile(r"^Extinction_(.+)_(median|Q1|Q3)_([0-9]+)$", re.IGNORECASE)


def read_uint32(blob: bytes, offset: int, little_endian: bool) -> tuple[int, int]:
    fmt = "<I" if little_endian else ">I"
    return struct.unpack_from(fmt, blob, offset)[0], offset + 4


def read_float64(blob: bytes, offset: int, little_endian: bool) -> tuple[float, int]:
    fmt = "<d" if little_endian else ">d"
    return struct.unpack_from(fmt, blob, offset)[0], offset + 8


def read_point(blob: bytes, offset: int, little_endian: bool) -> tuple[list[float], int]:
    x, offset = read_float64(blob, offset, little_endian)
    y, offset = read_float64(blob, offset, little_endian)
    return [x, y], offset


def read_line_string(blob: bytes, offset: int, little_endian: bool) -> tuple[list[list[float]], int]:
    point_count, offset = read_uint32(blob, offset, little_endian)
    coordinates = []
    for _ in range(point_count):
      point, offset = read_point(blob, offset, little_endian)
      coordinates.append(point)
    return coordinates, offset


def read_polygon(blob: bytes, offset: int, little_endian: bool) -> tuple[list[list[list[float]]], int]:
    ring_count, offset = read_uint32(blob, offset, little_endian)
    rings = []
    for _ in range(ring_count):
      ring, offset = read_line_string(blob, offset, little_endian)
      rings.append(ring)
    return rings, offset


def parse_geometry(blob: bytes, offset: int = 0) -> tuple[dict, int]:
    little_endian = blob[offset] == 1
    offset += 1
    raw_type, offset = read_uint32(blob, offset, little_endian)
    geometry_type = raw_type % 1000

    if geometry_type == 1:
        coordinates, offset = read_point(blob, offset, little_endian)
        return {"type": "Point", "coordinates": coordinates}, offset

    if geometry_type == 2:
        coordinates, offset = read_line_string(blob, offset, little_endian)
        return {"type": "LineString", "coordinates": coordinates}, offset

    if geometry_type == 3:
        coordinates, offset = read_polygon(blob, offset, little_endian)
        return {"type": "Polygon", "coordinates": coordinates}, offset

    if geometry_type == 6:
        polygon_count, offset = read_uint32(blob, offset, little_endian)
        polygons = []
        for _ in range(polygon_count):
            geometry, offset = parse_geometry(blob, offset)
            polygons.append(geometry["coordinates"])
        return {"type": "MultiPolygon", "coordinates": polygons}, offset

    raise ValueError(f"Unsupported WKB geometry type: {geometry_type}")


def normalize_scalar(value):
    if hasattr(value, "as_py"):
        value = value.as_py()
    if isinstance(value, bytes):
        return value
    return value


def detect_scenarios(columns: list[str]) -> list[dict]:
    grouped: dict[tuple[str, str], dict] = {}
    for column in columns:
        match = SCENARIO_PATTERN.match(column)
        if not match:
            continue
        family, stat_name, code = match.groups()
        key = (family, code)
        entry = grouped.setdefault(
            key,
            {
                "key": f"{family}:{code}",
                "family": family,
                "code": code,
                "label": f"Scenario {int(code) // 10}.{int(code) % 10}°C" if code.isdigit() else code,
                "fields": {},
                "styleField": None,
            },
        )
        entry["fields"][stat_name] = column
        if stat_name == "median" or entry["styleField"] is None:
            entry["styleField"] = column

    return [grouped[key] for key in sorted(grouped, key=lambda item: int(item[1]))]


def main() -> int:
    source = ROOT / "test_swiss.parquet"
    output_dir = ROOT / "data"
    output_dir.mkdir(exist_ok=True)

    table = pq.read_table(source)
    rows = table.to_pylist()
    columns = table.column_names

    geometry_field = "geometry"
    if geometry_field not in columns:
        raise SystemExit("Expected a 'geometry' column in the parquet file.")

    features = []
    for row in rows:
        geometry_blob = normalize_scalar(row[geometry_field])
        geometry, _ = parse_geometry(geometry_blob)
        properties = {k: normalize_scalar(v) for k, v in row.items() if k not in {geometry_field, "geometry_bbox"}}
        features.append(
            {
                "type": "Feature",
                "geometry": geometry,
                "properties": properties,
            }
        )

    collection = {"type": "FeatureCollection", "features": features}
    metadata = {
        "geometryField": geometry_field,
        "columns": [column for column in columns if column != "geometry_bbox"],
        "scenarioDefinitions": detect_scenarios(columns),
        "featureCount": len(features),
        "source": source.name,
    }

    (output_dir / "swiss_glaciers.geojson").write_text(
        json.dumps(collection, separators=(",", ":")),
        encoding="utf-8",
    )
    (output_dir / "swiss_glaciers.meta.json").write_text(
        json.dumps(metadata, indent=2),
        encoding="utf-8",
    )

    print(f"Wrote {output_dir / 'swiss_glaciers.geojson'}")
    print(f"Wrote {output_dir / 'swiss_glaciers.meta.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
