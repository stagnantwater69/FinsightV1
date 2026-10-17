import "axios";

declare module "axios" {
  interface AxiosRequestConfig<D = any> {
    serverStateScope?: {
      businessProfileId: number | string;
    };
    /** The stored-session access token this request was sent with, set by api.ts. */
    sessionToken?: string;
    /** Set once a 401 has been answered with a refresh, so a request is retried at most once. */
    sessionRetried?: boolean;
    manualCreateAccount?: { userId: string; generation: number } | null;
  }
}
