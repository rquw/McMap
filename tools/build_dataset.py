#!/usr/bin/env python3
"""Build the bundled dataset from the raw QLever CSVs in build/.

Run tools/fetch_raw.sh first. Output is columnar (parallel arrays + string
tables) rather than one object per restaurant: about half the bytes and much
faster to parse.
"""

import csv, json, math, os, re, sys, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, 'build')
OUT = os.path.join(ROOT, 'data', 'mcdonalds.json')

csv.field_size_limit(10 ** 8)


def rows(name):
    path = os.path.join(BUILD, name)
    if not os.path.exists(path):
        print('  ! missing %s' % name)
        return
    with open(path, newline='', encoding='utf-8') as f:
        r = csv.reader(f)
        next(r, None)
        for row in r:
            if row:
                yield row


IRI = re.compile(r'/(node|way|relation)/(\d+)$')


def poi_id(iri):
    m = IRI.search(iri)
    if not m:
        return None
    return m.group(1)[0] + m.group(2)      # n123 / w123 / r123


# ---------------------------------------------------------------- geometry

NUMPAIR = re.compile(r'(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)')


def centroid(wkt):
    """Centre of a WKT geometry: shoelace centroid, vertex mean if degenerate."""
    if wkt.startswith('POINT'):
        m = NUMPAIR.search(wkt)
        return (float(m.group(1)), float(m.group(2))) if m else None

    pts = [(float(a), float(b)) for a, b in NUMPAIR.findall(wkt)]
    if not pts:
        return None
    if len(pts) < 3:
        return pts[0]

    a2 = cx = cy = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        cross = x0 * y1 - x1 * y0
        a2 += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a2) < 1e-12:
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    return (cx / (3 * a2), cy / (3 * a2))


def haversine(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    dla, dlo = (lat2 - lat1) * p, (lon2 - lon1) * p
    x = (math.sin(dla / 2) ** 2 +
         math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin(dlo / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(x))


# ---------------------------------------------------------------- load

print('reading geometry...')
pois = {}
for iri, wkt in ((r[0], r[1]) for r in rows('core.csv') if len(r) >= 2):
    pid = poi_id(iri)
    if not pid or pid in pois:
        continue
    c = centroid(wkt)
    if not c:
        continue
    lon, lat = c
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        continue
    pois[pid] = {'id': pid, 'lat': lat, 'lon': lon}
print('  %d restaurants' % len(pois))

TAGS = {
    'name': 'tag_name.csv',
    'street': 'tag_addr_street.csv',
    'hn': 'tag_addr_housenumber.csv',
    'addrcity': 'tag_addr_city.csv',
    'oh': 'tag_opening_hours.csv',
    'phone': 'tag_phone.csv',
    'drive': 'tag_drive_through.csv',
    'wifi': 'tag_internet_access.csv',
    'outdoor': 'tag_outdoor_seating.csv',
}

print('reading tags...')
for key, fname in TAGS.items():
    n = 0
    for r in rows(fname):
        if len(r) < 2:
            continue
        pid = poi_id(r[0])
        p = pois.get(pid)
        if p is None or key in p:
            continue
        p[key] = r[1].strip()
        n += 1
    print('  %-9s %d' % (key, n))

# ---------------------------------------------------------------- admin

print('reading admin boundaries...')
# overlapping boundaries are common; the smallest is the real local unit
best = collections.defaultdict(lambda: collections.defaultdict(list))
for r in rows('admin_area.csv'):
    if len(r) < 4:
        continue
    pid = poi_id(r[0])
    if pid not in pois:
        continue
    try:
        lvl, area = int(r[1]), float(r[3])
    except ValueError:
        continue
    name = r[2].strip()
    if not name:
        continue
    best[pid][lvl].append((area, name))

print('  %d restaurants have boundary data' % len(best))

# country name -> ISO alpha-2 (+ display names)
iso_by_name, country_meta = {}, {}
for r in rows('countries_osm.csv'):
    if len(r) < 2:
        continue
    nm, iso = r[0].strip(), r[1].strip().upper()
    en = r[2].strip() if len(r) > 2 and r[2].strip() else nm
    de = r[3].strip() if len(r) > 3 and r[3].strip() else en
    if not nm or len(iso) != 2:
        continue
    iso_by_name[nm] = iso
    country_meta.setdefault(iso, {'local': nm, 'en': en, 'de': de})

REGION_LEVELS = (4, 5, 3, 6)
# city = level 8 usually, 6-7 sometimes. City-states (Wien, Berlin, Singapore)
# have nothing below 4, hence the last resort.
CITY_LEVELS = (8, 7, 6, 4)
DISTRICT_LEVELS = (9, 10)

# AT uses level 10 for cadastral parcels, not neighbourhoods
DISTRICT_SKIP = re.compile(r'^(katastralgemeinde|gemarkung|cadastral)\b', re.I)

# territorial waters are level 2 with no ISO code, so take the smallest
# candidate that actually names a country
ISO_FALLBACK = {
    '中華民國12浬領海外界線': 'TW',
    '中華民國': 'TW',
    '臺灣': 'TW',
    'España (mar territorial)': 'ES',
    'Portugal (águas territoriais)': 'PT',
    'France, La Réunion (eaux territoriales)': 'RE',
    'France, Polynésie française (eaux territoriales)': 'PF',
    'United States of America (Guam)': 'GU',
    'United States of America (CNMI)': 'MP',
    'United States of America (American Samoa)': 'AS',
}

missing_iso = collections.Counter()
for pid, p in pois.items():
    lv = best.get(pid, {})

    iso = ''
    for area, cname in sorted(lv.get(2, [])):
        iso = iso_by_name.get(cname) or ISO_FALLBACK.get(cname) or ''
        if iso:
            break
    if not iso and lv.get(2):
        missing_iso[sorted(lv[2])[0][1]] += 1
    p['cc'] = iso

    for key, levels in (('region', REGION_LEVELS), ('city', CITY_LEVELS),
                        ('district', DISTRICT_LEVELS)):
        for L in levels:
            names = sorted(lv.get(L, []))
            if key == 'district':
                names = [x for x in names if not DISTRICT_SKIP.match(x[1])]
            if names:
                p[key] = names[0][1]
                break
    if 'city' not in p and p.get('addrcity'):
        p['city'] = p['addrcity']

if missing_iso:
    print('  ! country names with no ISO code:')
    for nm, k in missing_iso.most_common(10):
        print('      %6d  %s' % (k, nm))

print('  attributed: %d country, %d region, %d city' % (
    sum(1 for p in pois.values() if p.get('cc')),
    sum(1 for p in pois.values() if p.get('region')),
    sum(1 for p in pois.values() if p.get('city'))))
print('  district: %d' % sum(1 for p in pois.values() if p.get('district')))

# ---------------------------------------------------------------- dedupe

# node + its building way = same restaurant twice. Keep the node; the app
# applies the same rule so ids stay stable.
print('deduping...')
grid = collections.defaultdict(list)
for p in pois.values():
    grid[(round(p['lat'] * 1000), round(p['lon'] * 1000))].append(p)

drop = set()
for p in sorted(pois.values(), key=lambda q: q['id']):
    if p['id'] in drop or p['id'][0] != 'n':
        continue
    la, lo = round(p['lat'] * 1000), round(p['lon'] * 1000)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for q in grid[(la + dy, lo + dx)]:
                if q['id'][0] == 'n' or q['id'] in drop:
                    continue
                if haversine(p['lat'], p['lon'], q['lat'], q['lon']) < 40:
                    # keep the way's richer tags
                    for k, v in q.items():
                        p.setdefault(k, v)
                    drop.add(q['id'])
print('  dropped %d duplicate ways/relations' % len(drop))

kept = [p for p in pois.values() if p['id'] not in drop]
kept.sort(key=lambda p: (p['lat'], p['lon']))
print('  %d restaurants kept' % len(kept))

# ---------------------------------------------------------------- encode

class Table:
    """Interns repeated strings; 0 means absent."""
    def __init__(self):
        self.items, self.index = [''], {'': 0}

    def add(self, s):
        if not s:
            return 0
        i = self.index.get(s)
        if i is None:
            i = len(self.items)
            self.index[s] = i
            self.items.append(s)
        return i


countries, regions, cities, districts = Table(), Table(), Table(), Table()
streets, hours, hnums = Table(), Table(), Table()

ids, types, lats, lons = [], [], [], []
ccs, regs, cits, dists = [], [], [], []
strs, hns, ohs, flags, names = [], [], [], [], []

DEFAULT_NAME = "McDonald's"

for p in kept:
    ids.append(int(p['id'][1:]))
    types.append(p['id'][0])
    lats.append(round(p['lat'] * 1e5))
    lons.append(round(p['lon'] * 1e5))
    ccs.append(countries.add(p.get('cc', '')))
    regs.append(regions.add(p.get('region', '')))
    cits.append(cities.add(p.get('city', '')))
    dists.append(districts.add(p.get('district', '')))

    strs.append(streets.add(p.get('street', '')))
    hns.append(hnums.add(p.get('hn', '')))
    ohs.append(hours.add(p.get('oh', '')))
    nm = p.get('name', '') or ''
    names.append('' if nm == DEFAULT_NAME else nm)
    f = 0
    if p.get('drive') == 'yes':
        f |= 1
    if p.get('wifi') in ('wlan', 'yes'):
        f |= 2
    if p.get('outdoor') == 'yes':
        f |= 4
    flags.append(f)


def delta(seq):
    """Latitude-sorted, so deltas stay small. Worth about a third of the file."""
    out, prev = [], 0
    for v in seq:
        out.append(v - prev)
        prev = v
    return out


STAMP = datetime.date.today().isoformat()
SOURCE = 'OpenStreetMap via QLever (qlever.dev/api/osm-planet)'

# core: pins + counts, loaded before first paint
core = {
    'v': 1,
    'generated': STAMP,
    'source': SOURCE,
    'n': len(kept),
    'countryMeta': {iso: country_meta[iso] for iso in countries.items[1:] if iso in country_meta},
    'countries': countries.items,
    'regions': regions.items,
    'cities': cities.items,
    'districts': districts.items,
    'type': ''.join(types),
    'id': ids,
    'lat': delta(lats),
    'lon': lons,
    'cc': ccs,
    'region': regs,
    'city': cits,
    'district': dists,
}

# details: only needed once a pin is opened
details = {
    'v': 1,
    'generated': STAMP,
    'n': len(kept),
    'streets': streets.items,
    'hnums': hnums.items,
    'hours': hours.items,
    'street': strs,
    'hn': hns,
    'oh': ohs,
    'flag': flags,
    'name': names,
}

os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
import gzip
for name, blob in (('mcdonalds.json', core), ('mcdonalds-details.json', details)):
    path = os.path.join(ROOT, 'data', name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(blob, f, ensure_ascii=False, separators=(',', ':'))
    raw = os.path.getsize(path)
    gz = len(gzip.compress(open(path, 'rb').read(), 6))
    print('wrote data/%-26s %6.2f MB raw   %5.2f MB gzipped' % (name, raw / 1e6, gz / 1e6))

by_cc = collections.Counter(p.get('cc', '??') for p in kept)
print('countries with data: %d' % len(by_cc))
print('top:', ', '.join('%s=%d' % (c, n) for c, n in by_cc.most_common(10)))
