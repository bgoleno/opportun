// A context manager for tests (https://github.com/bgoleno/opportun/issues/353). The OpenTelemetry
// API does nothing until something registers one, and the server's own (obs/tracing.ts, the
// AsyncLocalStorage manager from the SDK) is FR-T4 part 2's. Until then a test that needs an
// active span context registers this one: the same AsyncLocalStorage idea, with no SDK package.
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Context, type ContextManager, context, ROOT_CONTEXT } from '@opentelemetry/api';

class TestContextManager implements ContextManager {
  private readonly store = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.store.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.store.run(ctx, () => fn.apply(thisArg, args));
  }

  bind<T>(ctx: Context, target: T): T {
    if (typeof target !== 'function') return target;
    const fn = target as (...a: unknown[]) => unknown;
    return ((...a: unknown[]) => this.with(ctx, () => fn(...a))) as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.store.disable();
    return this;
  }
}

/** Registers the test context manager for the rest of the file; returns its undo. */
export function useTestContextManager(): () => void {
  const manager = new TestContextManager();
  context.setGlobalContextManager(manager);
  return () => context.disable();
}
