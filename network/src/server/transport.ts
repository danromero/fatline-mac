/**
 * HTTPS only, except on this computer. Over plain HTTP, pages move to HTTPS and everything else is
 * refused, so a token or form isn't sent in the clear a second time. Answers over HTTPS tell browsers
 * to use nothing else for a year.
 */

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const HSTS = "max-age=31536000";

/** The answer to a request that came over plain HTTP from elsewhere, or null when it may go on. */
export function insecure(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || LOCAL.test(url.hostname)) return null;
  if (!url.pathname.startsWith("/api/") && (request.method === "GET" || request.method === "HEAD")) {
    url.protocol = "https:";
    return new Response(null, { status: 301, headers: { location: url.toString(), "cache-control": "no-store" } });
  }
  return Response.json(
    { message: "This network only answers over HTTPS." },
    { status: 403, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

/** Adds Strict-Transport-Security to an answer sent over HTTPS. */
export function secured(request: Request, response: Response): Response {
  if (new URL(request.url).protocol !== "https:") return response;
  const answer = new Response(response.body, response);
  answer.headers.set("strict-transport-security", HSTS);
  return answer;
}
