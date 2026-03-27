import { AsyncLocalStorage } from 'node:async_hooks';
import type { StructuredLogContext } from '@druvia/shared';

const apiLogContextStorage = new AsyncLocalStorage<StructuredLogContext>();

export function getApiLogContext(): StructuredLogContext {
  return apiLogContextStorage.getStore() ?? {};
}

export function runWithApiLogContext<T>(
  context: StructuredLogContext,
  fn: () => T
): T {
  const currentContext = getApiLogContext();
  return apiLogContextStorage.run(
    {
      ...currentContext,
      ...context,
    },
    fn
  );
}

export function mergeApiLogContext(context: StructuredLogContext): void {
  apiLogContextStorage.enterWith({
    ...getApiLogContext(),
    ...context,
  });
}
