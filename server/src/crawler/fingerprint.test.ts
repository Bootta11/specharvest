import { describe, expect, it } from "vitest";
import { changedTokens, fingerprint, normalizeForHash, removedShare } from "./fingerprint.ts";

const page = (extra: string, price = "25.900 KM") => `Volkswagen Golf 8 2.0 TDI\n${price}\n${extra}\nKilometraža\n22.429 km\nGorivo\nDizel`;

describe("fingerprint", () => {
  it("ignores relative times, view counters and renew stamps", () => {
    expect(fingerprint(page("Prije 2 sata\nPregleda: 120"))).toBe(fingerprint(page("prije 3 dana\n1.234 pregleda")));
    expect(fingerprint(page("2 hours ago\n15 views"))).toBe(fingerprint(page("Obnovljeno 12.03.2026.")));
    expect(fingerprint(page("vor 5 Minuten"))).toBe(fingerprint(page("")));
  });

  it("drops label/value pairs whose value changes on every visit", () => {
    const a = "Datum objave\n22.06.2026\nObnovljen\n06.10.2026 u 14:52\nBroj pregleda\n9075\nOprema\nABS";
    const b = "Datum objave\n22.06.2026\nObnovljen\n07.10.2026 u 09:01\nBroj pregleda\n9310\nOprema\nABS";
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(normalizeForHash(a)).toBe("Datum objave\n22.06.2026\nOprema\nABS");
  });

  it("keeps equipment lines that only resemble counters", () => {
    expect(normalizeForHash("Kamera suvozača za pregled niskih prepreka")).toBe("Kamera suvozača za pregled niskih prepreka");
  });

  it("detects a price change", () => {
    expect(fingerprint(page("", "25.900 KM"))).not.toBe(fingerprint(page("", "24.500 KM")));
  });

  it("ignores whitespace-only differences", () => {
    expect(fingerprint("Gorivo   Dizel\n\n\nBoja\tCrna")).toBe(fingerprint("Gorivo Dizel\nBoja Crna  "));
  });

  it("keeps spec lines that merely contain numbers", () => {
    expect(normalizeForHash("Snaga motora\n110 kW\nGodište\n2021")).toBe("Snaga motora\n110 kW\nGodište\n2021");
  });

  it("ignores layout jitter between renders", () => {
    expect(fingerprint("Vozila\nAutomobili\nBANJA LUKA\nCijena 25.900 KM")).toBe(fingerprint("Vozila Automobili\nVozila Automobili\nBanja Luka\nCijena\n25.900 KM"));
    expect(fingerprint("Pitanja (0)\nIzdvojeno\nRealna cijena\nGorivo Dizel")).toBe(fingerprint("Pitanja\nOstali oglasi korisnika\nGorivo Dizel"));
  });

  it("detects an added feature", () => {
    expect(fingerprint("Oprema\nABS\nESP")).not.toBe(fingerprint("Oprema\nABS\nESP\nNavigacija"));
  });

  it("lists changed words", () => {
    expect(changedTokens(page("", "25.900 KM"), page("", "24.500 KM"))).toEqual(["- 25.900", "+ 24.500"]);
  });

  it("measures how much of the old text vanished", () => {
    expect(removedShare("a b c d", "a b c d e")).toBe(0);
    expect(removedShare("a b c d", "a b")).toBe(0.5);
  });
});
