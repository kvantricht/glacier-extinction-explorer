import {
  CURRENT_YEAR,
  METADATA_FIELD_LABELS,
  METADATA_FIELD_PRIORITY,
  YEAR_STYLE,
} from "./config.js";
import { loadDataset } from "./data.js?v=5";

const map = L.map("map", {
  zoomControl: false,
  preferCanvas: true,
});

L.control.zoom({ position: "topright" }).addTo(map);

const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    attribution:
      "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxZoom: 19,
  }
);

const streetsLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
});

satelliteLayer.addTo(map);

L.control
  .layers(
    {
      Satellite: satelliteLayer,
      Streets: streetsLayer,
    },
    {},
    { position: "topright", collapsed: true }
  )
  .addTo(map);

const statusBox = document.querySelector("#status-box");
const scenarioSelect = document.querySelector("#scenario-select");
const scenarioStats = document.querySelector("#scenario-stats");
const legendContainer = document.querySelector("#legend");
const activeScenarioChip = document.querySelector("#active-scenario-chip");
const datasetSummary = document.querySelector("#dataset-summary");
const resetViewButton = document.querySelector("#reset-view-button");
const panelToggleButton = document.querySelector("#panel-toggle-button");
const controlPanel = document.querySelector("#control-panel");
const searchSection = document.querySelector("#search-section");
const searchInput = document.querySelector("#search-input");
const searchButton = document.querySelector("#search-button");
const searchStatus = document.querySelector("#search-status");
const overlayVisibleInput = document.querySelector("#overlay-visible-input");
const overlayOpacityInput = document.querySelector("#overlay-opacity-input");
const overlayOpacityValue = document.querySelector("#overlay-opacity-value");

let datasetState = null;
let glacierLayer = null;
let selectedLayer = null;
let selectedFeatureId = null;
let defaultBounds = null;
let overlayVisible = true;
let overlayOpacity = Number(overlayOpacityInput.value) / 100;
const DEFAULT_SCENARIO_CODE = "27";

function setStatus(message, tone = "default") {
  statusBox.textContent = message;
  statusBox.dataset.tone = tone;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return escapeHtml(value);
  }

  return numeric.toLocaleString(undefined, {
    maximumFractionDigits: digits,
  });
}

function formatMetadataValue(key, value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  if (typeof value === "number") {
    const digits = ["Area", "Slope", "CenLat", "CenLon"].includes(key) ? 2 : 0;
    return formatNumber(value, digits);
  }

  return escapeHtml(value);
}

function getFeatureId(feature) {
  const fallback = feature.properties.fid ?? feature.properties.RGIId ?? feature.properties.GLIMSId;
  return String(fallback);
}

function getCurrentScenario() {
  return datasetState.scenarios.find((scenario) => scenario.key === scenarioSelect.value);
}

function classifyYearValue(normalized) {
  if (!normalized || normalized.kind === "missing") {
    return { color: YEAR_STYLE.missing, label: "Missing extinction year" };
  }

  if (normalized.kind === "survives") {
    return { color: YEAR_STYLE.survives, label: "Survives beyond study horizon" };
  }

  if (normalized.kind === "alreadyExtinct") {
    return { color: YEAR_STYLE.alreadyExtinct, label: `Already extinct by ${CURRENT_YEAR}` };
  }

  const binIndex = datasetState.legendBins.findIndex(
    (bin) => normalized.numeric >= bin.min && normalized.numeric <= bin.max
  );

  const color =
    YEAR_STYLE.ramp[Math.max(0, Math.min(YEAR_STYLE.ramp.length - 1, binIndex))] ??
    YEAR_STYLE.ramp[YEAR_STYLE.ramp.length - 1];

  return { color, label: normalized.label };
}

function styleFeature(feature) {
  const scenario = getCurrentScenario();
  const normalized = feature.properties.__scenarioValues[scenario.key];
  const classification = classifyYearValue(normalized);
  const isSelected = selectedFeatureId === getFeatureId(feature);

  return {
    color: isSelected ? YEAR_STYLE.selected : YEAR_STYLE.outline,
    weight: isSelected ? 2.4 : 1.1,
    fillColor: classification.color,
    fillOpacity: (isSelected ? 0.88 : 0.7) * overlayOpacity,
    opacity: (isSelected ? 1 : 0.9) * Math.max(overlayOpacity, 0.35),
  };
}

function applyHoverStyle(layer) {
  layer.setStyle({
    weight: 2.8,
    color: YEAR_STYLE.hover,
    fillOpacity: 0.95 * overlayOpacity,
  });
  layer.bringToFront();
}

function restoreLayerStyle(layer) {
  layer.setStyle(styleFeature(layer.feature));
}

function buildScenarioTable(feature, activeScenario) {
  const rows = datasetState.scenarios
    .map((scenario) => {
      const values = Object.entries(scenario.fields)
        .map(([statName]) => {
          const normalized = feature.properties.__scenarioValues[`${scenario.key}:${statName}`];
          const value = normalized?.label ?? "—";
          const label = statName === "median" ? "Median" : statName;
          return `<span><strong>${label}:</strong> ${escapeHtml(value)}</span>`;
        })
        .join("");

      return `
        <tr class="${scenario.key === activeScenario.key ? "active-row" : ""}">
          <th scope="row">${escapeHtml(scenario.label)}</th>
          <td>${values}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table class="popup-table">
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Extinction years</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildMetadataTable(feature) {
  const fields = METADATA_FIELD_PRIORITY.filter((field) => feature.properties[field] !== undefined);
  const rows = fields
    .map((field) => {
      const label = METADATA_FIELD_LABELS[field] ?? field;
      const value = formatMetadataValue(field, feature.properties[field]);
      return `<tr><th scope="row">${escapeHtml(label)}</th><td>${value}</td></tr>`;
    })
    .join("");

  if (!rows) {
    return "";
  }

  return `
    <details class="popup-details">
      <summary>Metadata</summary>
      <table class="popup-table metadata-table">
        <tbody>${rows}</tbody>
      </table>
    </details>
  `;
}

function buildPopupContent(feature) {
  const activeScenario = getCurrentScenario();
  const primaryLabel =
    feature.properties.Name || feature.properties.RGIId || feature.properties.GLIMSId || "Unnamed glacier";
  const activeValue = feature.properties.__scenarioValues[activeScenario.key];

  return `
    <div class="popup-content">
      <p class="popup-kicker">Active styling scenario</p>
      <h3>${escapeHtml(primaryLabel)}</h3>
      <p class="popup-highlight">
        ${escapeHtml(activeScenario.label)}: <strong>${escapeHtml(activeValue?.label ?? "Missing")}</strong>
      </p>
      <p class="popup-note">
        The map coloring currently follows <strong>${escapeHtml(activeScenario.label)}</strong>.
      </p>
      ${buildScenarioTable(feature, activeScenario)}
      ${buildMetadataTable(feature)}
    </div>
  `;
}

function buildTooltipContent(feature) {
  const activeScenario = getCurrentScenario();
  const title = feature.properties.Name || feature.properties.RGIId || feature.properties.GLIMSId || "Glacier";
  const value = feature.properties.__scenarioValues[activeScenario.key];

  return `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(activeScenario.label)}: ${escapeHtml(
    value?.label ?? "Missing"
  )}`;
}

function updateLegend() {
  const scenario = getCurrentScenario();
  activeScenarioChip.textContent = scenario.label;

  const items = datasetState.legendBins
    .map((bin, index) => {
      const color = YEAR_STYLE.ramp[Math.min(index, YEAR_STYLE.ramp.length - 1)];
      return `
        <div class="legend-item">
          <span class="legend-swatch" style="background:${color}"></span>
          <span>${bin.min}–${bin.max}</span>
        </div>
      `;
    })
    .join("");

  legendContainer.innerHTML = `
    <p class="panel-copy legend-copy">
      Earlier extinction years are shown with warmer colors. Later extinction years fade cooler and lighter.
    </p>
    <div class="legend-item">
      <span class="legend-swatch" style="background:${YEAR_STYLE.alreadyExtinct}"></span>
      <span>Already extinct before ${CURRENT_YEAR}</span>
    </div>
    ${items}
    <div class="legend-item">
      <span class="legend-swatch" style="background:${YEAR_STYLE.survives}"></span>
      <span>Survives beyond study horizon</span>
    </div>
    <div class="legend-item">
      <span class="legend-swatch" style="background:${YEAR_STYLE.missing}"></span>
      <span>Missing value</span>
    </div>
  `;
}

function updateScenarioStats() {
  const scenario = getCurrentScenario();
  let valid = 0;
  let survives = 0;

  for (const feature of datasetState.featureCollection.features) {
    const normalized = feature.properties.__scenarioValues[scenario.key];
    if (normalized?.kind === "year" || normalized?.kind === "alreadyExtinct") {
      valid += 1;
    } else if (normalized?.kind === "survives") {
      survives += 1;
    }
  }

  scenarioStats.textContent = `${valid.toLocaleString()} of ${datasetState.featureCollection.features.length.toLocaleString()} glaciers have a usable extinction year for ${scenario.label}. ${survives.toLocaleString()} are marked as surviving beyond the study horizon.`;
}

function updateDatasetSummary() {
  const summaryEntries = [
    ["Features", datasetState.featureCollection.features.length.toLocaleString()],
    ["Geometry column", datasetState.geometryField],
    ["Scenario fields", datasetState.scenarios.map((scenario) => scenario.styleField).join(", ")],
    ["Primary ID field", datasetState.primaryIdField ?? "None detected"],
  ];

  datasetSummary.innerHTML = summaryEntries
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
}

function updateLayerStyles() {
  if (!glacierLayer) {
    return;
  }

  glacierLayer.eachLayer((layer) => {
    restoreLayerStyle(layer);
    layer.setTooltipContent(buildTooltipContent(layer.feature));
    if (layer.isPopupOpen()) {
      layer.setPopupContent(buildPopupContent(layer.feature));
    }
  });
}

function updateOverlayState() {
  overlayOpacityValue.textContent = `${Math.round(overlayOpacity * 100)}%`;

  if (!glacierLayer) {
    return;
  }

  if (overlayVisible) {
    if (!map.hasLayer(glacierLayer)) {
      glacierLayer.addTo(map);
    }
    updateLayerStyles();
  } else if (map.hasLayer(glacierLayer)) {
    map.removeLayer(glacierLayer);
    selectedLayer = null;
    selectedFeatureId = null;
  }
}

function zoomToFeature(feature) {
  const matchLayer = glacierLayer
    .getLayers()
    .find((layer) => getFeatureId(layer.feature) === getFeatureId(feature));

  if (!matchLayer) {
    return;
  }

  selectedFeatureId = getFeatureId(feature);
  selectedLayer = matchLayer;
  updateLayerStyles();
  map.fitBounds(matchLayer.getBounds(), { maxZoom: 12, padding: [30, 30] });
  matchLayer.openPopup();
}

function wireLayerInteractions(layer) {
  layer.bindTooltip(buildTooltipContent(layer.feature), {
    direction: "top",
    sticky: true,
    opacity: 0.95,
  });

  layer.on("mouseover", () => applyHoverStyle(layer));
  layer.on("mouseout", () => restoreLayerStyle(layer));
  layer.on("click", () => {
    selectedFeatureId = getFeatureId(layer.feature);
    selectedLayer = layer;
    updateLayerStyles();
    layer.setPopupContent(buildPopupContent(layer.feature));
  });
  layer.on("popupclose", () => {
    if (selectedLayer === layer) {
      selectedLayer = null;
      selectedFeatureId = null;
      updateLayerStyles();
    }
  });
}

function initializeSearch() {
  if (!datasetState.primarySearchField) {
    searchSection.hidden = true;
    return;
  }

  function runSearch() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      searchStatus.textContent = "";
      return;
    }

    const feature = datasetState.featureCollection.features.find((candidate) =>
      datasetState.searchFields.some((field) =>
        String(candidate.properties[field] ?? "")
          .toLowerCase()
          .includes(query)
      )
    );

    if (!feature) {
      searchStatus.textContent = `No glacier matched "${query}".`;
      return;
    }

    searchStatus.textContent = "";
    zoomToFeature(feature);
  }

  searchButton.addEventListener("click", runSearch);
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      runSearch();
    }
  });
}

function initializePanelToggle() {
  panelToggleButton.addEventListener("click", () => {
    const collapsed = controlPanel.classList.toggle("is-collapsed");
    panelToggleButton.textContent = collapsed ? "Expand" : "Collapse";
    panelToggleButton.setAttribute("aria-expanded", String(!collapsed));
  });
}

async function bootstrap() {
  setStatus("Loading glacier geometries...");

  const result = await loadDataset();
  datasetState = {
    ...result,
    scenarios: result.scenarioDefinitions,
    searchFields: ["Name", "RGIId", "GLIMSId"].filter((field) => result.columns.includes(field)),
  };

  datasetState.scenarios.forEach((scenario) => {
    const option = document.createElement("option");
    option.value = scenario.key;
    option.textContent = scenario.label;
    scenarioSelect.append(option);
  });

  scenarioSelect.value =
    datasetState.scenarios.find((scenario) => scenario.code === DEFAULT_SCENARIO_CODE)?.key ??
    datasetState.scenarios[0].key;

  glacierLayer = L.geoJSON(datasetState.featureCollection, {
    style: styleFeature,
    onEachFeature(feature, layer) {
      layer.bindPopup(buildPopupContent(feature), {
        maxWidth: 360,
        minWidth: 260,
      });
      wireLayerInteractions(layer);
    },
  }).addTo(map);

  defaultBounds = glacierLayer.getBounds();
  if (defaultBounds.isValid()) {
    map.fitBounds(defaultBounds, { padding: [24, 24] });
  } else {
    map.setView([46.8, 8.2], 8);
  }

  scenarioSelect.addEventListener("change", () => {
    updateLegend();
    updateScenarioStats();
    updateLayerStyles();
  });

  overlayVisibleInput.addEventListener("change", () => {
    overlayVisible = overlayVisibleInput.checked;
    updateOverlayState();
  });

  overlayOpacityInput.addEventListener("input", () => {
    overlayOpacity = Number(overlayOpacityInput.value) / 100;
    updateOverlayState();
  });

  resetViewButton.addEventListener("click", () => {
    if (defaultBounds?.isValid()) {
      map.fitBounds(defaultBounds, { padding: [24, 24] });
    }
  });

  initializePanelToggle();
  updateLegend();
  updateScenarioStats();
  updateDatasetSummary();
  initializeSearch();
  updateOverlayState();
  setStatus("Loaded Swiss glacier geometries.", "success");
}

bootstrap().catch((error) => {
  console.error(error);
  setStatus(error.message, "error");
});
