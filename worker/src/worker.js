// Entry point for the RayPlayz Cloudflare Worker.
//
// Jobs:
//   1. Serve the public marketing site (from ./public) on rayplayz.online.
//   2. Serve the private /dashboard route, which contains its own client-side
//      auth flow that talks to /api/login, /api/me, /api/logout.
//   3. On the dedicated intake domain (raya.rocks), the intake form IS the
//      home page — a bare visit to raya.rocks lands on the form directly,
//      no /intake/ segment needed.
//
// All dashboard-side data (contacts, threads, messages, drafts) is served
// through /api/* endpoints in api.js. Every one of those endpoints requires
// a valid session cookie, so the static dashboard shell being publicly
// reachable is safe — nothing sensitive lives in the HTML.

import { handleApi } from './api.js';

const DASHBOARD_PATH = '/dashboard';

// Hostnames where a bare "/" should serve the intake form instead of the
// marketing site. The Worker also serves the form's CSS/JS from /intake/*
// on these hosts, so a browser request to raya.rocks/intake.css just works.
const INTAKE_HOSTS = new Set(['raya.rocks', 'www.raya.rocks']);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // JSON API — always available on every host so the form can POST
    // /api/intake regardless of which domain served it.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(req, env, url);
    }

    // Dedicated intake host: a bare "/" is the form. We rewrite the request
    // internally rather than redirecting so the URL in the browser stays
    // clean (just raya.rocks, no /intake/ visible).
    if (INTAKE_HOSTS.has(url.hostname)) {
      // Dashboard is NOT exposed on this host — keep raya.rocks suitor-facing.
      if (url.pathname === DASHBOARD_PATH || url.pathname.startsWith(DASHBOARD_PATH + '/')) {
        return new Response('Not found', { status: 404 });
      }
      if (url.pathname === '/' || url.pathname === '') {
        const rewritten = new URL(url);
        rewritten.pathname = '/intake/';
        return env.ASSETS.fetch(new Request(rewritten.toString(), req));
      }
      // Relative asset paths from the form (intake.css, intake.js) will come
      // in as /intake.css and /intake.js because the browser resolved them
      // against the rewritten "/" page. Serve them from /intake/<file>.
      if (url.pathname === '/intake.css' || url.pathname === '/intake.js') {
        const rewritten = new URL(url);
        rewritten.pathname = '/intake' + url.pathname;
        return env.ASSETS.fetch(new Request(rewritten.toString(), req));
      }
      // Everything else (favicons, direct /intake/* paths) falls through to
      // the static-assets binding below.
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
