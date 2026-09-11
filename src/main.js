const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const DB_FILE = path.join(DATA_DIR, 'orbit.sqlite');
const KEY_FILES = { openai:path.join(DATA_DIR,'openai.key'), anthropic:path.join(DATA_DIR,'anthropic.key') };
const PROVIDER_FILE = path.join(DATA_DIR, 'provider.json');
const AUTO_FILE = path.join(DATA_DIR, 'auto-research.json');
const STARTER_GOALS_FILE = path.join(DATA_DIR, 'starter-goals-v1.json');
const AUTO_INTERVALS = [1, 3, 6, 12, 24];
let db;
let autoTimer;
let autoRunning = false;

const seedBoards = [
  { id:'ai', title:'AI', description:'Track important developments in AI.', icon:'✦' },
  { id:'finance', title:'Personal Investing', description:'Explore markets, products, and opportunities.', icon:'$' },
  { id:'photo', title:'Photography & Video', description:'Creative tools, cameras, workflows, and creator economy.', icon:'◉' }
];

const starterGoals = {
  ai: [
    { title:'Track major shifts in AI capabilities and products', description:'Identify meaningful advances in models, agents, multimodal AI, reasoning, and AI-native products that could change what is possible.' },
    { title:'Understand the infrastructure and economics behind AI', description:'Track developments in compute, chips, inference costs, data centers, energy, and model economics that could materially affect the AI landscape.' },
    { title:'Identify regulatory, business, and societal shifts that could reshape AI', description:'Follow important developments in regulation, enterprise adoption, monetization, safety, and competitive dynamics that could change the trajectory of AI.' }
  ],
  finance: [
    { title:'Understand the forces driving markets and the economy', description:'Track major developments in interest rates, inflation, employment, economic growth, and liquidity that could materially affect markets.' },
    { title:'Identify important changes in companies and industries', description:'Surface developments in technology, competition, regulation, earnings, and business models that could create meaningful opportunities or risks.' },
    { title:'Discover long-term investment themes before they become consensus', description:'Look for structural trends, emerging technologies, and changing consumer or business behavior that could create significant opportunities over a multi-year horizon.' }
  ],
  photo: [
    { title:'Discover techniques that meaningfully improve photography and visual storytelling', description:'Find practical advances in composition, lighting, color, shooting techniques, and visual storytelling that can improve creative results.' },
    { title:'Track meaningful advances in cameras, lenses, and imaging technology', description:'Identify new technology and products that materially change image quality, workflow, or creative possibilities.' },
    { title:'Explore better creative and AI-powered photography/video workflows', description:'Track tools and techniques for editing, organization, post-production, generative AI, and automation that can make the creative process more powerful or efficient.' }
  ]
};

function openDb(){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  db = new DatabaseSync(DB_FILE);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,icon TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,board_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,board_id TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intelligence(id TEXT PRIMARY KEY,board_id TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,source TEXT NOT NULL,url TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS syntheses(id TEXT PRIMARY KEY,board_id TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
  try { db.exec('ALTER TABLE boards ADD COLUMN auto_research_enabled INTEGER NOT NULL DEFAULT 1'); } catch (e) {
    if (!String(e.message).includes('duplicate column')) throw e;
  }
  const count = db.prepare('SELECT COUNT(*) c FROM boards').get().c;
  if(Number(count)===0){
    const now=new Date().toISOString();
    const ins=db.prepare('INSERT INTO boards VALUES (?,?,?,?,?,?)');
    for(const b of seedBoards) ins.run(b.id,b.title,b.description,b.icon,now,1);
  }
  // Remove the old Adobe demo board from databases created by earlier prototypes.
  for(const table of ['goals','notes','intelligence','syntheses']) db.prepare(`DELETE FROM ${table} WHERE board_id=?`).run('adobe');
  db.prepare('DELETE FROM boards WHERE id=?').run('adobe');

  // Give the three built-in example boards meaningful starter goals once.
  // This is intentionally a one-time migration so a user who later removes
  // all goals is not surprised by them being recreated on every launch.
  if(!fs.existsSync(STARTER_GOALS_FILE)){
    const now=new Date().toISOString();
    const addGoal=db.prepare('INSERT INTO goals VALUES (?,?,?,?,?,?,?,?)');
    for(const [boardId, goals] of Object.entries(starterGoals)){
      const board=db.prepare('SELECT id FROM boards WHERE id=?').get(boardId);
      const existing=db.prepare('SELECT COUNT(*) c FROM goals WHERE board_id=?').get(boardId)?.c||0;
      if(board && Number(existing)===0){
        goals.forEach((g,i)=>addGoal.run(uid('g'),boardId,g.title,g.description,'Exploring',i,now,now));
      }
    }
    fs.writeFileSync(STARTER_GOALS_FILE,JSON.stringify({version:1,createdAt:now},null,2));
  }
}
function uid(prefix){return prefix+'_'+Math.random().toString(36).slice(2,10)}
function readData(){
  const boards=db.prepare('SELECT * FROM boards ORDER BY created_at').all();
  return {version:1,activeBoardId:boards[0]?.id||null,boards:boards.map(b=>({
    id:b.id,title:b.title,description:b.description,icon:b.icon,autoResearchEnabled:b.auto_research_enabled!==0,
    goals:db.prepare('SELECT id,title,description,status,position FROM goals WHERE board_id=? ORDER BY position').all(b.id),
    notes:db.prepare('SELECT id,text,created_at createdAt FROM notes WHERE board_id=? ORDER BY created_at').all(b.id),
    intelligence:db.prepare('SELECT id,title,summary,source,url,created_at createdAt FROM intelligence WHERE board_id=? ORDER BY created_at').all(b.id),
    synthesis:(db.prepare('SELECT content FROM syntheses WHERE board_id=? ORDER BY created_at DESC LIMIT 1').get(b.id)?.content)||'No synthesis yet.',
    questions:[]
  }))};
}
function saveData(data){
  // DatabaseSync does not expose better-sqlite3's db.transaction() helper.
  // Use SQLite's native transaction statements so this works reliably with
  // Electron's bundled Node runtime.
  db.exec('BEGIN IMMEDIATE');
  try{
    const existing=new Set(db.prepare('SELECT id FROM boards').all().map(x=>x.id));
    const seen=new Set();
    const up=db.prepare('INSERT INTO boards(id,title,description,icon,created_at,auto_research_enabled) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,icon=excluded.icon,auto_research_enabled=excluded.auto_research_enabled');
    for(const b of data.boards){
      seen.add(b.id);
      up.run(b.id,b.title,b.description,b.icon,new Date().toISOString(),b.autoResearchEnabled===false?0:1);
      db.prepare('DELETE FROM goals WHERE board_id=?').run(b.id);
      const gi=db.prepare('INSERT INTO goals VALUES (?,?,?,?,?,?,?,?)');
      (b.goals||[]).forEach((g,i)=>gi.run(g.id,b.id,g.title,g.description,g.status||'Exploring',i,g.createdAt||new Date().toISOString(),new Date().toISOString()));
      db.prepare('DELETE FROM notes WHERE board_id=?').run(b.id);
      const ni=db.prepare('INSERT INTO notes VALUES (?,?,?,?)');
      (b.notes||[]).forEach(n=>ni.run(n.id,b.id,n.text,n.createdAt||new Date().toISOString()));
      db.prepare('DELETE FROM intelligence WHERE board_id=?').run(b.id);
      const ii=db.prepare('INSERT INTO intelligence VALUES (?,?,?,?,?,?,?)');
      (b.intelligence||[]).forEach(i=>ii.run(i.id,b.id,i.title,i.summary,i.source||'ORBIT',i.url||null,i.createdAt||new Date().toISOString()));
      db.prepare('DELETE FROM syntheses WHERE board_id=?').run(b.id);
      db.prepare('INSERT INTO syntheses VALUES (?,?,?,?)').run(uid('s'),b.id,b.synthesis||'No synthesis yet.',new Date().toISOString());
    }
    for(const id of existing){
      if(!seen.has(id)){
        db.prepare('DELETE FROM goals WHERE board_id=?').run(id);
        db.prepare('DELETE FROM notes WHERE board_id=?').run(id);
        db.prepare('DELETE FROM intelligence WHERE board_id=?').run(id);
        db.prepare('DELETE FROM syntheses WHERE board_id=?').run(id);
        db.prepare('DELETE FROM boards WHERE id=?').run(id);
      }
    }
    db.exec('COMMIT');
    return data;
  }catch(e){
    try{db.exec('ROLLBACK')}catch{}
    throw e;
  }
}
function getProvider(){
  try{
    const cfg=JSON.parse(fs.readFileSync(PROVIDER_FILE,'utf8'));
    // Older ORBIT builds defaulted to Ollama even when the user configured LM Studio.
    // If an OpenAI-compatible local runtime is configured but has no model yet,
    // carry over the previously entered local model and make LM Studio active.
    if(cfg.provider==='ollama' && cfg.openaiCompatible?.baseUrl?.includes('/v1')){
      cfg.openaiCompatible.model=cfg.openaiCompatible.model||cfg.ollama?.model||'';
      cfg.provider='openai-compatible';
      fs.writeFileSync(PROVIDER_FILE,JSON.stringify(cfg,null,2));
    }
    return {
      provider:cfg.provider||'openai-compatible',
      ollama:{baseUrl:cfg.ollama?.baseUrl||'http://127.0.0.1:11434',model:cfg.ollama?.model||'qwen3:8b'},
      openaiCompatible:{baseUrl:normalizeOpenAICompatibleBaseUrl(cfg.openaiCompatible?.baseUrl||'http://127.0.0.1:1234'),model:cfg.openaiCompatible?.model||''},
      openai:{model:cfg.openai?.model||'gpt-5-mini'},
      anthropic:{model:cfg.anthropic?.model||'claude-sonnet-4-5'}
    };
  }catch{return {provider:'openai-compatible',ollama:{baseUrl:'http://127.0.0.1:11434',model:'qwen3:8b'},openaiCompatible:{baseUrl:'http://127.0.0.1:1234/v1',model:''},openai:{model:'gpt-5-mini'},anthropic:{model:'claude-sonnet-4-5'}}}
}
function setProvider(cfg){
  const next={...cfg,openaiCompatible:{...(cfg.openaiCompatible||{})}};
  next.openaiCompatible.baseUrl=normalizeOpenAICompatibleBaseUrl(next.openaiCompatible.baseUrl||'http://127.0.0.1:1234');
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(PROVIDER_FILE,JSON.stringify(next,null,2));
}
function getApiKey(provider){const file=KEY_FILES[provider];if(!file||!fs.existsSync(file))return '';try{return safeStorage.isEncryptionAvailable()?safeStorage.decryptString(fs.readFileSync(file)):fs.readFileSync(file,'utf8')}catch{return ''}}
function setApiKey(provider,key){const file=KEY_FILES[provider];if(!file)throw new Error('Unsupported provider');fs.mkdirSync(DATA_DIR,{recursive:true});fs.writeFileSync(file,safeStorage.isEncryptionAvailable()?safeStorage.encryptString(key):Buffer.from(key))}
function outputText(response){if(response.output_text)return response.output_text;let out='';for(const item of (response.output||[])){for(const c of (item.content||[])){if(c.type==='output_text')out+=c.text}}return out||JSON.stringify(response)}
function normalizeOpenAICompatibleBaseUrl(value){
  let base=(value||'http://127.0.0.1:1234').trim().replace(/\/+$/,'');
  if(!/\/v1$/i.test(base)) base+='/v1';
  return base;
}
function autoConfig(){
  try { return JSON.parse(fs.readFileSync(AUTO_FILE,'utf8')); }
  catch { return {enabled:true,intervalHours:6,lastRunAt:null}; }
}
function setAutoConfig(cfg){
  const next={...autoConfig(),...cfg};
  if(!AUTO_INTERVALS.includes(Number(next.intervalHours))) next.intervalHours=6;
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(AUTO_FILE,JSON.stringify(next,null,2));
  return next;
}
function getAutoStatus(){
  const c=autoConfig();
  return {enabled:c.enabled!==false,intervalHours:Number(c.intervalHours)||6,lastRunAt:c.lastRunAt||null,running:autoRunning};
}

async function callProvider({mode,board}){
  const cfg=getProvider();
  const provider=cfg.provider||'openai-compatible';
  const goals=board.goals.map(g=>`- ${g.title}: ${g.description} [${g.status}]`).join('\n')||'No goals defined.';
  const notes=board.notes.slice(-20).map(n=>`- ${n.text}`).join('\n')||'No scratchpad notes.';
  const intel=board.intelligence.slice(-10).map(i=>`- ${i.title}: ${i.summary}`).join('\n')||'No previous intelligence.';
  const synthesis=board.synthesis||'No synthesis yet.';
  const prompt=mode==='research'
    ?`You are ORBIT, a personal intelligence system. Do not ask the user what to research. Independently determine what is most worth investigating now from this board's goals, description, scratchpad, existing intelligence, and living synthesis. Prioritize meaningful developments, evidence, trends, contradictions, risks, opportunities, or changes that could alter understanding. Look for genuinely new information relative to existing intelligence. If there is no meaningful new information worth adding, return exactly NO_NEW_INTELLIGENCE. Otherwise provide 3-5 concise signals with a title, what changed, why it matters, and a source/URL only when a live source was actually consulted. Never fabricate browsing, sources, dates, or events. This may be an automatic background cycle; be selective and add nothing when there is no meaningful new intelligence.\nBOARD: ${board.title}\nDESCRIPTION: ${board.description}\nGOALS:\n${goals}\nSCRATCHPAD:\n${notes}\nCURRENT SYNTHESIS:\n${synthesis}\nPREVIOUS INTELLIGENCE:\n${intel}`
    :`You are ORBIT, a strategic thinking partner. Update the board's living synthesis using goals, scratchpad notes, recent intelligence, and the prior synthesis. Explain what changed, which goals are affected, and any emerging or weakened hypothesis. Do not invent facts. Board: ${board.title}\nDescription: ${board.description}\nGoals:\n${goals}\nScratchpad:\n${notes}\nRecent intelligence:\n${intel}\nPrevious synthesis:\n${synthesis}`;
  if(provider==='ollama'){
    const base=(cfg.ollama?.baseUrl||'http://127.0.0.1:11434').replace(/\/$/,'');
    const r=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:cfg.ollama?.model||'qwen3:8b',messages:[{role:'user',content:prompt}],stream:false,options:{temperature:0.3}})});
    if(!r.ok)throw new Error(`Ollama error ${r.status}: ${await r.text()}`); const j=await r.json(); return j.message?.content||'';
  }
  if(provider==='openai-compatible'){
    const base=normalizeOpenAICompatibleBaseUrl(cfg.openaiCompatible?.baseUrl||'http://127.0.0.1:1234');
    const model=cfg.openaiCompatible?.model||'';
    if(!model)throw new Error('Set a local model name in Settings first.');
    const r=await fetch(base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0.3,stream:false})});
    if(!r.ok)throw new Error(`Local OpenAI-compatible error ${r.status}: ${await r.text()}`);
    const j=await r.json(); return j.choices?.[0]?.message?.content||'';
  }
  if(provider==='openai'){
    const key=getApiKey('openai');if(!key)throw new Error('Add your OpenAI API key in Settings first.');
    const body={model:cfg.openai?.model||'gpt-5-mini',input:prompt};if(mode==='research')body.tools=[{type:'web_search'}];
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify(body)});
    if(!r.ok)throw new Error(`OpenAI API error ${r.status}: ${await r.text()}`);return outputText(await r.json());
  }
  if(provider==='anthropic'){
    const key=getApiKey('anthropic');if(!key)throw new Error('Add your Anthropic API key in Settings first.');
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:cfg.anthropic?.model||'claude-sonnet-4-5',max_tokens:3000,messages:[{role:'user',content:prompt}]})});
    if(!r.ok)throw new Error(`Anthropic API error ${r.status}: ${await r.text()}`);const j=await r.json();return (j.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
  }
  throw new Error('Choose an AI provider in Settings.');
}
async function automaticResearchCycle(){
  if(autoRunning) return {ran:false,reason:'already-running'};
  const cfg=autoConfig();
  if(cfg.enabled===false) return {ran:false,reason:'disabled'};
  autoRunning=true;
  try {
    const data=readData(); let processed=0;
    for(const board of data.boards){
      if(board.autoResearchEnabled===false || board.goals.length===0) continue;
      const text=await callProvider({mode:'research',board});
      if(!text || text.trim()==='NO_NEW_INTELLIGENCE') continue;
      const now=new Date().toISOString();
      const provider=getProvider().provider;
      const source=provider==='openai'?'ORBIT · web research':provider==='anthropic'?'ORBIT · automatic analysis':'ORBIT · automatic analysis (local model; no live web search)';
      db.prepare('INSERT INTO intelligence VALUES (?,?,?,?,?,?,?)').run(uid('i'),board.id,'ORBIT automatic research',text,source,null,now);
      const fresh=readData().boards.find(x=>x.id===board.id);
      if(fresh){
        const syn=await callProvider({mode:'synthesis',board:fresh});
        db.prepare('DELETE FROM syntheses WHERE board_id=?').run(board.id);
        db.prepare('INSERT INTO syntheses VALUES (?,?,?,?)').run(uid('s'),board.id,syn||fresh.synthesis,new Date().toISOString());
      }
      processed++;
    }
    const next=setAutoConfig({lastRunAt:new Date().toISOString()});
    return {ran:true,processed,lastRunAt:next.lastRunAt};
  } finally { autoRunning=false; }
}
function startAutoResearch(){
  clearInterval(autoTimer);
  const tick=async()=>{
    const c=autoConfig(); if(c.enabled===false||autoRunning) return;
    const last=c.lastRunAt?new Date(c.lastRunAt).getTime():0;
    const due=!last || Date.now()-last>=Number(c.intervalHours||6)*3600000;
    if(due){try{await automaticResearchCycle()}catch(e){console.error('ORBIT automatic research failed:',e.message)}}
  };
  setTimeout(tick,15000);
  autoTimer=setInterval(tick,5*60*1000);
}

function createWindow(){const win=new BrowserWindow({width:1440,height:920,minWidth:1100,minHeight:720,backgroundColor:'#f7f9fc',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});win.loadFile(path.join(__dirname,'index.html'))}
app.whenReady().then(()=>{openDb();ipcMain.handle('data:get',()=>readData());ipcMain.handle('data:save',(_,d)=>saveData(d));
  ipcMain.handle('auto:get',()=>getAutoStatus());
  ipcMain.handle('auto:set',(_,cfg)=>{const next=setAutoConfig(cfg);startAutoResearch();return {enabled:next.enabled!==false,intervalHours:Number(next.intervalHours)||6,lastRunAt:next.lastRunAt||null,running:autoRunning};});
  ipcMain.handle('auto:run',()=>automaticResearchCycle());ipcMain.handle('provider:get',()=>{const c=getProvider();return {provider:c.provider||'openai-compatible',ollama:{baseUrl:c.ollama?.baseUrl||'http://127.0.0.1:11434',model:c.ollama?.model||'qwen3:8b'},openaiCompatible:{baseUrl:normalizeOpenAICompatibleBaseUrl(c.openaiCompatible?.baseUrl||'http://127.0.0.1:1234'),model:c.openaiCompatible?.model||''},openai:{model:c.openai?.model||'gpt-5-mini',configured:Boolean(getApiKey('openai'))},anthropic:{model:c.anthropic?.model||'claude-sonnet-4-5',configured:Boolean(getApiKey('anthropic'))}}});ipcMain.handle('provider:set',(_,cfg)=>{setProvider(cfg);return getProvider()});ipcMain.handle('provider:test',async(_,cfg)=>{
  const prev=getProvider();
  try{
    setProvider(cfg);
    const testBoard={title:'Connection test',description:'Return a short confirmation that the connection works.',goals:[],notes:[],intelligence:[]};
    const text=await Promise.race([
      callProvider({mode:'synthesis',board:testBoard}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('Connection timed out after 20 seconds.')),20000))
    ]);
    return {ok:true,preview:(text||'Connected').slice(0,160)};
  }catch(e){return {ok:false,error:e.message}}
  finally{setProvider(prev)}
});ipcMain.handle('key:set',(_,args)=>{setApiKey(args.provider,args.key);return{configured:true}});ipcMain.handle('key:getStatus',(_,provider)=>({configured:Boolean(getApiKey(provider))}));ipcMain.handle('ai:run',async(_,args)=>{const data=readData();const board=data.boards.find(b=>b.id===args.boardId);if(!board)throw new Error('Board not found');return callProvider({mode:args.mode,board})});ipcMain.handle('open:url',(_,url)=>{if(/^https?:\/\//.test(url))shell.openExternal(url)});createWindow();startAutoResearch();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()})});app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
