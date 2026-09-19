# NYC Flood Risk Map

An interactive map of flood risk for every building in New York City. Search an address,
click a dot, or browse the whole city under three storm scenarios.

**908,000 buildings · 857,000 tax lots · 3 stormwater models · FEMA coastal zones**

## What it does

- **Search any NYC address.** Geocoded through NYC Planning Labs GeoSearch, resolved to a
  tax lot (BBL), and matched against the building-level flood file. The card reports the
  flood category for all three scenarios, the FEMA coastal designation, the basement grade,
  the land use, and how the surrounding ZIP compares.
- **Explore the dot map.** Every mapped building is drawn, coloured by the worst category
  that applies under the chosen scenario — future high tide, deep and contiguous flooding,
  nuisance flooding, or none.
- **Switch scenarios.** Extreme storm (3.66 in/hr + 2080 sea level), moderate storm with
  2050 seas, and moderate storm at today's sea level. The difference between them is the
  point of the map: 31% of buildings under the extreme storm, 5% under today's moderate one.
- **Narrow it down.** Filter by land use, or isolate buildings with a **below-grade
  basement** inside a flood footprint — 140,032 of them citywide under the extreme storm.
  Eleven of the thirteen people who died in New York during Hurricane Ida drowned in
  basement apartments.
- **Overlay FEMA's coastal zone.** A violet halo marks lots in the 1%-annual-chance flood
  zone — storm surge, a separate hazard from rainfall.
- **Switch to neighbourhoods.** A ZIP-level choropleth of the share of tax lots inside the
  flood area, with a ranked list of the most exposed neighbourhoods.

## Data

| Source | Used for |
| --- | --- |
| NYC DEP / Mayor's Office of Climate & Environmental Justice — Stormwater Flood Maps | Flood footprints and categories for all three scenarios |
| NYC Department of City Planning — MapPLUTO 24v4.1 | Tax-lot geometry, address, land use, basement grade |
| NYC DOB — Building Elevation and Subgrade (BES) | Per-building coordinates |
| FEMA — Preliminary FIRM database, 30 Jan 2015 | 1%-annual-chance and VE coastal zones |
| US Census (via OpenDataDE) | ZCTA boundaries |
| NYC Planning Labs GeoSearch | Address autocomplete |

The spatial overlay of flood footprints onto tax lots was done in R by Mythili Vinnakota
and Anna Weber; `tools/build_data.py` turns those outputs into the static assets this site
streams. A lot is flagged for a category when any part of it intersects that category's
footprint, so a large lot can be flagged when the building on it is not.

**This is not a flood-insurance determination.** For an official one use
[FEMA's Map Service Center](https://msc.fema.gov/portal/home); for what to do about flood
risk, see [FloodHelpNY](https://www.floodhelpny.org/).

## How it is built

A static site — no framework, no build step. MapLibre GL for the basemap and the ZIP
choropleth, deck.gl for the 859,351 building points.

```
index.html          markup
app.js              all behaviour
style.css           all styling
tools/build_data.py builds data/ from the research folder
data/
  meta.json         counts, bbox, code dictionaries
  points.bin        6 bytes per mapped building: lat/lon (u16), flags (u16), attrs (u8)
  details/d###.json address, ZIP, BBL — sharded by index >> 12
  bbl/b###.json     BBL → building index, sharded by BBL % 256 (search path)
  zips.json         per-ZIP shares and neighbourhood names
  zips.geojson      simplified ZCTA polygons
  neighborhoods.json  parent / detailed neighbourhood shares
```

Buildings are sorted along a Hilbert curve before sharding, so buildings near each other on
the map land in the same detail shard and clicking around rarely costs more than one fetch.
Coordinates are quantised to 16 bits over the city bounding box — about 0.7 m, finer than
the building centroids themselves.

## Running it

```bash
python3 serve.py
```

Then open http://localhost:8765.

To rebuild `data/` from the research folder, point `SRC` in `tools/build_data.py` at it and:

```bash
python3 tools/build_data.py
```
