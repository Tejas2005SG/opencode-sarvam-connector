import http, { IncomingMessage, ServerResponse } from "http";

export interface MockChatResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface CapturedChatRequest {
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface MockAccountBehavior {
  modelsStatus?: number;
  chatQueue?: MockChatResponse[];
  defaultChatResponse?: MockChatResponse;
}

function extractApiKey(request: IncomingMessage): string {
  const direct = request.headers["api-subscription-key"];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  return "";
}

export class MockSarvamServer {
  private readonly server: http.Server;
  private readonly behaviorByApiKey = new Map<string, MockAccountBehavior>();
  private readonly chatRequestsByApiKey = new Map<string, CapturedChatRequest[]>();
  private port = 0;

  public constructor() {
    this.server = http.createServer(this.handler.bind(this));
  }

  public get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public setBehavior(apiKey: string, behavior: MockAccountBehavior): void {
    this.behaviorByApiKey.set(apiKey, {
      modelsStatus: behavior.modelsStatus ?? 200,
      chatQueue: [...(behavior.chatQueue ?? [])],
      defaultChatResponse:
        behavior.defaultChatResponse ??
        ({
          status: 200,
          body: {
            id: "mock-default",
            choices: [{ message: { role: "assistant", content: "mock-response" } }],
            usage: { total_tokens: 10 }
          }
        } satisfies MockChatResponse)
    });
  }

  public getChatRequests(apiKey: string): CapturedChatRequest[] {
    return [...(this.chatRequestsByApiKey.get(apiKey) ?? [])];
  }

  public getLastChatRequest(apiKey: string): CapturedChatRequest | undefined {
    const requests = this.chatRequestsByApiKey.get(apiKey);
    return requests?.[requests.length - 1];
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Failed to start mock Sarvam server.");
        }
        this.port = address.port;
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const apiKey = extractApiKey(request);
    const behavior = this.behaviorByApiKey.get(apiKey);

    if (request.url === "/v1/models" && request.method === "GET") {
      if (!behavior) {
        this.send(response, 401, { error: { message: "unauthorized" } });
        return;
      }
      const status = behavior.modelsStatus ?? 200;
      this.send(
        response,
        status,
        status === 200 ? { data: [{ id: "sarvam-105b" }] } : { error: { message: "unauthorized" } }
      );
      return;
    }

    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      if (!behavior) {
        this.send(response, 401, { error: { message: "unauthorized" } });
        return;
      }

      const rawBody = await this.readBody(request);
      let body: unknown = {};
      if (rawBody.trim().length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }
      const requests = this.chatRequestsByApiKey.get(apiKey) ?? [];
      requests.push({
        url: request.url ?? "",
        headers: { ...request.headers },
        body
      });
      this.chatRequestsByApiKey.set(apiKey, requests);

      const next = behavior.chatQueue?.shift() ?? behavior.defaultChatResponse;
      if (!next) {
        this.send(response, 500, { error: { message: "missing mock response" } });
        return;
      }
      this.send(response, next.status, next.body, next.headers);
      return;
    }

    this.send(response, 404, { error: { message: "not-found" } });
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      request.on("error", reject);
    });
  }

  private send(
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): void {
    response.writeHead(status, {
      "content-type": "application/json",
      ...headers
    });
    response.end(JSON.stringify(body));
  }
}
