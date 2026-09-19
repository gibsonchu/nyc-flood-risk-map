"""Turn the R pipeline's BBL-level flood outputs into static assets the map can stream.

Inputs come from the "flood maps - for gibson" research folder:
  outputs/FloodChat Outputs/bbl_level_data.csv      one row per tax lot, flood flags + lat/lon
  intermediates/coastal_1pct_floodrisk_properties.csv  FEMA 1% annual-chance lots
  outputs/FloodChat Outputs/{ZIP,borough,parent_NH,detailed_NH}_level_data.csv
  inputs/NYC Neighborhoods and Zip Codes - Sheet1.csv

Outputs (data/):
  meta.json            counts, bbox, scenario + code dictionaries
  points.bin           lat/lon (quantised u16), flags (u16), attrs (u8) for mapped lots
  details/d###.json    address/BBL/zip per lot, sharded by index >> 12
  bbl/b###.json        BBL -> lot index, sharded by BBL % 256 (search uses this)
  zips.json            per-ZIP shares + neighbourhood names
  zips.geojson         simplified ZCTA polygons for the NYC ZIPs we have data for
  neighborhoods.json   parent / detailed neighbourhood shares
"""
import csv, json, math, os, sys, collections

csv.field_size_limit(1 << 30)

SRC = "/Users/gibson/Downloads/flood maps - for gibson"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
ZCTA_SRC = "/private/tmp/claude-501/-Users-gibson-ClaudeCode/af067af0-ba40-46c8-b872-5da9d2e2b2fd/scratchpad/ny_zips.json"

DETAIL_SHIFT = 12          # 4096 lots per detail shard
BBL_SHARDS = 256

BOROS = {"MN": "Manhattan", "BX": "Bronx", "BK": "Brooklyn", "QN": "Queens", "SI": "Staten Island"}

# ── flag bits ──────────────────────────────────────────────────────────────
FLAG = {
    "ext1": 1 << 0, "ext2": 1 << 1, "ext3": 1 << 2,
    "mod1": 1 << 3, "mod2": 1 << 4,
    "slr1": 1 << 5, "slr2": 1 << 6, "slr3": 1 << 7,
    "coastal": 1 << 8, "coastalV": 1 << 9,
}
COL = {
    "ext1": "Extreme_Flooding_Category_1", "ext2": "Extreme_Flooding_Category_2",
    "ext3": "Extreme_Flooding_Category_3",
    "mod1": "Moderate_Flooding_Category_1", "mod2": "Moderate_Flooding_Category_2",
    "slr1": "Moderate_with_SLR_Flooding_Category_1",
    "slr2": "Moderate_with_SLR_Flooding_Category_2",
    "slr3": "Moderate_with_SLR_Flooding_Category_3",
}

# ── Hilbert curve, so that lots near each other on the map land in the same
#    detail shard and a click rarely costs more than one extra fetch ────────
def hilbert_d(order, x, y):
    rx = ry = 0
    d = 0
    s = order // 2
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
        s //= 2
    return d


def load_coastal():
    zones = {}
    with open(os.path.join(SRC, "intermediates/coastal_1pct_floodrisk_properties.csv")) as f:
        for row in csv.DictReader(f):
            bbl = row["BBL"]
            z = row["FLD_ZONE"]
            # VE (wave action) is the more severe designation; let it win on ties
            if z == "VE" or bbl not in zones:
                zones[bbl] = z
    return zones


def load_neighborhoods():
    """parent neighbourhood / sub-neighbourhood per ZIP, mirroring 3_neighborhood_agg.R."""
    path = os.path.join(SRC, "inputs/NYC Neighborhoods and Zip Codes - Sheet1.csv")
    out = {}
    parent = None
    with open(path) as f:
        for row in csv.reader(f):
            row = (row + ["", "", ""])[:3]
            p, sub, zips = (c.strip() for c in row)
            if p:
                parent = p
            if not zips:
                continue
            zips = zips.replace("*", "").strip()
            if not zips or parent in (None, "Rikers Island"):
                continue
            for z in [z.strip() for z in zips.split(",") if z.strip()]:
                if z == "10463":       # dropped upstream for duplicate assignment
                    continue
                out[z] = {"parent": parent, "detailed": sub or parent}
    return out


def read_agg(path, key):
    rows = {}
    with open(os.path.join(SRC, path)) as f:
        for row in csv.DictReader(f):
            rec = {"n": int(float(row["n"]))}
            for k, c in COL.items():
                v = row.get("avg_" + c)
                rec[k] = round(float(v), 5) if v not in (None, "", "NA") else 0.0
            for short, c in (("anyExt", "Any_Extreme_Flooding"),
                             ("anyMod", "Any_Moderate_Flooding"),
                             ("anySlr", "Any_Moderate_with_SLR_Flooding")):
                v = row.get("avg_" + c)
                rec[short] = round(float(v), 5) if v not in (None, "", "NA") else 0.0
            rows[row[key]] = rec
    return rows


def main():
    os.makedirs(os.path.join(OUT, "details"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "bbl"), exist_ok=True)

    coastal = load_coastal()
    nb = load_neighborhoods()

    print("reading lot-level data…")
    lots = []
    src = os.path.join(SRC, "outputs/FloodChat Outputs/bbl_level_data.csv")
    with open(src) as f:
        for row in csv.DictReader(f):
            flags = 0
            for k, c in COL.items():
                if row[c] == "1":
                    flags |= FLAG[k]
            bbl = row["BBL"]
            z = coastal.get(bbl)
            if z:
                flags |= FLAG["coastal"]
                if z == "VE":
                    flags |= FLAG["coastalV"]

            def num(v, default=0):
                try:
                    return int(float(v))
                except (TypeError, ValueError):
                    return default

            bsmt = num(row["BsmtCode"], 5)
            if bsmt < 0 or bsmt > 5:
                bsmt = 5
            lu = num(row["LandUse"], 0)
            if lu < 0 or lu > 11:
                lu = 0
            attr = bsmt | (lu << 3)

            try:
                lat = float(row["latitude"]); lon = float(row["longitude"])
                if not (40.4 < lat < 41.0 and -74.3 < lon < -73.6):
                    lat = lon = None
            except (TypeError, ValueError):
                lat = lon = None

            lots.append({
                "bbl": bbl, "boro": row["Borough"], "block": num(row["Block"]),
                "lot": num(row["Lot"]), "zip": row["ZipCode"].strip(),
                "addr": row["Address"].strip(), "flags": flags, "attr": attr,
                "lat": lat, "lon": lon,
            })
    print(f"  {len(lots):,} lots")

    mapped = [l for l in lots if l["lat"] is not None]
    unmapped = [l for l in lots if l["lat"] is None]
    print(f"  {len(mapped):,} mapped, {len(unmapped):,} without coordinates")

    lat0 = min(l["lat"] for l in mapped); lat1 = max(l["lat"] for l in mapped)
    lon0 = min(l["lon"] for l in mapped); lon1 = max(l["lon"] for l in mapped)

    print("sorting along a Hilbert curve…")
    ORDER = 1 << 16
    dlat = (lat1 - lat0) or 1.0
    dlon = (lon1 - lon0) or 1.0
    for l in mapped:
        qy = min(ORDER - 1, int((l["lat"] - lat0) / dlat * (ORDER - 1)))
        qx = min(ORDER - 1, int((l["lon"] - lon0) / dlon * (ORDER - 1)))
        l["qx"], l["qy"] = qx, qy
        l["h"] = hilbert_d(ORDER, qx, qy)
    mapped.sort(key=lambda l: l["h"])
    ordered = mapped + unmapped

    # ── points.bin ────────────────────────────────────────────────────────
    import array
    n = len(mapped)
    qlat = array.array("H", (l["qy"] for l in mapped))
    qlon = array.array("H", (l["qx"] for l in mapped))
    fl = array.array("H", (l["flags"] for l in mapped))
    at = array.array("B", (l["attr"] for l in mapped))
    for a in (qlat, qlon, fl):
        if sys.byteorder == "big":
            a.byteswap()
    with open(os.path.join(OUT, "points.bin"), "wb") as f:
        f.write(qlat.tobytes()); f.write(qlon.tobytes())
        f.write(fl.tobytes()); f.write(at.tobytes())
    print(f"  points.bin {os.path.getsize(os.path.join(OUT,'points.bin'))/1e6:.1f} MB")

    # ── detail shards ─────────────────────────────────────────────────────
    print("writing detail shards…")
    shard = collections.defaultdict(list)
    for i, l in enumerate(ordered):
        # borough / block / lot are all recoverable from the 10-digit BBL, so they stay out
        shard[i >> DETAIL_SHIFT].append([l["addr"], l["zip"], l["bbl"], l["flags"], l["attr"]])
    for sid, rows in shard.items():
        with open(os.path.join(OUT, "details", f"d{sid}.json"), "w") as f:
            json.dump(rows, f, separators=(",", ":"))
    print(f"  {len(shard)} shards")

    # ── BBL -> index shards (address search resolves to a BBL) ────────────
    # A tax lot can carry many buildings (condo complexes run to 200+), so a BBL
    # maps to a bare index when it is alone and to a list when it is not.
    print("writing BBL index…")
    bshard = collections.defaultdict(lambda: collections.defaultdict(list))
    for i, l in enumerate(ordered):
        bshard[int(l["bbl"]) % BBL_SHARDS][l["bbl"]].append(i)
    for sid in range(BBL_SHARDS):
        entries = {k: (v[0] if len(v) == 1 else v) for k, v in bshard.get(sid, {}).items()}
        with open(os.path.join(OUT, "bbl", f"b{sid}.json"), "w") as f:
            json.dump(entries, f, separators=(",", ":"))

    # ── aggregates ────────────────────────────────────────────────────────
    print("writing aggregates…")
    zips = read_agg("outputs/FloodChat Outputs/ZIP_level_data.csv", "ZipCode")
    zip_boro = {}
    zip_center = {}
    acc = collections.defaultdict(lambda: [0.0, 0.0, 0])
    for l in ordered:
        if l["zip"]:
            zip_boro.setdefault(l["zip"], collections.Counter())[l["boro"]] += 1
            if l["lat"] is not None:
                a = acc[l["zip"]]
                a[0] += l["lat"]; a[1] += l["lon"]; a[2] += 1
    zout = {}
    for z, rec in zips.items():
        if z in ("0", "", "NA") or len(z) != 5:
            continue
        rec = dict(rec)
        rec["boro"] = zip_boro[z].most_common(1)[0][0] if z in zip_boro else ""
        info = nb.get(z)
        if info:
            rec["parent"] = info["parent"]; rec["detailed"] = info["detailed"]
        if z in acc and acc[z][2]:
            a = acc[z]
            rec["c"] = [round(a[1] / a[2], 5), round(a[0] / a[2], 5)]
        zout[z] = rec
    json.dump(zout, open(os.path.join(OUT, "zips.json"), "w"), separators=(",", ":"))

    hoods = {
        "parent": read_agg("outputs/FloodChat Outputs/parent_NH_level_data.csv", "parent_NH"),
        "detailed": read_agg("outputs/FloodChat Outputs/detailed_NH_level_data.csv", "detailed_NH"),
        "borough": read_agg("outputs/FloodChat Outputs/borough_level_data.csv", "Borough"),
    }
    # which ZIPs make up each neighbourhood, so the list can zoom to one
    zips_for = collections.defaultdict(list)
    for z, info in nb.items():
        if z in zout:
            zips_for[info["parent"]].append(z)
    for name, rec in hoods["parent"].items():
        rec["zips"] = sorted(zips_for.get(name, []))
    json.dump(hoods, open(os.path.join(OUT, "neighborhoods.json"), "w"), separators=(",", ":"))

    # ── ZIP polygons ──────────────────────────────────────────────────────
    print("simplifying ZIP polygons…")
    gj = json.load(open(ZCTA_SRC))
    feats = []
    for ft in gj["features"]:
        z = ft["properties"].get("ZCTA5CE10")
        if z not in zout:
            continue
        g = simplify_geom(ft["geometry"], 0.00035)
        if g is None:
            continue
        feats.append({"type": "Feature", "id": z,
                      "properties": {"z": z}, "geometry": g})
    json.dump({"type": "FeatureCollection", "features": feats},
              open(os.path.join(OUT, "zips.geojson"), "w"), separators=(",", ":"))
    print(f"  {len(feats)} ZIP polygons, "
          f"{os.path.getsize(os.path.join(OUT,'zips.geojson'))/1e6:.1f} MB")

    # ── meta ──────────────────────────────────────────────────────────────
    counts = collections.Counter()
    lot_counts = collections.Counter()
    seen_bbl = set()
    for l in ordered:
        if l["bbl"] not in seen_bbl:
            seen_bbl.add(l["bbl"])
            lot_counts["total"] += 1
            if l["flags"] & (FLAG["ext1"] | FLAG["ext2"] | FLAG["ext3"]):
                lot_counts["anyExt"] += 1
        for k, bit in FLAG.items():
            if l["flags"] & bit:
                counts[k] += 1
        if l["flags"] & (FLAG["ext1"] | FLAG["ext2"] | FLAG["ext3"]):
            counts["anyExt"] += 1
        if l["flags"] & (FLAG["mod1"] | FLAG["mod2"]):
            counts["anyMod"] += 1
        if l["flags"] & (FLAG["slr1"] | FLAG["slr2"] | FLAG["slr3"]):
            counts["anySlr"] += 1
        # below-grade basement inside an extreme-flood footprint
        if (l["flags"] & (FLAG["ext1"] | FLAG["ext2"] | FLAG["ext3"])) and (l["attr"] & 7) in (2, 4):
            counts["bsmtExt"] += 1

    meta = {
        "total": len(ordered), "mapped": n, "lots": lot_counts["total"],
        "lotsAnyExt": lot_counts["anyExt"],
        "bbox": [lon0, lat0, lon1, lat1],
        "detailShift": DETAIL_SHIFT, "bblShards": BBL_SHARDS,
        "counts": dict(counts),
        "boros": BOROS,
        "bsmt": {0: "No basement", 1: "Full basement, above grade",
                 2: "Full basement, below grade", 3: "Partial basement, above grade",
                 4: "Partial basement, below grade", 5: "Unknown"},
        "landuse": {1: "One & two family", 2: "Multi-family walk-up",
                    3: "Multi-family elevator", 4: "Mixed residential & commercial",
                    5: "Commercial & office", 6: "Industrial & manufacturing",
                    7: "Transportation & utility", 8: "Public facilities & institutions",
                    9: "Open space & recreation", 10: "Parking", 11: "Vacant land",
                    0: "Unknown"},
    }
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    print(json.dumps(meta["counts"], indent=1))


# ── Douglas–Peucker on lon/lat, keeps rings closed ─────────────────────────
def _dp(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dx * (ay - py) - (ax - px) * dy) / den if den else math.hypot(px - ax, py - ay)
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack.append((a, bi)); stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def _ring(ring, tol):
    pts = [(round(x, 5), round(y, 5)) for x, y in ring]
    out = _dp(pts, tol)
    if len(out) < 4:
        return None
    if out[0] != out[-1]:
        out.append(out[0])
    return [list(p) for p in out]


def simplify_geom(geom, tol):
    t = geom["type"]
    if t == "Polygon":
        polys = [geom["coordinates"]]
    elif t == "MultiPolygon":
        polys = geom["coordinates"]
    else:
        return None
    out = []
    for poly in polys:
        rings = []
        for i, ring in enumerate(poly):
            r = _ring(ring, tol)
            if r is None:
                if i == 0:
                    rings = []
                    break
                continue
            rings.append(r)
        if rings:
            out.append(rings)
    if not out:
        return None
    return {"type": "Polygon", "coordinates": out[0]} if len(out) == 1 \
        else {"type": "MultiPolygon", "coordinates": out}


if __name__ == "__main__":
    main()
