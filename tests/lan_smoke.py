"""Run from a second machine on the LAN. Writes only isolated qa-* profiles."""
import json, os, time, urllib.request, urllib.error
BASE = os.environ.get('HANZI_BASE_URL', 'http://127.0.0.1:4173').rstrip('/')
CHECK_RESTART = os.environ.get('HANZI_REQUIRE_RESTART_PROBE') == '1'
CHECK_AUDIO = os.environ.get('HANZI_LOCAL_AUDIO') == '1'
PROFILE = 'qa-smoke-' + str(int(time.time()))
def request(path, data=None, expected=200):
    headers={'Origin':BASE}
    if data is not None: headers['Content-Type']='application/json'
    req=urllib.request.Request(BASE+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=15) as r: status,body,meta=r.status,r.read(),r.headers
    except urllib.error.HTTPError as e: status,body,meta=e.code,e.read(),e.headers
    assert status==expected,(path,status,body[:300])
    return body,meta
def state(): return json.loads(request('/api/state?profile='+PROFILE)[0])
def post(kind,value,expected=200): return request('/api/state?profile='+PROFILE,{'kind':kind,'value':value},expected)
request('/')
request('/credits')
if CHECK_RESTART:
    prior=json.loads(request('/api/state?profile=qa-persistence')[0])
    assert any(a['id']=='restart-proof-20260925' for a in prior['attempts']), 'Restart lost the saved probe'
a={'id':'a-1','at':'2026-09-25T08:00:00.000Z','characterId':'yi','skill':'pinyin','mode':'practice','correct':True,'assisted':False,'mistakes':0,'first':True,'answer':'yī','responseMode':'spelling','contentVersion':'poc-1'}
post('attempt',a);post('attempt',a)
assert len(state()['attempts'])==1,'Duplicate submission was counted twice'
post('attempt',{**a,'characterId':'unknown'},400)
post('settings',{'enabled':[],'lessonSize':3},400)
post('settings',{'enabled':['yi','ren'],'lessonSize':1})
assert state()['settings']=={'enabled':['yi','ren'],'lessonSize':1}
draft={'id':'qa-session','mode':'lesson','ids':['yi','ren'],'index':0,'stage':'write','updatedAt':200,'raw':'','tone':0,'checked':False,'correct':False,'tries':0,'heard':False,'choice':'','writingStroke':1,'writingMistakes':0,'writingHelp':False,'independent':True,'writingDone':True}
post('draft',draft);post('draft',{**draft,'updatedAt':100,'writingStroke':0})
assert state()['draft']['writingStroke']==1,'Older draft overwrote newer work'
backup={'settings':{'enabled':['san'],'lessonSize':1},'attempts':[a,{**a,'id':'a-2','characterId':'san','answer':'sān'}]}
post('import',backup)
assert len(state()['attempts'])==2 and state()['settings']['enabled']==['san']
for char,count in [('一',1),('二',2),('三',3),('大',3),('小',3),('人',2)]:
    data=json.loads(request('/characters/'+urllib.parse.quote(char)+'.json')[0]);assert len(data['strokes'])==len(data['medians'])==count
if CHECK_AUDIO:
    for name in ['yi','er','san','da','xiao','ren','yi-word','er-word','san-word','da-word','xiao-word','ren-word','write','pinyin','recognition','welcome']:
        data,headers=request('/audio/'+name+'.m4a');assert len(data)>1000 and b'ftyp' in data[:30]
request('/licenses/ARPHICPL.TXT');request('/licenses/HANZI-WRITER-MIT.txt');request('/og.png')
print(json.dumps({'result':'passed','profile':PROFILE,'restart_persistence':CHECK_RESTART,'duplicate_submission':True,'draft_ordering':True,'parent_settings':True,'backup_import':True,'character_files':6,'audio_files':16 if CHECK_AUDIO else 0}))
