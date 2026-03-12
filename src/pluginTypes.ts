export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

export interface ApiKeyAuthDetails {
  type: "api_key";
  key: string;
}

export interface NonOAuthAuthDetails {
  type: string;
  [key: string]: unknown;
}

export type AuthDetails = OAuthAuthDetails | ApiKeyAuthDetails | NonOAuthAuthDetails;

export type GetAuth = () => Promise<AuthDetails>;

export interface ProviderModel {
  cost?: {
    input: number;
    output: number;
  };
  [key: string]: unknown;
}

export interface Provider {
  models?: Record<string, ProviderModel>;
}

export interface LoaderResult {
  apiKey: string;
  baseURL?: string;
  fetch(input: FetchInput, init?: RequestInit): Promise<Response>;
}

export type FetchInput = Parameters<typeof fetch>[0];

export interface PluginContext {
  client: unknown;
  directory: string;
}

export type SarvamAuthExchangeResult =
  | {
      type: "success";
      refresh: string;
      access: string;
      expires: number;
    }
  | {
      type: "failed";
      error: string;
    };

export interface OAuthAuthorizationResult {
  url: string;
  instructions: string;
  method: "code";
  callback: (code: string) => Promise<SarvamAuthExchangeResult>;
}

export interface AuthMethod {
  provider?: string;
  label: string;
  type: "oauth" | "api";
  authorize?: (inputs?: Record<string, string>) => Promise<OAuthAuthorizationResult>;
}

export interface PluginResult {
  auth: {
    provider: string;
    loader: (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | Record<string, unknown>>;
    methods: AuthMethod[];
  };
}
