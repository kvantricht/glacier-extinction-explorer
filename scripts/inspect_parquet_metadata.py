from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def extract_json_strings(blob: bytes) -> list[dict]:
    matches = re.findall(rb"\{[\x20-\x7e]{20,}\}", blob)
    parsed = []
    for match in matches:
      try:
        text = match.decode("utf-8")
        parsed.append(json.loads(text))
      except Exception:
        continue
    return parsed


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("test_swiss.parquet")
    if not target.exists():
        print(f"Missing parquet file: {target}", file=sys.stderr)
        return 1

    payload = target.read_bytes()
    metadata = extract_json_strings(payload)

    geo = next((item for item in metadata if "primary_column" in item), None)
    gdal = next((item for item in metadata if "columns" in item and "fid" in item["columns"]), None)

    if not geo and not gdal:
        print("Could not find embedded GeoParquet/GDAL JSON metadata.", file=sys.stderr)
        return 1

    print(f"File: {target}")

    if geo:
        print("\nGeoParquet metadata")
        print(json.dumps(geo, indent=2))

    if gdal:
        print("\nGDAL schema")
        print(json.dumps(gdal, indent=2))

        columns = list(gdal["columns"].keys())
        geometry_column = geo.get("primary_column") if geo else None
        scenario_columns = [
            name for name in columns if re.match(r"^Extinction_.+_(median|Q1|Q3)_[0-9]+$", name)
        ]

        print("\nDetected fields")
        print(f"- Geometry column: {geometry_column or 'unknown'}")
        print(f"- Scenario-related fields: {', '.join(scenario_columns)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
