'use strict';
// HOSPITAL RPM — сервер аттестации. Без внешних зависимостей. Запуск: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=__dirname,DATA=path.join(ROOT,'data'),PHOTOS=path.join(DATA,'photos'),PUB=path.join(ROOT,'public');
fs.mkdirSync(PHOTOS,{recursive:true});
const cfg=Object.assign({port:3000,adminCode:'change-me',testMinutes:15,questionsPerTest:15},JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8')));
if(process.env.PORT)cfg.port=+process.env.PORT;
// Код администратора НЕ хранится в репозитории: переменная ADMIN_CODE, либо файл data/admin-code.txt (папка data не попадает в GitHub).
let ac=process.env.ADMIN_CODE||cfg.adminCode||'';try{if(!ac)ac=fs.readFileSync(path.join(DATA,'admin-code.txt'),'utf8').trim()}catch(e){}
if(!ac||ac==='change-me'||ac.length<8){console.error('\nНе задан код администратора (минимум 8 символов).\nЗадайте переменную окружения ADMIN_CODE или создайте файл data/admin-code.txt с кодом внутри.\n');process.exit(1)}
cfg.adminCode=ac;
const Q=JSON.parse(fs.readFileSync(path.join(ROOT,'questions.json'),'utf8'));
const DBF=path.join(DATA,'db.json');let db={codes:[],subs:[]};
try{db=JSON.parse(fs.readFileSync(DBF,'utf8'))}catch(e){}
db.codes=db.codes||[];db.subs=db.subs||[];
let timer=null;const flush=()=>{clearTimeout(timer);timer=null;const t=DBF+'.tmp';fs.writeFileSync(t,JSON.stringify(db));fs.renameSync(t,DBF)};
const save=()=>{if(!timer)timer=setTimeout(flush,150)};process.on('SIGINT',()=>{flush();process.exit()});process.on('SIGTERM',()=>{flush();process.exit()});
const norm=s=>String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
const rid=()=>crypto.randomBytes(16).toString('hex');
const AL='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?+=';
const gen=()=>Array.from(crypto.randomBytes(15),b=>AL[b%AL.length]).join('');
const TL=cfg.testMinutes*60000,GRACE=5000;
function pickVariant(){const use=Q.map(()=>0);db.codes.forEach(c=>(c.qs||[]).forEach(i=>use[i]++));
 const k=Math.min(cfg.questionsPerTest,Q.length),ord=Q.map((_,i)=>i).sort((a,b)=>use[a]-use[b]||crypto.randomInt(3)-1);
 const qs=ord.slice(0,k);for(let i=qs.length-1;i>0;i--){const j=crypto.randomInt(i+1);[qs[i],qs[j]]=[qs[j],qs[i]]}return qs}
function expire(s){if(s.status==='in_progress'&&Date.now()>s.deadline+GRACE){s.status='timeout';s.finished=s.deadline;save()}}
const stateOf=s=>{expire(s);return{token:s.id,nick:s.nick,status:s.status,i:s.i,total:s.qs.length,deadline:s.deadline,now:Date.now(),question:s.status==='in_progress'?Q[s.qs[s.i]]:null}};
// --- ограничение частоты ---
const hits=new Map();const limited=(req,key,max)=>{const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim(),k=key+ip,now=Date.now();let h=hits.get(k);if(!h||h.r<now)h={n:0,r:now+300000};h.n++;hits.set(k,h);return h.n>max};
// --- админ-сессии ---
const atok=new Map();const hash=s=>crypto.createHash('sha256').update(String(s)).digest();
const isAdmin=(req,u)=>{const t=req.headers['x-admin']||u.searchParams.get('t');const e=atok.get(t);return !!e&&e>Date.now()};
const send=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};
const body=req=>new Promise((ok,no)=>{let b='',n=0;req.on('data',c=>{n+=c.length;if(n>9e6){no(new Error('Слишком большой файл'));req.destroy()}else b+=c});req.on('end',()=>{try{ok(b?JSON.parse(b):{})}catch(e){no(new Error('Неверный запрос'))}});req.on('error',no)});
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml'};
async function api(req,res,u){const p=u.pathname.slice(5);
 if(req.method==='GET'&&p==='state'){const s=db.subs.find(x=>x.id===u.searchParams.get('token'));return s?send(res,200,stateOf(s)):send(res,404,{error:'Сессия не найдена'})}
 if(req.method==='GET'&&p.startsWith('admin/photo/')){if(!isAdmin(req,u))return send(res,401,{error:'Нет доступа'});const id=p.slice(12).replace(/[^a-f0-9]/g,''),f=path.join(PHOTOS,id+'.jpg');if(!fs.existsSync(f))return send(res,404,{error:'Нет фото'});res.writeHead(200,{'Content-Type':'image/jpeg'});return fs.createReadStream(f).pipe(res)}
 if(req.method==='GET'&&p==='admin/data'){if(!isAdmin(req,u))return send(res,401,{error:'Нет доступа'});db.subs.forEach(expire);
  return send(res,200,{codes:db.codes.map(c=>({id:c.id,n:c.n,nick:c.nick,code:c.code,used:!!c.used,usedAt:c.usedAt})),subs:db.subs.map(s=>({id:s.id,n:s.n,nick:s.nick,status:s.status,started:s.started,finished:s.finished,answers:s.answers,skipped:s.skipped,grades:s.grades,qs:s.qs.map(i=>Q[i])})).sort((a,b)=>b.started-a.started)})}
 if(req.method!=='POST')return send(res,404,{error:'Не найдено'});
 const b=await body(req);
 if(p==='register'){if(limited(req,'reg',12))return send(res,429,{error:'Слишком много попыток. Подождите несколько минут.'});
  const nick=String(b.nick||'').trim(),code=String(b.code||'').trim(),photo=String(b.photo||'');
  if(nick.length<2||nick.length>40||!code||!/^data:image\/(jpeg|png|webp);base64,/.test(photo))return send(res,400,{error:'Заполните все поля и приложите фотографию.'});
  const c=db.codes.find(x=>x.norm===norm(nick)&&x.code===code);if(!c)return send(res,400,{error:'Код недействителен для этого никнейма.'});
  if(c.used)return send(res,400,{error:'Код уже был использован и больше недействителен.'});
  const id=rid();c.used=true;c.usedAt=Date.now();
  try{fs.writeFileSync(path.join(PHOTOS,id+'.jpg'),Buffer.from(photo.split(',')[1],'base64'))}catch(e){c.used=false;delete c.usedAt;return send(res,500,{error:'Не удалось сохранить фото.'})}
  const now=Date.now(),s={id,n:c.n,codeId:c.id,nick,norm:norm(nick),status:'in_progress',started:now,deadline:now+TL,qs:c.qs,i:0,answers:{},skipped:[],grades:{}};db.subs.push(s);save();return send(res,200,stateOf(s))}
 if(p==='answer'||p==='finish'){const s=db.subs.find(x=>x.id===b.token);if(!s)return send(res,404,{error:'Сессия не найдена'});expire(s);
  if(s.status==='in_progress'){const t=String(b.text||'').trim().slice(0,6000);
   if(p==='answer'){if(b.skip)s.skipped.push(s.i+1);else if(t)s.answers['p'+(s.i+1)]=t;else return send(res,400,{error:'Введите ответ или нажмите «Пропустить».'});s.i++;if(s.i>=s.qs.length){s.status='completed';s.finished=Date.now()}}
   else{if(t&&Date.now()<=s.deadline+GRACE)s.answers['p'+(s.i+1)]=t;s.status='timeout';s.finished=Date.now()}save()}
  return send(res,200,stateOf(s))}
 if(p==='admin/login'){if(limited(req,'adm',10))return send(res,429,{error:'Слишком много попыток.'});const ok=crypto.timingSafeEqual(hash(b.code),hash(cfg.adminCode));if(!ok)return send(res,401,{error:'Неверный код.'});const t=rid();atok.set(t,Date.now()+12*3600000);return send(res,200,{token:t})}
 if(!isAdmin(req,u))return send(res,401,{error:'Нет доступа'});
 if(p==='admin/codes'){const added=[],skipped=[];for(const line of String(b.text||'').split('\n')){const l=line.trim();if(!l)continue;let nick=l,code='';const m=l.search(/[;\t=]/);if(m>0){nick=l.slice(0,m).trim();code=l.slice(m+1).trim()}
   if(nick.length<2||nick.length>40){skipped.push(l+' — некорректный никнейм');continue}
   if(db.codes.some(c=>c.norm===norm(nick))){skipped.push(nick+' — для этого ника код уже есть');continue}
   if(code&&code.length<6){skipped.push(nick+' — код короче 6 символов');continue}
   if(!code)code=gen();if(db.codes.some(c=>c.norm===norm(nick)&&c.code===code))continue;
   const n=db.codes.reduce((m,c)=>Math.max(m,c.n||0),0)+1;const c={id:rid(),n,nick,norm:norm(nick),code,qs:pickVariant(),created:Date.now()};db.codes.push(c);added.push({n,nick,code})}
  save();return send(res,200,{added,skipped})}
 if(p==='admin/code-delete'){db.codes=db.codes.filter(c=>c.id!==b.id);save();return send(res,200,{ok:1})}
 if(p==='admin/grade'){const s=db.subs.find(x=>x.id===b.id);if(!s)return send(res,404,{error:'Нет такого участника'});s.grades=s.grades||{};s.grades[b.pos]=b.val===1?1:0;save();return send(res,200,{ok:1})}
 send(res,404,{error:'Не найдено'})}
http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x');
 try{if(u.pathname.startsWith('/api/'))return await api(req,res,u);
  let f=path.normalize(path.join(PUB,u.pathname==='/'?'index.html':u.pathname));if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(PUB,'index.html');
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)}
 catch(e){send(res,400,{error:e.message||'Ошибка'})}}).listen(cfg.port,()=>console.log('HOSPITAL RPM: http://localhost:'+cfg.port));
