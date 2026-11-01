import { Context, Effect, Layer, ManagedRuntime, Scope } from 'effect'
import { isMainThread, threadId } from 'node:worker_threads'

export interface HostSnapshot {
  instanceId: string
  pid: number
  threadId: number
  isMainThread: boolean
  startedAt: number
  uptimeMs: number
  counter: number
  ticks: number
  subscribers: number
  activeTickers: number
  moduleEvals: number
  runtimeConstructions: number
}

export interface HostDiagnostics {
  singleton: boolean
  moduleEvals: number
  runtimeConstructions: number
  activeTickers: number
  instances: Array<{ instanceId: string; builtAt: number; pid: number; threadId: number }>
  currentInstanceId: string
  sigtermListeners: number
  sigintListeners: number
  isMainThread: boolean
  threadId: number
}

export interface HostRuntimeShape {
  readonly instanceId: string
  snapshot: () => HostSnapshot
  subscribe: (listener: (snapshot: HostSnapshot) => void) => () => void
  bump: () => void
}

class HostRuntime extends Context.Service<HostRuntime, HostRuntimeShape>()(
  'sprout/runtime-host/HostRuntime',
) {
  static readonly layer = Layer.effect(
    HostRuntime,
    Effect.gen(function* () {
      const instanceId = `rt-${Math.random().toString(36).slice(2, 8)}`
      const startedAt = Date.now()
      counters.instances.push({ instanceId, builtAt: startedAt, pid: process.pid, threadId })
      console.log(
        `[host-runtime] init instance=${instanceId} pid=${process.pid} thread=${threadId} main=${isMainThread} moduleEvals=${counters.moduleEvals} constructions=${counters.runtimeConstructions}`,
      )

      const state = { counter: 0, ticks: 0 }
      const subscribers = new Set<(snapshot: HostSnapshot) => void>()

      const snapshot = (): HostSnapshot => ({
        instanceId,
        pid: process.pid,
        threadId,
        isMainThread,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        counter: state.counter,
        ticks: state.ticks,
        subscribers: subscribers.size,
        activeTickers: counters.activeTickers,
        moduleEvals: counters.moduleEvals,
        runtimeConstructions: counters.runtimeConstructions,
      })

      const scope = yield* Scope.Scope
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          console.log(
            `[host-runtime] finalizer#1 close-subscribers instance=${instanceId} counter=${state.counter} ticks=${state.ticks} subscribers=${subscribers.size}`,
          )
          subscribers.clear()
        }),
      )

      const ticker = Effect.forever(
        Effect.sleep('1 second').pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.counter += 1
              state.ticks += 1
              const current = snapshot()
              for (const listener of subscribers) listener(current)
            }),
          ),
        ),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            counters.activeTickers -= 1
            console.log(
              `[host-runtime] finalizer#2 ticker-interrupted instance=${instanceId} ticks=${state.ticks} activeTickers=${counters.activeTickers}`,
            )
          }),
        ),
      )

      counters.activeTickers += 1
      console.log(
        `[host-runtime] ticker-started instance=${instanceId} activeTickers=${counters.activeTickers}`,
      )
      yield* Effect.forkScoped(ticker)

      return {
        instanceId,
        snapshot,
        bump: () => {
          state.counter += 1
        },
        subscribe: (listener) => {
          subscribers.add(listener)
          return () => subscribers.delete(listener)
        },
      }
    }),
  )
}

interface HostState {
  moduleEvals: number
  runtimeConstructions: number
  activeTickers: number
  instances: Array<{ instanceId: string; builtAt: number; pid: number; threadId: number }>
  runtime: ManagedRuntime.ManagedRuntime<HostRuntime, never> | null
  ready: Promise<unknown> | null
  shutdownHooksInstalled: boolean
}

const GLOBAL_KEY = '__sproutHostRuntime__'
const globalScope = globalThis as unknown as Record<string, HostState | undefined>
const counters: HostState = (globalScope[GLOBAL_KEY] ??= {
  moduleEvals: 0,
  runtimeConstructions: 0,
  activeTickers: 0,
  instances: [],
  runtime: null,
  ready: null,
  shutdownHooksInstalled: false,
})
counters.moduleEvals += 1

const singletonEnabled = process.env.HOST_RUNTIME_SINGLETON !== '0'

if (singletonEnabled && counters.runtime) {
  console.log(
    `[host-runtime] module re-evaluated, reusing singleton instance=${counters.runtime.runSync(HostRuntime).instanceId} moduleEvals=${counters.moduleEvals}`,
  )
} else {
  counters.runtimeConstructions += 1
  const runtime = ManagedRuntime.make(HostRuntime.layer)
  counters.runtime = runtime
  counters.ready = runtime.context()
  counters.ready.catch((error) => {
    console.error('[host-runtime] layer construction failed', error)
  })
}

export const hostRuntime: HostRuntimeShape = counters.runtime!.runSync(HostRuntime)
export const hostReady: Promise<unknown> = counters.ready ?? Promise.resolve()

export function hostDiagnostics(): HostDiagnostics {
  return {
    singleton: singletonEnabled,
    moduleEvals: counters.moduleEvals,
    runtimeConstructions: counters.runtimeConstructions,
    activeTickers: counters.activeTickers,
    instances: [...counters.instances],
    currentInstanceId: hostRuntime?.instanceId ?? '',
    sigtermListeners: process.listenerCount('SIGTERM'),
    sigintListeners: process.listenerCount('SIGINT'),
    isMainThread,
    threadId,
  }
}

export async function shutdownHostRuntime(reason: string): Promise<void> {
  const runtime = counters.runtime
  if (!runtime) return
  console.log(
    `[host-runtime] shutdown-requested reason=${reason} instance=${hostRuntime.instanceId} counter=${hostRuntime.snapshot().counter}`,
  )
  await runtime.dispose()
  console.log('[host-runtime] shutdown-complete')
}

function installShutdownHooks(): void {
  if (counters.shutdownHooksInstalled) return
  counters.shutdownHooksInstalled = true
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[host-runtime] signal=${signal} main=${isMainThread} thread=${threadId}`)
      void shutdownHostRuntime(signal).then(() => process.exit(0))
    })
  }
  console.log(
    `[host-runtime] shutdown-hooks-installed SIGTERM,SIGINT main=${isMainThread} thread=${threadId}`,
  )
}

installShutdownHooks()
