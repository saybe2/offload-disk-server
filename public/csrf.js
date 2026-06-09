// Attaches the CSRF token to same-origin, state-changing fetch() requests.
//
// The server issues a per-session token in a readable `csrfToken` cookie. We
// echo it back in the `X-CSRF-Token` header for POST/PUT/PATCH/DELETE so the
// server can verify the request originated from our own pages. Safe methods
// (GET/HEAD) and cross-origin requests are left untouched.
(function () {
  function readCsrfCookie() {
    var match = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function isSameOrigin(url) {
    try {
      var u = new URL(url, window.location.href);
      return u.origin === window.location.origin;
    } catch (e) {
      // Relative URLs that fail to parse are same-origin by definition.
      return true;
    }
  }

  // --- Patch XMLHttpRequest (used for chunked uploads) ---
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var nativeOpen = XHR.prototype.open;
    var nativeSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__csrfUnsafe =
        method &&
        method.toUpperCase() !== "GET" &&
        method.toUpperCase() !== "HEAD" &&
        method.toUpperCase() !== "OPTIONS" &&
        isSameOrigin(url);
      return nativeOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      if (this.__csrfUnsafe) {
        var token = readCsrfCookie();
        if (token) {
          try {
            this.setRequestHeader("X-CSRF-Token", token);
          } catch (e) {
            /* header already sent / locked: ignore */
          }
        }
      }
      return nativeSend.apply(this, arguments);
    };
  }

  // --- Patch fetch ---
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = (init.method || (typeof input === "object" && input && input.method) || "GET").toUpperCase();
    var unsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

    if (unsafe && isSameOrigin(url)) {
      var token = readCsrfCookie();
      if (token) {
        var headers = new Headers(init.headers || (typeof input === "object" && input && input.headers) || {});
        if (!headers.has("X-CSRF-Token")) {
          headers.set("X-CSRF-Token", token);
        }
        init.headers = headers;
      }
    }
    return nativeFetch(input, init);
  };
})();
