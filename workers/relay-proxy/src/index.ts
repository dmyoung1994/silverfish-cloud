export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.pathname !== "/healthz" && !incoming.pathname.startsWith("/api/rooms")) {
      return env.ASSETS.fetch(request);
    }

    const origin = new URL(env.ORIGIN_URL);
    origin.pathname = incoming.pathname;
    origin.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.delete("host");
    headers.delete("x-forwarded-for");
    headers.set("x-forwarded-proto", "https");

    try {
      return await fetch(new Request(origin, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      }));
    } catch (error) {
      console.error(JSON.stringify({
        message: "relay origin unavailable",
        error: error instanceof Error ? error.message : String(error),
        method: request.method,
        path: incoming.pathname,
      }));
      return Response.json({ error: "Relay temporarily unavailable" }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
