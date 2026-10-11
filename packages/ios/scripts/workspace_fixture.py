"""Isolated HTTP/WebSocket contract fixture. No production credentials or daemon."""
import asyncio, base64, json, time, uuid, hashlib, html
from urllib.parse import urlencode
from aiohttp import web, WSMsgType
from pathlib import Path
import sys

PORT = 18743
EVENTS = Path(__file__).resolve().parent.parent / '.build' / 'fixture-events.jsonl'
state = {}
current_events = []
attachment_bytes = {}

def reset():
    state.clear(); current_events.clear(); attachment_bytes.clear()
    now = int(time.time()*1000)
    state.update(projects=[dict(id='empty',name='Empty project',role='owner'),dict(id='demo',name='Test workspace',role='owner',memory_enabled=True)], agents=[dict(id='agent',name='Fixture Agent',status='idle',paused=False),dict(id='offline',name='Offline Agent',status='offline',paused=False)], portals={}, tasks={'task':dict(id='task',team_id='demo',agent_id='agent',subject='Review fixture changes',status='waiting_input',created_at=now,sender_id='user',first_message_role='user')}, messages={'task':[dict(id='message',role='agent',body='Ready for your review. 猫 café 🚀',created_at=now,attachments=[])]}, resources={}, authorization_codes={}, failure=None)
SEED = Path(sys.argv[sys.argv.index('--seed')+1]) if '--seed' in sys.argv else None

def seed():
    """Replaces the contract state with a sample workspace (launch/media/native/sample_workspace.py)."""
    data = json.loads(SEED.read_text()); team = data['teams'][0]['id']
    state.update(projects=data['teams'], agents=data['agents'], me=data['me'], stats=data['stats'],
                 tasks={t['id']: t for t in data['tasks']}, messages=data['messages'],
                 portals={p['id']: p for p in data['portals']},
                 resources={f"{team}:{k.replace('_','-')}": v for k, v in data['resources'].items()})
    state['resources'][f'{team}:notes:comments'] = [c for cs in data['comments'].values() for c in cs]

reset()
if SEED: seed()

def event(kind, **kwargs):
    EVENTS.parent.mkdir(parents=True,exist_ok=True)
    line = json.dumps(dict(kind=kind,time=time.time(),**kwargs),ensure_ascii=False)
    current_events.append(line)
    with EVENTS.open('a') as f: f.write(line+'\n')

def response(value, status=200): return web.json_response(value,status=status)

async def handler(req):
    path=req.path.strip('/').split('/')
    if path[0]=='__test':
        if path[-1]=='reset': reset(); SEED and seed(); event('reset'); return response({'ok':True})
        if path[-1]=='fail': state['failure']=await req.json(); return response({'ok':True})
        if path[-1]=='state': return response(state)
        if path[-1]=='events': return web.Response(text='\n'.join(current_events),content_type='application/x-ndjson')
    if path==['mobile','authorize']:
        if req.query.get('redirect_uri')!='tasksquad-portal://oauth/callback': return response({'error':'bad_redirect'},400)
        code=uuid.uuid4().hex+uuid.uuid4().hex
        state['authorization_codes'][code]=req.query.get('code_challenge')
        callback='tasksquad-portal://oauth/callback?'+urlencode(dict(code=code,state=req.query.get('state','')))
        event('authorization_started')
        return web.Response(text='<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><h1>Fixture authorization</h1><p>Disposable local account for native authentication tests.</p><a href="'+html.escape(callback)+'">Authorize fixture</a></body></html>',content_type='text/html')
    if path==['mobile','authorization','exchange']:
        body=await req.json()
        verifier=body.get('code_verifier','')
        challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        expected=state['authorization_codes'].get(body.get('code'))
        if expected is None or expected!=challenge: return response({'error':'invalid_code'},401)
        state['authorization_codes'].pop(body.get('code'))
        event('pkce_exchange',verified=True)
        return response(dict(token='fixture-token',expires_at=time.time()*1000+300000))
    if path[0]=='terminal' and len(path)==2 and path[1]!='ticket':
        if req.query.get('ticket')!='fixture-ticket': return response({'error':'invalid_ticket'},401)
        ws=web.WebSocketResponse(); await ws.prepare(req)
        event('socket_open',session=path[1],replay=req.query.get('replay'))
        await ws.send_bytes(b'\x1b[2J\x1b[HFixture shell ready\r\n$ ')
        async for msg in ws:
            if msg.type in (WSMsgType.BINARY,WSMsgType.TEXT):
                frame=json.loads(msg.data)
                if frame['t']=='r': event('resize',cols=frame['c'],rows=frame['r'])
                elif frame['t']=='i':
                    data=base64.b64decode(frame['d']); event('input',text=data.decode('utf-8','replace')); await ws.send_bytes(data+b'\r\n$ ')
        event('socket_close',session=path[1]); return ws
    if req.headers.get('Authorization')!='Bearer fixture-token': return response({'error':'unauthorized'},401)
    event('request',method=req.method,path=req.path,query=dict(req.query))
    failure=state['failure']
    if failure and failure['method']==req.method and failure['path']==req.path:
        state['failure']=None; return response({'error':failure.get('error','Fixture request rejected')},failure.get('status',503))
    body={}; attachments=[]
    if req.method in ('POST','PUT','PATCH'):
        if req.content_type.startswith('multipart/'):
            form=await req.post()
            for key,value in form.items():
                if key=='images':
                    data=value.file.read(); attachment_id='image-'+uuid.uuid4().hex
                    attachment_bytes[attachment_id]=(data,value.content_type)
                    attachments.append(dict(id=attachment_id,filename=value.filename,mime_type=value.content_type,size=len(data),sha256=hashlib.sha256(data).hexdigest()))
                else: body[key]=value
        else: body=await req.json() if req.can_read_body else {}
        event('mutation',method=req.method,path=req.path,body=body,attachments=len(attachments))
    if path==['auth','cli-token'] and req.method=='DELETE': event('token_revoked'); return response({'ok':True})
    if path==['me']: return response(state.get('me') or dict(id='user',email='fixture@example.test',plan='pro'))
    if path==['teams']: return response({'teams':state['projects']})
    if path[:1]==['teams']:
        team=path[1]
        if len(path)==2:
            state['projects'][1].update(body); return response({'ok':True})
        resource=path[2]; key=team+':'+resource
        if resource=='agents' and len(path)==3: return response({'agents':state['agents'] if team in ('demo', SEED and state['projects'][0]['id']) else []})
        if resource=='stats' and 'stats' in state: return response(state['stats'])
        if resource=='stats': return response({'totals':dict(created=3,done=1,failed=0,in_progress=2,scheduled=0),'usage':dict(turns=5,input_tokens=120,output_tokens=240,tool_calls=2,tool_errors=0)})
        items=state['resources'].setdefault(key,[])
        if len(path)>4 and path[4]=='tasks': return response({'tasks':[]})
        if len(path)>4 and path[4]=='comments':
            comments=state['resources'].setdefault(key+':comments',[])
            if req.method=='POST': comments.append(dict(id=uuid.uuid4().hex,**body)); return response(comments[-1])
            return response({'comments':comments})
        if len(path)>4 and path[4] in ('convert','critique'): return response({'task_id':'task'})
        if req.method=='GET':
            if len(path)==3: return response({resource.replace('-','_'):items})
            return response(next((i for i in items if i['id']==path[3]),{}))
        if req.method=='POST' and len(path)==3:
            row=dict(id=uuid.uuid4().hex,created_at=time.time()*1000,**body); items.append(row); return response(row,201)
        row=next((i for i in items if i['id']==path[3]),{})
        row.update(body); return response({'ok':True})
    if path[0]=='tasks':
        if len(path)==1:
            if req.method=='GET': return response({'tasks':[t for t in state['tasks'].values() if t['team_id']==req.query.get('team_id')]})
            task=dict(id=uuid.uuid4().hex,status='pending',created_at=time.time()*1000,**body); state['tasks'][task['id']]=task
            state['messages'][task['id']]=[dict(id=uuid.uuid4().hex,role='user',body=body.get('body',''),attachments=attachments,created_at=time.time()*1000)]
            return response(task,201)
        id=path[1]
        if len(path)==2: return response(state['tasks'].get(id,{}))
        if path[2]=='close': state['tasks'][id]['status']='done'; return response({'ok':True})
        if path[2]=='logs': return response({'logs':[dict(id='log',body='Fixture log entry')]})
        if path[2]=='messages':
            if len(path)>4 and path[4]=='attachments':
                stored=attachment_bytes.get(path[5])
                if stored is None: return response({'error':'attachment_not_found'},404)
                data,mime=stored
                event('attachment_download',id=path[5],size=len(data),sha256=hashlib.sha256(data).hexdigest())
                return web.Response(body=data,content_type=mime)
            if req.method=='GET': return response({'messages':state['messages'].get(id,[])})
            message=dict(id=uuid.uuid4().hex,role='user',created_at=time.time()*1000,attachments=attachments,**body); state['messages'].setdefault(id,[]).append(message); return response(message,201)
    if path[0]=='portals':
        if len(path)==1:
            if req.method=='GET': return response({'portals':[p for p in state['portals'].values() if p['team_id']==req.query.get('team_id')]})
            portal=dict(id=uuid.uuid4().hex,status='pending',session_id=None,created_at=time.time()*1000,**body); state['portals'][portal['id']]=portal
            return response({'id':portal['id'],'status':'pending'},201)
        portal=state['portals'].get(path[1])
        if not portal: return response({'error':'not_found'},404)
        if len(path)>2: portal.update(status='done',completed_at=time.time()*1000); return response({'ok':True})
        if portal['status']=='pending' and time.time()*1000-portal['created_at']>1800: portal.update(status='running',session_id='session-'+portal['id'])
        return response(portal)
    if path==['terminal','ticket']: return response({'ticket':'fixture-ticket'})
    return response({'error':'unsupported fixture route'},404)

app=web.Application(); app.router.add_route('*','/{path:.*}',handler)
web.run_app(app,host='127.0.0.1',port=PORT,print=None)
