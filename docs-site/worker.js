// The one Worker of oc-workers. Static assets serve /docs/. This script runs only for "/"
// (assets.run_worker_first) and sends the visitor to the docs until a landing page exists.
export default {
  fetch(request) {
    return Response.redirect(new URL("/docs/", request.url).toString(), 302);
  },
};
