import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'
import { getSessionInfo, readProtectedValue } from '@/server/auth-functions'

export const Route = createFileRoute('/')({ component: Home })

type SessionInfo = Awaited<ReturnType<typeof getSessionInfo>>

function Home() {
  const [session, setSession] = useState<SessionInfo>(null)
  const [email, setEmail] = useState('probe@example.com')
  const [password, setPassword] = useState('probe-password-123')
  const [authStatus, setAuthStatus] = useState('idle')
  const [protectedStatus, setProtectedStatus] = useState('not called')

  const refreshSession = useCallback(async () => {
    setSession(await getSessionInfo())
  }, [])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  const submitCredentials = async (mode: 'sign-up' | 'sign-in') => {
    const result =
      mode === 'sign-up'
        ? await authClient.signUp.email({ email, password, name: email })
        : await authClient.signIn.email({ email, password })

    setAuthStatus(
      result.error
        ? `${mode} failed: ${result.error.message ?? result.error.status}`
        : `${mode} ok`,
    )
    await refreshSession()
  }

  const signOut = async () => {
    await authClient.signOut()
    setAuthStatus('sign-out ok')
    await refreshSession()
  }

  const callProtected = async () => {
    try {
      const result = await readProtectedValue()
      setProtectedStatus(`ok: ${result.value} (${result.userId})`)
    } catch (error) {
      setProtectedStatus(`rejected: ${(error as Error).message}`)
    }
  }

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-4xl font-bold" data-testid="home-marker">
        Home page
      </h1>

      <section className="space-y-2" data-testid="auth-panel">
        <h2 className="text-xl font-semibold">Auth</h2>
        <div className="flex gap-2">
          <input
            data-testid="email-input"
            className="border px-2 py-1"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            data-testid="password-input"
            className="border px-2 py-1"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button data-testid="sign-up" onClick={() => void submitCredentials('sign-up')}>
            Sign up
          </Button>
          <Button
            data-testid="sign-in"
            variant="secondary"
            onClick={() => void submitCredentials('sign-in')}
          >
            Sign in
          </Button>
          <Button data-testid="sign-out" variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
        <p data-testid="auth-status">{authStatus}</p>
        <p data-testid="session-email">{session ? session.email : 'no-session'}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Protected server function</h2>
        <Button data-testid="call-protected" onClick={() => void callProtected()}>
          Call readProtectedValue
        </Button>
        <p data-testid="protected-result">{protectedStatus}</p>
      </section>

      <Link to="/second" className="inline-block underline">
        Go to second page
      </Link>
    </div>
  )
}
