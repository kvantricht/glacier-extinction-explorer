/**
 * main.js – MapLibre GL JS frontend for the Glacier Extinction Explorer.
 *
 * Data architecture:
 *   - Vector tiles served from PMTiles files (glaciers_points + glaciers_polygons)
 *   - Points layer visible at zoom < DETAIL_POLYGON_ZOOM (overview)
 *   - Polygons layer visible at zoom >= DETAIL_POLYGON_ZOOM (detail)
 *   - Search driven by a pre-built search_index.json
 *   - Scenario/extent metadata from build_metadata.json
 */

import {
    BUILD_METADATA_URL,
    CURRENT_YEAR,
    DEFAULT_SCENARIO_CODE,
    DETAIL_POLYGON_ZOOM,
    EXTINCT_SENTINEL,
    POINTS_PMTILES_URL,
    POINTS_SOURCE_LAYER,
    POLYGONS_PMTILES_URL,
    POLYGONS_SOURCE_LAYER,
    SEARCH_INDEX_URL,
    STUDY_HORIZON_YEAR,
    SURVIVES_SENTINEL,
    VERSION_URL,
    YEAR_STYLE,
    escapeHtml,
    formatNumber,
} from "./config.js";

import { BASEMAP_GLYPHS_URL, basemapLabelsSource, createBasemapLabelLayers } from "./basemap-labels.js";

// ---------------------------------------------------------------------------
// PMTiles protocol registration (with retry on network error)
// ---------------------------------------------------------------------------

const protocol = new pmtiles.Protocol();

const MAX_TILE_RETRIES = 3;
const TILE_RETRY_BASE_MS = 1000;

function tileWithRetry(params, abortController) {
    const attempt = (retriesLeft, delay) =>
        protocol.tile(params, abortController).catch((err) => {
            // Only retry on network-level failures (ERR_TIMED_OUT, ERR_NETWORK_CHANGED, etc.)
            // Do not retry if the request was intentionally aborted.
            if (retriesLeft <= 0 || abortController?.signal?.aborted) throw err;
            if (!(err instanceof TypeError)) throw err;
            return new Promise((resolve, reject) => {
                setTimeout(() => attempt(retriesLeft - 1, delay * 2).then(resolve, reject), delay);
            });
        });
    return attempt(MAX_TILE_RETRIES, TILE_RETRY_BASE_MS);
}

maplibregl.addProtocol("pmtiles", tileWithRetry);

// ---------------------------------------------------------------------------
// Map initialisation
// ---------------------------------------------------------------------------

const map = new maplibregl.Map({
    container: "map",
    attributionControl: false,
    style: {
        version: 8,
        glyphs: BASEMAP_GLYPHS_URL,
        sources: {
            satellite: {
                type: "raster",
                tiles: [
                    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                ],
                tileSize: 256,
                attribution:
                    "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community | Glacier data: <a href='https://doi.org/10.1038/s41558-025-02513-9' target='_blank' rel='noopener'>Van Tricht et al. (2026)</a>",
                maxzoom: 19,
            },
            "basemap-labels": basemapLabelsSource,
        },
        layers: [
            { id: "satellite", type: "raster", source: "satellite" },
            ...createBasemapLabelLayers(),
        ],
    },
    center: [0, 20],
    zoom: 2,
    maxZoom: 18,
    maxPitch: 70,
});

const TERRAIN_ON_PITCH_DEGREES = 42;
const TERRAIN_OFF_PITCH_DEGREES = 0;
const TERRAIN_CAMERA_ANIMATION_MS = 500;

map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const statusBox = document.querySelector("#status-box");
const statusMessage = document.querySelector("#status-message");
const statusDismiss = document.querySelector("#status-dismiss");

statusDismiss.addEventListener("click", clearStatus);
const scenarioSelect = document.querySelector("#scenario-select");
const scenarioStats = document.querySelector("#scenario-stats");
const legendContainer = document.querySelector("#legend");
const activeScenarioChip = document.querySelector("#active-scenario-chip");
const resetViewButton = document.querySelector("#reset-view-button");
const bboxZoomButton = document.querySelector("#bbox-zoom-button");
const terrainButton = document.querySelector("#terrain-button");
const terrainHint = document.querySelector("#terrain-hint");
const terrainHintClose = document.querySelector("#terrain-hint-close");
const panelToggleButton = document.querySelector("#panel-toggle-button");
const panelLaunchButton = document.querySelector("#panel-launch-button");
const controlPanel = document.querySelector("#control-panel");
const searchSection = document.querySelector("#search-section");
const searchInput = document.querySelector("#search-input");
const searchResults = document.querySelector("#search-results");
const searchStatus = document.querySelector("#search-status");
const overlayVisibleInput = document.querySelector("#overlay-visible-input");
const basemapLabelsInput = document.querySelector("#basemap-labels-input");
const basemapLabelsAttribution = document.querySelector("#basemap-labels-attribution");
const hoverOutlineInput = document.querySelector("#hover-outline-input");
const hoverMetadataInput = document.querySelector("#hover-metadata-input");
const hoverTooltip = document.querySelector("#hover-tooltip");
const compactLayout = window.matchMedia("(max-width: 840px)");
const navigationGroup = document.querySelector(".maplibregl-ctrl-group");
navigationGroup.append(bboxZoomButton, terrainButton);
bboxZoomButton.setAttribute("aria-pressed", "false");
terrainButton.setAttribute("aria-pressed", "false");

function syncBasemapLabels() {
    basemapLabelsAttribution.hidden = !basemapLabelsInput.checked;
    const layers = createBasemapLabelLayers();
    for (const layer of layers) {
        if (!map.getLayer(layer.id)) continue;
        map.setLayoutProperty(layer.id, "visibility", basemapLabelsInput.checked ? "visible" : "none");
    }
}

basemapLabelsInput.addEventListener("change", syncBasemapLabels);
map.once("load", syncBasemapLabels);
const TERRAIN_HINT_STORAGE_KEY = "glacier-extinction-explorer.terrain-hint-seen";

function hasSeenTerrainHint() {
    try {
        return window.localStorage.getItem(TERRAIN_HINT_STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

function markTerrainHintAsSeen() {
    try {
        window.localStorage.setItem(TERRAIN_HINT_STORAGE_KEY, "true");
    } catch {
        // Storage can be unavailable in private or restricted browsing modes.
    }
}

function dismissTerrainHint() {
    terrainHint.hidden = true;
    terrainHint.removeEventListener("keydown", handleTerrainHintKeydown);
    terrainButton.focus({ preventScroll: true });
}

function handleTerrainHintKeydown(event) {
    if (event.key === "Escape") {
        event.preventDefault();
        dismissTerrainHint();
    }
}

function showTerrainHint() {
    if (compactLayout.matches || hasSeenTerrainHint()) return;

    markTerrainHintAsSeen();
    terrainHint.hidden = false;
    terrainHint.addEventListener("keydown", handleTerrainHintKeydown);
    requestAnimationFrame(() => terrainHintClose.focus({ preventScroll: true }));
}

terrainHintClose.addEventListener("click", dismissTerrainHint);

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

let metadata = null;       // build_metadata.json contents
let searchIndex = [];      // search_index.json contents
let bboxActive = false;    // true while box-zoom drag mode is active
let terrainEnabled = false;
let overlayVisible = true;
const overlayOpacity = 0.75;
let hoverOutlineEnabled = false;
let hoverMetadataEnabled = false;
// True when the current popup was opened by hover; false when opened by click.
let popupOpenedByHover = false;
let activeScenarioKey = null;
let hoveredPointId = null;
let hoveredPolygonId = null;
let selectedFeatureId = null;
let popupProperties = null;
const activePopup = new maplibregl.Popup({
    maxWidth: "400px",
    className: "glacier-popup",
    closeOnClick: false,
});

// ---------------------------------------------------------------------------
// Status overlay
// ---------------------------------------------------------------------------

function setStatus(message, tone = "loading") {
    statusBox.hidden = false;
    statusMessage.textContent = message;
    statusBox.dataset.tone = tone;
    statusDismiss.hidden = tone !== "error";
}

function clearStatus() {
    statusBox.hidden = true;
    statusMessage.textContent = "";
    delete statusBox.dataset.tone;
    statusDismiss.hidden = true;
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

function getScenario(key) {
    return metadata.scenarios.find((s) => s.key === key) ?? metadata.scenarios[0];
}

function getCurrentScenario() {
    return getScenario(activeScenarioKey);
}

// ---------------------------------------------------------------------------
// Year decoding (inverse of build_pmtiles.py sentinel scheme)
// ---------------------------------------------------------------------------

function decodeYearLabel(encoded) {
    if (encoded === null || encoded === undefined) return "Survives";
    if (encoded === SURVIVES_SENTINEL || encoded >= STUDY_HORIZON_YEAR) return "Survives";
    if (encoded === EXTINCT_SENTINEL || encoded < CURRENT_YEAR) return "Already extinct";
    return String(encoded);
}

function decodeYearKind(encoded) {
    if (encoded === null || encoded === undefined) return "survives";
    if (encoded === SURVIVES_SENTINEL || encoded >= STUDY_HORIZON_YEAR) return "survives";
    if (encoded === EXTINCT_SENTINEL || encoded < CURRENT_YEAR) return "alreadyExtinct";
    return "year";
}

// ---------------------------------------------------------------------------
// MapLibre style expression builders
// ---------------------------------------------------------------------------

/**
 * Build a MapLibre GL expression that maps an encoded extinction-year tile
 * field to a fill/circle color.
 */
function buildColorExpression(tileField, yearExtent) {
    const { min, max } = yearExtent;
    const ramp = YEAR_STYLE.ramp;
    const segmentCount = ramp.length - 1;

    // Build interpolation stops
    const stops = [];
    for (let i = 0; i < ramp.length; i++) {
        const year = Math.round(min + ((max - min) * i) / segmentCount);
        stops.push(year, ramp[i]);
    }

    return [
        "case",
        ["==", ["coalesce", ["get", tileField], SURVIVES_SENTINEL], EXTINCT_SENTINEL],
        YEAR_STYLE.alreadyExtinct,
        [">=", ["coalesce", ["get", tileField], SURVIVES_SENTINEL], SURVIVES_SENTINEL],
        YEAR_STYLE.survives,
        ["interpolate", ["linear"], ["get", tileField], ...stops],
    ];
}

/**
 * Build a circle-radius expression that scales by log_area and zoom level.
 */
function buildRadiusExpression(logAreaExtent) {
    const { min, max } = logAreaExtent;
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
    // zoom must be the direct input to the top-level interpolate.
    // Stop output values can themselves be expressions (area-based).
    return [
        "interpolate", ["linear"], ["zoom"],
        0, ["interpolate", ["linear"], ["coalesce", ["get", "log_area"], lo], lo, 2, hi, 6],
        4, ["interpolate", ["linear"], ["coalesce", ["get", "log_area"], lo], lo, 3, hi, 8],
        7, ["interpolate", ["linear"], ["coalesce", ["get", "log_area"], lo], lo, 4, hi, 12],
        10, ["interpolate", ["linear"], ["coalesce", ["get", "log_area"], lo], lo, 6, hi, 18],
    ];
}

function getPointFillOpacity() {
    return Math.min(1, overlayOpacity + 0.08);
}

function getPointStrokeOpacity() {
    return Math.min(0.7, overlayOpacity * 0.65 + 0.05);
}

// ---------------------------------------------------------------------------
// Layer management
// ---------------------------------------------------------------------------

function addGlacierSources() {
    // AWS Open Data terrain tiles (Terrarium encoding, no API key required)
    map.addSource("dem", {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 14,
        encoding: "terrarium",
        attribution: "Terrain &copy; Mapzen, USGS, SRTM",
    });

    map.addSource("glaciers-points", {
        type: "vector",
        url: `pmtiles://${POINTS_PMTILES_URL}`,
        promoteId: { [POINTS_SOURCE_LAYER]: metadata.idField ?? "RGIId" },
    });

    map.addSource("glaciers-polygons", {
        type: "vector",
        url: `pmtiles://${POLYGONS_PMTILES_URL}`,
        promoteId: { [POLYGONS_SOURCE_LAYER]: metadata.idField ?? "RGIId" },
    });
}

function addGlacierLayers() {
    const scenario = getCurrentScenario();
    const colorExpr = buildColorExpression(scenario.styleField, metadata.yearExtent);
    const radiusExpr = buildRadiusExpression(metadata.logAreaExtent);
    const opacityExpr = ["case",
        ["boolean", ["feature-state", "hover"], false], Math.min(1, overlayOpacity + 0.15),
        overlayOpacity,
    ];

    // ----- Circle layer for points -----
    map.addLayer({
        id: "glaciers-points",
        type: "circle",
        source: "glaciers-points",
        "source-layer": POINTS_SOURCE_LAYER,
        maxzoom: DETAIL_POLYGON_ZOOM,
        layout: {
            visibility: overlayVisible ? "visible" : "none",
            // Render larger glaciers on top of smaller ones
            "circle-sort-key": ["coalesce", ["get", "log_area"], 0],
        },
        paint: {
            "circle-color": colorExpr,
            "circle-radius": radiusExpr,
            "circle-opacity": getPointFillOpacity(),
            "circle-stroke-width": [
                "case",
                ["boolean", ["feature-state", "hover"], false], 2.5,
                ["boolean", ["feature-state", "selected"], false], 2.5,
                0.9,
            ],
            "circle-stroke-color": [
                "case",
                ["boolean", ["feature-state", "hover"], false], YEAR_STYLE.hover,
                ["boolean", ["feature-state", "selected"], false], YEAR_STYLE.selected,
                YEAR_STYLE.outline,
            ],
            "circle-stroke-opacity": getPointStrokeOpacity(),
        },
    });

    // ----- Fill layer for polygons -----
    map.addLayer({
        id: "glaciers-polygons-fill",
        type: "fill",
        source: "glaciers-polygons",
        "source-layer": POLYGONS_SOURCE_LAYER,
        minzoom: DETAIL_POLYGON_ZOOM,
        layout: { visibility: overlayVisible ? "visible" : "none" },
        paint: {
            "fill-color": colorExpr,
            "fill-opacity": overlayOpacity,
        },
    });

    // ----- Line layer for polygon outlines -----
    map.addLayer({
        id: "glaciers-polygons-line",
        type: "line",
        source: "glaciers-polygons",
        "source-layer": POLYGONS_SOURCE_LAYER,
        minzoom: DETAIL_POLYGON_ZOOM,
        layout: { visibility: overlayVisible ? "visible" : "none" },
        paint: {
            "line-color": [
                "case",
                ["boolean", ["feature-state", "hover"], false], YEAR_STYLE.hover,
                ["boolean", ["feature-state", "selected"], false], YEAR_STYLE.selected,
                YEAR_STYLE.outline,
            ],
            "line-width": [
                "case",
                ["boolean", ["feature-state", "hover"], false], 2.5,
                ["boolean", ["feature-state", "selected"], false], 2.5,
                1.1,
            ],
            "line-opacity": overlayOpacity,
        },
    });

    // ----- Hover-outline preview (vector tile layer, filtered by hovered ID) -----
    // Rendered directly from the polygon source so MapLibre handles tile-boundary
    // stitching — no clipping artefacts. Hidden by default; filter is updated on
    // point hover. minzoom 9 also forces polygon tile loading below DETAIL_POLYGON_ZOOM.
    map.addLayer({
        id: "hover-outline-line",
        type: "line",
        source: "glaciers-polygons",
        "source-layer": POLYGONS_SOURCE_LAYER,
        minzoom: 9,
        maxzoom: DETAIL_POLYGON_ZOOM,
        filter: ["boolean", false],
        paint: {
            "line-color": "#4db0ff",
            "line-width": 2,
            "line-opacity": 0.85,
        },
    });
}

// ---------------------------------------------------------------------------
// Style update (called when scenario or opacity changes)
// ---------------------------------------------------------------------------

function applyScenarioStyles() {
    if (!map.getLayer("glaciers-points")) return;

    const scenario = getCurrentScenario();
    const colorExpr = buildColorExpression(scenario.styleField, metadata.yearExtent);

    map.setPaintProperty("glaciers-points", "circle-color", colorExpr);
    map.setPaintProperty("glaciers-polygons-fill", "fill-color", colorExpr);
}

function applyOpacityStyles() {
    if (!map.getLayer("glaciers-points")) return;

    map.setPaintProperty("glaciers-points", "circle-opacity", getPointFillOpacity());
    map.setPaintProperty("glaciers-points", "circle-stroke-opacity", getPointStrokeOpacity());
    map.setPaintProperty("glaciers-polygons-fill", "fill-opacity", overlayOpacity);
    map.setPaintProperty("glaciers-polygons-line", "line-opacity", overlayOpacity);
}

function applyVisibility() {
    if (!map.getLayer("glaciers-points")) return;

    const vis = overlayVisible ? "visible" : "none";
    for (const id of ["glaciers-points", "glaciers-polygons-fill", "glaciers-polygons-line"]) {
        map.setLayoutProperty(id, "visibility", vis);
    }

    if (!overlayVisible) {
        clearHoverState();
        activePopup.remove();
        selectedFeatureId = null;
    }
}

// ---------------------------------------------------------------------------
// Feature state helpers
// ---------------------------------------------------------------------------

function setPointHover(id, state) {
    if (id === null) return;
    map.setFeatureState(
        { source: "glaciers-points", sourceLayer: POINTS_SOURCE_LAYER, id },
        { hover: state }
    );
}

function setPolygonHover(id, state) {
    if (id === null) return;
    map.setFeatureState(
        { source: "glaciers-polygons", sourceLayer: POLYGONS_SOURCE_LAYER, id },
        { hover: state }
    );
}

function setPointSelected(id, state) {
    if (id === null) return;
    map.setFeatureState(
        { source: "glaciers-points", sourceLayer: POINTS_SOURCE_LAYER, id },
        { selected: state }
    );
}

function setPolygonSelected(id, state) {
    if (id === null) return;
    map.setFeatureState(
        { source: "glaciers-polygons", sourceLayer: POLYGONS_SOURCE_LAYER, id },
        { selected: state }
    );
}

function clearHoverState() {
    setPointHover(hoveredPointId, false);
    setPolygonHover(hoveredPolygonId, false);
    hoveredPointId = null;
    hoveredPolygonId = null;
}

function clearSelectedState() {
    setPointSelected(selectedFeatureId, false);
    setPolygonSelected(selectedFeatureId, false);
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function buildTooltipHtml(props) {
    const activeScenario = getCurrentScenario();
    const title = props.Name || props.RGIId || props.GLIMSId || "Glacier";

    const rows = metadata.scenarios
        .map((s) => {
            const encoded = props[s.styleField];
            const label = decodeYearLabel(encoded);
            const isActive = s.key === activeScenario.key;
            return `<div class="tt-row${isActive ? " tt-active" : ""}">
        <span class="tt-label">${escapeHtml(s.label)}</span>
        <span class="tt-value">${escapeHtml(label)}</span>
      </div>`;
        })
        .join("");

    return `<strong class="tt-title">${escapeHtml(title)}</strong>${rows}`;
}

function showTooltip(x, y, props) {
    hoverTooltip.innerHTML = buildTooltipHtml(props);
    hoverTooltip.hidden = false;
    positionTooltip(x, y);
}

function positionTooltip(x, y) {
    const tt = hoverTooltip;
    const ttRect = tt.getBoundingClientRect();

    let left = x + 16;
    let top = y - 10;

    // Clamp right edge against viewport
    if (left + ttRect.width > window.innerWidth - 8) {
        left = x - ttRect.width - 16;
    }

    // Clamp bottom edge against legend panel (if visible) or viewport
    const legendEl = document.querySelector("#legend-panel");
    const bottomBound = (legendEl && !legendEl.hidden)
        ? legendEl.getBoundingClientRect().top - 8
        : window.innerHeight - 8;
    if (top + ttRect.height > bottomBound) {
        top = bottomBound - ttRect.height;
    }

    // Clamp to screen edges
    left = Math.max(left, 8);
    top = Math.max(top, 8);

    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
}

function hideTooltip() {
    hoverTooltip.hidden = true;
}

// ---------------------------------------------------------------------------
// Popup content builders
// ---------------------------------------------------------------------------

function formatMetadataValue(key, value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "number") {
        const digits = ["Area", "Slope", "CenLat", "CenLon"].includes(key) ? 2 : 0;
        return formatNumber(value, digits);
    }
    return escapeHtml(String(value));
}

function formatCoordinatePair(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
    const latLabel = `${formatNumber(Math.abs(lat), 2)}°${lat >= 0 ? "N" : "S"}`;
    const lonLabel = `${formatNumber(Math.abs(lon), 2)}°${lon >= 0 ? "E" : "W"}`;
    return `${latLabel}, ${lonLabel}`;
}

function buildScenarioTableHtml(props, activeScenario) {
    const rows = metadata.scenarios
        .map((s) => {
            const field = s.tileFields.median ?? s.styleField;
            const encoded = props[field];
            const label = decodeYearLabel(encoded);

            return `<tr class="${s.key === activeScenario.key ? "active-row" : ""}">
        <th scope="row">${escapeHtml(s.label)}</th>
        <td>${escapeHtml(label)}</td>
      </tr>`;
        })
        .join("");

    return `<table class="popup-table">
    <thead><tr><th>Scenario</th><th>Median extinction year</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildMetadataTableHtml(props) {
    const fieldOrder = metadata.metadataFieldOrder ?? [];
    const fieldLabels = metadata.metadataFields ?? {};
    const rows = fieldOrder
        .filter((f) => !["CenLat", "CenLon"].includes(f))
        .filter((f) => props[f] !== undefined && props[f] !== null)
        .map((f) => {
            const label = fieldLabels[f] ?? f;
            return `<tr><th scope="row">${escapeHtml(label)}</th><td>${formatMetadataValue(f, props[f])}</td></tr>`;
        })
        .join("");

    if (!rows) return "";

    return `<details class="popup-details">
    <summary>Metadata</summary>
    <table class="popup-table metadata-table"><tbody>${rows}</tbody></table>
  </details>`;
}

function buildPopupHtml(props) {
    const activeScenario = getCurrentScenario();
    const title = props.Name || props.RGIId || props.GLIMSId || "Unnamed glacier";
    const activeEncoded = props[activeScenario.styleField];
    const coordinatePair = formatCoordinatePair(props.CenLat, props.CenLon);

    return `<div class="popup-content">
    <p class="popup-kicker">Active styling scenario</p>
    <h3>${escapeHtml(title)}</h3>
        ${coordinatePair ? `<p class="popup-note">${escapeHtml(coordinatePair)}</p>` : ""}
    <p class="popup-highlight">
      ${escapeHtml(activeScenario.label)}: <strong>${escapeHtml(decodeYearLabel(activeEncoded))}</strong>
    </p>
    <p class="popup-note">
      The map coloring currently follows <strong>${escapeHtml(activeScenario.label)}</strong>.
    </p>
    ${buildScenarioTableHtml(props, activeScenario)}
    ${buildMetadataTableHtml(props)}
  </div>`;
}

function showPopupAt(lngLat, props) {
    popupProperties = props;
    clearSelectedState();
    selectedFeatureId = props[metadata.idField ?? "RGIId"] ?? null;
    setPointSelected(selectedFeatureId, true);
    setPolygonSelected(selectedFeatureId, true);

    hideTooltip();

    activePopup
        .setLngLat(lngLat)
        .setHTML(buildPopupHtml(props));
    // Re-adding an open Popup fires its close handler and clears selection.
    if (!activePopup.isOpen()) activePopup.addTo(map);
}

activePopup.on("close", () => {
    clearSelectedState();
    selectedFeatureId = null;
    popupProperties = null;
    popupOpenedByHover = false;
});

// ---------------------------------------------------------------------------
// Hover interactions
// ---------------------------------------------------------------------------

function wireHoverLayer(layerId, sourceId, sourceLayer, setHoverFn, clearHoverVar, setVar) {
    map.on("mousemove", layerId, (e) => {
        if (!overlayVisible || !e.features.length) return;
        if (bboxActive) return;
        map.getCanvas().style.cursor = "pointer";
        const feature = e.features[0];
        const fid = feature.id;

        if (fid !== window[clearHoverVar]) {
            setHoverFn(window[clearHoverVar], false);
            window[clearHoverVar] = fid;
            setHoverFn(fid, true);
        }

        if (!activePopup.isOpen()) {
            showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, feature.properties);
        }
    });

    map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
        setHoverFn(window[clearHoverVar], false);
        window[clearHoverVar] = null;
        hideTooltip();
    });
}

// ---------------------------------------------------------------------------
// Click interactions
// ---------------------------------------------------------------------------

let suppressMapClickUntil = 0;

// Selection is independent of the camera. A small hit area helps with tiny
// glaciers on touchscreens; panning, zooming and empty-map clicks keep it pinned.
map.on("click", (event) => {
    if (!metadata || !overlayVisible || bboxActive || performance.now() < suppressMapClickUntil) return;
    const radius = event.originalEvent.pointerType === "touch" || compactLayout.matches ? 8 : 4;
    const layers = ["glaciers-polygons-fill", "glaciers-points"].filter(id => map.getLayer(id));
    const features = map.queryRenderedFeatures([
        [event.point.x - radius, event.point.y - radius],
        [event.point.x + radius, event.point.y + radius],
    ], { layers });
    const feature = features[0];
    if (!feature) return;
    map.stop();
    popupOpenedByHover = false;
    const anchor = feature.geometry.type === "Point" ? feature.geometry.coordinates : event.lngLat;
    showPopupAt(anchor, feature.properties);
});

// ---------------------------------------------------------------------------
// Mousemove passthrough for tooltip repositioning
// ---------------------------------------------------------------------------

map.on("mousemove", (e) => {
    if (!hoverTooltip.hidden) {
        positionTooltip(e.originalEvent.clientX, e.originalEvent.clientY);
    }
});

// ---------------------------------------------------------------------------
// Legend & scenario stats
// ---------------------------------------------------------------------------

function interpolateHex(start, end, t) {
    const s = start.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16));
    const f = end.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16));
    return "#" + s.map((v, i) => Math.round(v + (f[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

function getYearColor(year, yearExtent) {
    const { min, max } = yearExtent;
    if (max <= min) return YEAR_STYLE.ramp[Math.floor(YEAR_STYLE.ramp.length / 2)];
    const ramp = YEAR_STYLE.ramp;
    const segmentCount = ramp.length - 1;
    const position = ((year - min) / (max - min)) * segmentCount;
    const leftIndex = Math.max(0, Math.min(segmentCount - 1, Math.floor(position)));
    return interpolateHex(ramp[leftIndex], ramp[leftIndex + 1], position - leftIndex);
}

function buildLegendBins(yearExtent) {
    const { min, max } = yearExtent;
    const targetBins = 6;
    const step = Math.max(5, Math.ceil((max - min) / targetBins / 5) * 5);
    const bins = [];
    for (let start = min; start <= max; start += step) {
        bins.push({ min: start, max: Math.min(max, start + step - 1) });
    }
    return bins;
}

function updateLegend() {
    const scenario = getCurrentScenario();
    activeScenarioChip.textContent = scenario.label;

    const bins = buildLegendBins(metadata.yearExtent);
    const items = bins
        .map((bin) => {
            const color = getYearColor(Math.round((bin.min + bin.max) / 2), metadata.yearExtent);
            return `<div class="legend-item">
        <span class="legend-swatch" style="background:${color}"></span>
        <span>${bin.min}–${bin.max}</span>
      </div>`;
        })
        .join("");

    legendContainer.innerHTML = `
    <div class="legend-item">
      <span class="legend-swatch" style="background:${YEAR_STYLE.alreadyExtinct}"></span>
      <span>Already extinct</span>
    </div>
    ${items}
    <div class="legend-item">
      <span class="legend-swatch" style="background:${YEAR_STYLE.survives}"></span>
      <span>Survives through ${STUDY_HORIZON_YEAR}</span>
    </div>`;
}

function updateScenarioStats() {
    // We can't iterate all features from vector tiles, so use precomputed counts
    // from metadata if available, otherwise show a helpful placeholder.
    const stats = metadata.scenarioStats?.[getCurrentScenario().key];
    if (stats) {
        scenarioStats.textContent =
            `${stats.disappear.toLocaleString()} glaciers disappear before ${STUDY_HORIZON_YEAR} ` +
            `under ${getCurrentScenario().label}, while ${stats.survive.toLocaleString()} survive through ${STUDY_HORIZON_YEAR}.`;
    } else {
        scenarioStats.textContent = "";
    }
}

// ---------------------------------------------------------------------------
// Typeahead search
// ---------------------------------------------------------------------------

function initSearch() {
    if (!searchIndex.length) {
        searchSection.hidden = true;
        return;
    }

    let currentResults = [];
    let activeIndex = -1;

    function getLabel(item) {
        return item.name || item.rgi_id || item.glims_id || "Unnamed glacier";
    }

    function getMeta(item) {
        return [item.rgi_id, item.glims_id].filter(Boolean).join(" • ");
    }

    function rankMatch(item, query) {
        let best = Infinity;
        for (const val of [item.name, item.rgi_id, item.glims_id]) {
            if (!val) continue;
            const lower = val.toLowerCase();
            const idx = lower.indexOf(query);
            if (idx === -1) continue;
            const score = idx === 0 ? 0 : lower.includes(` ${query}`) ? 1 : 2 + idx;
            best = Math.min(best, score);
        }
        return Number.isFinite(best) ? best : null;
    }

    function hideResults() {
        searchResults.hidden = true;
        searchResults.innerHTML = "";
        activeIndex = -1;
    }

    function updateActive() {
        searchResults.querySelectorAll(".search-result").forEach((btn, i) => {
            btn.classList.toggle("is-active", i === activeIndex);
            if (i === activeIndex) btn.scrollIntoView({ block: "nearest" });
        });
    }

    function applyResult(item) {
        searchInput.value = getLabel(item);
        searchStatus.textContent = "";
        hideResults();
        zoomToSearchResult(item);
    }

    function runSearch() {
        const query = searchInput.value.trim().toLowerCase();
        if (!query) {
            searchStatus.textContent = "";
            currentResults = [];
            hideResults();
            return;
        }

        const matches = searchIndex
            .map((item) => ({ item, score: rankMatch(item, query) }))
            .filter((e) => e.score !== null)
            .sort(
                (a, b) =>
                    a.score - b.score || getLabel(a.item).localeCompare(getLabel(b.item))
            )
            .slice(0, 5)
            .map((e) => e.item);

        currentResults = matches;
        activeIndex = -1;

        if (!matches.length) {
            hideResults();
            searchStatus.textContent = `No glacier matched "${query}".`;
            return;
        }

        searchStatus.textContent = "";
        searchResults.hidden = false;
        searchResults.innerHTML = matches
            .map(
                (item, i) => `
        <button class="search-result" type="button" data-index="${i}">
          <span class="search-result-title">${escapeHtml(getLabel(item))}</span>
          ${getMeta(item) ? `<span class="search-result-meta">${escapeHtml(getMeta(item))}</span>` : ""}
        </button>`
            )
            .join("");

        searchResults.querySelectorAll(".search-result").forEach((btn) => {
            btn.addEventListener("click", () => applyResult(matches[Number(btn.dataset.index)]));
        });
    }

    searchInput.addEventListener("input", runSearch);

    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" && currentResults.length) {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
            updateActive();
        } else if (e.key === "ArrowUp" && currentResults.length) {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            updateActive();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const target = activeIndex >= 0 ? currentResults[activeIndex] : currentResults[0];
            if (target) applyResult(target);
        } else if (e.key === "Escape") {
            hideResults();
        }
    });

    searchInput.addEventListener("focus", () => {
        if (currentResults.length) {
            searchResults.hidden = false;
        }
    });

    document.addEventListener("click", (e) => {
        if (!searchSection.contains(e.target)) hideResults();
    });
}

function zoomToSearchResult(item) {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
    if (compactLayout.matches) setControlsOpen(false);
    setLegendExpanded(false);
    activePopup.remove();
    popupOpenedByHover = false;
    selectedFeatureId = item.rgi_id;
    setPointSelected(selectedFeatureId, true);
    setPolygonSelected(selectedFeatureId, true);
    activePopup.setLngLat([item.lon, item.lat]).setHTML(
        `<div class="popup-content"><h3>${escapeHtml(item.name || item.rgi_id || "Glacier")}</h3>
        <p class="popup-note">${escapeHtml(item.rgi_id)} ? Loading glacier profile?</p></div>`
    ).addTo(map);
    // One predictable search move. Never fit to a clipped vector-tile polygon,
    // and never move the camera again when the detailed properties arrive.
    map.flyTo({ center: [item.lon, item.lat], zoom: 11.5, duration: 700, offset: getDetailOffset() });
    map.once("idle", () => {
        if (selectedFeatureId !== item.rgi_id || !activePopup.isOpen()) return;
        const layers = ["glaciers-polygons-fill", "glaciers-points"].filter(id => map.getLayer(id));
        const match = map.queryRenderedFeatures({ layers }).find(feature =>
            feature.properties[metadata.idField ?? "RGIId"] === item.rgi_id);
        if (match) {
            showPopupAt([item.lon, item.lat], match.properties);
        } else {
            activePopup.setHTML(`<div class="popup-content"><h3>${escapeHtml(item.name || item.rgi_id)}</h3>
                <p class="popup-note">${escapeHtml(item.rgi_id)} ? Pan or zoom to inspect this glacier on the map.</p></div>`);
        }
    });
}

// ---------------------------------------------------------------------------
// Panel toggle
// ---------------------------------------------------------------------------

const legendPanel = document.querySelector("#legend-panel");
const legendToggleButton = document.querySelector("#legend-toggle-button");

function setLegendExpanded(expanded) {
    legendPanel.classList.toggle("is-expanded", expanded);
    legendToggleButton.setAttribute("aria-expanded", String(expanded));
    legendToggleButton.innerHTML = expanded ? "&#x25BC;" : "&#x25B2;";
    const label = expanded ? "Collapse legend" : "Expand legend";
    legendToggleButton.title = label;
    legendToggleButton.setAttribute("aria-label", label);
    if (!expanded) document.querySelector(".map-dock").scrollTop = 0;
}

function setControlsOpen(open, focus = false) {
    if (open && compactLayout.matches) {
        setLegendExpanded(false);
        activePopup.remove();
    }
    controlPanel.classList.toggle("is-collapsed", !open);
    panelToggleButton.textContent = compactLayout.matches ? "Close" : "Collapse";
    panelToggleButton.setAttribute("aria-expanded", String(open));
    panelToggleButton.setAttribute("aria-label", "Close controls");
    // The mobile dock keeps the same toggle reachable in either state.
    panelLaunchButton.hidden = open && !compactLayout.matches;
    panelLaunchButton.setAttribute("aria-expanded", String(open));
    panelLaunchButton.setAttribute("aria-label", open ? "Close controls" : "Show controls");
    panelLaunchButton.title = open ? "Close controls" : "Show controls";
    if (!open) {
        searchInput.blur();
        searchResults.hidden = true;
    }
    if (focus) (open ? panelToggleButton : panelLaunchButton).focus({ preventScroll: true });
}

function syncResponsiveLayout() {
    const focusWasInPanel = controlPanel.contains(document.activeElement);
    legendToggleButton.hidden = false;
    setLegendExpanded(!compactLayout.matches);
    setControlsOpen(!compactLayout.matches, focusWasInPanel);
    if (compactLayout.matches) terrainHint.hidden = true;
    map.resize();
}

panelToggleButton.addEventListener("click", () => setControlsOpen(false, true));
panelLaunchButton.addEventListener("click", () => {
    setControlsOpen(controlPanel.classList.contains("is-collapsed"), true);
});
legendToggleButton.addEventListener("click", () => {
    const expanded = !legendPanel.classList.contains("is-expanded");
    if (expanded && compactLayout.matches) {
        setControlsOpen(false);
        activePopup.remove();
    }
    setLegendExpanded(expanded);
});
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("#about-modal").open) return;
    if (compactLayout.matches && !controlPanel.classList.contains("is-collapsed")) {
        setControlsOpen(false, true);
    } else if (compactLayout.matches && legendPanel.classList.contains("is-expanded")) {
        setLegendExpanded(false);
        legendToggleButton.focus({ preventScroll: true });
    } else if (activePopup.isOpen()) {
        activePopup.remove();
        map.getCanvas().focus({ preventScroll: true });
    }
});
activePopup.on("open", () => {
    setLegendExpanded(false);
    if (!compactLayout.matches) return;
    setControlsOpen(false);
});
compactLayout.addEventListener("change", syncResponsiveLayout);
syncResponsiveLayout();
// Opening the legend changes the map row's height without a window resize.
new ResizeObserver(() => {
    document.documentElement.style.setProperty("--map-height", `${map.getContainer().clientHeight}px`);
    map.resize();
}).observe(map.getContainer());
new ResizeObserver(() => {
    document.documentElement.style.setProperty("--legend-height", `${legendPanel.getBoundingClientRect().height}px`);
}).observe(legendPanel);

// Safari's keyboard can cover the layout viewport without changing dvh.
// Follow the visible height while leaving pinch zoom to the browser.
if (window.visualViewport) {
    const syncVisibleHeight = () => {
        if (window.visualViewport.scale !== 1) return;
        document.documentElement.style.setProperty("--viewport-height", `${window.visualViewport.height}px`);
        if (compactLayout.matches && document.activeElement === searchInput) {
            requestAnimationFrame(() => searchInput.scrollIntoView({ block: "nearest" }));
        }
    };
    window.visualViewport.addEventListener("resize", syncVisibleHeight);
    syncVisibleHeight();
}

function getDetailOffset() {
    if (!compactLayout.matches) return [0, 0];
    // Reserve the final profile height even while its placeholder is loading.
    const profileHeight = Math.min((window.visualViewport?.height ?? window.innerHeight) * 0.42, 340);
    return [0, -profileHeight / 2];
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
    setStatus("Loading glacier data…");

    // Load metadata, search index, and package version in parallel
    const [metaRes, searchRes, versionRes] = await Promise.all([
        fetch(BUILD_METADATA_URL),
        fetch(SEARCH_INDEX_URL),
        fetch(VERSION_URL),
    ]);

    if (!metaRes.ok) throw new Error(`Failed to load build metadata (${metaRes.status}). Run scripts/build_pmtiles.py first.`);
    if (!searchRes.ok) throw new Error(`Failed to load search index (${searchRes.status}). Run scripts/build_pmtiles.py first.`);

    metadata = await metaRes.json();
    searchIndex = await searchRes.json();

    // Inject version into About modal
    if (versionRes.ok) {
        const pkg = await versionRes.json();
        const versionEl = document.getElementById("app-version");
        if (versionEl && pkg.version) versionEl.textContent = `v${pkg.version}`;
    }

    // Populate scenario selector
    for (const scenario of metadata.scenarios) {
        const option = document.createElement("option");
        option.value = scenario.key;
        option.textContent = scenario.label;
        scenarioSelect.append(option);
    }

    const defaultScenario =
        metadata.scenarios.find((s) => s.code === (metadata.defaultScenarioCode ?? DEFAULT_SCENARIO_CODE)) ??
        metadata.scenarios[0];

    activeScenarioKey = defaultScenario.key;
    scenarioSelect.value = activeScenarioKey;

    // Wait for map style to load, then add glacier layers
    await new Promise((resolve) => {
        if (map.isStyleLoaded()) resolve();
        else map.once("load", resolve);
    });

    addGlacierSources();
    addGlacierLayers();
    // Keep place names readable over glacier fills without changing hit testing.
    for (const layer of createBasemapLabelLayers()) map.moveLayer(layer.id);
    showTerrainHint();

    terrainButton.addEventListener("click", () => {
        terrainEnabled = !terrainEnabled;
        terrainButton.setAttribute("aria-pressed", String(terrainEnabled));
        map.stop();

        if (terrainEnabled) {
            // Animate pitch in flat 2D first, then enable terrain once the
            // camera has settled. Calling setTerrain() before or during a
            // camera animation causes MapLibre to fire async DEM-altitude
            // corrections that override the animation and shift the view.
            map.easeTo({
                pitch: TERRAIN_ON_PITCH_DEGREES,
                duration: TERRAIN_CAMERA_ANIMATION_MS,
            });
            setTimeout(() => {
                requestAnimationFrame(() => {
                    if (terrainEnabled) {
                        map.setTerrain({ source: "dem", exaggeration: 1.5 });
                    }
                });
            }, TERRAIN_CAMERA_ANIMATION_MS);
            terrainButton.classList.add("is-active");
        } else {
            // setTerrain(null) is synchronous – no tile loading, no async
            // altitude correction, so we can disable immediately then un-tilt.
            map.setTerrain(null);
            map.easeTo({
                pitch: TERRAIN_OFF_PITCH_DEGREES,
                duration: TERRAIN_CAMERA_ANIMATION_MS,
            });
            terrainButton.classList.remove("is-active");
        }
    });

    // Wire hover/click for both geometry layers
    // Use global vars for hover tracking (avoids closure capture issues with feature IDs)
    window.hoveredPointId = null;
    window.hoveredPolygonId = null;

    map.on("mousemove", "glaciers-points", (e) => {
        if (!overlayVisible || !e.features.length) return;
        if (bboxActive) return;
        map.getCanvas().style.cursor = "pointer";
        const feature = e.features[0];
        const fid = feature.id;
        const featureChanged = fid !== window.hoveredPointId;
        if (featureChanged) {
            setPointHover(window.hoveredPointId, false);
            window.hoveredPointId = fid;
            setPointHover(fid, true);
        }

        // hoverOwnsPopup: true when there is no popup yet, or when hover opened it.
        const hoverOwnsPopup = !activePopup.isOpen() || popupOpenedByHover;

        if (hoverMetadataEnabled && hoverOwnsPopup) {
            if (featureChanged) {
                showPopupAt([e.lngLat.lng, e.lngLat.lat], feature.properties);
                popupOpenedByHover = true;
            }
        } else if (!activePopup.isOpen()) {
            showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, feature.properties);
        }

        if (hoverOutlineEnabled && hoverOwnsPopup) {
            const idField = metadata.idField ?? "RGIId";
            const rgiId = feature.properties[idField];
            if (rgiId != null) {
                map.setFilter("hover-outline-line", ["==", ["get", idField], rgiId]);
            }
        } else if (!hoverOwnsPopup) {
            map.setFilter("hover-outline-line", ["boolean", false]);
        }
    });

    map.on("mouseleave", "glaciers-points", () => {
        map.getCanvas().style.cursor = "";
        setPointHover(window.hoveredPointId, false);
        window.hoveredPointId = null;
        hideTooltip();
        map.setFilter("hover-outline-line", ["boolean", false]);
        if (popupOpenedByHover) activePopup.remove();
    });

    map.on("mousemove", "glaciers-polygons-fill", (e) => {
        if (!overlayVisible || !e.features.length) return;
        if (bboxActive) return;
        map.getCanvas().style.cursor = "pointer";
        const feature = e.features[0];
        const fid = feature.id;
        const featureChanged = fid !== window.hoveredPolygonId;
        if (featureChanged) {
            setPolygonHover(window.hoveredPolygonId, false);
            window.hoveredPolygonId = fid;
            setPolygonHover(fid, true);
        }

        const hoverOwnsPopup = !activePopup.isOpen() || popupOpenedByHover;

        if (hoverMetadataEnabled && hoverOwnsPopup) {
            if (featureChanged) {
                showPopupAt([e.lngLat.lng, e.lngLat.lat], feature.properties);
                popupOpenedByHover = true;
            }
        } else if (!activePopup.isOpen()) {
            showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, feature.properties);
        }
    });

    map.on("mouseleave", "glaciers-polygons-fill", () => {
        map.getCanvas().style.cursor = "";
        setPolygonHover(window.hoveredPolygonId, false);
        window.hoveredPolygonId = null;
        hideTooltip();
        if (popupOpenedByHover) activePopup.remove();
    });


    // Wait for the tile sources to be ready, then clear the loading overlay
    // We wait for the 'idle' event which fires once all pending tile loads complete.
    map.once("idle", clearStatus);

    // If a tile source fails to load (e.g. network timeout after retries),
    // show an error message instead of silently clearing the overlay.
    map.once("error", (e) => {
        // Ignore errors that fire after the overlay was already dismissed.
        if (statusBox.hidden) return;
        setStatus("Some map data failed to load. Check your connection and reload the page.", "error");
    });

    // Fit map to initial bounds from metadata (if available), else world view
    if (metadata.initialBounds) {
        map.fitBounds(metadata.initialBounds, { padding: 24, duration: 0 });
    }

    // ---- Controls ----

    scenarioSelect.addEventListener("change", () => {
        activeScenarioKey = scenarioSelect.value;
        applyScenarioStyles();
        updateLegend();
        updateScenarioStats();
        if (activePopup.isOpen() && popupProperties) activePopup.setHTML(buildPopupHtml(popupProperties));
    });

    overlayVisibleInput.addEventListener("change", () => {
        overlayVisible = overlayVisibleInput.checked;
        applyVisibility();
    });

    hoverOutlineInput.addEventListener("change", () => {
        hoverOutlineEnabled = hoverOutlineInput.checked;
        if (!hoverOutlineEnabled) {
            map.setFilter("hover-outline-line", ["boolean", false]);
        }
    });

    hoverMetadataInput.addEventListener("change", () => {
        hoverMetadataEnabled = hoverMetadataInput.checked;
        if (!hoverMetadataEnabled && popupOpenedByHover) {
            activePopup.remove();
        }
    });

    resetViewButton.addEventListener("click", () => {
        if (metadata.initialBounds) {
            map.fitBounds(metadata.initialBounds, { padding: 24 });
        } else {
            map.flyTo({ center: [0, 20], zoom: 2 });
        }
    });

    // Bbox zoom – draw a rectangle on the map canvas, then fitBounds to it
    const mapCanvas = map.getCanvas();
    const mapCanvasContainer = map.getCanvasContainer();
    const mapContainer = map.getContainer();
    const bboxRect = document.createElement("div");
    bboxRect.id = "bbox-rect";
    bboxRect.hidden = true;
    mapContainer.appendChild(bboxRect);

    let bboxStart = null;

    function toContainerXY(e) {
        const rect = mapContainer.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function exitBboxMode() {
        bboxActive = false;
        bboxZoomButton.classList.remove("is-active");
        bboxZoomButton.setAttribute("aria-pressed", "false");
        map.touchZoomRotate.enable();
        mapCanvas.style.touchAction = "";
        mapCanvas.style.cursor = "";
        mapCanvasContainer.style.cursor = "";
        mapContainer.style.cursor = "";
        map.dragPan.enable();
        bboxRect.hidden = true;
        bboxStart = null;
    }

    bboxZoomButton.addEventListener("click", () => {
        if (bboxActive) { exitBboxMode(); return; }
        bboxActive = true;
        bboxZoomButton.classList.add("is-active");
        bboxZoomButton.setAttribute("aria-pressed", "true");
        map.touchZoomRotate.disable();
        map.dragPan.disable();
        mapCanvas.style.touchAction = "none";
        mapCanvas.style.cursor = "crosshair";
        mapCanvasContainer.style.cursor = "crosshair";
        mapContainer.style.cursor = "crosshair";
    });

    mapCanvas.addEventListener("pointerdown", (e) => {
        if (!bboxActive || !e.isPrimary) return;
        mapCanvas.setPointerCapture(e.pointerId);
        bboxStart = toContainerXY(e);
        bboxRect.hidden = false;
        bboxRect.style.left = bboxStart.x + "px";
        bboxRect.style.top = bboxStart.y + "px";
        bboxRect.style.width = "0px";
        bboxRect.style.height = "0px";
    });

    mapCanvas.addEventListener("pointermove", (e) => {
        if (!bboxActive || !bboxStart) return;
        mapCanvas.style.cursor = "crosshair";
        mapCanvasContainer.style.cursor = "crosshair";
        mapContainer.style.cursor = "crosshair";
        const cur = toContainerXY(e);
        const x = Math.min(cur.x, bboxStart.x);
        const y = Math.min(cur.y, bboxStart.y);
        const w = Math.abs(cur.x - bboxStart.x);
        const h = Math.abs(cur.y - bboxStart.y);
        bboxRect.style.left = x + "px";
        bboxRect.style.top = y + "px";
        bboxRect.style.width = w + "px";
        bboxRect.style.height = h + "px";
    });

    mapCanvas.addEventListener("pointerup", (e) => {
        if (!bboxActive || !bboxStart) return;
        if (mapCanvas.hasPointerCapture(e.pointerId)) mapCanvas.releasePointerCapture(e.pointerId);
        suppressMapClickUntil = performance.now() + 250;
        const end = toContainerXY(e);
        const x0 = Math.min(bboxStart.x, end.x);
        const y0 = Math.min(bboxStart.y, end.y);
        const x1 = Math.max(bboxStart.x, end.x);
        const y1 = Math.max(bboxStart.y, end.y);
        exitBboxMode();
        if (x1 - x0 < 10 || y1 - y0 < 10) return; // too small, treat as click
        const sw = map.unproject([x0, y1]);
        const ne = map.unproject([x1, y0]);
        map.fitBounds([sw, ne], { padding: 20, maxZoom: 14 });
    });

    mapCanvas.addEventListener("pointercancel", exitBboxMode);
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && bboxActive) exitBboxMode();
    });

    updateLegend();
    updateScenarioStats();
    initSearch();
}

bootstrap().catch((err) => {
    console.error(err);
    setStatus(err.message, "error");
});
