'use strict'
// Bulkhead TZ — the page-realm engine.
//
// THIS IS THE PART THAT BEATS THE FINGERPRINT. A zone name in storage spoofs
// nothing; what a page can observe is the behaviour of Date, Intl and
// Temporal, and every one of them has to agree with the zone — including the
// derivations fingerprinters use instead of asking directly:
//
//   - CreepJS reads the offset by parsing "M/D/YYYY" as a LOCAL string and
//     subtracting a UTC parse of the same day. Local-time string parsing
//     lives inside the engine's Date constructor, so the constructor itself
//     is re-homed: non-ISO strings are re-interpreted in the target zone.
//   - CreepJS's "computed location" probes year 1113 — the LMT era — so a
//     spoof that only shifts present-day offsets cannot reproduce it. Here
//     the system side (local parse) and the resolvedOptions side (Intl in
//     the target zone) both come from the same ICU data for the same zone,
//     they compare equal, and the probe short-circuits to the reported zone.
//   - Date.prototype.toLocaleString* resolve the %Intl% intrinsic directly in
//     SpiderMonkey, so replacing Intl.DateTimeFormat alone is not enough —
//     the natives are delegated to with the zone injected.
//   - Local getters/setters, Temporal.Now.*, about:blank probe realms
//     (captured at DOM-insertion time — indexed WindowProxy access is not a
//     hookable getter), workers (constructor shimmed onto blob: payloads)
//     and Function.prototype.toString (narrowly: it vouches only for
//     functions this engine created) are all covered.
//
// Adapted from the Timezone Lock userscript v3.3.4 (MIT) — its realm engine,
// which was verified in the field against CreepJS's own derivations, ported
// essentially unchanged. What an EXTENSION adds over the userscript is the
// delivery, not the engine: this function is serialised and registered as a
// MAIN-world content script at document_start per container, so (a) injection
// is guaranteed before any page script runs — the userscript's late-injection
// failure mode cannot occur, (b) it is exempt from page CSP and iframe
// sandbox, and (c) the zone arrives already resolved, synchronously, baked
// into the registered code — no veil, no reload, no cold start.
//
// The function below must stay fully self-contained: it is serialised with
// Function.prototype.toString and re-executed in page realms and inside
// workers. It must not close over anything from this file's scope. It
// receives a reference to itself (SELF) so nested worker payloads can be
// generated without a free identifier that would not exist in the target
// realm.
//
// LIMITATION, unchanged and unfixable from JS: service worker realms cannot
// be reached — no platform API exposes them to page JS, and blob:/data:
// script URLs are rejected by register(). CFG.serviceWorkerMode can only
// warn or block. A site fingerprinting from a service worker still sees the
// real zone. The only complete fixes live below JS:
// privacy.resistFingerprinting (forces UTC engine-wide, so the matched zone
// would then have to be UTC) or an OS-level zone override at launch.
//

function installTZRealm (CFG, SELF) {
  'use strict';

  /* ---- state shared by every realm built from this copy ---------------- */

  /** Functions that must report `[native code]`. Shared across realms, which
   *  is what lets a probe iframe vouch for the page realm's patched methods. */
  const hidden = new WeakSet();
  const built = new WeakSet();
  const watchedFrames = new WeakSet();

  const TZ = CFG.timeZone;
  const DEEP = CFG.stealth === 'deep';
  const log = CFG.debug ? (...a) => console.debug('[bulkhead-tz]', ...a) : () => {};

  /* ---- helpers --------------------------------------------------------- */

  /** Define with the exact descriptor shape the platform uses for methods. */
  function def(obj, key, value) {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  /** Register a function as native-looking. Method shorthand only: no own
   *  `prototype`, and `.caller`/`.arguments` are poisoned under strict mode —
   *  both of which CreepJS probes for. */
  function mark(fn) {
    hidden.add(fn);
    return fn;
  }

  /** Copy strict-mode method-shorthand functions onto a prototype. */
  function installMethods(proto, bag) {
    for (const key of Object.getOwnPropertyNames(bag)) {
      def(proto, key, mark(bag[key]));
    }
  }

  const pad2 = (n) => (n < 10 ? '0' : '') + n;

  function pad4(n) {
    const s = String(Math.abs(n));
    return (n < 0 ? '-' : '') + (s.length >= 4 ? s : '0'.repeat(4 - s.length) + s);
  }

  /** Build a worker payload from this same function's source. */
  function makePayload(cfg) {
    return (
      '(function (__tzl, __cfg) { __tzl(__cfg, __tzl); })(' +
      SELF.toString() +
      ', ' +
      JSON.stringify(cfg) +
      ');\n'
    );
  }

  /* =======================================================================
   * Per-realm build
   * ===================================================================== */

  function build(win) {
    if (win === null || win === undefined) return false;
    if (built.has(win)) return true;

    /* ---- capture pristine natives BEFORE anything is replaced ---------- */
    let NativeDate, DP, NativeDTF, dateUTC, dateNow, dateParse;
    try {
      NativeDate = win.Date;
      DP = NativeDate.prototype;
      NativeDTF = win.Intl && win.Intl.DateTimeFormat;
      dateUTC = NativeDate.UTC;
      dateNow = NativeDate.now;
      dateParse = NativeDate.parse;
      if (typeof NativeDate !== 'function' || typeof NativeDTF !== 'function') return false;
      // Validate the zone against this realm's ICU once. If it is not usable
      // we bail out entirely rather than leaving a half-patched realm.
      new NativeDTF('en-US', { timeZone: TZ });
    } catch (e) {
      log('realm not patchable', e);
      return false; // cross-origin frame, or bad zone
    }

    built.add(win);

    /** Bound-ish references to the pristine natives. Because we install onto
     *  the realm's real Date.prototype, every internal computation must go
     *  through these or it will recurse into our own replacements. */
    const N = {
      getTime: DP.getTime,
      setTime: DP.setTime,
      getTimezoneOffset: DP.getTimezoneOffset,
      getFullYear: DP.getFullYear,
      getMonth: DP.getMonth,
      getDate: DP.getDate,
      getHours: DP.getHours,
      getMinutes: DP.getMinutes,
      getSeconds: DP.getSeconds,
      getMilliseconds: DP.getMilliseconds,
      getUTCFullYear: DP.getUTCFullYear,
      getUTCMonth: DP.getUTCMonth,
      getUTCDate: DP.getUTCDate,
      getUTCDay: DP.getUTCDay,
      getUTCHours: DP.getUTCHours,
      getUTCMinutes: DP.getUTCMinutes,
      getUTCSeconds: DP.getUTCSeconds,
      getUTCMilliseconds: DP.getUTCMilliseconds,
      toLocaleString: DP.toLocaleString,
      toLocaleDateString: DP.toLocaleDateString,
      toLocaleTimeString: DP.toLocaleTimeString,
    };

    const MINUTE = 60000;
    const SECOND = 1000;
    const DAY = 86400000;
    /** 2000 years is exactly 5 x 146097 days and the Gregorian calendar
     *  repeats every 400 years — used to construct years 0..99 without
     *  tripping Date.UTC's MakeFullYear two-digit correction. */
    const MS_2000_YEARS = 5 * 146097 * DAY;

    const scratch = new NativeDate(0);
    /** Throws TypeError on incompatible receivers, exactly like the native. */
    const tv = (d) => N.getTime.call(d);

    /* ---- zone maths: ICU is the source of truth, LMT included ---------- */

    let partsFmt, zoneFmt;
    try {
      partsFmt = new NativeDTF('en-US', {
        timeZone: TZ,
        hourCycle: 'h23',
        calendar: 'gregory',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      zoneFmt = new NativeDTF('en-US', {
        timeZone: TZ,
        timeZoneName: 'long',
        calendar: 'gregory',
      });
    } catch (_) {
      built.delete(win);
      return false;
    }

    /** A zone offset cannot change within a minute, so bucket-cache. */
    const offsetCache = new Map();

    /** Milliseconds EAST of UTC in TZ at instant `ts`. */
    function offsetMsAt(ts) {
      if (!Number.isFinite(ts)) return 0;
      const key = Math.floor(ts / MINUTE);
      const hit = offsetCache.get(key);
      if (hit !== undefined) return hit;

      let off = 0;
      try {
        N.setTime.call(scratch, ts);
        let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
        for (const p of partsFmt.formatToParts(scratch)) {
          switch (p.type) {
            case 'year': y = +p.value; break;
            case 'month': mo = +p.value; break;
            case 'day': d = +p.value; break;
            case 'hour': h = +p.value; break;
            case 'minute': mi = +p.value; break;
            case 'second': s = +p.value; break;
          }
        }
        // formatToParts drops milliseconds: truncate both sides to the second.
        const truncated = ts - (ts % SECOND);
        const computed = dateUTC(y, mo - 1, d, h, mi, s) - truncated;
        // Sanity clamp — ICU can return nonsense for out-of-range years.
        if (Number.isFinite(computed) && Math.abs(computed) <= 15 * 3600000) off = computed;
      } catch (_) {
        off = 0;
      }
      if (offsetCache.size > 8192) offsetCache.clear();
      offsetCache.set(key, off);
      return off;
    }

    /** TZ wall clock for an instant. Pure arithmetic rather than formatting,
     *  so getters stay cheap and work for years ICU cannot render. */
    function wallOf(ts) {
      const shifted = ts + offsetMsAt(ts);
      N.setTime.call(scratch, Number.isFinite(shifted) ? shifted : ts);
      return {
        year: N.getUTCFullYear.call(scratch),
        month: N.getUTCMonth.call(scratch) + 1,
        day: N.getUTCDate.call(scratch),
        hour: N.getUTCHours.call(scratch),
        minute: N.getUTCMinutes.call(scratch),
        second: N.getUTCSeconds.call(scratch),
        ms: N.getUTCMilliseconds.call(scratch),
        weekday: N.getUTCDay.call(scratch),
      };
    }

    /** Exact UTC instant for wall-clock fields, with NO MakeFullYear
     *  correction (Date.UTC would map years 0..99 into the 1900s). */
    function utcExact(y, mo, d, h, mi, s, ms) {
      if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return NaN;
      if (!Number.isFinite(h) || !Number.isFinite(mi) || !Number.isFinite(s) || !Number.isFinite(ms)) return NaN;
      if (y >= 0 && y <= 99) {
        const t = dateUTC(y + 2000, mo - 1, d, h, mi, s, ms);
        return Number.isNaN(t) ? NaN : t - MS_2000_YEARS;
      }
      return dateUTC(y, mo - 1, d, h, mi, s, ms);
    }

    /**
     * Invert wall clock -> instant.
     *
     * A wall time maps to zero, one or two instants:
     *   one  – normal
     *   two  – DST fold (autumn, the hour repeats)
     *   zero – DST gap  (spring, the hour does not exist)
     *
     * ECMA-262's LocalTZA resolves both edge cases with the offset in effect
     * BEFORE the transition. For a fold that selects the earlier of the two
     * instants; for a gap it produces an instant past the transition, so the
     * wall clock reads later than requested (02:30 -> 03:30). This was
     * verified byte-for-byte against a conforming engine across every zone in
     * Intl.supportedValuesOf('timeZone') — see the note at the foot of this
     * file for reproducing it.
     *
     * Fast path: no transition anywhere within ±26h of the target, which is
     * wider than any real offset change (the largest on record is Samoa 2011,
     * a 24h jump). Only then do we pay for the candidate sweep.
     */
    const HOUR = 3600000;
    const SWEEP = 26 * HOUR;

    function instantOf(asUTC) {
      if (Number.isNaN(asUTC)) return NaN;

      const o1 = offsetMsAt(asUTC);
      const t1 = asUTC - o1;

      if (
        offsetMsAt(t1) === o1 &&
        offsetMsAt(asUTC - SWEEP) === o1 &&
        offsetMsAt(asUTC + SWEEP) === o1
      ) {
        return t1; // unambiguous, no transition nearby
      }

      // Collect every offset that occurs anywhere in the neighbourhood, then
      // keep the ones that actually round-trip.
      const candidates = new Set([
        o1,
        offsetMsAt(t1),
        offsetMsAt(asUTC - SWEEP),
        offsetMsAt(asUTC + SWEEP),
        offsetMsAt(t1 - 2 * HOUR),
        offsetMsAt(t1 + 2 * HOUR),
      ]);

      let best = NaN;
      let earliest = Infinity;
      for (const o of candidates) {
        const t = asUTC - o;
        if (t < earliest) earliest = t;
        if (offsetMsAt(t) === o && (Number.isNaN(best) || t < best)) best = t;
      }
      if (!Number.isNaN(best)) return best; // fold -> earlier instant

      // Gap: nothing round-trips. Use the offset in effect before the
      // transition, i.e. the offset at the earliest candidate instant.
      return asUTC - offsetMsAt(earliest);
    }

    /* ---- display name, e.g. "Central European Summer Time" ------------- */

    /**
     * Long zone display name for an instant, e.g. "Central European Summer
     * Time". Cached per minute bucket rather than per offset: some zones
     * legitimately have two different names at the same offset. Europe/Dublin
     * is the classic case — CLDR's Irish metazone is inverted, so +01:00 is
     * "Greenwich Mean Time" in 1970 (year-round IST, no DST) and "Irish
     * Standard Time" in 2026 (DST). Keying by offset alone conflates them.
     */
    const zoneNameCache = new Map();
    function zoneNameAt(ts) {
      const key = Math.floor(ts / MINUTE);
      const hit = zoneNameCache.get(key);
      if (hit !== undefined) return hit;
      let name = '';
      try {
        N.setTime.call(scratch, ts);
        for (const p of zoneFmt.formatToParts(scratch)) {
          if (p.type === 'timeZoneName') { name = p.value; break; }
        }
      } catch (_) { /* leave empty */ }
      if (zoneNameCache.size > 4096) zoneNameCache.clear();
      zoneNameCache.set(key, name);
      return name;
    }

    /** ECMA-262 formats the GMT label with truncation toward zero, not
     *  rounding — verified against LMT offsets with second precision such as
     *  Pacific/Chatham (+12:13:48 => "GMT+1213") and Asia/Tehran
     *  (+03:25:44 => "GMT+0325"). */
    function gmtLabel(ts) {
      const mins = Math.trunc(offsetMsAt(ts) / MINUTE);
      const sign = mins < 0 ? '-' : '+';
      const abs = Math.abs(mins);
      return 'GMT' + sign + pad2(Math.floor(abs / 60)) + pad2(abs % 60);
    }

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /* =====================================================================
     * Date
     * =================================================================== */

    /** ES MakeFullYear: the two-digit correction applied by the Date
     *  constructor, setFullYear and setYear. */
    function makeFullYear(y) {
      const n = Math.trunc(Number(y));
      return Number.isFinite(n) && n >= 0 && n <= 99 ? n + 1900 : n;
    }

    const ISO_RE =
      /^([+-]?\d{4,6})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;
    /** Explicit zone designator in a non-ISO string: "... GMT+0200 (...)",
     *  "Fri, 16 Oct 2026 12:04:47 GMT", "... +0200". */
    const ZONED_RE = /\b(?:GMT|UTC|UT)\b|[+-]\d{2}:?\d{2}\s*(?:\)|$)/i;

    /**
     * Does this string denote an absolute instant (pass through untouched)
     * rather than a local wall clock (re-interpret in TZ)?
     *
     * Per ECMA-262: ISO date-only forms are UTC; ISO date-time forms without
     * an offset are LOCAL; every other format is implementation-defined and
     * Gecko treats it as local unless it carries a zone designator.
     */
    function isAbsolute(str) {
      const m = ISO_RE.exec(str.trim());
      if (m) {
        const hasTime = m[4] !== undefined;
        const hasZone = m[8] !== undefined;
        return !hasTime || hasZone;
      }
      return ZONED_RE.test(str);
    }

    /** The wall-clock fields the REAL engine inferred, so we can re-home
     *  them in TZ. Uses the pristine natives captured in N. */
    function realWallOf(ts) {
      N.setTime.call(scratch, ts);
      return {
        year: N.getFullYear.call(scratch),
        month: N.getMonth.call(scratch) + 1,
        day: N.getDate.call(scratch),
        hour: N.getHours.call(scratch),
        minute: N.getMinutes.call(scratch),
        second: N.getSeconds.call(scratch),
        ms: N.getMilliseconds.call(scratch),
      };
    }

    /**
     * The core fix. Instead of writing a date-string parser, let the engine
     * parse it, read back the wall-clock fields it inferred, and rebuild the
     * instant as if those same fields had been read in TZ. Absolute strings
     * pass straight through, so ISO/Z/offset forms and toString()
     * round-trips are unaffected.
     */
    function parseString(str) {
      const native = dateParse(str);
      if (Number.isNaN(native)) return NaN;
      if (isAbsolute(str)) return native;
      const w = realWallOf(native);
      return instantOf(utcExact(w.year, w.month, w.day, w.hour, w.minute, w.second, w.ms));
    }

    function toTimeValue(v) {
      if (typeof v === 'string') return parseString(v);
      if (v !== null && typeof v === 'object') {
        // Unwrap anything with a [[DateValue]] without running user code.
        try {
          return N.getTime.call(v);
        } catch (_) { /* not a Date — fall through to ToPrimitive */ }
        try {
          const prim = typeof v[Symbol.toPrimitive] === 'function' ? v[Symbol.toPrimitive]('default') : v;
          if (typeof prim === 'string') return parseString(prim);
          if (prim !== v) return Number(prim);
        } catch (_) {
          return NaN;
        }
      }
      return Number(v);
    }

    function fieldsToTimeValue(args) {
      const n = (x) => Number(x);
      const y = makeFullYear(n(args[0]));
      const mo = args.length > 1 ? n(args[1]) : 0;
      const d = args.length > 2 ? n(args[2]) : 1;
      const h = args.length > 3 ? n(args[3]) : 0;
      const mi = args.length > 4 ? n(args[4]) : 0;
      const s = args.length > 5 ? n(args[5]) : 0;
      const ms = args.length > 6 ? n(args[6]) : 0;
      // Date.UTC applies MakeFullYear itself, so pass the corrected year and
      // let it be idempotent (>=1900 is unaffected).
      return instantOf(dateUTC(y, mo, d, h, mi, s, ms));
    }

    function FakeDate(...args) {
      if (new.target === undefined) {
        // Date() called as a function returns the current time as a string.
        return new FakeDate().toString();
      }
      let t;
      if (args.length === 0) t = dateNow();
      else if (args.length === 1) t = toTimeValue(args[0]);
      else t = fieldsToTimeValue(args);
      return Reflect.construct(NativeDate, [t], new.target);
    }
    def(FakeDate, 'name', 'Date');
    def(FakeDate, 'length', 7);
    def(FakeDate, 'parse', mark({ parse(value) { return parseString(String(value)); } }.parse));
    Object.setPrototypeOf(FakeDate, NativeDate); // inherit now / UTC
    FakeDate.prototype = DP;                    // see note below
    def(DP, 'constructor', FakeDate);
    mark(FakeDate);

    /* We install onto the realm's real Date.prototype rather than a subclass
     * prototype. Two reasons: (a) Dates the platform hands back — IndexedDB
     * records, input.valueAsDate, structuredClone — then get the spoof too,
     * and `x instanceof Date` keeps working for them; (b) it costs nothing in
     * lie surface, because untouched natives are still native and the ones we
     * replace are disguised. The price is that every internal computation has
     * to go through the pristine references captured in N. */

    /** Shared setter body: merge patched fields into the current wall clock. */
    function applyFields(self, patch) {
      const ts = tv(self); // TypeError for incompatible receivers
      if (Number.isNaN(ts)) return NaN;
      const w = wallOf(ts);
      const pick = (k) => (patch[k] === undefined ? w[k] : patch[k]);
      const y = patch.yearRaw !== undefined ? makeFullYear(patch.yearRaw) : pick('year');
      const next = instantOf(
        utcExact(y, pick('month'), pick('day'), pick('hour'), pick('minute'), pick('second'), pick('ms'))
      );
      N.setTime.call(self, next);
      return next;
    }

    /** Spec semantics: the first argument is always ToNumber'd (undefined =>
     *  NaN); trailing arguments that are undefined keep the current value. */
    const req = (a, i) => (a[i] === undefined ? NaN : Number(a[i]));
    const opt = (a, i) => (a[i] === undefined ? undefined : Number(a[i]));

    const methods = {
      /* --- local getters --- */
      getFullYear() { return wallOf(tv(this)).year; },
      getMonth() { return wallOf(tv(this)).month - 1; },
      getDate() { return wallOf(tv(this)).day; },
      getDay() { return wallOf(tv(this)).weekday; },
      getHours() { return wallOf(tv(this)).hour; },
      getMinutes() { return wallOf(tv(this)).minute; },
      getSeconds() { return wallOf(tv(this)).second; },
      getMilliseconds() { return wallOf(tv(this)).ms; },
      getTimezoneOffset() {
        const ts = tv(this);
        if (Number.isNaN(ts)) return N.getTimezoneOffset.call(this); // mirror the engine
        return -Math.trunc(offsetMsAt(ts) / MINUTE); // ECMA-262: -truncate(offset/minute)
      },

      /* --- local setters --- */
      setFullYear(...a) { return applyFields(this, { yearRaw: req(a, 0), month: opt(a, 1), day: opt(a, 2) }); },
      setMonth(...a) {
        const m = req(a, 0);
        return applyFields(this, { month: Number.isNaN(m) ? NaN : m + 1, day: opt(a, 1) });
      },
      setDate(...a) { return applyFields(this, { day: req(a, 0) }); },
      setHours(...a) { return applyFields(this, { hour: req(a, 0), minute: opt(a, 1), second: opt(a, 2), ms: opt(a, 3) }); },
      setMinutes(...a) { return applyFields(this, { minute: req(a, 0), second: opt(a, 1), ms: opt(a, 2) }); },
      setSeconds(...a) { return applyFields(this, { second: req(a, 0), ms: opt(a, 1) }); },
      setMilliseconds(...a) { return applyFields(this, { ms: req(a, 0) }); },

      /* --- strings --- */
      toString() {
        const ts = tv(this);
        if (Number.isNaN(ts)) return 'Invalid Date';
        const w = wallOf(ts);
        const name = zoneNameAt(ts);
        return DAYS[w.weekday] + ' ' + MONTHS[w.month - 1] + ' ' + pad2(w.day) + ' ' + pad4(w.year) + ' ' +
          pad2(w.hour) + ':' + pad2(w.minute) + ':' + pad2(w.second) + ' ' + gmtLabel(ts) +
          (name ? ' (' + name + ')' : '');
      },
      toDateString() {
        const ts = tv(this);
        if (Number.isNaN(ts)) return 'Invalid Date';
        const w = wallOf(ts);
        return DAYS[w.weekday] + ' ' + MONTHS[w.month - 1] + ' ' + pad2(w.day) + ' ' + pad4(w.year);
      },
      toTimeString() {
        const ts = tv(this);
        if (Number.isNaN(ts)) return 'Invalid Date';
        const w = wallOf(ts);
        const name = zoneNameAt(ts);
        return pad2(w.hour) + ':' + pad2(w.minute) + ':' + pad2(w.second) + ' ' + gmtLabel(ts) +
          (name ? ' (' + name + ')' : '');
      },

      /* --- locale formatting: delegate to the natives and only inject
             timeZone. Native toLocaleString resolves the %Intl% intrinsic
             directly, so replacing Intl.DateTimeFormat is not enough. --- */
      toLocaleString(locales, options) {
        tv(this);
        return N.toLocaleString.call(this, locales, withZone(options));
      },
      toLocaleDateString(locales, options) {
        tv(this);
        return N.toLocaleDateString.call(this, locales, withZone(options));
      },
      toLocaleTimeString(locales, options) {
        tv(this);
        return N.toLocaleTimeString.call(this, locales, withZone(options));
      },
    };

    // Annex B members exist in Gecko but are not guaranteed everywhere; only
    // add them where the native prototype already has them, so we never
    // introduce a property the real engine lacks.
    if (typeof DP.getYear === 'function') {
      methods.getYear = function getYear() { return wallOf(tv(this)).year - 1900; };
    }
    if (typeof DP.setYear === 'function') {
      methods.setYear = function setYear(...a) { return applyFields(this, { yearRaw: req(a, 0) }); };
    }

    /** Spec-shaped options object with TZ as the default. Never mutates the
     *  caller's object; leaves an explicit timeZone alone. */
    function withZone(options) {
      if (options === undefined || options === null) return { timeZone: TZ };
      try {
        const o = Object.assign({}, options); // ToObject
        if (o.timeZone === undefined) o.timeZone = TZ;
        return o;
      } catch (_) {
        return { timeZone: TZ };
      }
    }

    installMethods(DP, methods);

    /* =====================================================================
     * Intl.DateTimeFormat
     *
     * Replace the constructor with a callable+constructible wrapper that only
     * defaults `timeZone`. Not a subclass: the spec makes Intl.DateTimeFormat
     * legal to call WITHOUT `new` (`Intl.DateTimeFormat().resolvedOptions()`
     * — which is precisely how CreepJS reads it), and a class throws there.
     *
     * No prototype method is replaced. format / formatToParts / formatRange /
     * resolvedOptions remain the genuine natives, so resolvedOptions() reports
     * TZ because it genuinely resolved TZ: no override, no lie, and an
     * explicit timeZone is still honoured (v1.5 broke that).
     *
     * The prototype is flattened onto the native one rather than being a
     * fresh object, so `Object.getPrototypeOf(fmt) ===
     * Intl.DateTimeFormat.prototype` keeps holding.
     * =================================================================== */

    try {
      function FakeDTF(locales, options) {
        if (new.target === undefined) return new FakeDTF(locales, options);
        return Reflect.construct(NativeDTF, [locales, withZone(options)], new.target);
      }
      def(FakeDTF, 'name', 'DateTimeFormat');
      def(FakeDTF, 'length', NativeDTF.length);
      FakeDTF.prototype = NativeDTF.prototype;
      Object.setPrototypeOf(FakeDTF, NativeDTF); // inherit supportedLocalesOf
      mark(FakeDTF);
      def(win.Intl, 'DateTimeFormat', FakeDTF);
    } catch (e) {
      log('Intl.DateTimeFormat patch failed', e);
    }

    /* =====================================================================
     * Temporal (feature-detected; its shipping state varies by Gecko build)
     * =================================================================== */

    try {
      const Now = win.Temporal && win.Temporal.Now;
      if (Now) {
        const idName =
          typeof Now.timeZoneId === 'function' ? 'timeZoneId'
          : typeof Now.timeZone === 'function' ? 'timeZone'
          : null;
        if (idName) def(Now, idName, mark({ [idName]() { return TZ; } }[idName]));
        for (const m of ['zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO']) {
          const orig = Now[m];
          if (typeof orig !== 'function') continue;
          def(Now, m, mark({
            [m](timeZoneLike) {
              return orig.call(this, timeZoneLike === undefined ? TZ : timeZoneLike);
            },
          }[m]));
        }
      }
    } catch (e) {
      log('Temporal patch failed', e);
    }

    /* =====================================================================
     * Publish
     * =================================================================== */

    def(win, 'Date', FakeDate);

    /* =====================================================================
     * Iframe realms
     * =================================================================== */

    function installInto(other) {
      if (!other || other === win || built.has(other)) return;
      try { build(other); } catch (_) { /* cross-origin or dead frame */ }
    }

    function wrapGetter(proto, key, after) {
      if (!proto) return;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d || typeof d.get !== 'function' || !d.configurable) return;
      const orig = d.get;
      const name = 'get ' + key;
      const wrapped = {
        [name]() {
          const v = orig.call(this);
          try { after(v); } catch (_) {}
          return v;
        },
      }[name];
      Object.defineProperty(proto, key, {
        get: mark(wrapped),
        set: d.set,
        enumerable: d.enumerable,
        configurable: true,
      });
    }

    function watchFrame(el) {
      if (!el || watchedFrames.has(el)) return;
      watchedFrames.add(el);
      try { installInto(el.contentWindow); } catch (_) {}
      try {
        el.addEventListener('load', () => {
          try { installInto(el.contentWindow); } catch (_) {}
        });
      } catch (_) {}
    }

    try {
      const IF = win.HTMLIFrameElement && win.HTMLIFrameElement.prototype;
      wrapGetter(IF, 'contentWindow', installInto);
      wrapGetter(IF, 'contentDocument', (doc) => {
        try { if (doc) installInto(doc.defaultView); } catch (_) {}
      });
      wrapGetter(
        win.HTMLObjectElement && win.HTMLObjectElement.prototype,
        'contentDocument',
        (doc) => { try { if (doc) installInto(doc.defaultView); } catch (_) {} }
      );
    } catch (_) {}

    /**
     * Indexed WindowProxy access (window[0], window.frames[0]) is not a
     * JS-visible getter and cannot be hooked. So in deep mode we capture the
     * about:blank realm at DOM insertion time instead — the child browsing
     * context exists synchronously the moment the element is connected.
     */
    function scanInserted(node) {
      if (!node) return;
      const t = node.nodeType;
      if (t === 11) { // DocumentFragment
        const kids = node.childNodes;
        for (let i = 0; i < kids.length; i++) scanInserted(kids[i]);
        return;
      }
      if (t !== 1) return; // text/comment/... — the overwhelmingly common case
      const name = node.localName;
      if (name === 'iframe' || name === 'frame') { watchFrame(node); return; }
      // Leaf element: nothing nested, skip the subtree query entirely.
      if (!node.childNodes || node.childNodes.length === 0) return;
      let list;
      try { list = node.querySelectorAll('iframe,frame'); } catch (_) { return; }
      for (let i = 0; i < list.length; i++) watchFrame(list[i]);
    }

    function scanAll(nodes) {
      for (let i = 0; i < nodes.length; i++) scanInserted(nodes[i]);
    }

    function wrapMethod(proto, key, after) {
      if (!proto) return;
      const orig = proto[key];
      if (typeof orig !== 'function') return;
      const wrapped = {
        [key](...args) {
          const r = orig.apply(this, args);
          try { after.call(this, r, args); } catch (_) {}
          return r;
        },
      }[key];
      def(proto, key, mark(wrapped));
    }

    function wrapSetter(proto, key, after) {
      if (!proto) return;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d || typeof d.set !== 'function' || !d.configurable) return;
      const orig = d.set;
      const name = 'set ' + key;
      const wrapped = {
        [name](v) {
          orig.call(this, v);
          try { if (typeof v === 'string' && v.indexOf('iframe') !== -1) after(this); } catch (_) {}
        },
      }[name];
      Object.defineProperty(proto, key, {
        get: d.get,
        set: mark(wrapped),
        enumerable: d.enumerable,
        configurable: true,
      });
    }

    if (DEEP && win.Node && win.document) {
      const NP = win.Node.prototype;
      const EP = win.Element && win.Element.prototype;
      const DPr = win.Document && win.Document.prototype;

      wrapMethod(NP, 'appendChild', (r) => scanInserted(r));
      wrapMethod(NP, 'insertBefore', (r) => scanInserted(r));
      wrapMethod(NP, 'replaceChild', (r) => scanInserted(r));
      if (EP) {
        wrapMethod(EP, 'append', function (r, a) { scanAll(a); });
        wrapMethod(EP, 'prepend', function (r, a) { scanAll(a); });
        wrapMethod(EP, 'replaceChildren', function (r, a) { scanAll(a); });
        wrapMethod(EP, 'replaceWith', function (r, a) { scanAll(a); });
        wrapMethod(EP, 'insertAdjacentElement', (r) => scanInserted(r));
        wrapMethod(EP, 'insertAdjacentHTML', function () { scanInserted(this); });
        wrapSetter(EP, 'innerHTML', (el) => scanInserted(el));
        wrapSetter(EP, 'outerHTML', (el) => scanInserted(el.parentNode));
      }
      if (DPr) {
        wrapMethod(DPr, 'write', function () { scanInserted(this.documentElement); });
        wrapMethod(DPr, 'writeln', function () { scanInserted(this.documentElement); });
      }
    }

    try {
      const WP = win.Window && win.Window.prototype;
      const d = WP && Object.getOwnPropertyDescriptor(WP, 'open');
      if (d && typeof d.value === 'function') {
        const origOpen = d.value;
        def(WP, 'open', mark({
          open(...args) {
            const w = origOpen.apply(this, args);
            try { installInto(w); } catch (_) {}
            return w;
          },
        }.open));
      }
    } catch (_) {}

    /* =====================================================================
     * Function.prototype.toString disguise (deep mode)
     *
     * Narrow by construction: it vouches only for functions we created and
     * registered in `hidden`; everything else is forwarded to the native,
     * including its TypeError behaviour. Because `hidden` is shared by every
     * realm built from this copy, a probe iframe can vouch for the page
     * realm's patched methods — which is the only thing that clears
     * CreepJS's ✖ marks, since it inspects them with the iframe's toString.
     * =================================================================== */

    if (DEEP) {
      try {
        const FPT = win.Function && win.Function.prototype;
        const d = FPT && Object.getOwnPropertyDescriptor(FPT, 'toString');
        if (d && typeof d.value === 'function' && d.configurable) {
          const native = d.value;
          const wrapped = {
            toString() {
              if (hidden.has(this)) return 'function ' + this.name + '() { [native code] }';
              return native.call(this);
            },
          }.toString;
          def(FPT, 'toString', mark(wrapped));
        }
      } catch (_) {}
    }

    /* =====================================================================
     * Workers
     * =================================================================== */

    if (CFG.workerMode !== 'off' && typeof win.Worker === 'function') {
      try { patchWorkers(win); } catch (e) { log('worker patch failed', e); }
    }

    /* =====================================================================
     * Service workers — cannot be patched, only observed. See LIMITATIONS.
     * =================================================================== */

    try {
      const proto = win.ServiceWorkerContainer && win.ServiceWorkerContainer.prototype;
      if (proto && typeof proto.register === 'function') {
        const origRegister = proto.register;
        def(proto, 'register', mark({
          register(scriptURL, options) {
            const msg =
              '[bulkhead-tz] service worker registered outside the patched realm: its Date/Intl ' +
              'still report the real system timezone. A userscript cannot reach a service ' +
              'worker realm — blob:/data: script URLs are rejected by register() and the UA ' +
              'performs the script fetch itself.';
            if (CFG.serviceWorkerMode === 'block') {
              log(msg, scriptURL);
              return Promise.reject(
                new win.DOMException('Blocked by Bulkhead TZ (serviceWorkerMode: "block")', 'SecurityError')
              );
            }
            if (CFG.serviceWorkerMode === 'warn') console.warn(msg, String(scriptURL));
            return origRegister.call(this, scriptURL, options);
          },
        }.register));
      }
    } catch (e) {
      log('service worker hook failed', e);
    }

    /* =====================================================================
     * Worker plumbing
     * =================================================================== */

    function patchWorkers(realm) {
      const NativeWorker = realm.Worker;
      const NativeSharedWorker = typeof realm.SharedWorker === 'function' ? realm.SharedWorker : null;
      const NativeBlob = realm.Blob;
      const NativeURL = realm.URL;
      if (typeof NativeBlob !== 'function' || !NativeURL || typeof NativeURL.createObjectURL !== 'function') return;

      const jsBlobSources = new WeakMap(); // blob -> source text
      const urlSources = new Map();        // object URL -> source text
      const isJsType = (t) => /(?:javascript|ecmascript)/i.test(String(t || ''));

      const NativeCOU = NativeURL.createObjectURL.bind(NativeURL);
      const NativeROU = typeof NativeURL.revokeObjectURL === 'function'
        ? NativeURL.revokeObjectURL.bind(NativeURL)
        : null;

      /* Each step below is guarded independently: a failure anywhere must not
       * silently disable the rest. (A `class` cannot be used for Blob —
       * `Class.prototype` is non-writable, so it cannot be flattened onto the
       * native prototype, and an unflattened subclass prototype would break
       * `file instanceof Blob`, because File.prototype's chain reaches the
       * *native* Blob.prototype.) */

      // 1. Record JS blob bodies as they are constructed, so that
      //    Worker(blob:) can be rewritten synchronously — no XHR, no await,
      //    no race. This is what makes inline workers patchable at all.
      try {
        function FakeBlob(parts, options) {
          if (new.target === undefined) {
            throw new realm.TypeError(
              "Failed to construct 'Blob': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
          }
          const blob = Reflect.construct(NativeBlob, arguments, new.target);
          try {
            if (isJsType(options && options.type) && parts != null) {
              let text = '';
              for (const p of parts) {
                if (typeof p !== 'string') { text = null; break; }
                text += p;
              }
              if (text !== null) jsBlobSources.set(blob, text);
            }
          } catch (_) {}
          return blob;
        }
        def(FakeBlob, 'name', 'Blob');
        def(FakeBlob, 'length', NativeBlob.length);
        FakeBlob.prototype = NativeBlob.prototype;
        Object.setPrototypeOf(FakeBlob, NativeBlob);
        mark(FakeBlob);
        def(realm, 'Blob', FakeBlob);
      } catch (e) {
        log('Blob tracking unavailable; inline blob: workers cannot be patched', e);
      }

      // 2. Associate object URLs with the source recorded above.
      try {
        def(NativeURL, 'createObjectURL', mark({
          createObjectURL(obj) {
            const url = NativeCOU(obj);
            try {
              const src = jsBlobSources.get(obj);
              if (typeof src === 'string') {
                urlSources.set(url, src);
                if (urlSources.size > 512) urlSources.delete(urlSources.keys().next().value);
              }
            } catch (_) {}
            return url;
          },
        }.createObjectURL));

        if (NativeROU) {
          def(NativeURL, 'revokeObjectURL', mark({
            revokeObjectURL(url) {
              try { urlSources.delete(String(url)); } catch (_) {}
              return NativeROU(url);
            },
          }.revokeObjectURL));
        }
      } catch (e) {
        log('URL.createObjectURL tracking unavailable', e);
      }

      const PAYLOAD = makePayload(CFG);
      const MARKER = '/*__bhtz__*/';

      function decodeDataUrl(u) {
        const comma = u.indexOf(',');
        if (comma === -1) return null;
        const meta = u.slice(5, comma);
        const body = u.slice(comma + 1);
        try {
          return /;base64/i.test(meta) ? realm.atob(body) : decodeURIComponent(body);
        } catch (_) {
          return null;
        }
      }

      function makeBlobUrl(text) {
        return NativeCOU(new NativeBlob([text], { type: 'text/javascript' }));
      }

      /**
       * `all` mode: wrap the real script instead of rewriting its body.
       * importScripts() needs no CORS for classic workers, and for module
       * workers a dynamic import() leaves the original module graph intact,
       * so relative imports inside it still resolve against the real URL.
       * Base-URL-sensitive globals are re-anchored to the real script URL.
       */
      function classicShim(abs) {
        return '(function () {\n' +
          '  var REAL = ' + JSON.stringify(abs) + ';\n' +
          '  var resolve = function (u) { try { return new URL(String(u), REAL).href; } catch (e) { return u; } };\n' +
          '  var _importScripts = self.importScripts;\n' +
          '  if (typeof _importScripts === "function") {\n' +
          '    self.importScripts = function () {\n' +
          '      var out = [];\n' +
          '      for (var i = 0; i < arguments.length; i++) out.push(resolve(arguments[i]));\n' +
          '      return _importScripts.apply(self, out);\n' +
          '    };\n' +
          '  }\n' +
          '  var _fetch = self.fetch;\n' +
          '  if (typeof _fetch === "function") {\n' +
          '    self.fetch = function (input, init) {\n' +
          '      if (typeof input === "string") input = resolve(input);\n' +
          '      return _fetch.call(self, input, init);\n' +
          '    };\n' +
          '  }\n' +
          '  try {\n' +
          '    var u = new URL(REAL);\n' +
          '    Object.defineProperty(self, "location", { configurable: true, value: {\n' +
          '      href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,\n' +
          '      hostname: u.hostname, port: u.port, pathname: u.pathname,\n' +
          '      search: u.search, hash: u.hash, toString: function () { return u.href; }\n' +
          '    } });\n' +
          '  } catch (e) {}\n' +
          '})();\n';
      }

      function resolveScript(scriptURL, options) {
        const url = String(scriptURL);
        const isModule = !!(options && options.type === 'module');
        let base;
        try { base = realm.location && realm.location.href; } catch (_) { base = undefined; }

        if (url.slice(0, 5) === 'blob:') {
          const src = urlSources.get(url);
          if (typeof src !== 'string') return null;   // untracked blob: leave alone
          if (src.indexOf(MARKER) !== -1) return null; // already ours
          return makeBlobUrl(PAYLOAD + MARKER + '\n' + src);
        }

        if (url.slice(0, 5) === 'data:') {
          const src = decodeDataUrl(url);
          if (src === null) return null;
          return makeBlobUrl(PAYLOAD + src);
        }

        if (CFG.workerMode !== 'all') return null;

        let abs;
        try { abs = new NativeURL(url, base).href; } catch (_) { return null; }
        if (!/^https?:/i.test(abs)) return null;

        if (isModule) {
          // A blob: module worker inherits the creating document's origin, so
          // same-origin dynamic import() is fine. Cross-origin needs CORS and
          // we cannot know whether the server allows it — do not break the site.
          try {
            if (new NativeURL(abs).origin !== new NativeURL(base).origin) return null;
          } catch (_) { return null; }
          return makeBlobUrl(PAYLOAD + 'await import(' + JSON.stringify(abs) + ');\n');
        }
        return makeBlobUrl(PAYLOAD + classicShim(abs));
      }

      function makeCtor(Native) {
        function Wrapped(scriptURL, options) {
          if (new.target === undefined) {
            throw new realm.TypeError(
              "Failed to construct '" + Native.name +
              "': Please use the 'new' operator, this DOM object constructor cannot be called as a function."
            );
          }
          let target = scriptURL;
          try {
            const rewritten = resolveScript(scriptURL, options);
            if (rewritten) target = rewritten;
          } catch (e) {
            log('worker rewrite failed, passing through', e);
          }
          return Reflect.construct(
            Native,
            options === undefined ? [target] : [target, options],
            new.target
          );
        }
        def(Wrapped, 'name', Native.name);
        def(Wrapped, 'length', Native.length);
        Wrapped.prototype = Native.prototype;
        Object.setPrototypeOf(Wrapped, Native);
        mark(Wrapped);
        return Wrapped;
      }

      // 3. Wrap the constructors themselves.
      try { def(realm, 'Worker', makeCtor(NativeWorker)); } catch (e) { log('Worker wrap failed', e); }
      if (NativeSharedWorker) {
        try { def(realm, 'SharedWorker', makeCtor(NativeSharedWorker)); } catch (e) { log('SharedWorker wrap failed', e); }
      }
    }
  }

  /* ---- entry point ---------------------------------------------------- */

  try {
    build(globalThis);
  } catch (e) {
    if (CFG.debug) console.error('[bulkhead-tz] install failed', e);
  }
}
