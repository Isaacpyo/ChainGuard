import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/lib/bus';

describe('EventBus', () => {
  it('fans the resync signal out to its own listeners only', () => {
    const bus = new EventBus();
    const onEvent = vi.fn();
    const onResync = vi.fn();
    bus.on(onEvent);
    const off = bus.onResync(onResync);

    bus.resync();
    expect(onResync).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();

    off();
    bus.resync();
    expect(onResync).toHaveBeenCalledOnce();
  });
});
