export type Params = Record<string, string>;

export type Handler = (
  req: Request,
  params: Params,
) => Promise<Response>;

export type Middleware = (
  req: Request,
  params: Params,
  next: () => Promise<Response>,
) => Promise<Response>;

export interface Route {
  method: string;
  pattern: string;
  segments: string[];
  paramNames: string[];
  handler: Handler;
}

export interface Router {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  put(path: string, handler: Handler): void;
  patch(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
  use(middleware: Middleware): void;
  group(prefix: string, fn: (router: Router) => void): void;
  handle(req: Request): Promise<Response>;
}
