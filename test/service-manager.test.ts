/**
 * Tests for service-manager.ts — getServiceManager factory
 */
import { describe, test, expect, vi } from "vitest";

// We can test the factory function returns correct type based on platform
describe("getServiceManager", () => {
  test("returns an object with start/stop/status/logs methods", async () => {
    const { getServiceManager } = await import("../src/cli/service-manager");
    const svc = getServiceManager();
    expect(svc).toHaveProperty("start");
    expect(svc).toHaveProperty("stop");
    expect(svc).toHaveProperty("status");
    expect(svc).toHaveProperty("logs");
    expect(typeof svc.start).toBe("function");
    expect(typeof svc.stop).toBe("function");
    expect(typeof svc.status).toBe("function");
    expect(typeof svc.logs).toBe("function");
  });
});
