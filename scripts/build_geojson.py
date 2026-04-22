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


def coerce_float(value) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if numeric != numeric:
        return None
    return numeric


def iter_points(geometry: dict):
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")

    if geometry_type == "Point":
        yield coordinates
        return

    if geometry_type == "LineString":
        yield from coordinates
        return

    if geometry_type == "Polygon":
        for ring in coordinates:
            yield from ring
        return

    if geometry_type == "MultiPolygon":
        for polygon in coordinates:
            for ring in polygon:
                yield from ring
        return

    raise ValueError(f"Unsupported geometry type for display point computation: {geometry_type}")


def bbox_center(geometry: dict) -> tuple[float, float]:
    xs = []
    ys = []
    for x, y in iter_points(geometry):
        xs.append(x)
        ys.append(y)

    if not xs or not ys:
        raise ValueError("Geometry has no coordinates.")

    return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)


def ring_area_and_centroid(ring: list[list[float]]) -> tuple[float, tuple[float, float] | None]:
    if len(ring) < 3:
        return 0.0, None

    area_twice = 0.0
    centroid_x = 0.0
    centroid_y = 0.0
    point_count = len(ring)

    for index in range(point_count):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % point_count]
        cross = x1 * y2 - x2 * y1
        area_twice += cross
        centroid_x += (x1 + x2) * cross
        centroid_y += (y1 + y2) * cross

    if abs(area_twice) < 1e-12:
        return 0.0, None

    return abs(area_twice) / 2.0, (centroid_x / (3.0 * area_twice), centroid_y / (3.0 * area_twice))


def polygon_area_and_centroid(polygon: list[list[list[float]]]) -> tuple[float, tuple[float, float] | None]:
    if not polygon:
        return 0.0, None

    return ring_area_and_centroid(polygon[0])


def geometry_display_point(geometry: dict, properties: dict) -> tuple[float, float]:
    existing_lon = coerce_float(properties.get("DisplayLon"))
    existing_lat = coerce_float(properties.get("DisplayLat"))
    if existing_lon is not None and existing_lat is not None:
        return existing_lon, existing_lat

    centroid_lon = coerce_float(properties.get("CenLon"))
    centroid_lat = coerce_float(properties.get("CenLat"))
    if centroid_lon is not None and centroid_lat is not None:
        return centroid_lon, centroid_lat

    geometry_type = geometry.get("type")
    if geometry_type == "Point":
        x, y = geometry["coordinates"]
        return x, y

    if geometry_type == "Polygon":
        area, centroid = polygon_area_and_centroid(geometry["coordinates"])
        if area > 0 and centroid is not None:
            return centroid
        return bbox_center(geometry)

    if geometry_type == "MultiPolygon":
        weighted_area = 0.0
        weighted_x = 0.0
        weighted_y = 0.0
        for polygon in geometry["coordinates"]:
            area, centroid = polygon_area_and_centroid(polygon)
            if area > 0 and centroid is not None:
                weighted_area += area
                weighted_x += centroid[0] * area
                weighted_y += centroid[1] * area

        if weighted_area > 0:
            return weighted_x / weighted_area, weighted_y / weighted_area
        return bbox_center(geometry)

    return bbox_center(geometry)


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
        display_lon, display_lat = geometry_display_point(geometry, properties)
        properties["DisplayLon"] = round(display_lon, 6)
        properties["DisplayLat"] = round(display_lat, 6)
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
        "columns": [column for column in columns if column != "geometry_bbox"] + ["DisplayLon", "DisplayLat"],
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
