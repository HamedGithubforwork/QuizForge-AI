import { expect, test } from '@playwright/test'

test('native account opens decks and reminders without browser tokens, then clears the study screen on logout', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    let account: {userId:string;email:string;enrolled:boolean} | null = null
    let enabled = false
    let preferences = {enabled:false,reminder_time:'19:00:00',timezone:'America/Toronto',minimum_due_cards:1}
    Object.assign(window, {quizFromNotesDesktop: {
      version: 1,
      status: async () => ({available:true,account}),
      signIn: async () => account = {userId:'fixture-user',email:'student@example.test',enrolled:true},
      signOut: async () => { account=null; enabled=false },
      reminderStatus: async () => ({supported:true,enabled}),
      enableReminders: async () => {enabled=true},disableReminders: async () => {enabled=false},
      openAccountWebsite: async () => {},
      request: async (value: {path:string;method:string;body?:string}) => {
        if (!account) throw Error('Signed out')
        let body: unknown=[]
        if (value.path === '/api/study-notifications/preferences') {
          if(value.method==='PUT')preferences=JSON.parse(value.body!)
          body=preferences
        } else if(value.path==='/api/decks') body=[{id:'11111111-1111-4111-8111-111111111111',name:'Native Biology',description:null,card_count:2,due_count:1,study_intensity:'balanced',next_due_at:null,created_at:'2026-09-30T00:00:00Z',updated_at:'2026-09-30T00:00:00Z'}]
        else if(value.path.startsWith('/api/quiz-history'))body={items:[],next_cursor:null}
        else if(value.path==='/api/documents/jobs')body={jobs:[]}
        return {status:200,body:JSON.stringify(body),contentType:'application/json'}
      },
    }})
  })
  await page.goto('/')
  await expect(page.getByRole('heading',{name:'Sign in to the desktop app'})).toBeVisible()
  await page.getByRole('button',{name:'Sign in with browser',exact:true}).click()
  await expect(page.getByText('Signed in as student@example.test')).toBeVisible()
  await page.getByRole('button',{name:'Decks',exact:true}).click()
  await expect(page.getByText('Native Biology',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Reminders',exact:true}).click()
  await expect(page.getByText('This desktop',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Enable on this desktop',exact:true}).click()
  await expect(page.getByRole('button',{name:'Disable on this desktop',exact:true})).toBeVisible()
  const reminderToggle = page.getByRole('checkbox', {name:'Enable study reminders'})
  await reminderToggle.focus()
  await reminderToggle.press('Space')
  await expect(reminderToggle).toBeChecked()
  await page.getByLabel('Time zone',{exact:true}).selectOption('Europe/London')
  await page.getByRole('button',{name:'Save reminder settings'}).click()
  await expect(page.getByText('Study reminders are enabled.',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Sign out',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Sign in to the desktop app'})).toBeVisible()
  await expect(page.getByText('Native Biology',{exact:true})).toHaveCount(0)
  expect(errors).toEqual([])
})
