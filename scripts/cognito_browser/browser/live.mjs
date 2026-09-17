import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { setDefaultResultOrder } from 'node:dns'
import { chromium } from '@playwright/test'

const bundle = JSON.parse(await readFile('/run/fixture.json','utf8'))
// Docker's localhost IPv6 entry can disagree with Node's connect-family choice.
// Bind only IPv4 loopback and resolve localhost consistently; OAuth still uses localhost.
setDefaultResultOrder('ipv4first')
const base = 'http://localhost:4174'
const api = 'http://localhost:4175'
const domain = `https://${bundle.domain}.auth.ca-central-1.amazoncognito.com`
const wait = ms => new Promise(resolve => setTimeout(resolve,ms))
let phase = 'boot', browser, server, gateway, page
let startupLog = ''
const preflight = process.env.QUIZFORGE_PREFLIGHT === '1'
const watchdog = setTimeout(()=>{ console.error('ERROR: rehearsal exceeded five minutes in '+phase); process.exit(1) },300000)

function totp(secret) {
  let bits = ''
  for (const char of secret.replace(/=+$/,'')) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5,'0')
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b,2)))
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)))
  const digest = createHmac('sha1',key).update(counter).digest(), offset = digest.at(-1)&15
  return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0')
}
async function request(context,path,token,method='GET',data) {
  return context.request.fetch(api+path,{method,headers:{Origin:base,...(token?{Authorization:'Bearer '+token}:{})},data})
}
async function login(name) {
  phase = name + ': login page'
  const user = bundle.users[name]
  const context = await browser.newContext()
  context.setDefaultTimeout(30000)
  page = await context.newPage()
  let authorization, exchange, tokens
  page.on('request',r => {
    const url = new URL(r.url())
    if (url.origin === domain && url.pathname === '/oauth2/authorize') authorization = url.searchParams
    if (url.origin === domain && url.pathname === '/oauth2/token' && r.method()==='POST') exchange = new URLSearchParams(r.postData())
  })
  page.on('response', async response => {
    if (response.url()===domain+'/oauth2/token' && response.request().method()==='POST' && response.status()===200)
      tokens = await response.json()
  })
  await page.goto(base)
  await page.getByRole('button',{name:'Sign in or create account'}).click()
  await page.locator('input[name="username"]:visible').fill(user.email)
  await page.locator('input[name="password"]:visible').fill(user.password)
  await page.locator('input[name="signInSubmitButton"]:visible,button[name="signInSubmitButton"]:visible').click()
  phase = name + ': mandatory TOTP'
  const code = page.locator('input[name="totpCode"]:visible')
  await code.waitFor({state:'visible',timeout:30000})
  // Never reuse the setup OTP or submit at the end of a 30-second period.
  if (Math.floor(Date.now()/30000) <= Math.floor(user.enrolled_at/30) || Date.now()%30000 > 25000)
    await wait(31000-Date.now()%30000)
  await code.fill(totp(user.totp))
  await page.locator('input[type="submit"]:visible,button[type="submit"]:visible').click()
  await page.waitForURL(url => url.origin===base,{timeout:60000})
  for(let n=0;!tokens&&n<100;n++) await wait(100)
  assert(tokens?.access_token)
  assert.equal(authorization.get('response_type'),'code')
  assert.equal(authorization.get('code_challenge_method'),'S256')
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'),authorization.get('code_challenge'))
  assert.equal(JSON.parse(Buffer.from(tokens.id_token.split('.')[1],'base64url')).nonce,authorization.get('nonce'))
  return {context,page,tokens}
}
const entry = {quiz_title:'Live Cognito browser rehearsal',source_filename:'synthetic.pdf',document_sha256:'b'.repeat(64),
  difficulty:'easy',question_type:'multiple_choice',question_count:5,score:4,percentage:80,quiz_data:{questions:[]},selected_answers:{'0':1}}
try {
  for(const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','PGPASSWORD']) assert(!process.env[key])
  // A separate origin preserves real browser CORS/Origin behavior. Never inject
  // an Origin header: the identity broker must validate what the browser sends.
  gateway = createServer((incoming,outgoing) => {
    const identity = incoming.url.startsWith('/identity/')
    if(!identity && !incoming.url.startsWith('/api/')) { outgoing.writeHead(404); outgoing.end(); return }
    const upstream = httpRequest({hostname:identity?'identity':'api',port:identity?8001:8000,
      path:incoming.url,method:incoming.method,headers:incoming.headers},response => {
      outgoing.writeHead(response.statusCode,response.headers); response.pipe(outgoing)
    })
    upstream.on('error',()=>{ if(!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(upstream)
  })
  await new Promise(resolve=>gateway.listen(4175,'127.0.0.1',resolve))
  server = spawn(process.execPath,['/app/frontend/node_modules/vite/bin/vite.js','--configLoader','runner','--config','/app/frontend/.rehearsal-vite.config.mjs'],{
    stdio:['ignore','pipe','pipe'],env:{...process.env,VITE_AUTH_PROVIDER:'cognito',VITE_COGNITO_STAGING:'true',VITE_COGNITO_USER_POOL_ID:bundle.pool,
      VITE_COGNITO_CLIENT_ID:bundle.client,VITE_COGNITO_DOMAIN:domain,VITE_API_URL:api,VITE_IDENTITY_API_URL:api,
      VITE_SUPABASE_URL:'',VITE_SUPABASE_PUBLISHABLE_KEY:''}})
  for(const stream of [server.stdout,server.stderr]) stream.on('data',chunk=>{ if(phase==='boot') startupLog=(startupLog+chunk.toString()).slice(-12000) })
  const deadline = Date.now()+120000
  let ready=false, frontendStatus=0, apiStatus=0, frontendError='', apiError=''
  while(Date.now()<deadline) {
    if(server.exitCode!==null) throw new Error('Frontend exited')
    try { frontendStatus=(await fetch(base,{signal:AbortSignal.timeout(5000)})).status } catch(e) { frontendError=e.cause?.code||e.name }
    try { apiStatus=(await fetch(api+'/api/health',{signal:AbortSignal.timeout(5000)})).status } catch(e) { apiError=e.cause?.code||e.name }
    if(frontendStatus===200&&apiStatus===200) { ready=true; break }
    await wait(2000)
  }
  console.log(`Readiness: frontend HTTP ${frontendStatus}; API HTTP ${apiStatus}; frontend exit ${server.exitCode}; connection codes ${frontendError}/${apiError}`)
  assert(ready)
  browser = await chromium.launch({headless:true})
  if(preflight) {
    phase='offline sign-in screen'
    const context=await browser.newContext(); context.setDefaultTimeout(30000)
    page=await context.newPage(); await page.goto(base)
    await page.getByRole('button',{name:'Sign in or create account'}).waitFor()
    assert.equal((await request(context,'/identity/session')).status(),401)
    console.log('PASS: read-only non-root frontend, API, TLS history database and enrollment broker boot without AWS or provider requests')
  } else {
  const mapped = await login('mapped')
  phase = 'mapped: real protected history'
  await mapped.page.getByRole('button',{name:'My Quiz History',exact:false}).click()
  await mapped.page.getByText('No saved quizzes yet').waitFor()
  for(const token of ['', 'invalid', mapped.tokens.id_token,bundle.users.mapped.fixture_access])
    assert.equal((await request(mapped.context,'/api/quiz-history',token)).status(),401)
  let result = await request(mapped.context,'/api/quiz-history',mapped.tokens.access_token,'POST',entry)
  assert.equal(result.status(),201)
  result = await request(mapped.context,'/api/quiz-history',mapped.tokens.access_token)
  const saved = (await result.json()).items[0]
  assert.equal(saved.user_id,'00000000-0000-0000-0000-000000000003')
  console.log('PASS: live hosted login and mandatory TOTP, OAuth PKCE/nonce, backend JWT/GetUser and protected history CRUD')

  const fresh = await login('unmapped')
  phase = 'unmapped: explicit enrollment'
  await fresh.page.getByRole('heading',{name:'Set up your staging account'}).waitFor()
  assert.equal((await request(fresh.context,'/api/quiz-history',fresh.tokens.access_token)).status(),403)
  await fresh.page.getByLabel('Account setup',{exact:true}).selectOption('enroll')
  await fresh.page.getByRole('button',{name:'Continue account setup'}).click()
  await fresh.page.getByRole('button',{name:'Confirm account setup'}).click()
  await fresh.page.getByRole('button',{name:'My Quiz History',exact:false}).click()
  await fresh.page.getByText('No saved quizzes yet').waitFor()
  assert.equal((await request(fresh.context,'/api/quiz-history/'+saved.id,fresh.tokens.access_token,'DELETE')).status(),204)
  assert.equal((await (await request(mapped.context,'/api/quiz-history',mapped.tokens.access_token)).json()).totalCount,1)
  assert.equal((await request(mapped.context,'/api/quiz-history/'+saved.id,mapped.tokens.access_token,'DELETE')).status(),204)
  const storage = await fresh.page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))
  assert(!storage.includes(fresh.tokens.access_token)&&!storage.includes('code_verifier'))
  console.log('PASS: unmapped Cognito identity denied, explicit one-use enrollment succeeds, foreign history stays inaccessible, tokens remain out of browser storage')

  const unverified = await login('unverified')
  phase = 'unverified: denial and logout'
  assert.equal((await request(unverified.context,'/identity/session',unverified.tokens.access_token)).status(),403)
  assert.equal((await request(unverified.context,'/api/quiz-history',unverified.tokens.access_token)).status(),403)
  await fresh.page.getByRole('button',{name:'Sign out',exact:true}).click()
  await fresh.page.getByRole('button',{name:'Sign in or create account'}).waitFor()
  assert.equal((await request(fresh.context,'/api/quiz-history',fresh.tokens.access_token)).status(),401)
  console.log('PASS: unverified email denied; hosted logout revokes the previously used access session')
  console.log('PASS: live Cognito browser rehearsal complete; no OpenAI requests or production services used')
  }
} catch(error) {
  // Playwright exceptions can contain entered values/URLs. Never emit them or a trace.
  console.error(`ERROR: live browser rehearsal failed in ${phase} (${error.constructor.name})`)
  if(preflight&&phase==='boot') console.error('Offline frontend startup:',startupLog)
  if(page) console.error('Visible input schema:',JSON.stringify(await page.locator('input:visible').evaluateAll(nodes=>nodes.map(n=>({name:n.name,type:n.type,id:n.id}))).catch(()=>[])))
  process.exitCode=1
} finally {
  clearTimeout(watchdog); await browser?.close(); server?.kill('SIGTERM'); gateway?.close()
}
