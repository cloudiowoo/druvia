// Druvia Edge Functions - Isolated Executor
// 在隔离的 Worker 中执行用户代码

interface ExecuteMessage {
  code: string;
  secrets: Record<string, string>;
  payload?: unknown;
}

self.onmessage = async (e: MessageEvent<ExecuteMessage>) => {
  const { code, secrets, payload } = e.data;

  try {
    // 注入 secrets 到环境变量
    for (const [key, value] of Object.entries(secrets)) {
      Deno.env.set(key, value);
    }

    // 构建执行上下文
    const context = {
      // Deno 标准对象
      Deno,
      fetch,
      console,

      // 请求 payload
      payload,

      // 辅助函数
      Response,
      Request,
      Headers,
      URL,
      URLSearchParams,

      // JSON 处理
      JSON,

      // 编码
      TextEncoder,
      TextDecoder,
      btoa,
      atob,
    };

    // 动态执行代码
    // 用户代码应该是一个 async function 或返回值的表达式
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

    // 包装代码，支持多种写法
    const wrappedCode = `
      return (async () => {
        ${code}
      })();
    `;

    const fn = new AsyncFunction(
      ...Object.keys(context),
      wrappedCode
    );

    const result = await fn(...Object.values(context));

    self.postMessage({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ error: message });
  }
};
