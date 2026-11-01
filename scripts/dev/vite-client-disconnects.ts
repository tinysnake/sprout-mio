import type { Connect, Plugin } from "vite-plus";

export function devClientDisconnects(): Plugin {
  return {
    name: "sprout-dev-client-disconnects",
    apply: "serve",
    configureServer(server) {
      return () => {
        const onError: Connect.ErrorHandleFunction = (error, request, response, next) => {
          if (
            request.aborted &&
            request.errored === error &&
            error.code === "ECONNRESET" &&
            response.destroyed
          ) {
            return;
          }
          next(error);
        };
        server.middlewares.use(onError);
      };
    },
  };
}
