/**
 * KSS Activity Logger
 *
 * Reusable client-side logger for tracking user interactions.
 *
 * Usage:
 *   KSSActivityLogger.initLog(uuid, serviceId);
 *   KSSActivityLogger.enableListener(['button', 'a', 'input', 'select', 'form']);
 *   KSSActivityLogger.saveLog({ page: '/checkout' }, 'page_view');
 */
(function (root) {
  "use strict";

  var API_BASE =
    "https://main-server-u49f.onrender.com/api/v1/ks-solutions/activity-logs";

  // ── Internal state ──────────────────────────────────────────────────────
  var _uuid = null;
  var _serviceId = null;
  var _initialized = false;
  var _queue = [];
  var _listeners = [];
  var _boundFlush = null;
  var _boundBeforeUnload = null;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function warn(msg) {
    console.warn("[KSSActivityLogger] " + msg);
  }

  function isReady() {
    if (!_initialized) {
      warn(
        "Not initialized. Call KSSActivityLogger.initLog(uuid, serviceId) first.",
      );
      return false;
    }
    return true;
  }

  /** Resolve a human-readable label for an element. */
  function resolveLabel(el) {
    // Explicit aria / tooltip / title
    var label =
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("data-tooltip");

    if (label) return label.trim();

    // Inner text (limited length, first meaningful chunk)
    var text = (el.innerText || el.textContent || "").trim();
    if (text) return text.length > 80 ? text.substring(0, 80) + "…" : text;

    // Form controls
    if (el.placeholder) return el.placeholder;
    if (el.name) return el.name;
    if (el.value && el.tagName === "INPUT" && el.type === "submit")
      return el.value;

    // Images inside buttons / anchors
    var img = el.querySelector("img[alt]");
    if (img) return img.alt;

    // SVG title
    var svgTitle = el.querySelector("svg title");
    if (svgTitle) return (svgTitle.textContent || "").trim();

    // Fallback — class or id
    if (el.id) return "#" + el.id;
    if (el.className && typeof el.className === "string")
      return "." + el.className.split(/\s+/)[0];

    return el.tagName.toLowerCase();
  }

  /** Build a stable CSS-selector-like path for an element. */
  function resolvePath(el) {
    var parts = [];
    var node = el;

    while (node && node !== document.body && parts.length < 5) {
      var tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(tag + "#" + node.id);
        break;
      }
      if (node.className && typeof node.className === "string") {
        tag += "." + node.className.trim().split(/\s+/)[0];
      }
      parts.unshift(tag);
      node = node.parentElement;
    }

    return parts.join(" > ");
  }

  /** Map tag names the user passes to CSS selectors + event types. */
  var LISTENER_MAP = {
    button: {
      selector:
        'button, [role="button"], input[type="button"], input[type="submit"]',
      event: "click",
    },
    btn: {
      selector:
        'button, [role="button"], input[type="button"], input[type="submit"]',
      event: "click",
    },
    a: { selector: "a[href]", event: "click" },
    input: { selector: "input, textarea", event: "change" },
    select: { selector: "select", event: "change" },
    form: { selector: "form", event: "submit" },
    details: { selector: "details", event: "toggle" },
    dialog: { selector: "dialog", event: "close" },
    video: { selector: "video", event: "play" },
    audio: { selector: "audio", event: "play" },
  };

  /** Delegate handler factory – returns one handler per (selector, eventType). */
  function makeDelegateHandler(selector, eventName) {
    return function (e) {
      var target = e.target;
      var el = target.closest ? target.closest(selector) : null;
      if (!el) return;

      var tag = el.tagName.toLowerCase();
      var label = resolveLabel(el);
      var entry = {
        action: eventName + ":" + tag,
        logType: label,
        data: {
          tag: tag,
          label: label,
          path: resolvePath(el),
          href: el.href || undefined,
          type: el.type || undefined,
          name: el.name || undefined,
          value: eventName === "change" ? el.value || "" : undefined,
          url: location.href,
        },
        timestamp: Date.now(),
      };

      // Strip undefined values
      var d = entry.data;
      Object.keys(d).forEach(function (k) {
        if (d[k] === undefined) delete d[k];
      });

      _queue.push(entry);
    };
  }

  /** Flush gathered logs to the server. Uses sendBeacon for reliability. */
  function flush() {
    if (!_queue.length || !_initialized) return;

    var payload = JSON.stringify({
      uuid: _uuid,
      service: _serviceId,
      logs: _queue.splice(0),
    });

    var url = API_BASE + "/batch";

    // sendBeacon is the only reliable way to send data on page unload
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        url,
        new Blob([payload], { type: "application/json" }),
      );
    } else {
      // Fallback – synchronous XHR (last resort)
      var xhr = new XMLHttpRequest();
      xhr.open("POST", url, false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(payload);
    }
  }

  function teardownListeners() {
    _listeners.forEach(function (l) {
      document.removeEventListener(l.event, l.handler, true);
    });
    _listeners = [];
  }

  // ── Public API ──────────────────────────────────────────────────────────

  var KSSActivityLogger = {
    /**
     * Initialize the logger.
     * @param {string} uuid      – visitor UUID (from cookie / generated)
     * @param {string} serviceId – the _id of the service or menu
     */
    initLog: function (uuid, serviceId) {
      if (!uuid || !serviceId) {
        warn("uuid and serviceId are required.");
        return;
      }

      // Tear down previous session if re-initializing
      if (_initialized) {
        flush();
        teardownListeners();
      }

      _uuid = uuid;
      _serviceId = serviceId;
      _initialized = true;
      _queue = [];

      // Flush on page hide / unload
      if (!_boundFlush) {
        _boundFlush = flush;
        _boundBeforeUnload = flush;
        document.addEventListener("visibilitychange", function () {
          if (document.visibilityState === "hidden") flush();
        });
        window.addEventListener("beforeunload", _boundBeforeUnload);
      }
    },

    /**
     * Start listening on the specified element types.
     * @param {string[]} types – e.g. ['button', 'a', 'input', 'select', 'form']
     */
    enableListener: function (types) {
      if (!isReady()) return;
      if (!Array.isArray(types) || !types.length) {
        warn('enableListener expects a non-empty array, e.g. ["button","a"]');
        return;
      }

      types.forEach(function (type) {
        var key = type.toLowerCase();
        var mapping = LISTENER_MAP[key];

        if (!mapping) {
          warn(
            'Unknown listener type: "' +
              type +
              '". Supported: ' +
              Object.keys(LISTENER_MAP).join(", "),
          );
          return;
        }

        // Avoid duplicate listeners for the same type
        var alreadyBound = _listeners.some(function (l) {
          return l.type === key;
        });
        if (alreadyBound) return;

        var handler = makeDelegateHandler(mapping.selector, mapping.event);
        document.addEventListener(mapping.event, handler, true);
        _listeners.push({ type: key, event: mapping.event, handler: handler });
      });
    },

    /**
     * Immediately send a single log entry to the API.
     * @param {object} data    – arbitrary payload
     * @param {string} logType – human-readable description
     */
    saveLog: function (data, logType) {
      if (!isReady()) return;

      var payload = JSON.stringify({
        uuid: _uuid,
        service: _serviceId,
        action: (data && data.action) || "custom",
        logType: logType || "",
        data: data && typeof data === "object" ? data : {},
      });

      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          API_BASE,
          new Blob([payload], { type: "application/json" }),
        );
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", API_BASE, true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(payload);
      }
    },

    /** Force-flush any queued listener logs now (without waiting for page unload). */
    flush: flush,

    /** Tear down all listeners and reset state. */
    destroy: function () {
      flush();
      teardownListeners();
      _initialized = false;
      _uuid = null;
      _serviceId = null;
      _queue = [];
    },
  };

  // ── Export ───────────────────────────────────────────────────────────────
  if (typeof module !== "undefined" && module.exports) {
    module.exports = KSSActivityLogger;
  } else {
    root.KSSActivityLogger = KSSActivityLogger;
  }
})(typeof window !== "undefined" ? window : this);
