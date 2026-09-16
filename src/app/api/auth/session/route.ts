import { NextRequest, NextResponse } from "next/server";
import { establishSession, getCurrentSession, revokeCurrentSession, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth";

export const dynamic = "force-dynamic";

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

/** Fast server-session check: no Privy involved, no new rows, no writes. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({ authenticated: true, workspace: session.workspaceName });
}

export async function POST(request: NextRequest) {
  const accessToken = bearerToken(request);
  if (!accessToken) return NextResponse.json({ error: "Missing Privy access token." }, { status: 401 });
  try {
    const profile = await request.json().catch(() => ({}));
    const { token, expiresAt, session } = await establishSession({
      accessToken,
      email: profile.email,
      displayName: profile.displayName
    });
    const response = NextResponse.json({ workspace: session.workspaceName, renewed: token === null });
    // Reused sessions keep their existing cookie value; only the expiry is refreshed.
    if (token) response.cookies.set(SESSION_COOKIE, token, { ...sessionCookieOptions, expires: expiresAt });
    else response.cookies.set(SESSION_COOKIE, (request.cookies.get(SESSION_COOKIE)?.value ?? ""), { ...sessionCookieOptions, expires: expiresAt });
    return response;
  } catch {
    return NextResponse.json({ error: "Could not verify this Privy session." }, { status: 401 });
  }
}

export async function DELETE() {
  await revokeCurrentSession();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
  return response;
}
