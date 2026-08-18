import type { DenoLogger } from "./logging.ts";
import {
  WORKER_SECRET_HEADER,
  assertWorkerSecret,
  verifyWorkerSecret,
} from "./worker-auth.ts";

interface FunctionWorkerCallerBase {
  actorContractVersion: 1;
  actorSubject: string;
  projectId: string;
  role: string;
}

export type FunctionWorkerCaller =
  | FunctionWorkerCallerBase & {
      actorType: "platform_user";
      actorSource: "platform_session";
      authType: "platform_user";
      platformUserId: string;
      platformUid: number;
      userId: string;
      uid: number;
      tenantId?: string;
      projectUserId?: never;
      provider?: never;
      apiKeyId?: never;
      apiKeyPrefix?: never;
    }
  | FunctionWorkerCallerBase & {
      actorType: "project_user";
      actorSource: "project_session";
      authType: "project_user";
      platformUserId?: never;
      platformUid?: never;
      userId?: never;
      uid?: never;
      tenantId?: never;
      projectUserId: string;
      provider: string;
      apiKeyId?: never;
      apiKeyPrefix?: never;
    }
  | FunctionWorkerCallerBase & {
      actorType: "apikey";
      actorSource: "project_api_key";
      authType: "apikey";
      platformUserId?: never;
      platformUid?: never;
      userId?: never;
      uid?: never;
      tenantId?: never;
      projectUserId?: never;
      provider?: never;
      apiKeyId: number;
      apiKeyPrefix: string;
    };

export function buildTrustedHeaders(caller: FunctionWorkerCaller): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("x-druvia-auth-type", caller.authType);
  headers.set("x-druvia-actor-type", caller.actorType);
  headers.set("x-druvia-actor-source", caller.actorSource);
  headers.set("x-druvia-actor-subject", caller.actorSubject);
  headers.set("x-druvia-actor-contract-version", String(caller.actorContractVersion));
  headers.set("x-druvia-project-id", caller.projectId);
  headers.set("x-druvia-role", caller.role);

  if (caller.actorType === "platform_user") {
    headers.set("x-druvia-platform-user-id", caller.platformUserId);
    headers.set("x-druvia-platform-uid", String(caller.platformUid));
    headers.set("x-druvia-user-id", caller.userId);
    headers.set("x-druvia-uid", String(caller.uid));
    if (caller.tenantId) headers.set("x-druvia-tenant-id", caller.tenantId);
  } else if (caller.actorType === "project_user") {
    headers.set("x-druvia-project-user-id", caller.projectUserId);
    headers.set("x-druvia-provider", caller.provider);
  } else {
    headers.set("x-druvia-api-key-id", String(caller.apiKeyId));
    headers.set("x-druvia-api-key-prefix", caller.apiKeyPrefix);
  }
  return headers;
}

export interface WorkerExecuteRequest {
  code: string;
  functionName: string;
  executionId?: string;
  secrets: Record<string, string>;
  payload?: unknown;
  caller: FunctionWorkerCaller;
  internalToken: string;
  apiBaseUrl?: string;
  timeout: number;
}

export interface WorkerExecuteResponse {
  success: boolean;
  data?: unknown;
  error?: { message: string };
  durationMs?: number;
}

interface WorkerHandlerDependencies {
  workerSecret: string;
  logger: DenoLogger;
  executeFunction(request: WorkerExecuteRequest): Promise<WorkerExecuteResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function parseCaller(value: unknown): FunctionWorkerCaller | null {
  if (
    !isRecord(value)
    || value.actorContractVersion !== 1
    || !isNonEmptyString(value.actorSubject)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.role)
    || value.authType !== value.actorType
  ) {
    return null;
  }

  const baseKeys = [
    "actorContractVersion", "actorType", "actorSource", "actorSubject",
    "authType", "projectId", "role",
  ];
  if (value.actorType === "platform_user") {
    if (
      !hasOnlyKeys(value, [
        ...baseKeys, "platformUserId", "platformUid", "userId", "uid", "tenantId",
      ])
      || value.actorSource !== "platform_session"
      || !isNonEmptyString(value.platformUserId)
      || !Number.isSafeInteger(value.platformUid)
      || (value.platformUid as number) <= 0
      || value.userId !== value.platformUserId
      || value.uid !== value.platformUid
      || value.actorSubject !== `platform_user:${value.platformUserId}`
      || (value.tenantId !== undefined && !isNonEmptyString(value.tenantId))
    ) return null;
    return value as unknown as FunctionWorkerCaller;
  }

  if (value.actorType === "project_user") {
    if (
      !hasOnlyKeys(value, [...baseKeys, "projectUserId", "provider"])
      || value.actorSource !== "project_session"
      || value.role !== "authenticated"
      || !isNonEmptyString(value.projectUserId)
      || !isNonEmptyString(value.provider)
      || value.actorSubject !== `project_user:${value.projectUserId}`
    ) return null;
    return value as unknown as FunctionWorkerCaller;
  }

  if (value.actorType === "apikey") {
    if (
      !hasOnlyKeys(value, [...baseKeys, "apiKeyId", "apiKeyPrefix"])
      || value.actorSource !== "project_api_key"
      || value.role !== "anon"
      || !Number.isSafeInteger(value.apiKeyId)
      || (value.apiKeyId as number) <= 0
      || !isNonEmptyString(value.apiKeyPrefix)
      || value.apiKeyPrefix.length > 12
      || value.actorSubject !== `apikey:${value.apiKeyId}`
    ) return null;
    return value as unknown as FunctionWorkerCaller;
  }

  return null;
}

function parseSecrets(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  return Object.values(value).every((secret) => typeof secret === "string")
    ? value as Record<string, string>
    : null;
}

function parseExecuteRequest(value: unknown): WorkerExecuteRequest | null {
  if (!isRecord(value)) return null;
  const caller = parseCaller(value.caller);
  const secrets = parseSecrets(value.secrets);
  if (
    !isNonEmptyString(value.code)
    || !isNonEmptyString(value.functionName)
    || !isNonEmptyString(value.internalToken)
    || !caller
    || !secrets
    || (value.executionId !== undefined && !isNonEmptyString(value.executionId))
    || (value.apiBaseUrl !== undefined && !isNonEmptyString(value.apiBaseUrl))
  ) return null;

  const timeout = value.timeout === undefined ? 30_000 : value.timeout;
  if (!Number.isFinite(timeout) || (timeout as number) <= 0 || (timeout as number) > 300_000) {
    return null;
  }

  return {
    code: value.code,
    functionName: value.functionName,
    ...(value.executionId ? { executionId: value.executionId as string } : {}),
    secrets,
    ...(Object.prototype.hasOwnProperty.call(value, "payload") ? { payload: value.payload } : {}),
    caller,
    internalToken: value.internalToken,
    ...(value.apiBaseUrl ? { apiBaseUrl: value.apiBaseUrl as string } : {}),
    timeout: timeout as number,
  };
}

export function createWorkerHandler(dependencies: WorkerHandlerDependencies) {
  const workerSecret = assertWorkerSecret(dependencies.workerSecret);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", runtime: "deno" });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname !== "/execute") {
      return new Response("Not found", { status: 404 });
    }

    const authorized = await verifyWorkerSecret(
      workerSecret,
      request.headers.get(WORKER_SECRET_HEADER),
    );
    if (!authorized) {
      dependencies.logger.warn("worker execution request rejected");
      return Response.json({
        success: false,
        error: { message: "Unauthorized" },
      }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({
        success: false,
        error: { message: "Invalid execution request" },
      }, { status: 400 });
    }
    const executionRequest = parseExecuteRequest(body);
    if (!executionRequest) {
      return Response.json({
        success: false,
        error: { message: "Invalid execution request" },
      }, { status: 400 });
    }

    const executionLogger = dependencies.logger.child({
      projectId: executionRequest.caller.projectId,
      actorType: executionRequest.caller.actorType,
      actorSource: executionRequest.caller.actorSource,
      actorSubject: executionRequest.caller.actorSubject,
      ...(executionRequest.caller.platformUserId
        ? { platformUserId: executionRequest.caller.platformUserId }
        : {}),
      ...(executionRequest.caller.projectUserId
        ? { projectUserId: executionRequest.caller.projectUserId }
        : {}),
      ...(executionRequest.caller.apiKeyId
        ? {
            apiKeyId: executionRequest.caller.apiKeyId,
            apiKeyPrefix: executionRequest.caller.apiKeyPrefix,
          }
        : {}),
      functionName: executionRequest.functionName,
      executionId: executionRequest.executionId,
    });
    executionLogger.info("function execution started");

    try {
      const result = await dependencies.executeFunction(executionRequest);
      executionLogger.info(
        result.success ? "function execution succeeded" : "function execution failed",
        { durationMs: result.durationMs },
        result.success ? undefined : result.error?.message,
      );
      return Response.json(result);
    } catch (error) {
      executionLogger.error("worker execution failed", undefined, error);
      return Response.json({
        success: false,
        error: { message: "Worker execution failed" },
      }, { status: 500 });
    }
  };
}
