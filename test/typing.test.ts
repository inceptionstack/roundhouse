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
    vi.advanceTimersByTime(500);
    expect(startTyping).toHaveBeenCalledTimes(3); // no more after stop

    vi.useRealTimers();
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
