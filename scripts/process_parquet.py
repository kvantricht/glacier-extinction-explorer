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
    orig_file = r"C:\Users\vtrichtk\OneDrive - VITO\Documents\git\GlacierViz\data\global_glacier_extinction_dataset_07092026.gpkg"
    orig_df = gpd.read_file(orig_file)

    cols = orig_df.columns
    print(f"Columns in original file: {cols}")

    print("Number of rows with missing 'Name':", orig_df["Name"].isna().sum())

    literal_none_mask = orig_df["Name"].eq("None")
    print("Number of rows with literal 'None' name:", literal_none_mask.sum())
    orig_df.loc[literal_none_mask, "Name"] = None

    replacements = {
        "�yenbreen": "Øyenbreen",
        "�breen": "Øbreen",
        # add more known corrections here
    }

    orig_df["Name"] = orig_df["Name"].replace(replacements)

    numeric_name_mask = orig_df["Name"].apply(_is_numeric_name)
    print("Number of rows with numeric-only 'Name':", numeric_name_mask.sum())
    orig_df.loc[numeric_name_mask, "Name"] = None

    missing_name_count = orig_df["Name"].isna().sum()
    named_glacier_count = len(orig_df) - missing_name_count
    named_glacier_percentage = 100 * named_glacier_count / len(orig_df)
    print("Number of rows with missing 'Name' after cleaning:", missing_name_count)
    print(
        f"Glaciers with a usable name: {named_glacier_count:,} "
        f"({named_glacier_percentage:.1f}%)"
    )

    orig_df = orig_df.drop(columns=["fid"], errors="ignore")

    inventory_year = orig_df["BgnDate"].str[:4]
    inventory_year[inventory_year == "-999"] = "Unknown"
    orig_df["Inventory year"] = inventory_year
    orig_df = orig_df.drop(columns=["BgnDate"])

    print(
        f"Number of rows with missing 'Inventory year': {(orig_df['Inventory year'] == 'Unknown').sum()}"
    )

    # Process glacier volume
    def _process_volume(val):
        numeric_value = pd.to_numeric(val, errors="coerce")
        if pd.isna(numeric_value) or numeric_value == 0:
            return "Unknown"
        elif numeric_value < 0.001:
            return (
                str(round(numeric_value * 1e9)) + " m³"
            )  # convert km³ to m³ for very small glaciers
        else:
            return str(round(numeric_value, 3)) + " km³"

    orig_df["Glacier volume"] = orig_df["Volume"].apply(_process_volume)
    orig_df = orig_df.drop(columns=["Volume"])

    orig_df.to_parquet(
        r"C:\Users\VTRICHTK\OneDrive - VITO\Documents\git\GlacierViz\data\global_glaciers_processed.parquet"
    )
    print(f"Final columns in processed Parquet file: {orig_df.columns}")


if __name__ == "__main__":
    main()
