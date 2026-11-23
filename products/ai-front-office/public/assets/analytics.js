// PostHog for the public site. Served from our origin and loads the SDK through /ingest,
// so the CSP stays 'self'. In-memory persistence: no cookies or storage for anonymous
// visitors. No session replay and no autocapture here; only pageviews and the named clicks below.
(function () {
  var keyMeta = document.querySelector('meta[name="posthog-key"]');
  var key = keyMeta && keyMeta.getAttribute("content");
  if (!key || window.posthog) return;
  var uiMeta = document.querySelector('meta[name="posthog-ui-host"]');

  // The standard snippet stub: queue calls until /ingest/static/array.js replaces it.
  var stub = [];
  stub._i = [];
  stub.__SV = 1;
  stub.init = function (token, config, name) { stub._i.push([token, config, name]); };
  stub.capture = function () { stub.push(["capture"].concat(Array.prototype.slice.call(arguments))); };
  window.posthog = stub;
  stub.init(key, {
    api_host: "/ingest",
    ui_host: (uiMeta && uiMeta.getAttribute("content")) || "https://us.posthog.com",
    persistence: "memory",
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    capture_exceptions: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
  });
  var script = document.createElement("script");
  script.async = true;
  script.src = "/ingest/static/array.js";
  document.head.appendChild(script);

  function placement(element) {
    var section = element.closest("header, section, footer, .sticky-cta");
    if (!section) return "page";
    return section.id || section.tagName.toLowerCase() + (section.className ? "." + String(section.className).split(" ")[0] : "");
  }

  // Key clicks. sendBeacon survives the navigation the click starts.
  document.addEventListener("click", function (event) {
    var link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    var path = link.getAttribute("href").split(/[?#]/)[0];
    var name = path === "/signup" || path === "/start" ? "cta_get_plan_clicked"
      : path === "/demo" ? "cta_demo_clicked"
      : path === "/login" ? "cta_sign_in_clicked"
      : null;
    if (name) window.posthog.capture(name, { placement: placement(link), page: location.pathname }, { transport: "sendBeacon" });
  }, true);

  // The signup form: record the attempt only, never the values typed.
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (form instanceof HTMLFormElement && form.getAttribute("action") === "/signup") {
      window.posthog.capture("signup_submitted", { page: location.pathname }, { transport: "sendBeacon" });
    }
  }, true);
})();
