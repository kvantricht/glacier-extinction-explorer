import {
  CURRENT_YEAR,
  DETAIL_POLYGON_ZOOM,
  METADATA_FIELD_LABELS,
  METADATA_FIELD_PRIORITY,
  STUDY_HORIZON_YEAR,
  YEAR_STYLE,
} from "./config.js?v=7";
import { loadDataset } from "./data.js?v=11";

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

let statusBox = document.querySelector("#status-box");
let statusMessage = document.querySelector("#status-message");
const scenarioSelect = document.querySelector("#scenario-select");
const scenarioStats = document.querySelector("#scenario-stats");
const legendContainer = document.querySelector("#legend");
const activeScenarioChip = document.querySelector("#active-scenario-chip");
const resetViewButton = document.querySelector("#reset-view-button");
const panelToggleButton = document.querySelector("#panel-toggle-button");
const controlPanel = document.querySelector("#control-panel");
const searchSection = document.querySelector("#search-section");
const searchInput = document.querySelector("#search-input");
const searchResults = document.querySelector("#search-results");
const searchStatus = document.querySelector("#search-status");
const overlayVisibleInput = document.querySelector("#overlay-visible-input");
const overlayOpacityInput = document.querySelector("#overlay-opacity-input");
const overlayOpacityValue = document.querySelector("#overlay-opacity-value");

let datasetState = null;
let glacierLayer = null;
let glacierPointLayer = null;
let selectedLayer = null;
let selectedFeatureId = null;
let defaultBounds = null;
let overlayVisible = true;
let overlayOpacity = Number(overlayOpacityInput.value) / 100;
const DEFAULT_SCENARIO_CODE = "27";

function removeLegacyDatasetSection() {
  const datasetSummary = document.querySelector("#dataset-summary");
  if (datasetSummary) {
    datasetSummary.closest("section")?.remove();
  }

  for (const heading of document.querySelectorAll(".control-panel h2")) {
    if (heading.textContent?.trim() === "Dataset") {
      heading.closest("section")?.remove();
    }
  }
}

function ensureStatusOverlay() {
  removeLegacyDatasetSection();

  const legacyStatusSection =
    statusBox?.closest(".control-panel") && statusBox.tagName === "SECTION" ? statusBox : null;
  if (legacyStatusSection) {
    legacyStatusSection.remove();
    statusBox = null;
    statusMessage = null;
  }

  if (!statusBox || !statusMessage) {
    statusBox = document.createElement("div");
    statusBox.id = "status-box";
    statusBox.className = "loading-overlay";
    statusBox.setAttribute("aria-live", "polite");
    statusBox.hidden = true;
    statusBox.innerHTML = `
      <div class="loading-card">
        <div class="loading-spinner" aria-hidden="true"></div>
        <p id="status-message" class="loading-message"></p>
      </div>
    `;
    document.querySelector("#app-shell")?.append(statusBox);
    statusMessage = statusBox.querySelector("#status-message");
  }
}

function setStatus(message, tone = "default") {
  ensureStatusOverlay();
  statusBox.hidden = false;
  statusMessage.textContent = message;
  statusBox.dataset.tone = tone;
}

function clearStatus() {
  ensureStatusOverlay();
  statusBox.hidden = true;
  statusMessage.textContent = "";
  delete statusBox.dataset.tone;
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

function interpolateHexColor(startHex, endHex, ratio) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const start = startHex.match(/[0-9a-f]{2}/gi).map((part) => Number.parseInt(part, 16));
  const end = endHex.match(/[0-9a-f]{2}/gi).map((part) => Number.parseInt(part, 16));
  const channels = start.map((value, index) =>
    Math.round(value + (end[index] - value) * clamped)
      .toString(16)
      .padStart(2, "0")
  );
  return `#${channels.join("")}`;
}

function getYearColor(year) {
  const extent = datasetState.yearExtent;
  if (!extent || extent.max <= extent.min) {
    return YEAR_STYLE.ramp[Math.floor(YEAR_STYLE.ramp.length / 2)];
  }

  const segmentCount = YEAR_STYLE.ramp.length - 1;
  const position = ((year - extent.min) / (extent.max - extent.min)) * segmentCount;
  const leftIndex = Math.max(0, Math.min(segmentCount - 1, Math.floor(position)));
  const localRatio = position - leftIndex;
  return interpolateHexColor(YEAR_STYLE.ramp[leftIndex], YEAR_STYLE.ramp[leftIndex + 1], localRatio);
}

function getPointRadius(feature, isSelected = false) {
  const area = Number(feature.properties.Area);
  const minRadius = 2.5;
  const maxRadius = 20;

  if (!Number.isFinite(area) || area <= 0) {
    return isSelected ? minRadius + 2 : minRadius;
  }

  const areaExtent = datasetState?.areaExtent;
  if (!areaExtent || areaExtent.max <= areaExtent.min) {
    return isSelected ? 8.5 : 6.5;
  }

  const normalized =
    (Math.log(area) - Math.log(areaExtent.min)) /
    (Math.log(areaExtent.max) - Math.log(areaExtent.min));
  const radius = minRadius + Math.max(0, Math.min(1, normalized)) * (maxRadius - minRadius);
  return isSelected ? radius + 2.5 : radius;
}

function classifyYearValue(normalized) {
  if (!normalized || normalized.kind === "missing") {
    return { color: YEAR_STYLE.survives, label: "Survives beyond 2100" };
  }

  if (normalized.kind === "survives") {
    return { color: YEAR_STYLE.survives, label: "Survives beyond 2100" };
  }

  if (normalized.kind === "alreadyExtinct") {
    return { color: YEAR_STYLE.alreadyExtinct, label: "Already extinct" };
  }

  return { color: getYearColor(normalized.numeric), label: normalized.label };
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
    fillOpacity: overlayOpacity,
    opacity: overlayOpacity,
  };
}

function stylePointFeature(feature) {
  const scenario = getCurrentScenario();
  const normalized = feature.properties.__scenarioValues[scenario.key];
  const classification = classifyYearValue(normalized);
  const isSelected = selectedFeatureId === getFeatureId(feature);
  const outlineColor = isSelected ? YEAR_STYLE.selected : classification.color;
  const radius = getPointRadius(feature, isSelected);

  return {
    radius,
    color: outlineColor,
    weight: isSelected ? 2.4 : 1.4,
    fillColor: classification.color,
    fillOpacity: overlayOpacity,
    opacity: overlayOpacity,
  };
}

function applyHoverStyle(layer) {
  const hoverStyle =
    layer.__displayKind === "point"
      ? {
          radius: getPointRadius(layer.feature, true),
          weight: 2.6,
          color: YEAR_STYLE.hover,
          fillOpacity: overlayOpacity,
        }
      : {
          weight: 2.8,
          color: YEAR_STYLE.hover,
          fillOpacity: overlayOpacity,
        };

  layer.setStyle(hoverStyle);
  layer.bringToFront();
}

function restoreLayerStyle(layer) {
  const style = layer.__displayKind === "point" ? stylePointFeature(layer.feature) : styleFeature(layer.feature);
  layer.setStyle(style);
}

function getFeatureCenter(feature) {
  const latitude = Number(feature.properties.DisplayLat ?? feature.properties.CenLat);
  const longitude = Number(feature.properties.DisplayLon ?? feature.properties.CenLon);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return L.latLng(latitude, longitude);
  }
  return null;
}

function computeAreaExtent(features) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const feature of features) {
    const area = Number(feature.properties.Area);
    if (Number.isFinite(area) && area > 0) {
      min = Math.min(min, area);
      max = Math.max(max, area);
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  return { min, max };
}

function getFeatureArea(feature) {
  const area = Number(feature.properties.Area);
  return Number.isFinite(area) && area > 0 ? area : 0;
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
  const scenarioLines = datasetState.scenarios
    .map((scenario) => {
      const value = feature.properties.__scenarioValues[scenario.key];
      const line = `${escapeHtml(scenario.label)}: ${escapeHtml(value?.label ?? "Missing")}`;
      return scenario.key === activeScenario.key ? `<strong>${line}</strong>` : line;
    })
    .join("<br>");

  return `<strong>${escapeHtml(title)}</strong><br>${scenarioLines}`;
}

function updateLegend() {
  const scenario = getCurrentScenario();
  activeScenarioChip.textContent = scenario.label;

  const items = datasetState.legendBins
    .map((bin) => {
      const color = getYearColor(Math.round((bin.min + bin.max) / 2));
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
      <span>Already extinct</span>
    </div>
    ${items}
    <div class="legend-item">
      <span class="legend-swatch" style="background:${YEAR_STYLE.survives}"></span>
      <span>Survives through ${STUDY_HORIZON_YEAR}</span>
    </div>
  `;
}

function updateScenarioStats() {
  const scenario = getCurrentScenario();
  let disappearsBeforeHorizon = 0;
  let survives = 0;

  for (const feature of datasetState.featureCollection.features) {
    const normalized = feature.properties.__scenarioValues[scenario.key];
    if (normalized?.kind === "year" || normalized?.kind === "alreadyExtinct") {
      disappearsBeforeHorizon += 1;
    } else if (normalized?.kind === "survives") {
      survives += 1;
    }
  }

  scenarioStats.textContent = `${disappearsBeforeHorizon.toLocaleString()} glaciers disappear before ${STUDY_HORIZON_YEAR} under ${scenario.label}, while ${survives.toLocaleString()} survive through ${STUDY_HORIZON_YEAR}.`;
}

function updateLayerStyles() {
  if (!glacierLayer && !glacierPointLayer) {
    return;
  }

  [glacierLayer, glacierPointLayer].filter(Boolean).forEach((mapLayer) => {
    mapLayer.eachLayer((layer) => {
      restoreLayerStyle(layer);
      if (layer.getTooltip?.()) {
        layer.setTooltipContent(buildTooltipContent(layer.feature));
      }
      if (layer.isPopupOpen() && layer.getPopup?.()) {
        layer.setPopupContent(buildPopupContent(layer.feature));
      }
    });
  });
}

function shouldShowPolygons() {
  return map.getZoom() >= DETAIL_POLYGON_ZOOM;
}

function createPolygonLayer() {
  return L.geoJSON(datasetState.featureCollection, {
    style: styleFeature,
    onEachFeature(feature, layer) {
      wireLayerInteractions(layer, "polygon");
    },
  });
}

function ensurePolygonLayer() {
  if (!glacierLayer && datasetState?.featureCollection) {
    glacierLayer = createPolygonLayer();
  }
  return glacierLayer;
}

function getActiveGlacierLayer() {
  return shouldShowPolygons() ? ensurePolygonLayer() : glacierPointLayer;
}

function updateDisplayedGeometryLayer() {
  if (!glacierPointLayer) {
    return;
  }

  const activeLayer = getActiveGlacierLayer();
  const inactiveLayer = activeLayer === glacierLayer ? glacierPointLayer : glacierLayer;
  if (!activeLayer) {
    return;
  }

  if (!overlayVisible) {
    if (glacierLayer && map.hasLayer(glacierLayer)) {
      map.removeLayer(glacierLayer);
    }
    if (glacierPointLayer && map.hasLayer(glacierPointLayer)) {
      map.removeLayer(glacierPointLayer);
    }
    selectedLayer = null;
    return;
  }

  if (!map.hasLayer(activeLayer)) {
    activeLayer.addTo(map);
  }
  if (inactiveLayer && map.hasLayer(inactiveLayer)) {
    map.removeLayer(inactiveLayer);
  }

  updateLayerStyles();
}

function updateOverlayState() {
  overlayOpacityValue.textContent = `${Math.round(overlayOpacity * 100)}%`;

  if (!glacierPointLayer) {
    return;
  }

  if (!overlayVisible) {
    selectedLayer = null;
    selectedFeatureId = null;
  }

  updateDisplayedGeometryLayer();
}

function zoomToFeature(feature) {
  const polygonLayer = ensurePolygonLayer()
    ?.getLayers()
    .find((layer) => getFeatureId(layer.feature) === getFeatureId(feature));
  const activeLayer = getActiveGlacierLayer();
  const matchLayer = activeLayer
    ?.getLayers()
    .find((layer) => getFeatureId(layer.feature) === getFeatureId(feature));

  if (!polygonLayer) {
    return;
  }

  selectedFeatureId = getFeatureId(feature);
  selectedLayer = matchLayer ?? polygonLayer;
  updateLayerStyles();
  map.fitBounds(polygonLayer.getBounds(), { maxZoom: 12, padding: [30, 30] });

  map.once("moveend", () => {
    updateDisplayedGeometryLayer();
    const targetLayer = getActiveGlacierLayer()
      ?.getLayers()
      .find((layer) => getFeatureId(layer.feature) === getFeatureId(feature));
    ensureLayerPopup(targetLayer);
    targetLayer?.openPopup();
  });
}

function ensureLayerTooltip(layer) {
  if (!layer || layer.getTooltip?.()) {
    return;
  }

  layer.bindTooltip(buildTooltipContent(layer.feature), {
    direction: "top",
    sticky: true,
    opacity: 0.95,
  });
}

function ensureLayerPopup(layer) {
  if (!layer || layer.getPopup?.()) {
    return;
  }

  layer.bindPopup(buildPopupContent(layer.feature), {
    maxWidth: 360,
    minWidth: 260,
  });
}

function wireLayerInteractions(layer, displayKind = "polygon") {
  layer.__displayKind = displayKind;

  layer.on("mouseover", () => {
    ensureLayerTooltip(layer);
    applyHoverStyle(layer);
  });
  layer.on("mouseout", () => restoreLayerStyle(layer));
  layer.on("click", () => {
    ensureLayerPopup(layer);
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

  let activeResultIndex = -1;
  let currentResults = [];

  function getSearchLabel(feature) {
    return feature.properties.Name || feature.properties.RGIId || feature.properties.GLIMSId || "Unnamed glacier";
  }

  function getSearchMeta(feature) {
    return [feature.properties.RGIId, feature.properties.GLIMSId].filter(Boolean).join(" • ");
  }

  function rankFeatureMatch(feature, query) {
    let bestScore = Number.POSITIVE_INFINITY;

    for (const field of datasetState.searchFields) {
      const raw = String(feature.properties[field] ?? "").trim();
      if (!raw) {
        continue;
      }

      const value = raw.toLowerCase();
      const index = value.indexOf(query);
      if (index === -1) {
        continue;
      }

      const score =
        index === 0 ? 0 :
        value.includes(` ${query}`) ? 1 :
        2 + index;
      bestScore = Math.min(bestScore, score);
    }

    return Number.isFinite(bestScore) ? bestScore : null;
  }

  function hideResults() {
    searchResults.hidden = true;
    searchResults.innerHTML = "";
    activeResultIndex = -1;
  }

  function applySearchResult(feature) {
    searchInput.value = getSearchLabel(feature);
    searchStatus.textContent = "";
    hideResults();
    zoomToFeature(feature);
  }

  function renderResults(results) {
    currentResults = results;
    activeResultIndex = -1;

    if (!results.length) {
      hideResults();
      return;
    }

    searchResults.hidden = false;
    searchResults.innerHTML = results
      .map((feature, index) => {
        const title = escapeHtml(getSearchLabel(feature));
        const meta = escapeHtml(getSearchMeta(feature));
        return `
          <button class="search-result" type="button" data-index="${index}">
            <span class="search-result-title">${title}</span>
            ${meta ? `<span class="search-result-meta">${meta}</span>` : ""}
          </button>
        `;
      })
      .join("");

    searchResults.querySelectorAll(".search-result").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.index);
        applySearchResult(results[index]);
      });
    });
  }

  function updateActiveResult() {
    searchResults.querySelectorAll(".search-result").forEach((button, index) => {
      button.classList.toggle("is-active", index === activeResultIndex);
    });
  }

  function runSearch() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      searchStatus.textContent = "";
      currentResults = [];
      hideResults();
      return;
    }

    const matches = datasetState.featureCollection.features
      .map((feature) => ({
        feature,
        score: rankFeatureMatch(feature, query),
      }))
      .filter((entry) => entry.score !== null)
      .sort((left, right) => left.score - right.score || getSearchLabel(left.feature).localeCompare(getSearchLabel(right.feature)))
      .slice(0, 8)
      .map((entry) => entry.feature);

    if (!matches.length) {
      currentResults = [];
      hideResults();
      searchStatus.textContent = `No glacier matched "${query}".`;
      return;
    }

    searchStatus.textContent = "";
    renderResults(matches);
  }

  searchInput.addEventListener("input", runSearch);
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && currentResults.length) {
      event.preventDefault();
      activeResultIndex = Math.min(activeResultIndex + 1, currentResults.length - 1);
      updateActiveResult();
      return;
    }

    if (event.key === "ArrowUp" && currentResults.length) {
      event.preventDefault();
      activeResultIndex = Math.max(activeResultIndex - 1, 0);
      updateActiveResult();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (activeResultIndex >= 0 && currentResults[activeResultIndex]) {
        applySearchResult(currentResults[activeResultIndex]);
      } else if (currentResults[0]) {
        applySearchResult(currentResults[0]);
      } else {
        runSearch();
      }
    }

    if (event.key === "Escape") {
      hideResults();
    }
  });

  searchInput.addEventListener("focus", () => {
    if (currentResults.length) {
      searchResults.hidden = false;
    }
  });

  document.addEventListener("click", (event) => {
    if (!searchSection.contains(event.target)) {
      hideResults();
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
  ensureStatusOverlay();
  setStatus("Loading glaciers", "loading");

  const result = await loadDataset();
  datasetState = {
    ...result,
    scenarios: result.scenarioDefinitions,
    searchFields: ["Name", "RGIId", "GLIMSId"].filter((field) => result.columns.includes(field)),
    areaExtent: computeAreaExtent(result.featureCollection.features),
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

  glacierPointLayer = L.featureGroup(
    [...datasetState.featureCollection.features]
      .sort((left, right) => getFeatureArea(left) - getFeatureArea(right))
      .map((feature) => {
      const center = getFeatureCenter(feature);
      if (!center) {
        return null;
      }
      const marker = L.circleMarker(center, stylePointFeature(feature));
      marker.feature = feature;
      wireLayerInteractions(marker, "point");
      return marker;
    }).filter(Boolean)
  );

  defaultBounds = glacierPointLayer.getBounds();
  if (defaultBounds.isValid()) {
    map.fitBounds(defaultBounds, { padding: [24, 24] });
  } else {
    map.setView([46.8, 8.2], 8);
  }

  updateDisplayedGeometryLayer();

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

  map.on("zoomend", updateDisplayedGeometryLayer);

  initializePanelToggle();
  updateLegend();
  updateScenarioStats();
  initializeSearch();
  updateOverlayState();
  clearStatus();
}

bootstrap().catch((error) => {
  console.error(error);
  setStatus(error.message, "error");
});
