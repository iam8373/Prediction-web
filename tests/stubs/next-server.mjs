/**
 * Test stub for `next/server`.
 *
 * Next resolves this specifier through its own exports map and layers its
 * request/response classes on top of the platform `Response`. The Node test
 * runner cannot resolve the specifier at all, so the server units that build
 * error responses (`lib/security/guard.ts`, `lib/security/admin-guard.ts`) get
 * this minimal equivalent instead.
 *
 * It is intentionally tiny: only what those modules use is implemented, so a
 * change in how they build responses fails loudly here rather than silently
 * diverging from production behaviour.
 */

class StubResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200
    this.body = body
    this.headers = new Map(
      Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
    )
  }

  async json() {
    return this.body
  }
}

export const NextResponse = {
  json(body, init) {
    return new StubResponse(body, init)
  },
}

export class NextRequest extends Request {}
