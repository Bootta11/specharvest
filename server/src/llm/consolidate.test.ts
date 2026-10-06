import { describe, expect, it } from "vitest";
import { namesRelated } from "./consolidate.ts";

describe("namesRelated", () => {
  it.each([
    ["engine_kw", "engine_power_kw"],
    ["engine_power_hp", "engine_power_kw"],
    ["trunk_volume_liters", "trunk_capacity_liters"],
    ["airbag", "airbags"],
    ["hill_start_assist", "hill_assist"],
  ])("accepts %s ~ %s", (a, b) => expect(namesRelated(a, b)).toBe(true));

  it.each([
    ["cooled_seats", "heated_seats"],
    ["adaptive_cruise_control", "cruise_control"],
    ["heated_rear_window", "rear_window_wiper"],
    ["rain_sensor", "light_sensor"],
    ["esp", "battery_discharge_prevention"],
  ])("rejects %s ~ %s", (a, b) => expect(namesRelated(a, b)).toBe(false));

  it("requires identical tokens for booleans", () => {
    expect(namesRelated("remote_central_locking", "central_locking", true)).toBe(false);
    expect(namesRelated("airbag", "airbags", true)).toBe(true);
  });
});
