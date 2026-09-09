const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const DB_FILE = path.join(DATA_DIR, 'orbit.sqlite');
const KEY_FILES = { openai:path.join(DATA_DIR,'openai.key'), anthropic:path.join(DATA_DIR,'anthropic.key') };
const PROVIDER_FILE = path.join(DATA_DIR, 'provider.json');
let db;

const seedBoards = [
  { id:'ai', title:'AI', description:'Track important developments in AI.', icon:'✦' },
  { id:'finance', title:'Personal Investing', description:'Explore markets, products, and opportunities.', icon:'$' },
  { id:'photo', title:'Photography & Video', description:'Creative tools, cameras, workflows, and creator economy.', icon:'◉' }
];

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
  const count = db.prepare('SELECT COUNT(*) c FROM boards').get().c;
  if(Number(count)===0){
    const now=new Date().toISOString();
    const ins=db.prepare('INSERT INTO boards VALUES (?,?,?,?,?)');
    for(const b of seedBoards) ins.run(b.id,b.title,b.description,b.icon,now);
  }
  // Remove the old Adobe demo board from databases created by earlier prototypes.
  for(const table of ['goals','notes','intelligence','syntheses']) db.prepare(`DELETE FROM ${table} WHERE board_id=?`).run('adobe');
  db.prepare('DELETE FROM boards WHERE id=?').run('adobe');
}
function uid(prefix){return prefix+'_'+Math.random().toString(36).slice(2,10)}
function readData(){
  const boards=db.prepare('SELECT * FROM boards ORDER BY created_at').all();
  return {version:1,activeBoardId:boards[0]?.id||null,boards:boards.map(b=>({
    id:b.id,title:b.title,description:b.description,icon:b.icon,
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
    const up=db.prepare('INSERT INTO boards VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,icon=excluded.icon');
    for(const b of data.boards){
      seen.add(b.id);
      up.run(b.id,b.title,b.description,b.icon,new Date().toISOString());
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
async function callProvider({mode,board}){
  const cfg=getProvider();
  const provider=cfg.provider||'openai-compatible';
  const goals=board.goals.map(g=>`- ${g.title}: ${g.description} [${g.status}]`).join('\n')||'No goals defined.';
  const notes=board.notes.slice(-20).map(n=>`- ${n.text}`).join('\n')||'No scratchpad notes.';
  const intel=board.intelligence.slice(-10).map(i=>`- ${i.title}: ${i.summary}`).join('\n')||'No previous intelligence.';
  const prompt=mode==='research'
    ?`You are ORBIT, a personal intelligence analyst. Analyze this board and identify 3-5 meaningful signals. Avoid generic headlines. For each signal explain why it matters to the goals or, if there are no goals, why it matters to the board. End with a concise synthesis of what changed. IMPORTANT: only claim that you performed live web research if a live web-search tool is actually available in your runtime. If no live web search is available, clearly label the output as model-based analysis and do not fabricate current events, sources, dates, or browsing. Board: ${board.title}\nDescription: ${board.description}\nGoals:\n${goals}\nScratchpad:\n${notes}\nPrevious intelligence:\n${intel}`
    :`You are ORBIT, a strategic thinking partner. Update the board's living synthesis using goals, scratchpad notes and recent intelligence. Explain what changed, which goals are affected, and any emerging hypothesis. Do not invent facts. Board: ${board.title}\nDescription: ${board.description}\nGoals:\n${goals}\nScratchpad:\n${notes}\nRecent intelligence:\n${intel}`;
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
function createWindow(){const win=new BrowserWindow({width:1440,height:920,minWidth:1100,minHeight:720,backgroundColor:'#f7f9fc',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});win.loadFile(path.join(__dirname,'index.html'))}
app.whenReady().then(()=>{openDb();ipcMain.handle('data:get',()=>readData());ipcMain.handle('data:save',(_,d)=>saveData(d));ipcMain.handle('provider:get',()=>{const c=getProvider();return {provider:c.provider||'openai-compatible',ollama:{baseUrl:c.ollama?.baseUrl||'http://127.0.0.1:11434',model:c.ollama?.model||'qwen3:8b'},openaiCompatible:{baseUrl:normalizeOpenAICompatibleBaseUrl(c.openaiCompatible?.baseUrl||'http://127.0.0.1:1234'),model:c.openaiCompatible?.model||''},openai:{model:c.openai?.model||'gpt-5-mini',configured:Boolean(getApiKey('openai'))},anthropic:{model:c.anthropic?.model||'claude-sonnet-4-5',configured:Boolean(getApiKey('anthropic'))}}});ipcMain.handle('provider:set',(_,cfg)=>{setProvider(cfg);return getProvider()});ipcMain.handle('provider:test',async(_,cfg)=>{
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
});ipcMain.handle('key:set',(_,args)=>{setApiKey(args.provider,args.key);return{configured:true}});ipcMain.handle('key:getStatus',(_,provider)=>({configured:Boolean(getApiKey(provider))}));ipcMain.handle('ai:run',async(_,args)=>{const data=readData();const board=data.boards.find(b=>b.id===args.boardId);if(!board)throw new Error('Board not found');return callProvider({mode:args.mode,board})});ipcMain.handle('open:url',(_,url)=>{if(/^https?:\/\//.test(url))shell.openExternal(url)});createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()})});app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
