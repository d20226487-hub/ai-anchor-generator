import { NextResponse, type NextRequest } from "next/server";

// HTTP Basic Auth gate. Enabled when BOTH BASIC_AUTH_USER and BASIC_AUTH_PASS env vars are set.
// Intended for internal-network deployments where the network gate (VPN) is the primary control
// and basic auth is a secondary "who's at this URL" check.
//
// To enable in production, set the env vars in your deployment environment:
//   BASIC_AUTH_USER=team
//   BASIC_AUTH_PASS=some-shared-password
//
// To disable (e.g. local dev), leave one or both unset.

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="ai-anchor-generator", charset="UTF-8"',
    },
  });
}

export function middleware(req: NextRequest): NextResponse {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASS;
  if (!expectedUser || !expectedPass) return NextResponse.next(); // disabled

  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return unauthorized();
  }
  const colonIndex = decoded.indexOf(":");
  if (colonIndex < 0) return unauthorized();
  const user = decoded.slice(0, colonIndex);
  const pass = decoded.slice(colonIndex + 1);

  if (!safeEqual(user, expectedUser) || !safeEqual(pass, expectedPass)) {
    return unauthorized();
  }
  return NextResponse.next();
}

// Apply to all routes EXCEPT Next.js internals (static chunks, favicon, etc.) so the
// browser can still load the login form's CSS and the 401 response itself.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
