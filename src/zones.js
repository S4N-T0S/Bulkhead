'use strict'
// Bulkhead TZ — timezone derivation. Pure: geography in, IANA zone out. No
// browser APIs, no storage, no network, no clock, so it can be tested
// exhaustively without a browser and nothing outside this file may
// re-implement a derivation rule.
//
// WHY THIS EXISTS
// A container's exit IP and the timezone its pages report are two halves of
// one story, and fingerprinters (CreepJS's timezone test, for one) read both.
// Bulkhead already proves where each container exits — its health probe rides
// the container's own SOCKS relay and comes back with am.i.mullvad.net's
// answer for that exit: country and city. This module turns that answer into
// an IANA zone entirely OFFLINE, from embedded public-domain tzdb data. No
// geo-IP API, no third party, no extra request: the geography piggybacks on
// the probe the killswitch already makes.
//
// THE DERIVATION, in order:
//   1. Single-zone country (~70% of the fleet: NO, SE, GR, DE, FR, GB, ...).
//      The country alone is authoritative; the city is ignored, so a
//      mis-geolocated city can never move the answer across a zone border.
//   2. Multi-zone country, city known to the table: the city's zone, accepted
//      only if tzdb lists it among that country's zones.
//   3. Everything else: the country's primary zone, flagged `approx` — the
//      honest "best available", never a zone from the wrong country.
// A user pin outranks all of it and never consults these tables at all.
//
// DATA PROVENANCE (all offline, all rebuildable from public sources):
//   CZ_BLOB    tzdb zone.tab — country code -> zones, primary first.
//              (zone1970.tab is wrong for this: it files Norway and Sweden
//              under Europe/Berlin.)
//   N2I_BLOB   country NAME -> ISO-3166 alpha-2 (umpirsky country-list plus
//              aliases), for the probe's country names.
//   CITY_BLOB  city NAME -> zone, multi-zone countries only. Audited against
//              Mullvad's live relay list (2026-10, 50 countries, 553
//              wireguard relays): every relay city in a multi-zone country
//              maps to a member of that country's zone set. Mullvad adds
//              cities over time; an unmapped one degrades to rule 3 with the
//              approx flag, never to a wrong country.
//
// Adapted from the Timezone Lock userscript v3.3.4 (MIT), which derived the
// same tables for its Cloudflare-trace fallback path; the IATA/colo table it
// also carried is dropped here — the probe names the city directly, so no
// airport-code inference is needed.
//
// Loaded both as an MV2 background script (attaches to globalThis) and by
// node --test (module.exports).
;(function (root) {
  /** Parse a `k=v|k=v` blob into a null-prototype dict (no toString or
   *  hasOwnProperty shenanigans can leak through a hostile key).
   *  @param {string} blob */
  function parseBlob (blob) {
    const out = Object.create(null)
    for (const ent of String(blob).split('|')) {
      if (!ent) continue
      const eq = ent.indexOf('=')
      if (eq < 1) continue
      out[ent.slice(0, eq)] = ent.slice(eq + 1)
    }
    return out
  }

  /** Fold a provider-supplied name for table lookup: de-accent, lowercase,
   *  punctuation -> space, collapse runs. "São Paulo, SP" -> "sao paulo sp".
   *  @param {unknown} s */
  function normStr (s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()
  }

  // tzdb zone.tab: ISO-3166 alpha-2 -> zones, primary first.
  const CZ_BLOB = 'AD=Europe/Andorra|AE=Asia/Dubai|AF=Asia/Kabul|AG=America/Antigua|AI=America/Anguilla|AL=Europe/Tirane|AM=Asia/Yerevan|AO=Africa/Luanda|AQ=Antarctica/Troll,Antarctica/McMurdo,Antarctica/Casey,Antarctica/Davis,Antarctica/DumontDUrville,Antarctica/Mawson,Antarctica/Palmer,Antarctica/Rothera,Antarctica/Syowa,Antarctica/Vostok|AR=America/Argentina/Buenos_Aires,America/Argentina/Cordoba,America/Argentina/Salta,America/Argentina/Jujuy,America/Argentina/Tucuman,America/Argentina/Catamarca,America/Argentina/La_Rioja,America/Argentina/San_Juan,America/Argentina/Mendoza,America/Argentina/San_Luis,America/Argentina/Rio_Gallegos,America/Argentina/Ushuaia|AS=Pacific/Pago_Pago|AT=Europe/Vienna|AU=Australia/Sydney,Australia/Lord_Howe,Antarctica/Macquarie,Australia/Hobart,Australia/Melbourne,Australia/Broken_Hill,Australia/Brisbane,Australia/Lindeman,Australia/Adelaide,Australia/Darwin,Australia/Perth,Australia/Eucla|AW=America/Aruba|AX=Europe/Mariehamn|AZ=Asia/Baku|BA=Europe/Sarajevo|BB=America/Barbados|BD=Asia/Dhaka|BE=Europe/Brussels|BF=Africa/Ouagadougou|BG=Europe/Sofia|BH=Asia/Bahrain|BI=Africa/Bujumbura|BJ=Africa/Porto-Novo|BL=America/St_Barthelemy|BM=Atlantic/Bermuda|BN=Asia/Brunei|BO=America/La_Paz|BQ=America/Kralendijk|BR=America/Sao_Paulo,America/Noronha,America/Belem,America/Fortaleza,America/Recife,America/Araguaina,America/Maceio,America/Bahia,America/Campo_Grande,America/Cuiaba,America/Santarem,America/Porto_Velho,America/Boa_Vista,America/Manaus,America/Eirunepe,America/Rio_Branco|BS=America/Nassau|BT=Asia/Thimphu|BW=Africa/Gaborone|BY=Europe/Minsk|BZ=America/Belize|CA=America/Toronto,America/St_Johns,America/Halifax,America/Glace_Bay,America/Moncton,America/Goose_Bay,America/Blanc-Sablon,America/Iqaluit,America/Atikokan,America/Winnipeg,America/Resolute,America/Rankin_Inlet,America/Regina,America/Swift_Current,America/Edmonton,America/Cambridge_Bay,America/Inuvik,America/Vancouver,America/Creston,America/Dawson_Creek,America/Fort_Nelson,America/Whitehorse,America/Dawson|CC=Indian/Cocos|CD=Africa/Kinshasa,Africa/Lubumbashi|CF=Africa/Bangui|CG=Africa/Brazzaville|CH=Europe/Zurich|CI=Africa/Abidjan|CK=Pacific/Rarotonga|CL=America/Santiago,America/Coyhaique,America/Punta_Arenas,Pacific/Easter|CM=Africa/Douala|CN=Asia/Shanghai,Asia/Urumqi|CO=America/Bogota|CR=America/Costa_Rica|CU=America/Havana|CV=Atlantic/Cape_Verde|CW=America/Curacao|CX=Indian/Christmas|CY=Asia/Nicosia,Asia/Famagusta|CZ=Europe/Prague|DE=Europe/Berlin,Europe/Busingen|DJ=Africa/Djibouti|DK=Europe/Copenhagen|DM=America/Dominica|DO=America/Santo_Domingo|DZ=Africa/Algiers|EC=America/Guayaquil,Pacific/Galapagos|EE=Europe/Tallinn|EG=Africa/Cairo|EH=Africa/El_Aaiun|ER=Africa/Asmara|ES=Europe/Madrid,Africa/Ceuta,Atlantic/Canary|ET=Africa/Addis_Ababa|FI=Europe/Helsinki|FJ=Pacific/Fiji|FK=Atlantic/Stanley|FM=Pacific/Chuuk,Pacific/Pohnpei,Pacific/Kosrae|FO=Atlantic/Faroe|FR=Europe/Paris|GA=Africa/Libreville|GB=Europe/London|GD=America/Grenada|GE=Asia/Tbilisi|GF=America/Cayenne|GG=Europe/Guernsey|GH=Africa/Accra|GI=Europe/Gibraltar|GL=America/Nuuk,America/Danmarkshavn,America/Scoresbysund,America/Thule|GM=Africa/Banjul|GN=Africa/Conakry|GP=America/Guadeloupe|GQ=Africa/Malabo|GR=Europe/Athens|GS=Atlantic/South_Georgia|GT=America/Guatemala|GU=Pacific/Guam|GW=Africa/Bissau|GY=America/Guyana|HK=Asia/Hong_Kong|HN=America/Tegucigalpa|HR=Europe/Zagreb|HT=America/Port-au-Prince|HU=Europe/Budapest|ID=Asia/Jakarta,Asia/Pontianak,Asia/Makassar,Asia/Jayapura|IE=Europe/Dublin|IL=Asia/Jerusalem|IM=Europe/Isle_of_Man|IN=Asia/Kolkata|IO=Indian/Chagos|IQ=Asia/Baghdad|IR=Asia/Tehran|IS=Atlantic/Reykjavik|IT=Europe/Rome|JE=Europe/Jersey|JM=America/Jamaica|JO=Asia/Amman|JP=Asia/Tokyo|KE=Africa/Nairobi|KG=Asia/Bishkek|KH=Asia/Phnom_Penh|KI=Pacific/Tarawa,Pacific/Kanton,Pacific/Kiritimati|KM=Indian/Comoro|KN=America/St_Kitts|KP=Asia/Pyongyang|KR=Asia/Seoul|KW=Asia/Kuwait|KY=America/Cayman|KZ=Asia/Almaty,Asia/Qyzylorda,Asia/Qostanay,Asia/Aqtobe,Asia/Aqtau,Asia/Atyrau,Asia/Oral|LA=Asia/Vientiane|LB=Asia/Beirut|LC=America/St_Lucia|LI=Europe/Vaduz|LK=Asia/Colombo|LR=Africa/Monrovia|LS=Africa/Maseru|LT=Europe/Vilnius|LU=Europe/Luxembourg|LV=Europe/Riga|LY=Africa/Tripoli|MA=Africa/Casablanca|MC=Europe/Monaco|MD=Europe/Chisinau|ME=Europe/Podgorica|MF=America/Marigot|MG=Indian/Antananarivo|MH=Pacific/Majuro,Pacific/Kwajalein|MK=Europe/Skopje|ML=Africa/Bamako|MM=Asia/Yangon|MN=Asia/Ulaanbaatar,Asia/Hovd|MO=Asia/Macau|MP=Pacific/Saipan|MQ=America/Martinique|MR=Africa/Nouakchott|MS=America/Montserrat|MT=Europe/Malta|MU=Indian/Mauritius|MV=Indian/Maldives|MW=Africa/Blantyre|MX=America/Mexico_City,America/Cancun,America/Merida,America/Monterrey,America/Matamoros,America/Chihuahua,America/Ciudad_Juarez,America/Ojinaga,America/Mazatlan,America/Bahia_Banderas,America/Hermosillo,America/Tijuana|MY=Asia/Kuala_Lumpur,Asia/Kuching|MZ=Africa/Maputo|NA=Africa/Windhoek|NC=Pacific/Noumea|NE=Africa/Niamey|NF=Pacific/Norfolk|NG=Africa/Lagos|NI=America/Managua|NL=Europe/Amsterdam|NO=Europe/Oslo|NP=Asia/Kathmandu|NR=Pacific/Nauru|NU=Pacific/Niue|NZ=Pacific/Auckland,Pacific/Chatham|OM=Asia/Muscat|PA=America/Panama|PE=America/Lima|PF=Pacific/Tahiti,Pacific/Marquesas,Pacific/Gambier|PG=Pacific/Port_Moresby,Pacific/Bougainville|PH=Asia/Manila|PK=Asia/Karachi|PL=Europe/Warsaw|PM=America/Miquelon|PN=Pacific/Pitcairn|PR=America/Puerto_Rico|PS=Asia/Gaza,Asia/Hebron|PT=Europe/Lisbon,Atlantic/Madeira,Atlantic/Azores|PW=Pacific/Palau|PY=America/Asuncion|QA=Asia/Qatar|RE=Indian/Reunion|RO=Europe/Bucharest|RS=Europe/Belgrade|RU=Europe/Moscow,Europe/Kaliningrad,Europe/Kirov,Europe/Volgograd,Europe/Astrakhan,Europe/Saratov,Europe/Ulyanovsk,Europe/Samara,Asia/Yekaterinburg,Asia/Omsk,Asia/Novosibirsk,Asia/Barnaul,Asia/Tomsk,Asia/Novokuznetsk,Asia/Krasnoyarsk,Asia/Irkutsk,Asia/Chita,Asia/Yakutsk,Asia/Khandyga,Asia/Vladivostok,Asia/Ust-Nera,Asia/Magadan,Asia/Sakhalin,Asia/Srednekolymsk,Asia/Kamchatka,Asia/Anadyr|RW=Africa/Kigali|SA=Asia/Riyadh|SB=Pacific/Guadalcanal|SC=Indian/Mahe|SD=Africa/Khartoum|SE=Europe/Stockholm|SG=Asia/Singapore|SH=Atlantic/St_Helena|SI=Europe/Ljubljana|SJ=Arctic/Longyearbyen|SK=Europe/Bratislava|SL=Africa/Freetown|SM=Europe/San_Marino|SN=Africa/Dakar|SO=Africa/Mogadishu|SR=America/Paramaribo|SS=Africa/Juba|ST=Africa/Sao_Tome|SV=America/El_Salvador|SX=America/Lower_Princes|SY=Asia/Damascus|SZ=Africa/Mbabane|TC=America/Grand_Turk|TD=Africa/Ndjamena|TF=Indian/Kerguelen|TG=Africa/Lome|TH=Asia/Bangkok|TJ=Asia/Dushanbe|TK=Pacific/Fakaofo|TL=Asia/Dili|TM=Asia/Ashgabat|TN=Africa/Tunis|TO=Pacific/Tongatapu|TR=Europe/Istanbul|TT=America/Port_of_Spain|TV=Pacific/Funafuti|TW=Asia/Taipei|TZ=Africa/Dar_es_Salaam|UA=Europe/Kyiv,Europe/Simferopol|UG=Africa/Kampala|UM=Pacific/Wake,Pacific/Midway|US=America/New_York,America/Detroit,America/Kentucky/Louisville,America/Kentucky/Monticello,America/Indiana/Indianapolis,America/Indiana/Vincennes,America/Indiana/Winamac,America/Indiana/Marengo,America/Indiana/Petersburg,America/Indiana/Vevay,America/Chicago,America/Indiana/Tell_City,America/Indiana/Knox,America/Menominee,America/North_Dakota/Center,America/North_Dakota/New_Salem,America/North_Dakota/Beulah,America/Denver,America/Boise,America/Phoenix,America/Los_Angeles,America/Anchorage,America/Juneau,America/Sitka,America/Metlakatla,America/Yakutat,America/Nome,America/Adak,Pacific/Honolulu|UY=America/Montevideo|UZ=Asia/Tashkent,Asia/Samarkand|VA=Europe/Vatican|VC=America/St_Vincent|VE=America/Caracas|VG=America/Tortola|VI=America/St_Thomas|VN=Asia/Ho_Chi_Minh|VU=Pacific/Efate|WF=Pacific/Wallis|WS=Pacific/Apia|YE=Asia/Aden|YT=Indian/Mayotte|ZA=Africa/Johannesburg|ZM=Africa/Lusaka|ZW=Africa/Harare'

  // Country NAME -> ISO-3166 alpha-2 (umpirsky country-list plus aliases).
  // The probe reports names ("Sweden"), the relay list reports codes ("se");
  // both have to land in the same table.
  const N2I_BLOB = 'afghanistan=AF|albania=AL|algeria=DZ|american samoa=AS|andorra=AD|angola=AO|anguilla=AI|antarctica=AQ|antigua & barbuda=AG|argentina=AR|armenia=AM|aruba=AW|australia=AU|austria=AT|azerbaijan=AZ|bahamas=BS|bahrain=BH|bangladesh=BD|barbados=BB|belarus=BY|belgium=BE|belize=BZ|benin=BJ|bermuda=BM|bhutan=BT|bolivia=BO|bosnia & herzegovina=BA|bosnia and herzegovina=BA|botswana=BW|bouvet island=BV|brazil=BR|british indian ocean territory=IO|british virgin islands=VG|brunei=BN|bulgaria=BG|burkina faso=BF|burma=MM|burundi=BI|cambodia=KH|cameroon=CM|canada=CA|cape verde=CV|caribbean netherlands=BQ|cayman islands=KY|central african republic=CF|chad=TD|chile=CL|china=CN|christmas island=CX|cocos (keeling) islands=CC|colombia=CO|comoros=KM|congo - brazzaville=CG|congo - kinshasa=CD|cook islands=CK|costa rica=CR|cote d\'ivoire=CI|croatia=HR|cuba=CU|curacao=CW|cyprus=CY|czech republic=CZ|czechia=CZ|democratic republic of the congo=CD|denmark=DK|djibouti=DJ|dominica=DM|dominican republic=DO|dr congo=CD|ecuador=EC|egypt=EG|el salvador=SV|england=GB|equatorial guinea=GQ|eritrea=ER|estonia=EE|eswatini=SZ|ethiopia=ET|falkland islands=FK|faroe islands=FO|fiji=FJ|finland=FI|france=FR|french guiana=GF|french polynesia=PF|french southern territories=TF|gabon=GA|gambia=GM|georgia=GE|germany=DE|ghana=GH|gibraltar=GI|great britain=GB|greece=GR|greenland=GL|grenada=GD|guadeloupe=GP|guam=GU|guatemala=GT|guernsey=GG|guinea=GN|guinea-bissau=GW|guyana=GY|haiti=HT|heard & mcdonald islands=HM|honduras=HN|hong kong=HK|hong kong sar china=HK|hungary=HU|iceland=IS|india=IN|indonesia=ID|iran=IR|iran, islamic republic of=IR|iraq=IQ|ireland=IE|isle of man=IM|israel=IL|italy=IT|ivory coast=CI|jamaica=JM|japan=JP|jersey=JE|jordan=JO|kazakhstan=KZ|kenya=KE|kiribati=KI|korea, republic of=KR|kosovo=XK|kuwait=KW|kyrgyzstan=KG|laos=LA|latvia=LV|lebanon=LB|lesotho=LS|liberia=LR|libya=LY|liechtenstein=LI|lithuania=LT|luxembourg=LU|macao=MO|macao sar china=MO|macau=MO|macedonia=MK|madagascar=MG|malawi=MW|malaysia=MY|maldives=MV|mali=ML|malta=MT|marshall islands=MH|martinique=MQ|mauritania=MR|mauritius=MU|mayotte=YT|mexico=MX|micronesia=FM|moldova=MD|monaco=MC|mongolia=MN|montenegro=ME|montserrat=MS|morocco=MA|mozambique=MZ|myanmar=MM|myanmar (burma)=MM|namibia=NA|nauru=NR|nepal=NP|netherlands=NL|new caledonia=NC|new zealand=NZ|nicaragua=NI|niger=NE|nigeria=NG|niue=NU|norfolk island=NF|north korea=KP|north macedonia=MK|northern mariana islands=MP|norway=NO|oman=OM|pakistan=PK|palau=PW|palestine=PS|palestinian territories=PS|panama=PA|papua new guinea=PG|paraguay=PY|peru=PE|philippines=PH|pitcairn islands=PN|poland=PL|portugal=PT|puerto rico=PR|qatar=QA|ramallah=PS|republic of moldova=MD|republic of the congo=CG|romania=RO|rwanda=RW|reunion=RE|samoa=WS|san marino=SM|saudi arabia=SA|senegal=SN|serbia=RS|seychelles=SC|sierra leone=SL|singapore=SG|sint maarten=SX|slovakia=SK|slovenia=SI|solomon islands=SB|somalia=SO|south africa=ZA|south georgia & south sandwich islands=GS|south korea=KR|south sudan=SS|spain=ES|sri lanka=LK|st. barthelemy=BL|st. helena=SH|st. kitts & nevis=KN|st. lucia=LC|st. martin=MF|st. pierre & miquelon=PM|st. vincent & grenadines=VC|state of palestine=PS|sudan=SD|suriname=SR|svalbard & jan mayen=SJ|swaziland=SZ|sweden=SE|switzerland=CH|syria=SY|syrian arab republic=SY|sao tome & principe=ST|taipei=TW|taiwan=TW|taiwan, province of china=TW|tajikistan=TJ|tanzania=TZ|thailand=TH|timor-leste=TL|togo=TG|tokelau=TK|tonga=TO|trinidad & tobago=TT|trinidad and tobago=TT|tunisia=TN|turkey=TR|turkiye=TR|turkmenistan=TM|turks & caicos islands=TC|tuvalu=TV|u.s. outlying islands=UM|u.s. virgin islands=VI|uganda=UG|uk=GB|ukraine=UA|united arab emirates=AE|united kingdom=GB|united states=US|united states of america=US|uruguay=UY|usa=US|uzbekistan=UZ|vanuatu=VU|vatican city=VA|venezuela=VE|viet nam=VN|vietnam=VN|wallis & futuna=WF|western sahara=EH|yemen=YE|zambia=ZM|zimbabwe=ZW|aland islands=AX'

  // City NAME -> zone, multi-zone countries only. Keys are normStr() output.
  // Audited 2026-10 against Mullvad's full live relay list: this covers every
  // Mullvad city in a multi-zone country (the six gaps the audit found —
  // Nicosia, Berlin, Düsseldorf, Frankfurt, Raleigh NC, McAllen TX — are the
  // entries marked [bhtz-audit]; McAllen mattered, it is US Central and the
  // country primary would have said New York). Mullvad city names carry state
  // suffixes ("Ashburn, VA"); normStr keeps them and the lookup drops
  // trailing short tokens, so both "ashburn va" and "ashburn" resolve.
  const CITY_BLOB = 'adelaide=Australia/Adelaide|almaty=Asia/Almaty|americana=America/Sao_Paulo|anchorage=America/Anchorage|ashburn=America/New_York|astana=Asia/Almaty|atlanta=America/New_York|auckland=Pacific/Auckland|austin=America/Chicago|bandung=Asia/Jakarta|barcelona=Europe/Madrid|beijing=Asia/Shanghai|belem=America/Belem|berlin=Europe/Berlin|bilbao=Europe/Madrid|boston=America/New_York|brasilia=America/Sao_Paulo|brisbane=Australia/Brisbane|buenos aires=America/Argentina/Buenos_Aires|buffalo=America/New_York|calgary=America/Edmonton|campinas=America/Sao_Paulo|canberra=Australia/Sydney|cancun=America/Cancun|chicago=America/Chicago|christchurch=Pacific/Auckland|concepcion=America/Santiago|cordoba=America/Argentina/Cordoba|curitiba=America/Sao_Paulo|dallas=America/Chicago|darwin=Australia/Darwin|denpasar=Asia/Makassar|denver=America/Denver|detroit=America/Detroit|dusseldorf=Europe/Berlin|edmonton=America/Edmonton|fortaleza=America/Fortaleza|frankfurt=Europe/Berlin|funchal=Atlantic/Madeira|gaza=Asia/Gaza|guadalajara=America/Mexico_City|halifax=America/Halifax|hillsboro=America/Los_Angeles|hobart=Australia/Hobart|honolulu=Pacific/Honolulu|houston=America/Chicago|itajai=America/Sao_Paulo|jakarta=Asia/Jakarta|johor bahru=Asia/Kuala_Lumpur|kansas city=America/Chicago|kharkiv=Europe/Kyiv|kiev=Europe/Kyiv|kuala lumpur=Asia/Kuala_Lumpur|kyiv=Europe/Kyiv|las palmas=Atlantic/Canary|las vegas=America/Los_Angeles|lisbon=Europe/Lisbon|los angeles=America/Los_Angeles|lviv=Europe/Kyiv|madrid=Europe/Madrid|makassar=Asia/Makassar|malaga=Europe/Madrid|manaus=America/Manaus|mcallen=America/Chicago|medan=Asia/Jakarta|melbourne=Australia/Melbourne|mendoza=America/Argentina/Mendoza|merida=America/Merida|mexico city=America/Mexico_City|miami=America/New_York|minneapolis=America/Chicago|monterrey=America/Monterrey|montreal=America/Toronto|moscow=Europe/Moscow|nashville=America/Chicago|new york=America/New_York|newcastle=Australia/Sydney|nicosia=Asia/Nicosia|novosibirsk=Asia/Novosibirsk|nuuk=America/Nuuk|odessa=Europe/Kyiv|ottawa=America/Toronto|palma=Europe/Madrid|perth=Australia/Perth|philadelphia=America/New_York|phoenix=America/Phoenix|ponta delgada=Atlantic/Azores|portland=America/Los_Angeles|porto=Europe/Lisbon|porto alegre=America/Sao_Paulo|quebec=America/Toronto|queretaro=America/Mexico_City|raleigh=America/New_York|ramallah=Asia/Hebron|recife=America/Recife|rio de janeiro=America/Sao_Paulo|rosario=America/Argentina/Cordoba|sacramento=America/Los_Angeles|saint petersburg=Europe/Moscow|salt lake city=America/Denver|salvador=America/Bahia|san diego=America/Los_Angeles|san francisco=America/Los_Angeles|san jose=America/Los_Angeles|santiago=America/Santiago|sao paulo=America/Sao_Paulo|seattle=America/Los_Angeles|secaucus=America/New_York|seville=Europe/Madrid|shanghai=Asia/Shanghai|st louis=America/Chicago|surabaya=Asia/Jakarta|sydney=Australia/Sydney|tijuana=America/Tijuana|toronto=America/Toronto|urumqi=Asia/Urumqi|valencia=Europe/Madrid|valparaiso=America/Santiago|vancouver=America/Vancouver|vladivostok=Asia/Vladivostok|washington=America/New_York|wellington=Pacific/Auckland|winnipeg=America/Winnipeg|yekaterinburg=Asia/Yekaterinburg'

  /** ISO-3166 alpha-2 -> [zones], primary first. From tzdb's own zone.tab. */
  const COUNTRY_TZ = (function () {
    const m = Object.create(null)
    const raw = parseBlob(CZ_BLOB)
    for (const cc of Object.keys(raw)) m[cc] = raw[cc].split(',')
    return m
  })()

  /** Lowercased country name -> ISO code. Keys are folded through the same
   *  normStr() as queries, so punctuation-bearing entries ("cote d'ivoire",
   *  "congo - brazzaville") are actually reachable — an upstream-table quirk
   *  this fork fixes rather than inherits. */
  const NAME2ISO = (function () {
    const raw = parseBlob(N2I_BLOB)
    const m = Object.create(null)
    for (const k of Object.keys(raw)) {
      const folded = normStr(k)
      if (folded && !(folded in m)) m[folded] = raw[k]
    }
    return m
  })()

  /** Normalised city name -> zone, multi-zone countries only. Keys folded
   *  the same way, for the same reason. */
  const CITY_TZ = (function () {
    const raw = parseBlob(CITY_BLOB)
    const m = Object.create(null)
    for (const k of Object.keys(raw)) {
      const folded = normStr(k)
      if (folded && !(folded in m)) m[folded] = raw[k]
    }
    return m
  })()

  /**
   * The whole derivation. Pure function of a location and the tables.
   *
   * @param {{ country?: string | null, city?: string | null, cc?: string | null }} loc
   *   country/city are NAMES (the probe's answer); cc is an ISO alpha-2 code
   *   (the relay list's). A code beats a name: it needs no normalisation and
   *   cannot be a localised spelling the table has not seen.
   * @returns {{ zone: string | null, rule: string, approx: boolean }}
   */
  function zoneFromLocation (loc) {
    const ccRaw = typeof loc.cc === 'string' ? loc.cc.trim().toUpperCase() : ''
    const iso = (ccRaw && COUNTRY_TZ[ccRaw]) ? ccRaw : (NAME2ISO[normStr(loc.country)] || null)
    const zones = iso ? COUNTRY_TZ[iso] : null

    // 1. Single-zone country: authoritative. The city is ignored on purpose —
    //    a geo database that puts a Gothenburg exit in "Stockholm" (or in a
    //    PoP across the border) cannot move the answer, because the whole
    //    country is one zone.
    if (zones && zones.length === 1) {
      return { zone: zones[0], rule: `${iso} is a single-zone country`, approx: false }
    }

    // 2. Multi-zone country, known city. "Ashburn, VA" -> "ashburn va" ->
    //    drop trailing short tokens -> "ashburn". Accept the city's zone only
    //    if tzdb lists it inside this country: a Toronto answer for a US exit
    //    says nothing about the exit and would be installed as a lie.
    const toks = normStr(loc.city).split(' ').filter(Boolean)
    while (toks.length > 1 && toks[toks.length - 1].length <= 2) toks.pop()
    const tz = CITY_TZ[toks.join(' ')] || CITY_TZ[normStr(loc.city)] || null
    if (tz && (!zones || zones.indexOf(tz) !== -1)) {
      return { zone: tz, rule: `city "${loc.city}" -> ${tz}`, approx: false }
    }
    if (zones && zones.length) {
      // 3. Best honest answer: the country's primary zone, flagged.
      const why = tz
        ? `city "${loc.city}" (${tz}) lies outside ${iso} — cross-border geolocation; using country primary`
        : `city "${loc.city || '?'}" not in the embedded table; using ${iso} primary`
      return { zone: zones[0], rule: why, approx: true }
    }
    if (tz) return { zone: tz, rule: `city "${loc.city}" -> ${tz} (country unresolved)`, approx: false }
    return { zone: null, rule: `location unmappable ("${loc.country || '?'}" / "${loc.city || '?'}")`, approx: false }
  }

  /**
   * Is this a zone THIS engine will actually accept? A stored pin can be
   * stale or hand-edited, and injecting a zone the realm's ICU rejects would
   * make the patch bail — leaving the page realm completely unprotected,
   * which is worse than not patching at all. Callers pass the realm's
   * Intl in; this module stays browser-free.
   * @param {unknown} z
   * @param {typeof Intl} intl
   * @returns {boolean}
   */
  function usableZone (z, intl) {
    if (typeof z !== 'string' || !z) return false
    try {
      new intl.DateTimeFormat('en-US', { timeZone: z })
      return true
    } catch {
      return false
    }
  }

  /**
   * Canonicalise through ICU, so "asia/calcutta" and "Asia/Kolkata" are the
   * same pin and a tzdb rename cannot strand a stored value. Returns null for
   * anything the engine rejects — a garbage string can never become a zone.
   * @param {unknown} raw
   * @param {typeof Intl} intl
   * @returns {string | null}
   */
  function canonicalZone (raw, intl) {
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      const z = new intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone
      return typeof z === 'string' && z ? z : null
    } catch {
      return null
    }
  }

  // Zone sources, surfaced in the UI. `probe` is the normal steady state: the
  // killswitch's own health check, riding the container's own exit, said where
  // that exit is. It can only exist while health is 'up' — and because the
  // gate blocks everything until then, no page ever loads on a weaker source.
  /** @typedef {'pin' | 'probe' | 'relay' | 'off' | 'disabled' | 'unmanaged' | 'unknown'} TzSource */

  /**
   * Decide what zone (if any) a context should present, and why. Pure: the
   * caller supplies every input; registration is tz.js's business.
   *
   * Precedence, highest first:
   *   override 'off'   the user said: never spoof here.
   *   override zone    a pin. Standing instruction, no lookup, no expiry.
   *   global disabled  the feature is off; nothing spoofs anywhere.
   *   unmanaged        no exit assigned — there is nothing to match to, and
   *                    spoofing a zone your real IP contradicts is a louder
   *                    signal than an honest one.
   *   probe geo        the verified exit's own country/city (health 'up').
   *   relay geo        the assigned server's listed city/country. Weaker: it
   *                    describes the CONFIG, not the observed exit. Only ever
   *                    briefly relevant — the gate blocks until a probe
   *                    succeeds — but it means a pin-free container has the
   *                    right zone registered before its first allowed load.
   *
   * @param {{
   *   enabled: boolean,
   *   override?: string | null,
   *   geo?: { country?: string | null, city?: string | null } | null,
   *   geoTrusted?: boolean,
   *   config?: { city?: string, country?: string, cc?: string } | null,
   *   intl: typeof Intl
   * }} input
   * @returns {{ zone: string | null, source: TzSource, approx: boolean, rule: string }}
   */
  function derive (input) {
    /** @param {TzSource} source @param {string} [rule] */
    const none = (source, rule = '') => ({ zone: null, source, approx: false, rule })

    if (input.override === 'off') return none('off', 'spoofing switched off for this context')
    if (typeof input.override === 'string' && input.override) {
      const z = canonicalZone(input.override, input.intl)
      // An unusable pin is treated as absent rather than injected raw: a
      // hand-edited typo must not leave the container unprotected, and the
      // UI validates before storing, so this is belt and braces.
      if (z) return { zone: z, source: 'pin', approx: false, rule: 'user pin' }
    }
    if (!input.enabled) return none('disabled', 'timezone matching is switched off')
    if (!input.config) return none('unmanaged', 'no exit assigned to this context')

    if (input.geoTrusted && input.geo && (input.geo.country || input.geo.city)) {
      // Probe geography stands alone: it is the OBSERVED exit, and mixing in
      // the assignment's country code would let a config label override an
      // observation — the exact inversion of what "trust the probe" means.
      // (For relays the two agree by construction: 'up' requires the exit
      // hostname to match the assignment. For the tunnel endpoint and custom
      // exits the config has no geography at all.)
      const d = zoneFromLocation({ country: input.geo.country, city: input.geo.city })
      if (d.zone && usableZone(d.zone, input.intl)) return { zone: d.zone, source: 'probe', approx: d.approx, rule: d.rule }
    }

    if (input.config.city || input.config.cc || input.config.country) {
      const d = zoneFromLocation({ country: input.config.country, city: input.config.city, cc: input.config.cc })
      if (d.zone && usableZone(d.zone, input.intl)) return { zone: d.zone, source: 'relay', approx: d.approx, rule: d.rule }
    }

    return none('unknown', 'exit location not known yet')
  }

  const api = { zoneFromLocation, canonicalZone, usableZone, derive, normStr, COUNTRY_TZ, CITY_TZ, NAME2ISO }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    root.zonelib = api
  }
})(globalThis)
