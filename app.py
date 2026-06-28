"""
GeoAI Bengaluru House Finder — app.py
Clean, single-pass version. All startup I/O happens once at module level.
"""

import os
import re
import json
import math
import logging
from functools import lru_cache

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut, GeocoderUnavailable
from geopy.distance import geodesic
from shapely.geometry import Point
from shapely.strtree import STRtree
from difflib import get_close_matches

# ─────────────────────────────────────────────
# App setup
# ─────────────────────────────────────────────
app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)
logging.basicConfig(level=logging.INFO)

# ─────────────────────────────────────────────
# Paths  (cross-platform — no backslashes)
# ─────────────────────────────────────────────
STATIC = "static"
HOUSES_CSV      = os.path.join(STATIC, "cleaned_with_coordinates.csv")
AQI_CSV         = os.path.join(STATIC, "bengaluru_aqi.csv")
BUS_CSV         = os.path.join(STATIC, "bus_stop_cleaned.csv")
SCHOOLS_GEOJSON = os.path.join(STATIC, "cleaned_1000_schools.geojson")
METRO_GEOJSON   = os.path.join(STATIC, "metro-lines-stations.geojson")
HOSPITAL_CSV    = os.path.join(STATIC, "cleaned_hospitals.csv")
GEOCODE_CACHE   = os.path.join(STATIC, "geocode_cache.json")   # persistent geocode cache

# ─────────────────────────────────────────────
# Utility loaders
# ─────────────────────────────────────────────
def try_read_csv(path):
    try:
        return pd.read_csv(path, encoding="utf-8", on_bad_lines="skip")
    except Exception as e:
        app.logger.error(f"Failed to read CSV {path}: {e}")
        return pd.DataFrame()


def try_load_geojson(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        app.logger.error(f"Failed to load GeoJSON {path}: {e}")
        return {"type": "FeatureCollection", "features": []}


# ─────────────────────────────────────────────
# Distance helper  (vectorised, no geopy loop)
# ─────────────────────────────────────────────
def haversine_fast(lat1, lon1, lat2, lon2):
    """
    Accepts scalars or numpy arrays for lat2/lon2.
    Returns distance(s) in km.
    """
    R = 6371.0
    lat1, lon1 = math.radians(lat1), math.radians(lon1)
    lat2 = np.radians(np.asarray(lat2, dtype=float))
    lon2 = np.radians(np.asarray(lon2, dtype=float))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + math.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(a))


def nearest_distance(lat, lon, points):
    """Return (min_km, name) for the closest point in a list."""
    if not points:
        return None, None
    arr_lat = np.array([p["lat"] for p in points])
    arr_lon = np.array([p["lon"] for p in points])
    dists   = haversine_fast(lat, lon, arr_lat, arr_lon)
    idx     = int(np.argmin(dists))
    return round(float(dists[idx]), 2), points[idx].get("name", "")


# ─────────────────────────────────────────────
# Load & clean houses  (single load)
# ─────────────────────────────────────────────
def _parse_price_to_lakh(v):
    if pd.isna(v):
        return np.nan
    s = str(v).lower().replace(",", "").replace("₹", "").strip()
    if "lakh" in s or "lac" in s:
        n = re.sub(r"[^\d.]", "", s)
        try:
            return float(n)
        except ValueError:
            return np.nan
    n = re.sub(r"[^\d.]", "", s)
    try:
        val = float(n)
        return val / 100_000.0 if val > 1000 else val
    except ValueError:
        return np.nan


def _parse_bhk(v):
    if pd.isna(v):
        return np.nan
    s = str(v).lower()
    m = re.search(r"(\d+)\s*-?\s*bhk", s)
    if m:
        return int(m.group(1))
    m2 = re.search(r"^(\d+)\b", s)
    if m2:
        return int(m2.group(1))
    return np.nan


def _find_col(df, keywords):
    for c in df.columns:
        for k in keywords:
            if c.strip().lower() == k.lower():
                return c
    return None


_raw = try_read_csv(HOUSES_CSV)
if not _raw.empty:
    latc   = _find_col(_raw, ["latitude", "lat", "y"])
    lonc   = _find_col(_raw, ["longitude", "lon", "long", "x"])
    pricec = _find_col(_raw, ["price", "amount", "cost"])
    sizec  = _find_col(_raw, ["size", "bhk", "bed"])
    locc   = _find_col(_raw, ["location", "area", "locality", "place", "address"])

    _raw["latitude"]      = pd.to_numeric(_raw[latc],  errors="coerce") if latc  else np.nan
    _raw["longitude"]     = pd.to_numeric(_raw[lonc],  errors="coerce") if lonc  else np.nan
    _raw["price_lakh"]    = _raw[pricec].apply(_parse_price_to_lakh)    if pricec else np.nan
    _raw["size_num"]      = _raw[sizec].apply(_parse_bhk)               if sizec  else np.nan
    _raw["location_text"] = _raw[locc].fillna("")                        if locc   else _raw.index.astype(str)

    houses_df = _raw.dropna(subset=["latitude", "longitude"]).copy()
    houses_df = houses_df[(houses_df["latitude"] != 0) & (houses_df["longitude"] != 0)]

    # Pre-compute radians once
    houses_df["lat_rad"] = np.radians(houses_df["latitude"])
    houses_df["lon_rad"] = np.radians(houses_df["longitude"])
else:
    houses_df = pd.DataFrame(
        columns=["latitude", "longitude", "price_lakh", "size_num",
                 "location_text", "lat_rad", "lon_rad"]
    )

app.logger.info(f"Loaded {len(houses_df)} valid houses.")

# ─────────────────────────────────────────────
# Load amenity point lists
# ─────────────────────────────────────────────
def _points_from_geojson(features, name_props):
    pts = []
    for f in features:
        geom  = f.get("geometry") or {}
        props = f.get("properties") or {}
        if geom.get("type") == "Point":
            coords = geom.get("coordinates", [])
            if len(coords) >= 2:
                name = next((props[p] for p in name_props if p in props), "")
                pts.append({
                    "lat":  float(coords[1]),
                    "lon":  float(coords[0]),
                    "name": str(name),
                })
    return pts


schools_geo = try_load_geojson(SCHOOLS_GEOJSON)
metro_geo   = try_load_geojson(METRO_GEOJSON)

schools_pts  = _points_from_geojson(
    schools_geo.get("features", []),
    ["SCHName", "SCH_Name", "Name", "name", "SCH_NAME"]
)
metro_pts = _points_from_geojson(
    metro_geo.get("features", []),
    ["Name", "name", "station_name", "station"]
)

# AQI
aqi_df  = try_read_csv(AQI_CSV)
aqi_pts = []
if not aqi_df.empty:
    aqi_df.columns = aqi_df.columns.str.strip().str.lower()
    for _, r in aqi_df.iterrows():
        try:
            lat  = float(r.get("lat") or r.get("latitude") or np.nan)
            lon  = float(r.get("lon") or r.get("longitude") or np.nan)
            name = str(r.get("station_name") or r.get("station") or "")
            aqi  = r.get("aqi")
            if np.isfinite(lat) and np.isfinite(lon):
                aqi_pts.append({"lat": lat, "lon": lon, "name": name, "aqi": aqi})
        except Exception:
            continue

# Bus
bus_df  = try_read_csv(BUS_CSV)
bus_pts = []
if not bus_df.empty:
    _latc = next((c for c in bus_df.columns if "lat" in c.lower()), None)
    _lonc = next((c for c in bus_df.columns if "lon" in c.lower()), None)
    _namc = next(
        (c for c in bus_df.columns if any(x in c.lower() for x in ["stop", "name", "bus"])),
        None
    )
    for _, r in bus_df.iterrows():
        try:
            lat  = float(r[_latc]) if _latc else np.nan
            lon  = float(r[_lonc]) if _lonc else np.nan
            name = str(r[_namc]) if _namc else ""
            if np.isfinite(lat) and np.isfinite(lon):
                bus_pts.append({"lat": lat, "lon": lon, "name": name})
        except Exception:
            continue

# Hospitals
hospital_df  = try_read_csv(HOSPITAL_CSV)
hospital_pts = []
if not hospital_df.empty:
    hospital_df.columns = hospital_df.columns.str.strip().str.lower()
    hospital_df["lat"] = pd.to_numeric(hospital_df.get("lat", pd.Series(dtype=float)), errors="coerce")
    hospital_df["lon"] = pd.to_numeric(hospital_df.get("lon", pd.Series(dtype=float)), errors="coerce")
    hospital_df = hospital_df.dropna(subset=["lat", "lon"])
    for _, r in hospital_df.iterrows():
        name = str(r.get("hospital_name") or r.get("search_address") or "")
        hospital_pts.append({"lat": float(r["lat"]), "lon": float(r["lon"]), "name": name})

app.logger.info(
    f"Amenity points — schools:{len(schools_pts)} metro:{len(metro_pts)} "
    f"bus:{len(bus_pts)} hospitals:{len(hospital_pts)} aqi:{len(aqi_pts)}"
)

# ─────────────────────────────────────────────
# Livability score
# ─────────────────────────────────────────────
def compute_livability_score(lat, lon):
    """0–100 weighted livability score."""
    def proximity_score(km, max_km=3.0):
        return max(0.0, (1 - km / max_km)) * 25 if km is not None else 0.0

    school_km,   _ = nearest_distance(lat, lon, schools_pts)
    metro_km,    _ = nearest_distance(lat, lon, metro_pts)
    hospital_km, _ = nearest_distance(lat, lon, hospital_pts)
    bus_km,      _ = nearest_distance(lat, lon, bus_pts)

    score = (
        proximity_score(school_km)   * 1.0  +   # 25 pts
        proximity_score(metro_km)    * 1.0  +   # 25 pts
        proximity_score(hospital_km) * 1.0  +   # 25 pts
        proximity_score(bus_km)      * 0.6       # 15 pts
    )

    if aqi_pts:
        aqi_val, _ = nearest_distance(lat, lon, aqi_pts)
        if aqi_val is not None and np.isfinite(aqi_val) and aqi_val > 0:
            score += max(0.0, (200 - float(aqi_val)) / 200) * 10  # 10 pts

    return round(min(100.0, score), 1)


# ─────────────────────────────────────────────
# Persistent geocode cache  (survives restarts)
# ─────────────────────────────────────────────
_geo_disk_cache: dict = {}
if os.path.exists(GEOCODE_CACHE):
    try:
        with open(GEOCODE_CACHE, "r", encoding="utf-8") as _f:
            _geo_disk_cache = json.load(_f)
    except Exception:
        _geo_disk_cache = {}


def _save_geocode_cache():
    try:
        with open(GEOCODE_CACHE, "w", encoding="utf-8") as _f:
            json.dump(_geo_disk_cache, _f, indent=2)
    except Exception as e:
        app.logger.warning(f"Could not save geocode cache: {e}")


_nominatim = Nominatim(user_agent="geoai_bangalore", timeout=10)


def geocode_place(place: str):
    """
    Resolve a place name to {lat, lon, name}.
    Priority: disk cache → local amenity match → Nominatim (with persistence).
    Thread-safety note: good enough for single-worker dev; use a lock or Redis
    for multi-worker production.
    """
    if not place:
        return None
    key = place.strip().lower()

    # 1. Disk-persistent cache
    if key in _geo_disk_cache:
        return _geo_disk_cache[key]

    # 2. Local dataset matches
    if "location_text" in houses_df.columns:
        mask = houses_df["location_text"].str.lower().str.contains(key, na=False)
        match = houses_df[mask]
        if not match.empty:
            row = match.iloc[0]
            result = {"lat": float(row["latitude"]), "lon": float(row["longitude"]),
                      "name": row["location_text"]}
            _geo_disk_cache[key] = result
            _save_geocode_cache()
            return result

    for pts in [metro_pts, bus_pts, schools_pts, aqi_pts, hospital_pts]:
        for p in pts:
            if p.get("name") and key in p["name"].lower():
                result = {"lat": p["lat"], "lon": p["lon"], "name": p["name"]}
                _geo_disk_cache[key] = result
                _save_geocode_cache()
                return result

    # 3. Nominatim fallback
    try:
        viewbox = ((77.35, 12.80), (77.85, 13.20))
        loc = _nominatim.geocode(
            query=f"{place}, Bengaluru, Karnataka, India",
            country_codes="IN",
            bounded=True,
            viewbox=viewbox,
            exactly_one=True,
        )
        if loc:
            result = {"lat": loc.latitude, "lon": loc.longitude, "name": loc.address}
            _geo_disk_cache[key] = result
            _save_geocode_cache()
            return result
    except (GeocoderTimedOut, GeocoderUnavailable) as e:
        app.logger.warning(f"Nominatim unavailable for '{place}': {e}")
    except Exception as e:
        app.logger.error(f"Geocode error for '{place}': {e}")

    return None


# ─────────────────────────────────────────────
# Core filter  (fixed amenity pre-computation)
# ─────────────────────────────────────────────
def filter_houses_near(lat, lon, radius_km=3.5,
                       max_price_lakh=None, size_num=None,
                       must_near_school=False, must_near_metro=False,
                       must_near_bus=False, must_near_hospital=False,
                       prefer_good_aqi=False):
    """
    Filter houses within radius_km of (lat, lon).
    Amenity distances are vectorised with haversine_fast — no row-by-row geopy.
    """
    df_local = houses_df.copy()

    # Distance from search centre
    lat_rad = math.radians(lat)
    lon_rad = math.radians(lon)
    dlat = df_local["lat_rad"] - lat_rad
    dlon = df_local["lon_rad"] - lon_rad
    a = (np.sin(dlat / 2) ** 2
         + math.cos(lat_rad) * np.cos(df_local["lat_rad"]) * np.sin(dlon / 2) ** 2)
    df_local["dist_km"] = 2 * 6371.0 * np.arcsin(np.sqrt(a))

    sub = df_local[df_local["dist_km"] <= radius_km].copy()
    if sub.empty:
        return []

    # Vectorised amenity distances — compute only what's needed
    coords_lat = sub["latitude"].values
    coords_lon = sub["longitude"].values

    def batch_min_dist(pts):
        if not pts:
            return np.full(len(sub), np.nan)
        arr_lat = np.array([p["lat"] for p in pts])
        arr_lon = np.array([p["lon"] for p in pts])
        return np.array([
            float(np.min(haversine_fast(la, lo, arr_lat, arr_lon)))
            for la, lo in zip(coords_lat, coords_lon)
        ])

    if must_near_school and schools_pts:
        sub["nearest_school_km"] = batch_min_dist(schools_pts)
        sub = sub[sub["nearest_school_km"] <= 1.0]
        if sub.empty:
            return []
        coords_lat = sub["latitude"].values
        coords_lon = sub["longitude"].values

    if must_near_metro and metro_pts:
        sub["nearest_metro_km"] = batch_min_dist(metro_pts)
        sub = sub[sub["nearest_metro_km"] <= 1.0]
        if sub.empty:
            return []
        coords_lat = sub["latitude"].values
        coords_lon = sub["longitude"].values

    if must_near_bus and bus_pts:
        sub["nearest_bus_km"] = batch_min_dist(bus_pts)
        sub = sub[sub["nearest_bus_km"] <= 1.0]
        if sub.empty:
            return []
        coords_lat = sub["latitude"].values
        coords_lon = sub["longitude"].values

    if must_near_hospital and hospital_pts:
        sub["nearest_hospital_km"] = batch_min_dist(hospital_pts)
        sub = sub[sub["nearest_hospital_km"] <= 1.0]
        if sub.empty:
            return []

    if max_price_lakh is not None:
        sub = sub[sub["price_lakh"] <= max_price_lakh]
    if size_num is not None:
        sub = sub[sub["size_num"] == size_num]

    return sub.to_dict(orient="records")


# ─────────────────────────────────────────────
# Query parser  (single, authoritative version)
# ─────────────────────────────────────────────
def interpret_user_query(query: str) -> dict:
    """
    Rule-based parser. Returns a dict of filters.
    Named 'interpret_user_query'; no duplicate parsers.
    """
    q = query.lower().strip()

    # BHK
    m = re.search(r"(\d+)\s*-?\s*bhk", q)
    size_num = int(m.group(1)) if m else None

    # Price
    max_price_lakh = None
    m2 = re.search(r"(\d+(?:\.\d+)?)\s*(?:lakh|lac|l)\b", q)
    if m2:
        max_price_lakh = float(m2.group(1))
    if max_price_lakh is None:
        m3 = re.search(r"(?:under|below|less than)\s+(\d+(?:\.\d+)?)\b", q)
        if m3:
            max_price_lakh = float(m3.group(1))

    # Radius
    radius_km = 3.0
    m_rad = re.search(r"within\s+(\d+(?:\.\d+)?)\s*(?:km|kilometre|kilometer)\b", q)
    if m_rad:
        radius_km = float(m_rad.group(1))

    # Amenities
    must_near_hospital = bool(re.search(r"\bhospital\b", q))
    must_near_metro    = bool(re.search(r"\bmetro\b", q))
    must_near_bus      = bool(re.search(r"\bbus\b|\bbmtc\b|\bbus stop\b", q))
    must_near_school   = bool(re.search(r"\bschool\b|\bcollege\b", q))
    prefer_good_aqi    = bool(re.search(r"\baqi\b|\bair\b|\bpollution\b|\bclean air\b", q))

    # Location — "near X" beats "in X"
    place = None
    near_m = re.findall(r"near ([a-z][a-z\s]{1,30}?)(?:\s+with|\s+under|\s+close|$)", q)
    in_m   = re.findall(r"\bin ([a-z][a-z\s]{1,30}?)(?:\s+with|\s+under|\s+near|$)", q)
    raw    = (near_m or in_m or [""])[0]

    if raw:
        # Strip filter keywords that leaked in
        noise = r"\b(hospital|metro|school|bus stop|bus|under|bhk|lakh|price|near|in|with|close|good|aqi)\b"
        place = re.sub(noise, "", raw).strip()
        place = re.sub(r"\s+", " ", place).strip() or None

    if not place:
        tokens = query.split()
        if tokens:
            place = tokens[-1]

    return {
        "place":             place,
        "size_num":          size_num,
        "max_price_lakh":    max_price_lakh,
        "radius_km":         radius_km,
        "must_near_metro":   must_near_metro,
        "must_near_bus":     must_near_bus,
        "must_near_school":  must_near_school,
        "must_near_hospital":must_near_hospital,
        "prefer_good_aqi":   prefer_good_aqi,
    }


# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────
@app.route("/")
def home():
    return render_template("index.html")


@app.route("/houses")
def api_houses():
    try:
        out = houses_df[["latitude", "longitude", "location_text", "price_lakh", "size_num"]].copy()
        out = out.rename(columns={"location_text": "location"})
        return jsonify(out.head(500).to_dict(orient="records"))
    except Exception as e:
        app.logger.error(f"/houses error: {e}")
        return jsonify([])


@app.route("/aqi")
def api_aqi():
    return jsonify(aqi_pts)


@app.route("/bus")
def api_bus():
    return jsonify(bus_pts)


@app.route("/schools")
def api_schools():
    return jsonify(schools_geo)


@app.route("/metro")
def api_metro():
    return jsonify(metro_geo)


@app.route("/hospitals")
def api_hospitals():
    return jsonify(hospital_pts)


@app.route("/api/ai_query", methods=["POST"])
def api_ai_query():
    data = request.get_json(force=True) or {}
    query_text = data.get("query", "").strip()
    if not query_text:
        return jsonify({"error": "Empty query."}), 400

    filters = interpret_user_query(query_text)
    place   = filters["place"]

    if not place:
        return jsonify({"response": "Please specify a location, e.g. 'Find 2BHK under 60 lakh near Whitefield'."}), 400

    loc = geocode_place(place)
    if not loc:
        return jsonify({"error": f"Could not locate '{place}' on the map."}), 404

    raw_results = filter_houses_near(
        lat=loc["lat"],
        lon=loc["lon"],
        radius_km=filters["radius_km"],
        max_price_lakh=filters["max_price_lakh"],
        size_num=filters["size_num"],
        must_near_school=filters["must_near_school"],
        must_near_metro=filters["must_near_metro"],
        must_near_bus=filters["must_near_bus"],
        must_near_hospital=filters["must_near_hospital"],
        prefer_good_aqi=filters["prefer_good_aqi"],
    )

    # Human-readable summary
    parts = []
    if filters["size_num"]:          parts.append(f"{filters['size_num']}BHK")
    if filters["max_price_lakh"]:    parts.append(f"under ₹{filters['max_price_lakh']} Lakh")
    summary = " ".join(parts) if parts else "houses"

    if not raw_results:
        return jsonify({
            "action":   "filter",
            "data":     [],
            "count":    0,
            "response": f"No {summary} found near {place}. Try widening the radius or relaxing filters.",
        })

    resp = f"🏘️ Found {len(raw_results)} {summary} near {place}"
    if filters["must_near_metro"]:   resp += " (near metro)"
    if filters["must_near_bus"]:     resp += " (near bus stop)"
    if filters["must_near_school"]:  resp += " (near school)"
    if filters["must_near_hospital"]: resp += " (near hospital)"
    if filters["prefer_good_aqi"]:   resp += " (good air quality)"
    resp += "."

    # Build serialisable result list with vectorised amenity distances
    # Compute all amenity distances in one pass per amenity list for the top-50 slice
    top50 = raw_results[:50]
    lats  = np.array([h["latitude"]  for h in top50])
    lons  = np.array([h["longitude"] for h in top50])

    def batch_nearest(pts):
        if not pts:
            return [(None, "")] * len(top50)
        arr_lat = np.array([p["lat"] for p in pts])
        arr_lon = np.array([p["lon"] for p in pts])
        results_inner = []
        for la, lo in zip(lats, lons):
            dists = haversine_fast(la, lo, arr_lat, arr_lon)
            idx   = int(np.argmin(dists))
            results_inner.append((round(float(dists[idx]), 2), pts[idx].get("name", "")))
        return results_inner

    school_near   = batch_nearest(schools_pts)
    metro_near    = batch_nearest(metro_pts)
    bus_near      = batch_nearest(bus_pts)
    hospital_near = batch_nearest(hospital_pts)

    # AQI: use aqi field from nearest aqi_pt
    def batch_nearest_aqi():
        if not aqi_pts:
            return [None] * len(top50)
        arr_lat = np.array([p["lat"] for p in aqi_pts])
        arr_lon = np.array([p["lon"] for p in aqi_pts])
        out = []
        for la, lo in zip(lats, lons):
            dists = haversine_fast(la, lo, arr_lat, arr_lon)
            idx   = int(np.argmin(dists))
            out.append(aqi_pts[idx].get("aqi"))
        return out

    aqi_vals = batch_nearest_aqi()

    results = []
    for i, h in enumerate(top50):
        lat = float(h["latitude"])
        lon = float(h["longitude"])
        results.append({
            "latitude":             lat,
            "longitude":            lon,
            "location":             str(h.get("location_text", "")),
            "price_lakh":           h.get("price_lakh"),
            "size_num":             h.get("size_num"),
            "nearest_school_km":    school_near[i][0],
            "nearest_school_name":  school_near[i][1],
            "nearest_metro_km":     metro_near[i][0],
            "nearest_metro_name":   metro_near[i][1],
            "nearest_bus_km":       bus_near[i][0],
            "nearest_bus_name":     bus_near[i][1],
            "nearest_hospital_km":  hospital_near[i][0],
            "nearest_hospital_name":hospital_near[i][1],
            "nearest_aqi_val":      aqi_vals[i],
            "livability_score":     compute_livability_score(lat, lon),
        })

    return jsonify({
        "action":   "filter",
        "data":     results,
        "count":    len(raw_results),
        "response": resp,
    })


# ─────────────────────────────────────────────
if __name__ == "__main__":
    app.run(debug=True)