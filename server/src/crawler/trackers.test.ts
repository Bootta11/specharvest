import { describe, expect, it } from "vitest";
import { isTracker } from "./trackers.ts";

const t = (u: string) => isTracker(new URL(u));

describe("isTracker", () => {
  it("matches listed hosts and their subdomains", () => {
    expect(t("https://ad.doubleclick.net/activity;src=1")).toBe(true);
    expect(t("https://www.googletagmanager.com/gtm.js?id=GTM-1")).toBe(true);
    expect(t("https://insight.adsrvr.org/track")).toBe(true);
    expect(t("https://connect.facebook.net/en_US/fbevents.js")).toBe(true);
    expect(t("https://a.clarity.ms/collect")).toBe(true);
  });

  it("matches Google's ad paths but not the rest of google.com", () => {
    expect(t("https://www.google.com/rmkt/collect/1035699132/")).toBe(true);
    expect(t("https://www.google.ba/pagead/1p-user-list/1/")).toBe(true);
    expect(t("https://www.google.com/ccm/collect?rcb=1")).toBe(true);
    expect(t("https://www.google.com/search?q=billy")).toBe(false);
    expect(t("https://www.google.com/maps/place/x")).toBe(false);
  });

  it("leaves shops, CDNs and look-alike hosts alone", () => {
    expect(t("https://www.ikea.com/us/en/p/billy-bookcase-white-00263850/")).toBe(false);
    expect(t("https://cdn.shopify.com/s/files/1/product.jpg")).toBe(false);
    expect(t("https://www.facebook.com/somepage")).toBe(false);
    expect(t("https://notdoubleclick.net/x")).toBe(false);
    expect(t("https://doubleclick.net.example.com/x")).toBe(false);
  });
});
