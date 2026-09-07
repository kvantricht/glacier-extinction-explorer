// Geographic context from CARTO's OpenMapTiles-compatible source. Schema:
// https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json
// Text stays in screen pixels, independent of raster tile resolution.
export const BASEMAP_GLYPHS_URL = "https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf";
export const basemapLabelsSource = {
    type: "vector",
    url: "https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json",
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a>, &copy; OpenStreetMap contributors',
};

export function createBasemapLabelLayers() {
    const layers = [
        { id: "countries", classes: ["country"], min: 1, max: 8, size: 17, bold: true },
        { id: "regions", classes: ["state", "province"], min: 4, max: 10, size: 14 },
        { id: "cities", classes: ["city"], min: 3, max: 24, size: 15, bold: true },
        { id: "towns", classes: ["town"], min: 8, max: 24, size: 15 },
        { id: "villages", classes: ["village"], min: 9, max: 24, size: 14 },
        { id: "hamlets", classes: ["hamlet", "neighbourhood", "suburb"], min: 12, max: 24, size: 14 },
        { id: "water", source: "water_name", min: 2, max: 24, size: 14, water: true },
        { id: "peaks", source: "mountain_peak", min: 10, max: 24, size: 14 },
    ].map(({ id, source = "place", classes, min, max, size, bold, water }) => ({
        id: `basemap-labels-${id}`,
        type: "symbol",
        source: "basemap-labels",
        "source-layer": source,
        minzoom: min,
        maxzoom: max,
        ...(classes ? { filter: ["in", "class", ...classes] } : {}),
        layout: {
            visibility: "none",
            "text-field": ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name"], ""],
            "text-font": [bold ? "Open Sans Semibold" : "Open Sans Regular", "Noto Sans Regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 2, size, 18, size + 2],
            "text-max-width": 9,
            "text-padding": 6,
            "text-allow-overlap": false,
            "text-pitch-alignment": "viewport",
            "text-rotation-alignment": "viewport",
            "symbol-sort-key": ["coalesce", ["get", "rank"], 0],
        },
        paint: {
            "text-color": water ? "#c6e8ff" : "#ffffff",
            "text-halo-color": "rgba(5, 14, 24, 0.95)",
            "text-halo-width": 1.6,
            "text-halo-blur": 0.4,
        },
    }));

    const boundaries = [
        { id: "countries", levels: [2], min: 1, width: 1.1 },
        { id: "regions", levels: [4, 6], min: 6, width: 0.7 },
    ].flatMap(({ id, levels, min, width }) => [false, true].map(disputed => ({
        id: `basemap-labels-boundaries-${id}${disputed ? "-disputed" : ""}`,
        type: "line",
        source: "basemap-labels",
        "source-layer": "boundary",
        minzoom: min,
        filter: ["all", ["in", "admin_level", ...levels], ["!=", "maritime", 1],
            [disputed ? "==" : "!=", "disputed", 1]],
        layout: { visibility: "none" },
        paint: {
            "line-color": "#ffffff",
            "line-opacity": 0.55,
            "line-width": width,
            ...(disputed ? { "line-dasharray": [3, 3] } : {}),
        },
    })));
    return [...boundaries, ...layers];
}
