/* ISO 3166-1 alpha-2 -> continent. Totals no longer live here: every count in
   the app comes from data/mcdonalds.json, so the numbers are exact and
   internally consistent at every zoom level. */
(function () {
  'use strict';

  var MEMBERS = {
    AF: 'DZ AO BJ BW BF BI CM CV CF TD KM CD CG CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW',
    AS: 'AF AM AZ BH BD BT BN KH CN CY GE HK IN ID IR IQ IL JP JO KZ KP KR KW KG LA LB MO MY MV MN MM NP OM PK PS PH QA SA SG LK SY TW TJ TH TL TR TM AE UZ VN YE',
    EU: 'AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SJ SE CH UA GB VA',
    NA: 'AI AG AW BS BB BZ BM BQ VG CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA PR BL KN LC MF PM VC SX TT TC US VI',
    SA: 'AR BO BR CL CO EC FK GF GY PY PE SR UY VE',
    OC: 'AS AU CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV VU WF',
    AN: 'AQ'
  };

  var isoToContinent = {};
  Object.keys(MEMBERS).forEach(function (cont) {
    MEMBERS[cont].split(' ').forEach(function (cc) { isoToContinent[cc] = cont; });
  });

  window.MCMAP_CONTINENTS = { isoToContinent: isoToContinent };
})();
