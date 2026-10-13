/**
 * Ad and analytics hosts a crawled page doesn't need: they carry no product text or images, but on shop pages they
 * are most of the third-party requests, cost the shared browser CPU, and keep the network "busy" (beacons). The
 * request filter aborts them (SCRAPE_BLOCK_TRACKERS). Consent managers are deliberately not listed: some sites keep
 * content hidden until their banner script has run.
 */
const TRACKER_HOSTS = [
  // Google ads / analytics / tag manager
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "analytics.google.com",
  "adservice.google.com",
  // Ad exchanges and retargeting
  "adsrvr.org",
  "teads.tv",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "adnxs.com",
  "rubiconproject.com",
  "pubmatic.com",
  "casalemedia.com",
  "amazon-adsystem.com",
  "adform.net",
  "smartadserver.com",
  "moatads.com",
  "doubleverify.com",
  "quantserve.com",
  "scorecardresearch.com",
  // Social pixels
  "connect.facebook.net",
  "analytics.tiktok.com",
  "ct.pinterest.com",
  "px.ads.linkedin.com",
  "snap.licdn.com",
  "tr.snapchat.com",
  "sc-static.net",
  "bat.bing.com",
  // Session recording / product analytics / RUM
  "clarity.ms",
  "hotjar.com",
  "hotjar.io",
  "mc.yandex.ru",
  "cdn.segment.com",
  "api.segment.io",
  "mixpanel.com",
  "js-agent.newrelic.com",
  "bam.nr-data.net",
  "cloudflareinsights.com",
];

const hosts = new Set(TRACKER_HOSTS);

/** Ad paths on hosts that also serve real content (google.com, google.<cc>). */
const GOOGLE_AD_PATHS = ["/pagead/", "/rmkt/", "/ccm/collect", "/ads/"];
const GOOGLE_HOST = /^(www\.)?google\.[a-z.]+$/;

/** True for a request to a known ad/analytics host (the host or any subdomain of it). */
export function isTracker(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  for (let h = host; h.includes("."); h = h.slice(h.indexOf(".") + 1)) {
    if (hosts.has(h)) return true;
  }
  return GOOGLE_HOST.test(host) && GOOGLE_AD_PATHS.some((p) => url.pathname.startsWith(p));
}
