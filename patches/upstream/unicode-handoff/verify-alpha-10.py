import json,subprocess,time,http.client,socket
from pathlib import Path
import os
root=Path(os.environ['PORFFOR_ALPHA10_TEST_DIR'])
base=Path(__file__).resolve().parent
e=json.loads((base/'evidence.json').read_text());rows=[]
with socket.socket() as s: s.bind(('127.0.0.1',18082))
for case in e['results']:
 proc=subprocess.Popen([str(root/'all-unicode')],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 row={'name':case['name'],'expected':case['expected']}
 try:
  ready=False
  for i in range(100):
   try:
    c=http.client.HTTPConnection('127.0.0.1',18082,timeout=.1);c.request('GET','/health');r=c.getresponse();r.read();c.close();ready=True;break
   except (OSError,http.client.HTTPException):time.sleep(.02)
  if not ready:raise RuntimeError('server did not become ready')
  c=http.client.HTTPConnection('127.0.0.1',18082,timeout=2);c.request('GET','/'+case['name']);r=c.getresponse();b=r.read();c.close();row['status']=r.status;row['rawHex']=b.hex()
  if case['name'].startswith('response-') or case['name'] in ['json-lone','json-quoted-key']:actual=b.decode('utf-8')
  else:actual=json.loads(b)
  row['actual']=actual;row['correct']=actual==case['expected']
 except Exception as err:row['error']=str(err);row['correct']=False
 finally:
  time.sleep(.03);row['exitCodeBeforeCleanup']=proc.poll()
  if proc.poll() is None:proc.terminate()
  try:_,stderr=proc.communicate(timeout=2)
  except subprocess.TimeoutExpired:proc.kill();_,stderr=proc.communicate()
  if stderr:row['stderr']=stderr.decode(errors='replace')
 rows.append(row);print(case['name'],row['correct'],row.get('actual',row.get('error')))
metadata=json.loads((root/'platform-metadata.json').read_text())
out={'release':'alpha-10','commit':'08ac7ee1077c05da2bec18dcca15197051e87b62','platform':'darwin-arm64','packageIntegrity':metadata['dist']['integrity'],'scope':'One fresh native process per probe, official npm binary; no Sproutboat patches','results':rows}
(base/'alpha-10-release-results.json').write_text(json.dumps(out,indent=2)+'\n')
