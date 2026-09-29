// Isolated popup + real background handlers; fake Chrome storage, no user profile.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('extension');
const output=path.resolve('output/extension-connection');fs.mkdirSync(output,{recursive:true});
const storage={token:'wrong-fixture-token'};
const area=data=>({get:async defaults=>Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,data[k]??v])),set:async values=>Object.assign(data,values)});
const event=()=>({addListener(){},removeListener(){}});
globalThis.chrome={
  runtime:{onInstalled:event(),onStartup:event(),onMessage:event(),getManifest:()=>({version:'2.0.72'})},
  alarms:{onAlarm:event(),create:async()=>{},clear:async()=>true},
  storage:{local:area(storage),session:area({favoritesBrowserIdentity:'isolated-fixture'})},
  permissions:{contains:async()=>true},
  tabs:{query:async()=>[{id:1,url:'https://www.xiaohongshu.com/board/fixture123'}],onRemoved:event(),onUpdated:event(),create:async()=>{throw Error('No browser tab creation allowed in connection fixture');}},
};
let background;
const events=[];
const server=http.createServer(async(req,res)=>{
  try {
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    if(req.method==='POST') {
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16000)throw Error('Body too large');}
      const body=JSON.parse(raw);
      res.setHeader('content-type','application/json');
      if(pathname==='/api/captures/identity-check'){
        const authorized=req.headers.authorization==='Bearer valid-fixture-token';
        events.push({kind:'identity-check',status:authorized?200:401,items:body.items.length});
        res.statusCode=authorized?200:401;
        return res.end(JSON.stringify(authorized?{items:[]}:{error:'Unauthorized'}));
      }
      if(pathname==='/fixture-command'){
        if(!['GET_STATE','START_SYNC','CHECK_CONNECTION','SAVE_SETTINGS'].includes(body.type))throw Error('Unsupported fixture command');
        events.push({kind:'command',type:body.type});
        let result;
        try {result=await background.handleMessage(body);} catch(error){result={ok:false,error:{code:error.code,message:error.message}};}
        fs.writeFileSync(path.join(output,'browser-events.json'),JSON.stringify(events,null,2));
        return res.end(JSON.stringify(result));
      }
      throw Error('Unexpected POST');
    }
    if(pathname==='/'){
      let html=fs.readFileSync(path.join(root,'popup.html'),'utf8');
      html=html.replace('<body>','<body><p style="font-size:12px;color:#9c3f35">隔离测试 · 合成收藏夹 · 不连接生产</p>');
      html=html.replace('<script type="module" src="popup.js"></script>',`<script>window.chrome={runtime:{sendMessage:async message=>(await fetch('/fixture-command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)})).json()}};</script><script type="module" src="popup.js"></script>`);
      res.setHeader('content-type','text/html;charset=utf-8');return res.end(html);
    }
    if(['/popup.js','/popup-state.js'].includes(pathname)){
      res.setHeader('content-type','text/javascript;charset=utf-8');return res.end(fs.readFileSync(path.join(root,pathname.slice(1))));
    }
    res.statusCode=404;res.end();
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;storage.endpoint=origin;
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{
  if(new URL(url).origin!==origin)throw Error('External network forbidden by fixture');
  return nativeFetch(url,options);
};
background=await import('../extension/background.js');await background.restoreAfterRestart();
fs.writeFileSync(path.join(output,'fixture.json'),JSON.stringify({origin,processId:process.pid,production:false}));
console.log(JSON.stringify({origin,processId:process.pid,production:false}));
const timer=setInterval(()=>{
  if(fs.existsSync(path.join(output,'STOP'))){clearInterval(timer);server.close();}
},500);
