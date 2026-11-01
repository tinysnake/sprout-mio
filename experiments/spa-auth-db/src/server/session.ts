import { auth } from '#/lib/auth'

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized')
    this.name = 'UnauthorizedError'
  }
}

export type SessionInfo = {
  userId: string
  email: string
}

export async function readSession(headers: Headers): Promise<SessionInfo | null> {
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  return { userId: session.user.id, email: session.user.email }
}

export async function requireSession(headers: Headers): Promise<SessionInfo> {
  const session = await readSession(headers)
  if (!session) throw new UnauthorizedError()
  return session
}
