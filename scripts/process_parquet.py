import geopandas as gpd
import numpy as np
import pandas as pd


def _is_numeric_name(value):
    if pd.isna(value):
        return False
    text = str(value).strip()
    if not text:
        return False
    return text.replace(",", ".", 1).replace("-", "", 1).isdigit()


def main():
    orig_file = r"C:\Users\VTRICHTK\OneDrive - VITO\Documents\git\GlacierViz\data\global_glaciers_raw_selected_attributes.parquet"
    orig_df = gpd.read_parquet(orig_file)

    cols = orig_df.columns
    print(f"Columns in original Parquet file: {cols}")

    print("Number of rows with missing 'Name':", orig_df["Name"].isna().sum())

    orig_df.loc[orig_df["Name"].isna(), "Name"] = orig_df.loc[
        orig_df["Name"].isna(), "all_extinction_perglacier_volume_glacier_name"
    ]

    orig_df.loc[orig_df["Name"] == "None", "Name"] = None

    replacements = {
        "�yenbreen": "Øyenbreen",
        "�breen": "Øbreen",
        # add more known corrections here
    }

    orig_df["Name"] = orig_df["Name"].replace(replacements)

    numeric_name_mask = orig_df["Name"].apply(_is_numeric_name)
    print("Number of rows with numeric-only 'Name':", numeric_name_mask.sum())
    orig_df.loc[numeric_name_mask, "Name"] = None

    print(
        "Number of rows with missing 'Name' after filling:",
        orig_df["Name"].isna().sum(),
    )

    orig_df = orig_df.drop(
        columns=["all_extinction_perglacier_volume_glacier_name", "fid"],
        errors="ignore",
    )

    inventory_year = orig_df["BgnDate"].str[:4]
    inventory_year[inventory_year == "-999"] = "Unknown"
    orig_df["Inventory year"] = inventory_year
    orig_df = orig_df.drop(columns=["BgnDate"])

    print(
        f"Number of rows with missing 'Inventory year': {(orig_df['Inventory year'] == 'Unknown').sum()}"
    )

    # Process glacier volume
    def _process_volume(val):
        if val is None or val == 0 or np.isnan(val):
            return "Unknown"
        elif val < 0.001:
            return (
                str(round(val * 1e9)) + " m³"
            )  # convert km³ to m³ for very small glaciers
        else:
            return str(round(val, 3)) + " km³"

    orig_df["Glacier volume"] = orig_df[
        "all_extinction_perglacier_volume_ice_volume_km3"
    ].apply(_process_volume)
    orig_df = orig_df.drop(columns=["all_extinction_perglacier_volume_ice_volume_km3"])

    orig_df.to_parquet(
        r"C:\Users\VTRICHTK\OneDrive - VITO\Documents\git\GlacierViz\data\global_glaciers_processed.parquet"
    )
    print(f"Final columns in processed Parquet file: {orig_df.columns}")


if __name__ == "__main__":
    main()
