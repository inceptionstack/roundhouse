import { describe, it, expect, vi } from "vitest";
import { startTypingLoop } from "../src/util";

describe("startTypingLoop", () => {
  it("calls startTyping immediately", () => {
    const startTyping = vi.fn().mockResolvedValue(undefined);
    const stop = startTypingLoop({ startTyping }, 100);
    expect(startTyping).toHaveBeenCalledTimes(1);
    stop();
  });

  it("calls startTyping repeatedly on interval", async () => {
    vi.useFakeTimers();
    const startTyping = vi.fn().mockResolvedValue(undefined);
    const stop = startTypingLoop({ startTyping }, 100);

    expect(startTyping).toHaveBeenCalledTimes(1); // immediate

    vi.advanceTimersByTime(100);
    expect(startTyping).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    expect(startTyping).toHaveBeenCalledTimes(3);

    stop();
    // stop() runs cleanup asynchronously so it can await any in-flight
    // tick before sending the clear (race-fix). Drain the microtask
    // queue so the deferred startTyping("") lands.
    await vi.runAllTimersAsync();
    expect(startTyping).toHaveBeenCalledTimes(4);
    expect(startTyping).toHaveBeenLastCalledWith("");

    vi.advanceTimersByTime(500);
    expect(startTyping).toHaveBeenCalledTimes(4); // no further interval ticks

    vi.useRealTimers();
  });

  it("calls thread.stopTyping on stop when the thread provides one", async () => {
    const startTyping = vi.fn().mockResolvedValue(undefined);
    const stopTyping = vi.fn().mockResolvedValue(undefined);
    const stop = startTypingLoop({ startTyping, stopTyping }, 100);
    stop();
    // Cleanup is async — flush microtasks.
    await new Promise((r) => setImmediate(r));
    expect(stopTyping).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight startTyping() before sending the clear", async () => {
    // Race regression: a tick that started just before stop() must NOT
    // land after the clear and silently re-set Slack's persistent status.
    let resolveInFlight: () => void = () => {};
    const inFlightPromise = new Promise<void>((r) => { resolveInFlight = r; });
    const startTyping = vi.fn()
      .mockImplementationOnce(() => inFlightPromise)   // first (immediate) tick stays in flight
      .mockResolvedValue(undefined);                    // subsequent calls (incl. clear) resolve sync

    const stop = startTypingLoop({ startTyping }, 100);
    stop();
    // Cleanup is awaiting the in-flight promise; the clear hasn't fired yet.
    await new Promise((r) => setImmediate(r));
    expect(startTyping).toHaveBeenCalledTimes(1); // only the immediate, clear deferred

    resolveInFlight();
    await new Promise((r) => setImmediate(r));
    // Now the clear has landed.
    expect(startTyping).toHaveBeenCalledTimes(2);
    expect(startTyping).toHaveBeenLastCalledWith("");
  });

  it("does not throw if startTyping rejects", async () => {
    const startTyping = vi.fn().mockRejectedValue(new Error("network"));
    const stop = startTypingLoop({ startTyping }, 100);
    // Should not throw
    expect(startTyping).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stop is idempotent", () => {
    const startTyping = vi.fn().mockResolvedValue(undefined);
    const stop = startTypingLoop({ startTyping }, 100);
    stop();
    stop(); // should not throw
  });
});
