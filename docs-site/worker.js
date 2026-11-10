// The one Worker of oc-workers. Static assets serve the landing page at / and the docs at /docs/.
// This script runs only when no asset matches, and sends the visitor to the docs.
export default {
  fetch(request) {
    return Response.redirect(new URL("/docs/", request.url).toString(), 302);
  },
};
