import { createStart } from '@tanstack/react-start'

// SPA mode is build-time (the shell). This is the runtime half: the server sends the
// shell and the client router renders the matched route on every document request.
export const startInstance = createStart(() => ({
  defaultSsr: false,
}))
