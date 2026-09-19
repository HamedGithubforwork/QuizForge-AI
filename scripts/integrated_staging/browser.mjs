// Trusted driver; no mocks, local proxy, AWS credentials, trace or token logs.
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chromium, request as http, expect } from '@playwright/test'
const bundle=JSON.parse(await readFile('/run/fixture.json','utf8'))
const base=bundle.frontend_url, api=bundle.api_url
const domain=`https://${bundle.domain}.auth.ca-central-1.amazoncognito.com`
assert.match(base,/^https:\/\/[a-z0-9]+\.cloudfront\.net$/)
assert.equal(api,'https://staging-api.quizfromnotes.com')
assert.match(domain,/^https:\/\/quizforge-integrated-[0-9]{12}\.auth\.ca-central-1\.amazoncognito\.com$/)
assert(Date.parse(bundle.deadline)>Date.now())
for(const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','PGPASSWORD']) assert(!process.env[key])
const wait=ms=>new Promise(r=>setTimeout(r,ms))
let browser, page, phase='hosting and TLS', client
const watchdog=setTimeout(()=>{console.error('ERROR: integrated browser timed out in '+phase);process.exit(1)},540000)
function totp(secret) {
  let bits = ''
  for (const char of secret.replace(/=+$/,'')) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5,'0')
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b,2)))
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)))
  const digest = createHmac('sha1',key).update(counter).digest(), offset = digest.at(-1)&15
  return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0')
}
// Execute from the real CloudFront page: browser enforces CORS and CSP.
async function request(context,path,token,method='GET',data) {
  const originPage=context.pages().find(p=>new URL(p.url()).origin===base)
  assert(originPage)
  const r=await originPage.evaluate(async ({api,path,token,method,data})=>{
    const response=await fetch(api+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined})
    return {status:response.status,text:await response.text()}
  },{api,path,token,method,data})
  return {status:()=>r.status,json:async()=>JSON.parse(r.text)}
}
async function login(name, context, userOverride) {
  phase = name + ': login page'
  const user = userOverride || bundle.users[name]
  context ||= await browser.newContext()
  context.setDefaultTimeout(30000)
  await context.addInitScript(()=>{
    window.integrationCsp=[]
    document.addEventListener('securitypolicyviolation',e=>window.integrationCsp.push(e.violatedDirective))
  })
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
  const code = page.locator('input[name="authentication_code"][id="totpCodeInput"]:visible')
  await code.waitFor({state:'visible',timeout:30000})
  // Never reuse the setup OTP or submit at the end of a 30-second period.
  if (Math.floor(Date.now()/30000) <= Math.floor(user.enrolled_at/30) || Date.now()%30000 > 25000)
    await wait(31000-Date.now()%30000)
  await code.fill(totp(user.totp))
  user.enrolled_at = Math.floor(Date.now()/1000)
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

async function rejectedRefresh(context, token) {
  const response = await context.request.post(domain+'/oauth2/token', {
    form:{grant_type:'refresh_token',client_id:bundle.client,refresh_token:token}
  })
  assert.equal(response.status(),400)
  assert.equal((await response.json()).error,'invalid_grant')
}
function unexpired(token) {
  assert(JSON.parse(Buffer.from(token.split('.')[1],'base64url')).exp*1000-Date.now()>60000)
}
async function logout(session, user) {
  phase='hosted logout and cookie clearance'
  // Establish both a live API session and a provider cookie before signing out.
  unexpired(session.tokens.access_token)
  assert.equal((await request(session.context,'/api/quiz-history',session.tokens.access_token)).status(),200)
  assert((await session.context.cookies(domain)).some(c=>c.name==='cognito'&&c.value))
  const navigation = session.page.waitForRequest(r=>new URL(r.url()).origin===domain&&new URL(r.url()).pathname==='/logout')
  await session.page.getByRole('button',{name:'Sign out',exact:true}).click()
  const target = new URL((await navigation).url())
  assert.equal(target.searchParams.get('client_id'),bundle.client)
  assert.equal(target.searchParams.get('logout_uri'),base+'/')
  await session.page.getByRole('button',{name:'Sign in or create account'}).waitFor()
  assert(!(await session.context.cookies(domain)).some(c=>c.name==='cognito'&&c.value))
  assert.equal((await request(session.context,'/api/quiz-history',session.tokens.access_token)).status(),401)
  await rejectedRefresh(session.context,session.tokens.refresh_token)
  unexpired(session.tokens.access_token)
  // Same browser context: a surviving provider cookie would skip the required
  // visible password and MFA fields and make login fail, never silently pass.
  const again = await login('mapped',session.context,user)
  assert.equal((await request(again.context,'/api/quiz-history',again.tokens.access_token)).status(),200)
  console.log('PASS: hosted logout clears the provider cookie, revokes fresh access/refresh tokens, and same-browser sign-in requires password plus existing TOTP')
}

async function fullQuiz(session) {
  page=session.page
  phase='PDF upload and document cache'
  const pdf=Buffer.from(bundle.pdf,'base64')
  const sha=createHash('sha256').update(pdf).digest('hex')
  await page.locator('input[type="file"]').setInputFiles({name:'integrated-water-cycle.pdf',mimeType:'application/pdf',buffer:pdf})
  let document
  for(let n=0;n<2;n++) {
    const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/documents/upload'&&r.request().method()==='POST')
    await page.getByRole('button',{name:'Process PDF',exact:true}).click()
    const response=await pending
    assert.equal(response.status(),200)
    const data=await response.json()
    assert.equal(data.pdf_sha256,sha); assert.equal(data.page_count,1)
    assert(data.character_count>400 && !data.scanned_likely)
    if(document) assert.deepEqual(data,document)
    document=data
    await page.getByRole('heading',{name:'PDF processed successfully'}).waitFor()
  }
  phase='bounded real quiz generation'
  await page.getByLabel('Number of questions',{exact:true}).selectOption('5')
  await page.getByLabel('Difficulty',{exact:true}).selectOption('easy')
  await page.getByLabel('Question type',{exact:true}).selectOption('multiple_choice')
  const generation=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quizzes/generate'&&r.request().method()==='POST',{timeout:240000})
  await page.getByRole('button',{name:'Generate Quiz',exact:true}).click()
  const response=await generation
  assert.equal(response.status(),200)
  const quiz=await response.json()
  assert.equal(quiz.questions.length,5)
  await page.getByRole('heading',{name:quiz.title,exact:true}).waitFor()
  phase='answering, grading and source-page retrieval'
  const cards=page.locator('.question-card')
  await expect(cards).toHaveCount(5)
  for(const [index,question] of quiz.questions.entries()) {
    assert.equal(question.question_type,'multiple_choice')
    assert.equal(question.choices.length,4)
    assert(Number.isInteger(question.correct_index)&&question.correct_index>=0&&question.correct_index<4)
    assert.deepEqual(question.source_pages,[1])
    // One deliberately wrong choice verifies both sides of deterministic grading.
    const choice=index===0?(question.correct_index+1)%4:question.correct_index
    await cards.nth(index).getByText(question.choices[choice],{exact:true}).click()
  }
  await page.getByRole('button',{name:'Check Answers',exact:true}).click()
  await page.getByRole('heading',{name:'4 / 5 correct',exact:true}).waitFor()
  const source=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/documents/${sha}/pages/1`)
  await cards.nth(0).getByRole('button',{name:'View Source',exact:true}).click()
  assert.equal((await source).status(),200)
  await expect(cards.nth(0)).toContainText('Evaporation')
  phase='saving graded quiz to private RDS'
  const saving=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quiz-history'&&r.request().method()==='POST')
  await page.getByRole('button',{name:'Save Result',exact:true}).click()
  assert.equal((await saving).status(),201)
  await page.getByText('Quiz result saved to your history.',{exact:true}).waitFor()
  const saved=(await (await request(session.context,'/api/quiz-history',session.tokens.access_token)).json()).items[0]
  assert.equal(saved.user_id,'00000000-0000-0000-0000-000000000003')
  assert.equal(saved.document_sha256,sha); assert.equal(saved.score,4); assert.equal(saved.percentage,80)
  assert.deepEqual(saved.quiz_data,quiz)
  phase='quiz cache and normal API rate limit'
  async function generate(count) {
    return page.evaluate(async ({api,token,sha,count})=>{
      const form=new FormData()
      for(const [key,value] of Object.entries({document_sha256:sha,question_count:String(count),difficulty:'easy',question_type:'multiple_choice'})) form.append(key,value)
      const r=await fetch(api+'/api/quizzes/generate',{method:'POST',headers:{Authorization:'Bearer '+token},body:form})
      return {status:r.status,body:await r.json(),retryAfter:r.headers.get('Retry-After')}
    },{api,token:session.tokens.access_token,sha,count})
  }
  const cached=await generate(5)
  assert.equal(cached.status,200); assert.deepEqual(cached.body,quiz)
  for(let n=0;n<8;n++) assert.equal((await generate(1)).status,400)
  const limitedResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quizzes/generate'&&r.status()===429)
  const limited=await generate(1)
  assert.equal(limited.status,429)
  const retryAfter=Number((await limitedResponse).headers()['retry-after'])
  assert(retryAfter>=1&&retryAfter<=600)
  assert.deepEqual(await page.evaluate(()=>window.integrationCsp),[])
  console.log('PASS: real PDF upload/repeat, five-question generation, 4/5 grading, source retrieval, RDS save, identical cached quiz and normal 429 rate limit')
  await session.context.close()
  const reopened=await login('mapped')
  phase='reopening saved result in a new authenticated browser context'
  await reopened.page.getByRole('button',{name:'My Quiz History',exact:false}).click()
  const card=reopened.page.locator('.history-card').filter({hasText:quiz.title})
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('80%'); await expect(card).toContainText('4 / 5')
  await expect(card).toContainText('integrated-water-cycle.pdf')
  assert.deepEqual(await reopened.page.evaluate(()=>window.integrationCsp),[])
  console.log('PASS: saved quiz and score reopened from RDS after fresh Cognito MFA login')
  return {saved,session:reopened}
}
try {
  client=await http.newContext({timeout:30000})
  assert.equal((await client.get(bundle.origin_url+'/index.html')).status(),403)
  const redirect=await client.get(base.replace('https:','http:')+'/',{maxRedirects:0})
  assert.equal(redirect.status(),301); assert.equal(redirect.headers().location,base+'/')
  let index
  for(let n=0;n<18;n++) {
    index=await client.get(base+'/')
    if(index.status()===200) break
    await wait(5000)
  }
  assert.equal(index.status(),200)
  assert.equal(index.headers()['content-security-policy'],bundle.csp)
  assert.equal(index.headers()['cache-control'],'no-store')
  assert.equal(index.headers()['x-frame-options'],'DENY')
  assert.equal(index.headers()['x-content-type-options'],'nosniff')
  assert.equal(index.headers()['referrer-policy'],'no-referrer')
  assert.equal((await client.get(base+'/auth/callback?error=access_denied')).status(),200)
  for(const path of ['/api/health','/missing-route','/assets/missing.js'])
    assert([403,404].includes((await client.get(base+path)).status()))
  const health=await client.get(api+'/api/health')
  assert.equal(health.status(),200)
  const apiRedirect=await client.get(api.replace('https:','http:')+'/api/health?https_probe=1',{maxRedirects:0})
  assert.equal(apiRedirect.status(),301)
  assert([api+'/api/health?https_probe=1',api+':443/api/health?https_probe=1'].includes(apiRedirect.headers().location))
  assert.equal((await client.get(api+'/api/health',{headers:{Host:'unrelated.invalid'}})).status(),404)
  assert.equal((await client.get(api+'/identity/session')).status(),403)
  const cors=await client.fetch(api+'/api/quiz-history',{method:'OPTIONS',headers:{Origin:'https://foreign.invalid','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}})
  assert(!cors.headers()['access-control-allow-origin'])
  console.log('PASS: private S3, CloudFront HTTPS/CSP/routes, trusted API TLS/redirects, foreign Host and Origin rejection')
  browser=await chromium.launch({headless:true})
  const mobile=await browser.newContext({viewport:{width:390,height:844}})
  const mobilePage=await mobile.newPage(); await mobilePage.goto(base)
  await mobilePage.getByRole('button',{name:'Sign in or create account'}).waitFor()
  assert(await mobilePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await mobile.close()

  let mapped=await login('mapped')
  phase='mapped history and real browser CORS'
  await mapped.page.getByRole('button',{name:'My Quiz History',exact:false}).waitFor()
  assert.equal((await (await request(mapped.context,'/api/quiz-history',mapped.tokens.access_token)).json()).totalCount,0)
  for(const token of ['', 'invalid', mapped.tokens.id_token,bundle.users.mapped.fixture_access])
    assert.equal((await request(mapped.context,'/api/quiz-history',token)).status(),401)
  const completed=await fullQuiz(mapped)
  const saved=completed.saved
  mapped=completed.session

  const fresh=await login('unmapped')
  phase='explicit account enrollment and ownership isolation'
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
  const storage=await fresh.page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))
  assert(!storage.includes(fresh.tokens.access_token)&&!storage.includes('code_verifier'))
  assert.deepEqual(await fresh.page.evaluate(()=>window.integrationCsp),[])
  console.log('PASS: explicit one-use enrollment, foreign history isolation, own deletion, no tokens in persistent storage or CSP violations')
  const unverified=await login('unverified')
  phase='unverified identity rejection'
  assert.equal((await request(unverified.context,'/identity/session',unverified.tokens.access_token)).status(),403)
  assert.equal((await request(unverified.context,'/api/quiz-history',unverified.tokens.access_token)).status(),403)
  console.log('PASS: unverified email cannot access enrollment or history')
  await logout(fresh,bundle.users.unmapped)
  console.log('PASS: integrated AWS browser quiz validation complete; bounded real OpenAI generation and synthetic data only')
} catch(error) {
  // Playwright errors may contain entered values, tokens, or OAuth URLs.
  console.error('ERROR: integrated browser failed in '+phase+' ('+error.constructor.name+')')
  if(page) console.error('Visible input schema:',JSON.stringify(await page.locator('input:visible').evaluateAll(nodes=>nodes.map(n=>({name:n.name,type:n.type,id:n.id}))).catch(()=>[])))
  process.exitCode=1
} finally {
  clearTimeout(watchdog)
  await browser?.close(); await client?.dispose()
}
