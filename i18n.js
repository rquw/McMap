/* McMap — interface strings. Place names stay in their local language
   (Wien, 日本); only the interface switches. */
(function () {
  'use strict';

  window.MCMAP_I18N = {
    en: {
      code: 'en',
      tagline: "Every McDonald's on Earth, on one map.<br>Turn the red pins green.",
      start: 'Start where I am',
      skip: 'Browse the world instead',
      loading: "Loading every McDonald's on Earth…",
      loadFailed: "Couldn't load the restaurant data. Check your connection and reload.",

      notVisited: 'Not visited',
      beenThere: 'Been there',
      visitAction: 'Visited!',
      visitDone: 'Visited',
      rateHint: 'Tap to rate',
      ratings: ['', 'Rough.', 'Fine.', 'Solid.', 'Really good.', "Peak McDonald's."],
      googleMaps: 'Google Maps',
      appleMaps: 'Apple Maps',

      hours: 'Hours',
      driveThru: 'Drive-thru',
      wifi: 'Wi-Fi',
      outdoor: 'Outdoor seating',
      distance: 'Distance',
      yes: 'Yes',

      yourMap: 'Your map',
      statVisited: 'visited',
      statCity: 'city',
      statCities: 'cities',
      statCountry: 'country',
      statCountries: 'countries',
      statRating: 'average rating',
      statShare: "of all we know of",
      savedLocal: 'Saved in this browser only. Nothing leaves your device.',
      reset: 'Reset everything',
      resetConfirm: 'Clear every visit and rating on this device?',
      language: 'Language',

      searchPlaceholder: 'Search a place',
      noResults: 'Nothing found',
      marked: 'Marked as visited',
      unmarked: 'Unmarked',
      cleared: 'Map cleared',
      noLocation: "Couldn't get your location",
      noGeo: 'Location is not available here',

      earth: 'Earth',
      continents: {
        AF: 'Africa', AS: 'Asia', EU: 'Europe', NA: 'North America',
        SA: 'South America', OC: 'Oceania', AN: 'Antarctica'
      },

      /* n = total, been = visited, place = HTML-safe label (null for Earth) */
      progress: function (been, n, place, isEarth, inView) {
        if (inView) {
          if (n === 1) {
            return been ? "You've been to the one McDonald's here."
                        : "One McDonald's here — you haven't been.";
          }
          if (been === n) return "You've been to all " + n + " McDonald's in view.";
          return "You've been to <b>" + been + "</b>/<b>" + n + "</b> McDonald's in view.";
        }
        var where = isEarth ? 'on <b>Earth</b>' : 'in <b>' + place + '</b>';
        if (been === n) return "You've been to all " + n + " McDonald's " + where + '.';
        return "You've been to <b>" + been + "</b>/<b>" + n + "</b> McDonald's " + where + '.';
      },
      counting: function (place) { return 'Counting McDonald\'s in <b>' + place + '</b>…'; }
    },

    de: {
      code: 'de',
      tagline: "Jedes McDonald's der Welt auf einer Karte.<br>Mach die roten Pins grün.",
      start: 'Dort starten, wo ich bin',
      skip: 'Lieber die Welt erkunden',
      loading: "Lade jedes McDonald's der Welt…",
      loadFailed: 'Die Restaurantdaten konnten nicht geladen werden. Verbindung prüfen und neu laden.',

      notVisited: 'Noch nicht besucht',
      beenThere: 'Schon besucht',
      visitAction: 'Besucht!',
      visitDone: 'Besucht',
      rateHint: 'Zum Bewerten tippen',
      ratings: ['', 'Mies.', 'Geht so.', 'Solide.', 'Richtig gut.', "Bestes McDonald's."],
      googleMaps: 'Google Maps',
      appleMaps: 'Apple Maps',

      hours: 'Öffnungszeiten',
      driveThru: 'Drive-in',
      wifi: 'WLAN',
      outdoor: 'Außenplätze',
      distance: 'Entfernung',
      yes: 'Ja',

      yourMap: 'Deine Karte',
      statVisited: 'besucht',
      statCity: 'Stadt',
      statCities: 'Städte',
      statCountry: 'Land',
      statCountries: 'Länder',
      statRating: 'Ø Bewertung',
      statShare: 'von allen bekannten',
      savedLocal: 'Nur in diesem Browser gespeichert. Nichts verlässt dein Gerät.',
      reset: 'Alles zurücksetzen',
      resetConfirm: 'Alle Besuche und Bewertungen auf diesem Gerät löschen?',
      language: 'Sprache',

      searchPlaceholder: 'Ort suchen',
      noResults: 'Nichts gefunden',
      marked: 'Als besucht markiert',
      unmarked: 'Markierung entfernt',
      cleared: 'Karte zurückgesetzt',
      noLocation: 'Dein Standort konnte nicht ermittelt werden',
      noGeo: 'Standort ist hier nicht verfügbar',

      earth: 'Erde',
      continents: {
        AF: 'Afrika', AS: 'Asien', EU: 'Europa', NA: 'Nordamerika',
        SA: 'Südamerika', OC: 'Ozeanien', AN: 'Antarktis'
      },

      progress: function (been, n, place, isEarth, inView) {
        if (inView) {
          if (n === 1) {
            return been ? "Du warst im einzigen McDonald's hier."
                        : "Ein McDonald's hier — da warst du noch nicht.";
          }
          if (been === n) return 'Du warst in allen ' + n + " McDonald's im Ausschnitt.";
          return 'Du warst in <b>' + been + '</b>/<b>' + n + "</b> McDonald's im Ausschnitt.";
        }
        var where = isEarth ? 'auf der <b>Erde</b>' : 'in <b>' + place + '</b>';
        if (been === n) return 'Du warst in allen ' + n + " McDonald's " + where + '.';
        return 'Du warst in <b>' + been + '</b>/<b>' + n + "</b> McDonald's " + where + '.';
      },
      counting: function (place) { return 'Zähle McDonald\'s in <b>' + place + '</b>…'; }
    }
  };
})();
