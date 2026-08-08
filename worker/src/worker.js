// Entry point for the RayPlayz Cloudflare Worker.
//
// Two jobs right now:
//   1. Serve the existing public site (from ./public) unchanged.
//   2. Serve the private /dashboard route, which contains its own client-side
//      auth flow that talks to /api/login, /api/me, /api/logout.
//
// All dashboard-side data (contacts, threads, messages, drafts) will be added
// in Phase 2 as new /api/* endpoints in api.js. Every one of those endpoints
// will require a valid session cookie, so the static dashboard shell being
// publicly reachable is safe — nothing sensitive lives in the HTML.

import { handleApi } from './api.js';

const DASHBOARD_PATH = '/dashboard';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // JSON API
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(req, env, url);
    }

    // Normalize /dashboard → /dashboard/ so the static index.html resolves.
    if (url.pathname === DASHBOARD_PATH) {
      return Response.redirect(url.origin + DASHBOARD_PATH + '/', 302);
    }

    // Everything else falls through to the static-assets binding, which
    // serves ./public verbatim, including the public marketing site at /.
    return env.ASSETS.fetch(req);
  },
};
