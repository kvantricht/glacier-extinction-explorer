import {
  CURRENT_YEAR,
  DATASET_URL,
  DATASET_METADATA_URL,
  ID_FIELD_PRIORITY,
  SCENARIO_FIELD_PATTERN,
  SCENARIO_STAT_PRIORITY,
  SEARCH_FIELD_PRIORITY,
  STUDY_HORIZON_YEAR,
  VALID_YEAR_MAX,
  VALID_YEAR_MIN,
  formatScenarioLabel,
} from "./config.js?v=7";

function normalizeScalar(value) {
  if (typeof value === "bigint") {
    return Number(value);
  }

  return value;
}

function normalizeYearValue(value) {
  if (value === null || value === undefined || value === "") {
    return { kind: "survives", numeric: null, label: "Survives beyond 2100" };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return { kind: "survives", numeric: null, label: "Survives beyond 2100" };
    }

    const lower = trimmed.toLowerCase();
    if (lower.includes("survive") || lower.includes("no extinction") || lower.includes("missing")) {
      return { kind: "survives", numeric: null, label: "Survives beyond 2100" };
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      value = parsed;
    } else {
      return { kind: "survives", numeric: null, label: "Survives beyond 2100" };
    }
  }

  if (typeof value === "bigint") {
    value = Number(value);
  }

  if (!Number.isFinite(value)) {
    return { kind: "survives", numeric: null, label: "Survives beyond 2100" };
  }

  if (value >= STUDY_HORIZON_YEAR || value >= 9999 || value > VALID_YEAR_MAX) {
    return { kind: "survives", numeric: null, label: "Survives beyond 2100" };
  }

  if (value <= 0) {
    return { kind: "survives", numeric: null, label: "Survives beyond 2100" };
  }

  if (value < VALID_YEAR_MIN) {
    return { kind: "missing", numeric: null, label: String(value) };
  }

  if (value < CURRENT_YEAR) {
    return { kind: "alreadyExtinct", numeric: value, label: `${value}` };
  }

  return { kind: "year", numeric: value, label: `${value}` };
}

function detectScenarioDefinitions(columns) {
  const scenarioMap = new Map();

  for (const column of columns) {
    const match = SCENARIO_FIELD_PATTERN.exec(column);
    if (!match) {
      continue;
    }

    const [, family, statName, code] = match;
    const key = `${family}:${code}`;
    const entry =
      scenarioMap.get(key) ||
      {
        code,
        family,
        key,
        label: formatScenarioLabel(code),
        fields: {},
      };

    entry.fields[statName] = column;
    scenarioMap.set(key, entry);
  }

  const scenarios = [...scenarioMap.values()]
    .filter((entry) => SCENARIO_STAT_PRIORITY.some((name) => entry.fields[name]))
    .sort((left, right) => Number(left.code) - Number(right.code))
    .map((entry) => ({
      ...entry,
      styleField:
        entry.fields.median ??
        entry.fields[SCENARIO_STAT_PRIORITY.find((name) => entry.fields[name])],
    }));

  if (!scenarios.length) {
    throw new Error(
      "No extinction scenario fields were detected. Update the scenario pattern in src/config.js."
    );
  }

  return scenarios;
}

function withStyleField(scenarios) {
  return scenarios.map((entry) => ({
    ...entry,
    styleField:
      entry.styleField ??
      entry.fields?.median ??
      entry.fields?.[SCENARIO_STAT_PRIORITY.find((name) => entry.fields?.[name])],
  }));
}

function pickBestField(columns, priority) {
  return priority.find((field) => columns.includes(field)) || null;
}

function computeLegendBins(features, scenarios) {
  const years = [];

  for (const feature of features) {
    for (const scenario of scenarios) {
      const normalized = feature.properties.__scenarioValues[scenario.key];
      if (normalized?.kind === "year") {
        years.push(normalized.numeric);
      }
    }
  }

  years.sort((left, right) => left - right);

  if (!years.length) {
    return [];
  }

  const first = years[0];
  const last = years[years.length - 1];
  if (first === last) {
    return [{ min: first, max: last }];
  }

  const targetBins = 6;
  const step = Math.max(5, Math.ceil((last - first) / targetBins / 5) * 5);
  const bins = [];
  let min = first;

  while (min <= last) {
    const max = Math.min(last, min + step - 1);
    bins.push({ min, max });
    min = max + 1;
  }

  return bins;
}

function computeYearExtent(features, scenarios) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const feature of features) {
    for (const scenario of scenarios) {
      const normalized = feature.properties.__scenarioValues[scenario.key];
      if (normalized?.kind === "year") {
        min = Math.min(min, normalized.numeric);
        max = Math.max(max, normalized.numeric);
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  return { min, max };
}

function buildFeature(row, geometryField, scenarioDefinitions) {
  const properties = {};

  for (const [key, value] of Object.entries(row)) {
    if (key === geometryField || key === "geometry_bbox") {
      continue;
    }
    properties[key] = normalizeScalar(value);
  }

  properties.__scenarioValues = {};
  for (const scenario of scenarioDefinitions) {
    for (const [statName, fieldName] of Object.entries(scenario.fields)) {
      properties.__scenarioValues[`${scenario.key}:${statName}`] = normalizeYearValue(
        properties[fieldName]
      );
    }

    properties.__scenarioValues[scenario.key] = normalizeYearValue(
      properties[scenario.styleField]
    );
  }

  const geometry = row[geometryField];
  if (!geometry) {
    return null;
  }

  return {
    type: "Feature",
    geometry,
    properties,
  };
}

export async function loadDataset() {
  const [dataResponse, metadataResponse] = await Promise.all([
    fetch(DATASET_URL),
    fetch(DATASET_METADATA_URL),
  ]);

  if (!dataResponse.ok) {
    throw new Error(`Failed to load ${DATASET_URL} (${dataResponse.status}).`);
  }
  if (!metadataResponse.ok) {
    throw new Error(`Failed to load ${DATASET_METADATA_URL} (${metadataResponse.status}).`);
  }

  const featureCollection = await dataResponse.json();
  const metadata = await metadataResponse.json();

  const features = featureCollection.features || [];
  if (!features.length) {
    throw new Error("The GeoJSON dataset is empty.");
  }

  const columns = metadata.columns || Object.keys(features[0].properties || {});
  const geometryField = metadata.geometryField || "geometry";
  const scenarioDefinitions =
    withStyleField(
      metadata.scenarioDefinitions?.length
        ? metadata.scenarioDefinitions
        : detectScenarioDefinitions(columns)
    );
  const primaryIdField = pickBestField(columns, ID_FIELD_PRIORITY);
  const primarySearchField = pickBestField(columns, SEARCH_FIELD_PRIORITY);

  const normalizedFeatures = features
    .map((feature) =>
      buildFeature(
        {
          ...feature.properties,
          [geometryField]: feature.geometry,
        },
        geometryField,
        scenarioDefinitions
      )
    )
    .filter(Boolean);

  return {
    columns,
    geometryField,
    metadata,
    primaryIdField,
    primarySearchField,
    scenarioDefinitions,
    legendBins: computeLegendBins(normalizedFeatures, scenarioDefinitions),
    yearExtent: computeYearExtent(normalizedFeatures, scenarioDefinitions),
    featureCollection: {
      type: "FeatureCollection",
      features: normalizedFeatures,
    },
  };
}
