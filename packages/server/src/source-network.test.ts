import { describe, expect, test } from "vitest";
import { sourceNetwork } from "./source-network.js";

describe("sourceNetwork", () => {
  test("IPv4 stands alone; IPv6 collapses to its /64; IPv4-mapped IPv6 is its IPv4", () => {
    expect(sourceNetwork("203.0.113.7")).toBe("203.0.113.7");
    expect(sourceNetwork("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(sourceNetwork("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(sourceNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(sourceNetwork("::1")).toBe("0:0:0:0::/64");
    expect(sourceNetwork("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(sourceNetwork("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  test("anything that is not an IP address has no source", () => {
    for (const bad of ["", "localhost", "2001:db8:::1", "1.2.3", "2001:db8::1::2"]) {
      expect(sourceNetwork(bad)).toBeNull();
    }
  });
});
