import type { AxiosRequestConfig } from "axios";
import { api } from "./api";
import {
  peekServerState,
  queryServerState,
  type ServerStateQueryOptions,
  type ServerStateScope,
} from "./serverStateCache";

export type CachedApiScope = Omit<ServerStateScope, "resource" | "params"> & {
  resource?: string;
};

function requestScope(url: string, config: AxiosRequestConfig, scope: CachedApiScope): ServerStateScope {
  return {
    ...scope,
    resource: scope.resource ?? url,
    params: config.params,
  };
}

export function peekCachedApiData<T>(
  url: string,
  config: AxiosRequestConfig,
  scope: CachedApiScope,
) {
  return peekServerState<T>(requestScope(url, config, scope));
}

export async function cachedApiGet<T>(
  url: string,
  config: AxiosRequestConfig,
  scope: CachedApiScope,
  options: Omit<ServerStateQueryOptions, "signal"> = {},
): Promise<{ data: T }> {
  const { signal, ...requestConfig } = config;
  const data = await queryServerState<T>(
    requestScope(url, config, scope),
    (sharedSignal) => api.get<T>(url, { ...requestConfig, signal: sharedSignal }).then((response) => response.data),
    { ...options, signal: signal as AbortSignal | undefined },
  );
  return { data };
}
