import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'

import { readSession, requireSession } from './session'

export const getSessionInfo = createServerFn({ method: 'GET' }).handler(() =>
  readSession(getRequestHeaders()),
)

export const readProtectedValue = createServerFn({ method: 'POST' }).handler(
  async () => {
    const session = await requireSession(getRequestHeaders())
    return { value: 'protected-ok', userId: session.userId }
  },
)
