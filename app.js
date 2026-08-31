/* ============================================================
   McMap — every McDonald's on Earth, on one map.

   Every restaurant ships with the app (data/mcdonalds.json, built by
   tools/build_dataset.py from OpenStreetMap). Nothing is queried while you
   browse: pins, totals and progress are all computed locally, so the numbers
   appear the moment you move the map. The only network call during use is the
   optional boundary outline, and that never blocks anything.
   ============================================================ */
(function () {
  'use strict';

  var CONT = window.MCMAP_CONTINENTS;
  var I18N = window.MCMAP_I18N;

  var LS_KEY = 'mcmap.v1';
  var LS_THEME = 'mcmap.theme';
  var LS_LANG = 'mcmap.lang';

  var MAX_PINS = 500;   // beyond this the view becomes dots instead of pins
  var DOT_PAD = 0.25;   // extra canvas around the viewport, so dragging doesn't tear

  /* ---------------------------------------------------------
     helpers
     --------------------------------------------------------- */

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function haversine(a, b, c, d) {
    var R = 6371000, p = Math.PI / 180;
    var dLat = (c - a) * p, dLon = (d - b) * p;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a * p) * Math.cos(c * p) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  /* ---------------------------------------------------------
     language
     --------------------------------------------------------- */

  var lang = 'en';
  var T = I18N.en;

  function pickLang() {
    var saved;
    try { saved = localStorage.getItem(LS_LANG); } catch (e) {}
    if (saved && I18N[saved]) return saved;
    var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return I18N[nav] ? nav : 'en';
  }

  function setLang(next, redraw) {
    if (!I18N[next]) return;
    lang = next;
    T = I18N[next];
    document.documentElement.lang = next;
    try { localStorage.setItem(LS_LANG, next); } catch (e) {}
    applyStaticText();
    if (redraw) {
      syncPanelState();
      if (openIdx >= 0) renderFacts(openIdx);
      if (sheet.classList.contains('is-open')) openSheet();
      searchIndex = null;   // country names are localised
      updateProgress();
    }
  }

  function applyStaticText() {
    var si = document.getElementById('searchInput');
    if (si) si.placeholder = T.searchPlaceholder;
    document.querySelectorAll('[data-t]').forEach(function (el) {
      var v = T[el.dataset.t];
      if (typeof v === 'string') {
        if (el.dataset.thtml === '1') el.innerHTML = v;
        else el.textContent = v;
      }
    });
    document.querySelectorAll('.lang__opt').forEach(function (b) {
      b.classList.toggle('on', b.dataset.lang === lang);
      b.setAttribute('aria-pressed', b.dataset.lang === lang ? 'true' : 'false');
    });
  }

  /* ---------------------------------------------------------
     storage
     --------------------------------------------------------- */

  var store = {
    data: { visits: {}, introDone: false },

    load: function () {
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (p && typeof p === 'object') {
            this.data.visits = p.visits || {};
            this.data.introDone = !!p.introDone;
          }
        }
      } catch (e) { /* private mode or corrupt data — start clean */ }
    },

    save: function () {
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); } catch (e) {}
    },

    get: function (id) { return this.data.visits[id] || null; },

    put: function (id, patch) {
      var next = Object.assign({}, this.data.visits[id] || {}, patch);
      if (!next.visited && !next.rating) delete this.data.visits[id];
      else this.data.visits[id] = next;
      this.save();
    },

    ids: function () { return Object.keys(this.data.visits); },

    visitedIds: function () {
      var v = this.data.visits;
      return Object.keys(v).filter(function (k) { return v[k].visited; });
    },

    clear: function () { this.data.visits = {}; this.save(); }
  };

  /* ---------------------------------------------------------
     the dataset
     --------------------------------------------------------- */

  var DB = null;

  function decodeCore(j) {
    var n = j.n, i;
    var lat = new Float64Array(n), lon = new Float64Array(n);
    var acc = 0;
    for (i = 0; i < n; i++) {
      acc += j.lat[i];                 // latitudes are delta-encoded
      lat[i] = acc / 1e5;
      lon[i] = j.lon[i] / 1e5;
    }

    var TYPE = { n: 'node', w: 'way', r: 'relation' };
    var ids = new Array(n), byId = new Map();
    for (i = 0; i < n; i++) {
      ids[i] = TYPE[j.type[i]] + '/' + j.id[i];
      byId.set(ids[i], i);
    }

    /* Normalised Web Mercator, computed once. Redrawing the dot canvas is then
       a multiply and a subtract per restaurant instead of a Leaflet projection
       call, which is the difference between a smooth pan and a stuttering one. */
    var mx = new Float64Array(n), my = new Float64Array(n);
    for (i = 0; i < n; i++) {
      mx[i] = (lon[i] + 180) / 360;
      var rad = lat[i] * Math.PI / 180;
      my[i] = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
    }

    return {
      n: n,
      lat: lat, lon: lon, mx: mx, my: my,
      ids: ids, byId: byId,
      cc: j.cc, region: j.region, city: j.city, district: j.district,
      countries: j.countries, regions: j.regions, cities: j.cities,
      districts: j.districts || [''],
      countryMeta: j.countryMeta || {},
      generated: j.generated,
      details: null,
      groups: null,
      grid: null
    };
  }

  /* Every scope the progress bar can describe, precomputed once: how many
     restaurants it holds and the box it covers. Counting later is a lookup. */
  function buildGroups() {
    var g = { country: new Map(), region: new Map(), city: new Map(),
              district: new Map(), cont: new Map() };
    var contOf = new Array(DB.countries.length);
    for (var c = 0; c < DB.countries.length; c++) {
      contOf[c] = CONT.isoToContinent[DB.countries[c]] || '';
    }
    DB.contOf = contOf;

    for (var i = 0; i < DB.n; i++) {
      var la = DB.lat[i], lo = DB.lon[i];
      touch(g.country, keyOf('country', i), la, lo);
      touch(g.cont, keyOf('cont', i), la, lo);
      touch(g.region, keyOf('region', i), la, lo);
      touch(g.city, keyOf('city', i), la, lo);
      touch(g.district, keyOf('district', i), la, lo);
    }
    DB.groups = g;

    function touch(map, key, la, lo) {
      if (!key) return;
      var e = map.get(key);
      if (!e) { map.set(key, { n: 1, s: la, w: lo, nn: la, e: lo }); return; }
      e.n++;
      if (la < e.s) e.s = la;
      if (la > e.nn) e.nn = la;
      if (lo < e.w) e.w = lo;
      if (lo > e.e) e.e = lo;
    }
  }

  /* Coarse grid so "what's near the cursor" and viewport scans stay cheap. */
  function buildGrid() {
    var grid = new Map();
    for (var i = 0; i < DB.n; i++) {
      var k = Math.floor(DB.lat[i]) + ':' + Math.floor(DB.lon[i]);
      var b = grid.get(k);
      if (b) b.push(i); else grid.set(k, [i]);
    }
    DB.grid = grid;
  }

  function loadData() {
    setHint(T.loading);
    /* no-cache still uses the ETag, so a rebuilt dataset is picked up on the
       next load while an unchanged one costs a single 304. */
    return fetch('data/mcdonalds.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        DB = decodeCore(j);
        buildGroups();
        buildGrid();
        setHint(null);
        dots.addTo(map);
        renderMarkers();
        updateProgress();
        updateBrandCount();

        /* Addresses and opening hours only matter once a pin is open, so they
           arrive after the map is already usable. */
        fetch('data/mcdonalds-details.json', { cache: 'no-cache' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || d.n !== DB.n) return;
            DB.details = d;
            if (openIdx >= 0) openPanel(openIdx);
          })
          .catch(function () { /* the map works fine without them */ });
      })
      .catch(function () {
        setHint(T.loadFailed);
      });
  }

  /* ---- per-restaurant accessors ---- */

  function idAt(i) { return DB.ids[i]; }
  function ccAt(i) { return DB.countries[DB.cc[i]] || ''; }
  function cityAt(i) { return DB.cities[DB.city[i]] || ''; }
  function regionAt(i) { return DB.regions[DB.region[i]] || ''; }

  function nameAt(i) {
    var d = DB.details;
    var nm = d && d.name && d.name[i];
    return nm || "McDonald's";
  }

  function addrAt(i) {
    var d = DB.details;
    if (!d) return '';
    var street = d.streets[d.street[i]] || '';
    var hn = d.hnums[d.hn[i]] || '';
    var line = (street + ' ' + hn).trim();
    var city = cityAt(i);
    return [line, city].filter(Boolean).join(', ');
  }

  function countryName(cc) {
    var m = DB.countryMeta[cc];
    if (!m) return cc;
    return m[lang] || m.en || m.local || cc;
  }

  /* ---------------------------------------------------------
     map
     --------------------------------------------------------- */

  var ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &middot; ' +
               '<a href="https://openfreemap.org">OpenFreeMap</a>';

  var map = L.map('map', {
    zoomControl: false,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 19,
    zoomSnap: 0,        // fractional zoom; the wheel handler below drives it
    zoomDelta: 1,       // but the +/- buttons still step by a whole level
    attributionControl: true
  }).setView([25, 8], 2.5);

  function theme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
  function styleUrl() {
    return 'https://tiles.openfreemap.org/styles/' + (theme() === 'dark' ? 'dark' : 'positron');
  }

  var glLayer = null;
  var glOk = !!(window.maplibregl && L.maplibreGL &&
                (!maplibregl.supported || maplibregl.supported()));

  if (glOk) {
    try {
      glLayer = L.maplibreGL({ style: styleUrl(), attribution: ATTRIB }).addTo(map);
    } catch (e) { glOk = false; glLayer = null; }
  }
  if (!glOk) {
    $('map').classList.add('is-raster');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
  }

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  /* Leaflet's wheel handler waits out a debounce and then starts a 250 ms zoom
     animation. On a trackpad the next event lands long before that finishes,
     so every animation is cancelled by the one after it and the gesture
     stutters. Applying the accumulated delta once per animation frame, with no
     animation at all, is what continuous zoom is meant to feel like — the
     frames themselves are the animation. */
  map.scrollWheelZoom.disable();

  var wheelAccum = 0, wheelPoint = null, wheelFrame = null;

  var WHEEL_PX_PER_ZOOM = 220;   // deltaY needed for one zoom level
  var WHEEL_MAX_PER_FRAME = 0.5; // levels; a hard flick glides instead of jumping

  function applyWheel() {
    wheelFrame = null;
    if (!wheelPoint) return;

    var step = wheelAccum / WHEEL_PX_PER_ZOOM;
    if (step > WHEEL_MAX_PER_FRAME) step = WHEEL_MAX_PER_FRAME;
    else if (step < -WHEEL_MAX_PER_FRAME) step = -WHEEL_MAX_PER_FRAME;

    // keep whatever we clamped off and spend it on the following frames, so a
    // fast flick glides to a stop rather than teleporting
    wheelAccum -= step * WHEEL_PX_PER_ZOOM;
    if (Math.abs(wheelAccum) < 1) wheelAccum = 0;

    var from = map.getZoom();
    var to = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), from - step));

    if (Math.abs(to - from) > 1e-4) {
      map.setZoomAround(wheelPoint, to, { animate: false });
    } else {
      wheelAccum = 0;
    }

    if (wheelAccum && !wheelFrame) wheelFrame = L.Util.requestAnimFrame(applyWheel);
  }

  L.DomEvent.on(map.getContainer(), 'wheel', function (e) {
    e.preventDefault();

    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 20;          // reported in lines
    else if (e.deltaMode === 2) dy *= 400;    // reported in pages

    // a trackpad pinch arrives as ctrl+wheel with much smaller deltas
    wheelAccum += e.ctrlKey ? dy * 3 : dy;
    wheelPoint = map.mouseEventToContainerPoint(e);

    if (!wheelFrame) wheelFrame = L.Util.requestAnimFrame(applyWheel);
  });

  map.createPane('scope');
  map.getPane('scope').style.zIndex = 350;
  map.getPane('scope').style.pointerEvents = 'none';

  map.createPane('dots');
  map.getPane('dots').style.zIndex = 450;
  map.getPane('dots').style.pointerEvents = 'none';

  /* ---------------------------------------------------------
     markers
     --------------------------------------------------------- */

  var markers = new Map();     // index -> L.Marker
  var selectedIdx = -1;
  var dropBudget = 0;

  function pinHtml() {
    return '<div class="pin"><div class="pin__body"></div>' +
           '<div class="pin__dot"></div><div class="pin__check"></div></div>';
  }

  function applyState(marker, i) {
    var el = marker.getElement();
    if (!el) return;
    var pin = el.querySelector('.pin');
    if (!pin) return;
    var v = store.get(idAt(i));
    pin.classList.toggle('pin--visited', !!(v && v.visited));
    pin.classList.toggle('pin--sel', selectedIdx === i);
  }

  function addMarker(i) {
    var m = L.marker([DB.lat[i], DB.lon[i]], {
      icon: L.divIcon({
        className: 'pin-marker',
        html: pinHtml(),
        iconSize: [26, 34],
        iconAnchor: [13, 32]
      }),
      riseOnHover: true,
      keyboard: false
    });
    m.on('click', function () { openPanel(i); });
    m.addTo(map);

    var el = m.getElement();
    if (el) {
      if (dropBudget > 0) { el.style.animationDelay = (Math.random() * 0.2).toFixed(3) + 's'; dropBudget--; }
      else el.style.animation = 'none';
    }
    markers.set(i, m);
    applyState(m, i);
    return m;
  }

  function removeMarker(i) {
    var m = markers.get(i);
    if (m) { map.removeLayer(m); markers.delete(i); }
  }

  function popMarker(i) {
    var m = markers.get(i);
    var el = m && m.getElement();
    if (!el) return;
    el.classList.remove('is-pop');
    void el.offsetWidth;
    el.classList.add('is-pop');
  }

  function inBounds(b, lat, lon) {
    if (lat < b.getSouth() || lat > b.getNorth()) return false;
    var w = b.getWest(), e = b.getEast();
    if (e - w >= 360) return true;
    for (var k = -1; k <= 1; k++) {
      var x = lon + k * 360;                 // worldCopyJump can push bounds past ±180
      if (x >= w && x <= e) return true;
    }
    return false;
  }

  /* Indices inside a view. Uses the 1-degree grid when that's cheaper than a
     full scan, and falls back to scanning when the view spans the planet. */
  function indicesInBounds(b, cap) {
    var out = [];
    if (!DB) return out;

    var s = Math.floor(b.getSouth()), n = Math.floor(b.getNorth());
    var w = Math.floor(b.getWest()), e = Math.floor(b.getEast());
    var cells = (n - s + 1) * (e - w + 1);

    if (cells > 8000 || e < w) {
      for (var i = 0; i < DB.n; i++) {
        if (inBounds(b, DB.lat[i], DB.lon[i])) {
          out.push(i);
          if (cap && out.length > cap) return out;
        }
      }
      return out;
    }

    for (var y = s; y <= n; y++) {
      for (var x = w; x <= e; x++) {
        var bucket = DB.grid.get(y + ':' + x);
        if (!bucket) continue;
        for (var k = 0; k < bucket.length; k++) {
          var j = bucket[k];
          if (inBounds(b, DB.lat[j], DB.lon[j])) {
            out.push(j);
            if (cap && out.length > cap) return out;
          }
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------
     dot layer

     36k DOM pins is not a thing a browser will do. Past the pin budget every
     restaurant is drawn as a translucent dot on a single canvas, so nothing
     ever disappears just because you zoomed out.
     --------------------------------------------------------- */

  var pinned = new Set();

  var DotLayer = L.Layer.extend({
    onAdd: function (map) {
      /* leaflet-zoom-animated gives us transform-origin: 0 0 and the shared
         zoom transition. Without it the canvas scales about its own centre and
         every dot slides away during the zoom, snapping back on settle. */
      var c = this._canvas = L.DomUtil.create('canvas', 'mcmap-dots leaflet-zoom-animated');
      this._ctx = c.getContext('2d');
      map.getPane('dots').appendChild(c);
      map.on('moveend zoomend resize', this._schedule, this);
      if (map.options.zoomAnimation && L.Browser.any3d) {
        map.on('zoomanim', this._zoomAnim, this);
      }
      this._reset();
    },

    onRemove: function (map) {
      L.DomUtil.remove(this._canvas);
      if (this._frame) L.Util.cancelAnimFrame(this._frame);
      map.off('moveend zoomend resize', this._schedule, this);
      map.off('zoomanim', this._zoomAnim, this);
    },

    /* Ride the zoom animation with a transform, the way Leaflet's own canvas
       renderer does, then redraw sharply once it settles. */
    _zoomAnim: function (e) {
      var map = this._map;
      var scale = map.getZoomScale(e.zoom, map.getZoom());
      var offset = map._latLngToNewLayerPoint(this._nw, e.zoom, e.center);
      L.DomUtil.setTransform(this._canvas, offset, scale);
    },

    /* Wheel zooming applies a new zoom every frame, so reset can fire far more
       often than we can usefully draw. Collapse it to one pass per frame. */
    _schedule: function () {
      var self = this;
      if (this._frame) return;
      this._frame = L.Util.requestAnimFrame(function () {
        self._frame = null;
        self._reset();
      });
    },

    /* Park the canvas over the padded viewport and remember where that is.
       Dot pixel positions are derived from this, so the two must never be
       computed from different map states — if they are, every dot lands at a
       stale offset and the layer looks like it slid off the map. */
    _place: function () {
      var map = this._map;
      var size = map.getSize();
      var pad = L.point(Math.round(size.x * DOT_PAD), Math.round(size.y * DOT_PAD));
      var origin = map.containerPointToLayerPoint(pad.multiplyBy(-1)).round();

      L.DomUtil.setPosition(this._canvas, origin);
      this._origin = origin;
      this._nw = map.layerPointToLatLng(origin);
      return { size: size, pad: pad };
    },

    _reset: function () {
      var map = this._map;
      if (!map) return;

      var at = this._place();
      var w = at.size.x + at.pad.x * 2, h = at.size.y + at.pad.y * 2;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);

      var c = this._canvas;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = w + 'px';
        c.style.height = h + 'px';
      }
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.redraw();
    },

    redraw: function () {
      var map = this._map, ctx = this._ctx;
      if (!map || !ctx || !DB) return;
      this._place();

      var w = this._canvas.width, h = this._canvas.height;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.restore();

      var z = map.getZoom();
      var scale = 256 * Math.pow(2, z);
      var po = map.getPixelOrigin();
      var ox = this._origin.x + po.x, oy = this._origin.y + po.y;
      var r = z < 5 ? 1.6 : (z < 9 ? 2.3 : 3.2);

      var b = map.getBounds().pad(DOT_PAD + 0.05);
      var idx = indicesInBounds(b, 0);

      var plain = [], done = [];
      for (var k = 0; k < idx.length; k++) {
        var i = idx[k];
        if (pinned.has(i)) continue;          // a real pin is already drawn there
        var v = store.get(DB.ids[i]);
        (v && v.visited ? done : plain).push(i);
      }

      draw(plain, VISUAL.dotRed, 0.5);
      draw(done, VISUAL.dotGreen, 0.85);

      function draw(list, color, alpha) {
        if (!list.length) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;

        /* At a few thousand dots the arc calls dominate the frame, and at this
           radius a square is indistinguishable anyway. */
        if (list.length > 3000) {
          var d = r * 2;
          for (var m = 0; m < list.length; m++) {
            var q = list[m];
            ctx.fillRect(DB.mx[q] * scale - ox - r, DB.my[q] * scale - oy - r, d, d);
          }
        } else {
          ctx.beginPath();
          for (var n = 0; n < list.length; n++) {
            var j = list[n];
            var x = DB.mx[j] * scale - ox;
            var y = DB.my[j] * scale - oy;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, 6.2832);
          }
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
  });

  var VISUAL = { dotRed: '#da291c', dotGreen: '#1a8a4a' };
  var dots = new DotLayer();

  function renderMarkers() {
    if (!DB) return;
    var b = map.getBounds().pad(0.25);
    var candidates = indicesInBounds(b, MAX_PINS + 1);
    var wanted = new Set();

    // Past the budget everything becomes a dot, visited ones included — a lone
    // green pin floating over a field of dots just looks like a mistake.
    if (candidates.length <= MAX_PINS) {
      candidates.forEach(function (i) { wanted.add(i); });
    }

    markers.forEach(function (m, i) { if (!wanted.has(i)) removeMarker(i); });

    dropBudget = 200;
    wanted.forEach(function (i) {
      if (!markers.has(i)) addMarker(i);
      else applyState(markers.get(i), i);
    });

    pinned = wanted;
    dots.redraw();
  }

  /* ---------------------------------------------------------
     progress
     --------------------------------------------------------- */

  var progressEl = $('progress');
  var progressText = $('progressText');
  var progressNum = $('progressNum');
  var progressFill = $('progressFill');

  function levelForZoom(z) {
    if (z >= 17) return 'view';
    if (z >= 15) return 'district';
    if (z >= 12) return 'city';
    if (z >= 9) return 'region';
    if (z >= 6) return 'country';
    if (z >= 4) return 'continent';
    return 'world';
  }

  /* The single definition of a scope key. Districts carry their city because
     207 district names (Innere Stadt, Centro, Belmont...) repeat across cities
     in the same country and would otherwise be counted as one place. */
  function keyOf(level, i) {
    var cc = DB.cc[i];
    if (level === 'country') return 'c' + cc;
    if (level === 'cont') return DB.contOf[cc] || '';
    if (level === 'region') return cc + ':' + DB.region[i];
    if (level === 'city') return cc + ':' + DB.region[i] + ':' + DB.city[i];
    if (level === 'district') {
      return DB.district[i]
        ? cc + ':' + DB.region[i] + ':' + DB.city[i] + ':' + DB.district[i]
        : '';
    }
    return '';
  }

  /* Which group is the map centred on? Prefer the smallest group whose box
     contains the centre; otherwise fall back to the nearest restaurant. */
  function scopeKey(level, c) {
    var map_ = DB.groups[level];
    if (!map_) return null;

    var bestKey = null, bestArea = Infinity;
    map_.forEach(function (e, key) {
      if (c.lat < e.s || c.lat > e.nn || c.lng < e.w || c.lng > e.e) return;
      var area = (e.nn - e.s) * (e.e - e.w);
      if (area < bestArea) { bestArea = area; bestKey = key; }
    });
    if (bestKey) return bestKey;

    var i = nearestIndex(c.lat, c.lng);
    return i < 0 ? null : keyOf(level, i);
  }

  function nearestIndex(lat, lon) {
    if (!DB) return -1;
    var best = -1, bestD = Infinity;
    for (var ring = 0; ring <= 6 && best < 0; ring++) {
      var la = Math.floor(lat), lo = Math.floor(lon);
      for (var dy = -ring; dy <= ring; dy++) {
        for (var dx = -ring; dx <= ring; dx++) {
          if (ring > 0 && Math.abs(dy) !== ring && Math.abs(dx) !== ring) continue;
          var bucket = DB.grid.get((la + dy) + ':' + (lo + dx));
          if (!bucket) continue;
          for (var k = 0; k < bucket.length; k++) {
            var i = bucket[k];
            var d = haversine(lat, lon, DB.lat[i], DB.lon[i]);
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
    }
    return best;
  }

  /* How many of your visits fall inside a group. Visits are few, so this walks
     the visit list rather than the 36k restaurants. */
  function visitedIn(level, key) {
    var n = 0;
    store.visitedIds().forEach(function (id) {
      var i = DB.byId.get(id);
      if (i !== undefined && keyOf(level, i) === key) n++;
    });
    return n;
  }

  function labelFor(level, key) {
    var parts = String(key).split(':');
    if (level === 'cont') return T.continents[key] || key;
    if (level === 'country') return countryName(DB.countries[+key.slice(1)] || '');
    if (level === 'region') return DB.regions[+parts[1]] || '';
    if (level === 'district') return DB.districts[+parts[3]] || '';
    return DB.cities[+parts[2]] || '';
  }

  function updateProgress() {
    if (!DB) return;
    var z = map.getZoom(), c = map.getCenter();
    var level = levelForZoom(z);

    if (level === 'world') {
      hideOutline();
      return paint(store.visitedIds().length, DB.n, T.earth, { earth: true });
    }

    if (level === 'view') {
      hideOutline();
      var idx = indicesInBounds(map.getBounds(), 400);
      var been = 0;
      idx.forEach(function (i) {
        var v = store.get(idAt(i));
        if (v && v.visited) been++;
      });
      return paint(been, idx.length, null, { view: true });
    }

    var gk = level === 'continent' ? 'cont' : level;
    var key = scopeKey(gk, c);
    var group = key == null ? null : DB.groups[gk].get(key);

    if (!group && gk === 'district') {      // most of the world has no level 9/10
      gk = 'city';
      key = scopeKey(gk, c);
      group = key == null ? null : DB.groups[gk].get(key);
    }
    if (!group) { hideOutline(); return paint(0, 0); }

    var label = labelFor(gk, key);
    paint(visitedIn(gk, key), group.n, label);
    requestOutline(gk, key, label, c);
  }

  function paint(been, total, label, opts) {
    opts = opts || {};
    progressEl.classList.remove('is-loading');

    if (!total) {
      progressEl.classList.add('is-hidden');
      return;
    }
    been = Math.min(been, total);

    progressEl.classList.remove('is-hidden');
    progressEl.classList.toggle('is-complete', been === total);
    progressText.innerHTML = T.progress(been, total, esc(label), !!opts.earth, !!opts.view);
    progressNum.textContent = Math.round((been / total) * 100) + '%';
    progressFill.style.width = ((been / total) * 100).toFixed(2) + '%';
  }

  /* ---------------------------------------------------------
     boundary outline — decorative, always async, never blocking
     --------------------------------------------------------- */

  var outline = null;
  var outlineKey = null;
  var outlineWanted = null;
  var geoCache = new Map();
  var geoChain = Promise.resolve();
  var geoLast = 0;

  var SIMPLIFY = { district: 0.0003, city: 0.001, region: 0.006, country: 0.02 };
  var NOM_ZOOM = { district: 14, city: 10, region: 5, country: 3 };

  function reverse(lat, lon, zoom, poly) {
    var p = zoom >= 10 ? 2 : (zoom >= 5 ? 1 : 0);
    var key = zoom + '@' + lat.toFixed(p) + ',' + lon.toFixed(p);
    if (geoCache.has(key)) return geoCache.get(key);

    var run = geoChain.then(function () {
      var wait = 1100 - (Date.now() - geoLast);   // Nominatim asks for 1 req/s
      return wait > 0 ? new Promise(function (r) { setTimeout(r, wait); }) : null;
    }).then(function () {
      geoLast = Date.now();
      var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
                '&zoom=' + zoom + '&lat=' + lat.toFixed(6) + '&lon=' + lon.toFixed(6) +
                '&polygon_geojson=1&polygon_threshold=' + poly;
      return fetch(url, { headers: { Accept: 'application/json' } });
    }).then(function (r) {
      if (!r.ok) throw new Error('geocode ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.error) throw new Error('no place');
      return j;
    });

    geoChain = run.catch(function () {});
    geoCache.set(key, run);
    run.catch(function () { geoCache.delete(key); });
    return run;
  }

  var requestOutline = debounce(function (level, key, label, c) {
    if (level === 'cont') { hideOutline(); return; }
    var want = level + '/' + key;
    if (want === outlineKey) return;
    outlineWanted = want;

    reverse(c.lat, c.lng, NOM_ZOOM[level], SIMPLIFY[level]).then(function (place) {
      if (outlineWanted !== want) return;      // the map moved on
      hideOutline();
      if (!place.geojson) return;
      outlineKey = want;
      outline = L.geoJSON(place.geojson, {
        pane: 'scope',
        interactive: false,
        style: { className: 'scope-outline' }
      }).addTo(map);
    }).catch(function () { /* no outline, no problem */ });
  }, 550);

  function hideOutline() {
    if (outline) { map.removeLayer(outline); outline = null; }
    outlineKey = null;
  }

  /* ---------------------------------------------------------
     detail panel
     --------------------------------------------------------- */

  var panel = $('panel');
  var starsEl = $('stars');
  var starBtns = Array.prototype.slice.call(starsEl.querySelectorAll('button'));
  var visitBtn = $('visitBtn');
  var openIdx = -1;

  function openPanel(i) {
    if (!DB) return;
    openIdx = i;
    selectedIdx = i;
    markers.forEach(function (m, mi) { applyState(m, mi); });

    $('panelName').textContent = nameAt(i);
    var addr = addrAt(i);
    $('panelAddr').textContent = addr;
    $('panelAddr').hidden = !addr;

    var q = DB.lat[i].toFixed(6) + ',' + DB.lon[i].toFixed(6);
    $('gmapsLink').href = 'https://www.google.com/maps/search/?api=1&query=' + q;
    $('amapsLink').href = 'https://maps.apple.com/?q=' + encodeURIComponent(nameAt(i)) + '&ll=' + q;

    renderFacts(i);
    syncPanelState();

    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    if (window.innerWidth <= 720) progressEl.classList.add('is-pushed');
  }

  function closePanel() {
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    progressEl.classList.remove('is-pushed');
    openIdx = -1;
    selectedIdx = -1;
    markers.forEach(function (m, mi) { applyState(m, mi); });
  }

  function syncPanelState() {
    if (openIdx < 0) return;
    var v = store.get(idAt(openIdx)) || {};
    var on = !!v.visited;

    visitBtn.classList.toggle('is-on', on);
    $('visitLabel').textContent = on ? T.visitDone : T.visitAction;

    var badge = $('panelBadge');
    badge.textContent = on ? T.beenThere : T.notVisited;
    badge.classList.toggle('is-visited', on);

    paintStars(v.rating || 0);
    $('starsHint').textContent = v.rating ? T.ratings[v.rating] : T.rateHint;
  }

  function paintStars(n) {
    starBtns.forEach(function (b, i) { b.classList.toggle('on', i < n); });
  }

  function renderFacts(i) {
    var rows = [];
    var d = DB.details;
    if (d) {
      var oh = d.hours[d.oh[i]];
      if (oh) rows.push([T.hours, oh]);
      var f = d.flag[i] || 0;
      if (f & 1) rows.push([T.driveThru, T.yes]);
      if (f & 2) rows.push([T.wifi, T.yes]);
      if (f & 4) rows.push([T.outdoor, T.yes]);
    }
    if (userPos) {
      var dist = haversine(userPos.lat, userPos.lng, DB.lat[i], DB.lon[i]);
      rows.push([T.distance, dist < 1000 ? Math.round(dist) + ' m' : (dist / 1000).toFixed(1) + ' km']);
    }
    $('facts').innerHTML = rows.map(function (r) {
      return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
    }).join('');
  }

  visitBtn.addEventListener('click', function () {
    if (openIdx < 0) return;
    var id = idAt(openIdx);
    var v = store.get(id) || {};
    var on = !v.visited;

    store.put(id, { visited: on, rating: v.rating || 0, ts: Date.now() });

    syncPanelState();
    if (!markers.has(openIdx)) addMarker(openIdx);
    applyState(markers.get(openIdx), openIdx);
    popMarker(openIdx);
    updateBrandCount();
    updateProgress();
    toast(on ? T.marked : T.unmarked);
  });

  starBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      if (openIdx < 0) return;
      var id = idAt(openIdx);
      var val = parseInt(b.dataset.v, 10);
      var v = store.get(id) || {};
      store.put(id, { rating: v.rating === val ? 0 : val, visited: !!v.visited });
      syncPanelState();
      renderMarkers();
    });
    b.addEventListener('mouseenter', function () { paintStars(parseInt(b.dataset.v, 10)); });
  });
  starsEl.addEventListener('mouseleave', function () {
    var v = openIdx >= 0 ? (store.get(idAt(openIdx)) || {}) : {};
    paintStars(v.rating || 0);
  });

  $('panelClose').addEventListener('click', closePanel);

  /* In dot mode there are no markers to click, so fall back to "whatever is
     within a finger's width of the tap". */
  map.on('click', function (e) {
    if (!DB) { closePanel(); return; }
    var p = map.latLngToContainerPoint(e.latlng);
    var best = -1, bestD = 26;
    var b = map.getBounds();
    var idx = indicesInBounds(b, 4000);
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k];
      if (pinned.has(i)) continue;
      var q = map.latLngToContainerPoint([DB.lat[i], DB.lon[i]]);
      var d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) openPanel(best);
    else closePanel();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePanel(); closeSheet(); }
  });

  /* ---------------------------------------------------------
     stats sheet
     --------------------------------------------------------- */

  var sheet = $('sheet');

  function updateBrandCount() {
    var n = store.visitedIds().length;
    var el = $('brandCount');
    el.textContent = n;
    el.classList.toggle('has', n > 0);
  }

  function openSheet() {
    var ids = store.visitedIds();
    var countries = new Set(), cities = new Set(), rated = [];

    ids.forEach(function (id) {
      var i = DB && DB.byId.get(id);
      if (i !== undefined && DB) {
        if (DB.cc[i]) countries.add(DB.cc[i]);
        if (DB.city[i]) cities.add(DB.cc[i] + ':' + DB.city[i]);
      }
      var v = store.get(id);
      if (v && v.rating) rated.push(v.rating);
    });

    var avg = rated.length ? rated.reduce(function (a, b) { return a + b; }, 0) / rated.length : 0;
    var pct = DB ? (ids.length / DB.n) * 100 : 0;

    $('sheetGrid').innerHTML =
      tile(ids.length.toLocaleString(), T.statVisited) +
      tile(cities.size, cities.size === 1 ? T.statCity : T.statCities) +
      tile(countries.size, countries.size === 1 ? T.statCountry : T.statCountries) +
      tile(avg ? avg.toFixed(1) : '—', T.statRating) +
      tile((pct > 0 && pct < 0.01 ? '<0.01' : pct.toFixed(2)) + '%', T.statShare);

    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function tile(big, small) {
    return '<div><b>' + esc(big) + '</b><span>' + esc(small) + '</span></div>';
  }

  function closeSheet() {
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
  }

  $('statsBtn').addEventListener('click', openSheet);
  $('sheetClose').addEventListener('click', closeSheet);
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });

  $('resetBtn').addEventListener('click', function () {
    if (!window.confirm(T.resetConfirm)) return;
    store.clear();
    closeSheet();
    closePanel();
    updateBrandCount();
    renderMarkers();
    updateProgress();
    toast(T.cleared);
  });

  /* ---------------------------------------------------------
     hint + toast
     --------------------------------------------------------- */

  var hintEl = $('hint');
  var hintTimer;
  var hintKey = null;

  function setHint(text, ms) {
    clearTimeout(hintTimer);
    if (!text) { hintEl.hidden = true; hintKey = null; return; }
    hintEl.textContent = text;
    hintEl.hidden = false;
    if (ms) hintTimer = setTimeout(function () { hintEl.hidden = true; hintKey = null; }, ms);
  }

  var toastEl = $('toast');
  var toastTimer;

  function toast(text) {
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.classList.add('is-on');
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 1900);
  }

  /* ---------------------------------------------------------
     search

     Searches the bundled place names first, so results appear as you type with
     no network at all. Nominatim is only consulted for things the dataset
     can't know about — streets, landmarks, postcodes.
     --------------------------------------------------------- */

  var searchBox = $('search');
  var searchInput = $('searchInput');
  var searchResults = $('searchResults');
  var searchIndex = null;
  var searchRows = [];
  var searchCursor = -1;
  var searchSeq = 0;

  function normalize(str) {
    return String(str || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function buildSearchIndex() {
    if (searchIndex || !DB) return searchIndex;
    var out = [];

    DB.groups.country.forEach(function (g, key) {
      var cc = DB.countries[+key.slice(1)] || '';
      out.push(entry(countryName(cc), T.continents[CONT.isoToContinent[cc]] || '', 'country', key, g));
    });
    DB.groups.region.forEach(function (g, key) {
      var parts = key.split(':');
      var name = DB.regions[+parts[1]];
      if (!name) return;
      out.push(entry(name, countryName(DB.countries[+parts[0]] || ''), 'region', key, g));
    });
    DB.groups.city.forEach(function (g, key) {
      var parts = key.split(':');
      var name = DB.cities[+parts[2]];
      if (!name) return;
      var sub = [DB.regions[+parts[1]], countryName(DB.countries[+parts[0]] || '')]
        .filter(Boolean).join(', ');
      out.push(entry(name, sub, 'city', key, g));
    });

    function entry(label, sub, level, key, g) {
      return {
        label: label, sub: sub, level: level, key: key, n: g.n,
        norm: normalize(label),
        s: g.s, w: g.w, nn: g.nn, e: g.e
      };
    }

    searchIndex = out;
    return out;
  }

  function localMatches(q) {
    var idx = buildSearchIndex();
    if (!idx) return [];
    var nq = normalize(q);
    var hits = [];
    for (var i = 0; i < idx.length; i++) {
      var e = idx[i];
      var at = e.norm.indexOf(nq);
      if (at < 0) continue;
      // exact, then prefix, then anywhere; bigger places break ties
      var rank = e.norm === nq ? 0 : (at === 0 ? 1 : 2);
      hits.push([rank, -e.n, e]);
      if (hits.length > 4000) break;
    }
    hits.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });

    /* City-states appear twice — Wien the region and Wien the city hold the
       same restaurants. One row is enough. */
    var seen = {}, out = [];
    for (var h = 0; h < hits.length && out.length < 7; h++) {
      var e = hits[h][2];
      var k = e.norm + '|' + e.n + '|' + e.sub.split(',').pop().trim();
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(e);
    }
    return out;
  }

  function renderResults(rows, pending) {
    searchRows = rows;
    searchCursor = -1;
    if (!rows.length) {
      /* The bundled names are the local ones (東京都, not Tokyo), so an empty
         local result usually just means the wider search hasn't landed yet. */
      searchResults.innerHTML = '<li class="search__empty">' +
        esc(pending ? T.searching : T.noResults) + '</li>';
      searchResults.classList.add('is-open');
      return;
    }
    searchResults.innerHTML = rows.map(function (r) {
      return '<li role="option"><b>' + esc(r.label) + '</b><span>' + esc(r.sub) + '</span>' +
             (r.n ? '<em>' + r.n + '</em>' : '') + '</li>';
    }).join('');
    searchResults.classList.add('is-open');

    Array.prototype.forEach.call(searchResults.children, function (li, i) {
      li.addEventListener('click', function () { gotoResult(rows[i]); });
    });
  }

  function closeResults() {
    searchResults.classList.remove('is-open');
    searchCursor = -1;
  }

  /* Fly to a result by centre + zoom rather than flyToBounds: getBoundsZoom
     returns NaN for a degenerate box or a container that has no size yet, and
     Leaflet then throws on the NaN centre instead of just not moving. */
  function gotoResult(r) {
    closeResults();
    searchInput.blur();

    if (r.latlng) {
      map.flyTo(r.latlng, r.zoom || 14, { duration: 1.1 });
      return;
    }

    var lat = (r.s + r.nn) / 2, lon = (r.w + r.e) / 2;
    if (!isFinite(lat) || !isFinite(lon)) return;

    var size = map.getSize();
    var tiny = (r.nn - r.s) < 0.004 && (r.e - r.w) < 0.004;
    if (tiny || !size.x || !size.y) {
      map.flyTo([lat, lon], 15, { duration: 1.1 });
      return;
    }

    var z = map.getBoundsZoom(L.latLngBounds([r.s, r.w], [r.nn, r.e]).pad(0.08));
    map.flyTo([lat, lon], isFinite(z) ? Math.min(z, 16) : 12, { duration: 1.1 });
  }

  var runRemoteSearch = debounce(function (q, seq) {
    if (q.length < 3 || seq !== searchSeq) return;
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&q=' +
              encodeURIComponent(q);
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        if (seq !== searchSeq) return;
        if (!list.length) {
          if (!searchRows.length) renderResults([], false);
          return;
        }
        var extra = list.map(function (p) {
          var parts = (p.display_name || '').split(',');
          return {
            label: parts.shift().trim(),
            sub: parts.join(',').trim().slice(0, 60),
            latlng: [parseFloat(p.lat), parseFloat(p.lon)],
            zoom: p.type === 'city' || p.type === 'administrative' ? 12 : 16,
            n: 0
          };
        });
        var seen = {};
        var merged = searchRows.concat(extra).filter(function (r) {
          var k = r.label + '|' + r.sub;
          if (seen[k]) return false;
          seen[k] = 1;
          return true;
        }).slice(0, 8);
        renderResults(merged);
      })
      .catch(function () {
        if (seq === searchSeq && !searchRows.length) renderResults([], false);
      });
  }, 300);

  searchInput.addEventListener('input', function () {
    var q = searchInput.value.trim();
    $('searchClear').hidden = !q;
    var seq = ++searchSeq;
    if (q.length < 2) { closeResults(); return; }
    renderResults(localMatches(q), q.length >= 3);
    runRemoteSearch(q, seq);
  });

  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeResults(); searchInput.blur(); return; }
    if (!searchResults.classList.contains('is-open') || !searchRows.length) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      searchCursor += e.key === 'ArrowDown' ? 1 : -1;
      if (searchCursor < 0) searchCursor = searchRows.length - 1;
      if (searchCursor >= searchRows.length) searchCursor = 0;
      Array.prototype.forEach.call(searchResults.children, function (li, i) {
        li.classList.toggle('on', i === searchCursor);
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      gotoResult(searchRows[searchCursor >= 0 ? searchCursor : 0]);
    }
  });

  $('searchClear').addEventListener('click', function () {
    searchInput.value = '';
    $('searchClear').hidden = true;
    closeResults();
    searchInput.focus();
  });

  document.addEventListener('click', function (e) {
    if (!searchBox.contains(e.target)) closeResults();
  });

  /* ---------------------------------------------------------
     geolocation
     --------------------------------------------------------- */

  var userPos = null;
  var meMarker = null;

  function locate(zoom) {
    var btn = $('locateBtn');
    if (!navigator.geolocation) { toast(T.noGeo); return; }
    btn.classList.add('is-busy');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.classList.remove('is-busy');
      userPos = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (meMarker) meMarker.setLatLng(userPos);
      else {
        meMarker = L.marker(userPos, {
          icon: L.divIcon({
            className: '',
            html: '<div class="me"><div class="me__halo"></div><div class="me__dot"></div></div>',
            iconSize: [18, 18], iconAnchor: [9, 9]
          }),
          interactive: false,
          zIndexOffset: -500
        }).addTo(map);
      }
      map.flyTo(userPos, zoom || 14, { duration: 1.4 });
    }, function () {
      btn.classList.remove('is-busy');
      toast(T.noLocation);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  $('locateBtn').addEventListener('click', function () { locate(15); });

  /* ---------------------------------------------------------
     theme
     --------------------------------------------------------- */

  $('themeBtn').addEventListener('click', function () {
    var next = theme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(LS_THEME, next); } catch (e) {}
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#101012' : '#ffffff');
    if (glLayer && glLayer.getMaplibreMap) {
      try { glLayer.getMaplibreMap().setStyle(styleUrl()); } catch (e) {}
    }
  });

  /* ---------------------------------------------------------
     intro
     --------------------------------------------------------- */

  var intro = $('intro');

  function dismissIntro() {
    intro.classList.add('is-gone');
    store.data.introDone = true;
    store.save();
    setTimeout(function () { if (intro.parentNode) intro.remove(); }, 600);
  }

  $('introLocate').addEventListener('click', function () { dismissIntro(); locate(14); });
  $('introSkip').addEventListener('click', function () {
    dismissIntro();
    map.flyTo([30, 5], 3, { duration: 1.2 });
  });

  document.querySelectorAll('.lang__opt').forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.dataset.lang, true); });
  });

  /* ---------------------------------------------------------
     wiring
     --------------------------------------------------------- */

  var onMove = debounce(function () {
    renderMarkers();
    updateProgress();
  }, 90);

  map.on('moveend zoomend', onMove);

  window.addEventListener('resize', debounce(function () {
    if (window.innerWidth > 720) progressEl.classList.remove('is-pushed');
  }, 150));

  /* Leaflet only watches window resize, so a container that changes size on its
     own — a rotated phone, a tab that was hidden at load, a split view — leaves
     the map convinced it is still the old size. */
  if (window.ResizeObserver) {
    var lastW = 0, lastH = 0;
    new ResizeObserver(debounce(function () {
      var el = $('map');
      if (!el.offsetWidth || !el.offsetHeight) return;
      if (el.offsetWidth === lastW && el.offsetHeight === lastH) return;
      lastW = el.offsetWidth;
      lastH = el.offsetHeight;
      map.invalidateSize({ animate: false });
      renderMarkers();
      updateProgress();
    }, 160)).observe($('map'));
  }

  window.McMap = { map: map, store: store, db: function () { return DB; } };

  /* boot */
  store.load();
  setLang(pickLang(), false);
  updateBrandCount();

  if (store.data.introDone) {
    intro.classList.add('is-gone');
    intro.remove();
  }

  loadData().then(function () {
    if (!store.data.introDone) return;
    var last = store.visitedIds().slice(-1)[0];
    var i = last && DB && DB.byId.get(last);
    if (i !== undefined && i >= 0 && DB) map.setView([DB.lat[i], DB.lon[i]], 13);
    else locate(14);
  });
})();
