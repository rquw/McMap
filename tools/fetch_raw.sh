#!/bin/zsh
# Pull the raw OSM extracts into build/*.csv, then run tools/build_dataset.py.
# QLever instead of Overpass: one query for the whole planet in seconds.
set -e
cd "$(dirname "$0")/.."
mkdir -p build

EP="https://qlever.dev/api/osm-planet"
BRAND='{ ?s <https://www.openstreetmap.org/wiki/Key:brand:wikidata> "Q38076" } UNION { ?s <https://www.openstreetmap.org/wiki/Key:brand> "McDonald'"'"'s" }'

runq() {  # runq <sparql> <out.csv>
  print -n "  $2 ... "
  curl -sL -m 900 -H "Accept: text/csv" -H "Content-Type: application/sparql-query" \
    --data-binary "$1" "$EP" -o "build/$2" -w "%{http_code}  %{size_download}B\n"
}

# 1. restaurants + geometry
runq "PREFIX geo: <http://www.opengis.net/ont/geosparql#>
SELECT ?s ?wkt WHERE { $BRAND ?s geo:hasGeometry/geo:asWKT ?wkt . }" core.csv

# 2. tags the app shows
for TAG in name addr:street addr:housenumber addr:city opening_hours phone \
           drive_through internet_access outdoor_seating; do
  runq "SELECT ?s ?v WHERE { $BRAND ?s <https://www.openstreetmap.org/wiki/Key:$TAG> ?v . }" \
       "tag_${TAG//:/_}.csv"
done

# 3. enclosing admin boundaries + size (smallest per level wins)
runq 'PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX ogc: <http://www.opengis.net/rdf#>
PREFIX osm2rdf: <https://osm2rdf.cs.uni-freiburg.de/rdf#>
SELECT ?poi ?lvl ?nm ?ar WHERE {
  ?poi osmkey:brand:wikidata "Q38076" .
  ?poi ogc:sfIntersects ?a .
  ?a osmkey:admin_level ?lvl .
  ?a osmkey:name ?nm .
  ?a osmkey:boundary "administrative" .
  ?a osm2rdf:area ?ar .
  FILTER(?lvl >= 2 && ?lvl <= 10)
}' admin_area.csv

# 4. country names + ISO codes
runq 'PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
SELECT ?nm ?iso ?en ?de WHERE {
  ?a osmkey:admin_level 2 .
  ?a osmkey:boundary "administrative" .
  ?a osmkey:name ?nm .
  ?a <https://www.openstreetmap.org/wiki/Key:ISO3166-1:alpha2> ?iso .
  OPTIONAL { ?a <https://www.openstreetmap.org/wiki/Key:name:en> ?en }
  OPTIONAL { ?a <https://www.openstreetmap.org/wiki/Key:name:de> ?de }
}' countries_osm.csv

print "\ndone — now run: python3 tools/build_dataset.py"
