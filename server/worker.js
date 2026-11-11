const FEED = "https://api.neynar.com";
const NODE = "https://snapchain-api.neynar.com";
const ROUTES = {
  "GET /v2/farcaster/feed/following/": FEED,
  "GET /v2/farcaster/user/bulk/": FEED,
  "GET /v1/linksByFid": NODE,
  "GET /v1/userDataByFid": NODE,
  "GET /v1/signersByFid": NODE,
  "GET /v1/castById": NODE,
  "GET /v1/onChainIdRegistryEventByAddress": NODE,
  "POST /v1/submitMessage": NODE,
};

// Also rejects the placeholder in .dev.vars.example, which a deploy form may offer as a default.
const STRONG_PATH_SECRET = /^[A-Za-z0-9_-]{32,}$/;

export default {
  async fetch(request, env) {
    if (!STRONG_PATH_SECRET.test(env.PATH_SECRET ?? "") || !env.NEYNAR_API_KEY) {
      return new Response("Server not configured", { status: 503 });
    }

    const url = new URL(request.url);
    const prefix = `/${env.PATH_SECRET}/`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length - 1) : "";
    const origin = ROUTES[`${request.method} ${path}`];
    if (!origin) return new Response("Not found", { status: 404 });

    const isPost = request.method === "POST";
    const headers = { "x-api-key": env.NEYNAR_API_KEY };
    if (isPost) headers["content-type"] = "application/octet-stream";
    return fetch(origin + path + url.search, {
      method: request.method,
      headers,
      body: isPost ? request.body : undefined,
      redirect: "manual",
    });
  },
};
