export const DATASET_URL = "./data/swiss_glaciers.geojson";
export const DATASET_METADATA_URL = "./data/swiss_glaciers.meta.json";

export const SCENARIO_FIELD_PATTERN =
  /^Extinction_(.+)_(median|Q1|Q3)_([0-9]+)$/i;

export const SCENARIO_STAT_PRIORITY = ["median", "Q1", "Q3"];

export const YEAR_STYLE = {
  alreadyExtinct: "#7f0000",
  ramp: ["#c72e29", "#e3692e", "#f1a340", "#f9d27b", "#d7ecf6", "#92c5de"],
  survives: "#eff8ff",
  missing: "#cbd5e1",
  outline: "#365266",
  hover: "#0f172a",
  selected: "#111827",
};

export const METADATA_FIELD_LABELS = {
  Area: "Area (km²)",
  BgnDate: "Begin date",
  CenLat: "Centroid latitude",
  CenLon: "Centroid longitude",
  Connect: "Connectivity",
  EndDate: "End date",
  Form: "Form",
  GLIMSId: "GLIMS ID",
  Lmax: "Max length",
  Name: "Name",
  O1Region: "RGI region",
  O2Region: "RGI subregion",
  RGIId: "RGI ID",
  Slope: "Slope",
  Status: "Status",
  Surging: "Surging",
  TermType: "Terminus type",
  Zmax: "Max elevation (m)",
  Zmed: "Median elevation (m)",
  Zmin: "Min elevation (m)",
  fid: "Feature ID",
};

export const METADATA_FIELD_PRIORITY = [
  "Area",
  "Zmin",
  "Zmed",
  "Zmax",
  "Slope",
  "Status",
  "TermType",
  "Form",
  "Connect",
  "Surging",
  "BgnDate",
  "EndDate",
  "O1Region",
  "O2Region",
  "CenLat",
  "CenLon",
  "fid",
];

export const ID_FIELD_PRIORITY = ["Name", "RGIId", "GLIMSId", "fid", "id"];

export const SEARCH_FIELD_PRIORITY = ["Name", "RGIId", "GLIMSId"];

export const CURRENT_YEAR = new Date().getFullYear();

export const VALID_YEAR_MIN = 1850;
export const VALID_YEAR_MAX = 2500;

export function formatScenarioLabel(code) {
  if (!/^\d+$/.test(code)) {
    return code;
  }

  const numeric = Number(code);
  return `Scenario ${Math.floor(numeric / 10)}.${numeric % 10}\u00b0C`;
}
