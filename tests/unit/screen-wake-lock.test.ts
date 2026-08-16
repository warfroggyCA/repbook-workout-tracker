import { describe, expect, it, vi } from "vitest";
import {
  ScreenWakeLockController,
  type ScreenWakeLockSentinel,
} from "@/lib/screen-wake-lock";

function sentinel() {
  let releaseListener: (() => void) | null = null;
  const value: ScreenWakeLockSentinel = {
    released: false,
    release: vi.fn(async () => {
      value.released = true;
    }),
    addEventListener: vi.fn((_type, listener) => {
      releaseListener = listener;
    }),
    removeEventListener: vi.fn((_type, listener) => {
      if (releaseListener === listener) releaseListener = null;
    }),
  };
  return { value, revoke: () => releaseListener?.() };
}

describe("ScreenWakeLockController", () => {
  it("holds one lock only while a visible timer is active", async () => {
    let visible = true;
    const first = sentinel();
    const request = vi.fn(async () => first.value);
    const controller = new ScreenWakeLockController(request, () => visible);

    controller.setActive(true);
    controller.reconcile();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.setActive(false);
    await vi.waitFor(() => expect(first.value.release).toHaveBeenCalledTimes(1));

    visible = false;
    controller.setActive(true);
    controller.reconcile();
    expect(request).toHaveBeenCalledTimes(1);
    await controller.dispose();
  });

  it("reacquires after visibility return and operating-system revocation", async () => {
    let visible = true;
    const locks = [sentinel(), sentinel(), sentinel()];
    const request = vi.fn(async () => locks[request.mock.calls.length - 1]!.value);
    const controller = new ScreenWakeLockController(request, () => visible);

    controller.setActive(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    visible = false;
    controller.reconcile();
    await vi.waitFor(() => expect(locks[0]!.value.release).toHaveBeenCalled());
    visible = true;
    controller.reconcile();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(locks[1]!.value.addEventListener).toHaveBeenCalled(),
    );
    locks[1]!.revoke();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await controller.dispose();
  });

  it("releases a request that resolves after cleanup and tolerates rejection", async () => {
    let resolve!: (value: ScreenWakeLockSentinel) => void;
    const late = sentinel();
    const request = vi
      .fn<() => Promise<ScreenWakeLockSentinel>>()
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockRejectedValueOnce(new Error("not allowed"));
    const controller = new ScreenWakeLockController(request, () => true);

    controller.setActive(true);
    await controller.dispose();
    resolve(late.value);
    await vi.waitFor(() => expect(late.value.release).toHaveBeenCalledTimes(1));

    const rejected = new ScreenWakeLockController(request, () => true);
    rejected.setActive(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await rejected.dispose();
  });
});
