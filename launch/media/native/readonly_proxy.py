"""Read-only loopback proxy to the production API for capturing launch screenshots of real data.

The debug iOS app (`--ui-test-api`) and the macOS promo render test call http://127.0.0.1:18744 with the
placeholder token `fixture-token`. The proxy swaps in your token and forwards GET requests only. Every
write is rejected with 405, so capturing screens can never change the workspace.

    TSQ_TOKEN=<your token> .build/fixture-env/bin/python launch/media/native/readonly_proxy.py   # from packages/ios

The token is read from the environment and never logged or written to disk.
"""
import os, sys
from aiohttp import ClientSession, web

UPSTREAM = os.environ.get('TSQ_API', 'https://api.tasksquad.ai')
PORT = int(os.environ.get('TSQ_PROXY_PORT', '18744'))
TOKEN = os.environ.get('TSQ_TOKEN', '').strip()
if not TOKEN: sys.exit('Set TSQ_TOKEN to a TaskSquad bearer token')

async def handler(req: web.Request):
    if req.method != 'GET': return web.json_response({'error': 'read-only proxy'}, status=405)
    async with req.app['client'].get(UPSTREAM + req.rel_url.path_qs, headers={'Authorization': 'Bearer ' + TOKEN}) as res:
        body = await res.read()
        print(res.status, req.rel_url.path, flush=True)
        return web.Response(body=body, status=res.status, content_type=res.content_type)

async def client(app):
    app['client'] = ClientSession(); yield; await app['client'].close()

app = web.Application(); app.cleanup_ctx.append(client); app.router.add_route('*', '/{path:.*}', handler)
web.run_app(app, host='127.0.0.1', port=PORT, print=lambda _: print(f'read-only proxy on 127.0.0.1:{PORT} → {UPSTREAM}', flush=True))
