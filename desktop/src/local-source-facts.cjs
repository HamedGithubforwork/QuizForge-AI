'use strict'

// Topic-independent, conservative extraction of source facts from text pages.
// SourceFact.schema=1: {kind,subject,relation,answer,quote,page,language,section}
// Each answer is literally present in its source quote. Unknown grammar is not
// promoted to a verified fact, and model/fixture answer keys never enter here.
const MAX_QUOTE = 295
const MAX_ANSWER = 110
const MAX_CANDIDATES = 32
const ACTIONS = Object.freeze({
  describes:'describe', preserves:'preserve', publishes:'publish',
  archives:'archive', reviews:'review', records:'record', affects:'affect',
  causes:'cause', contains:'contain', controls:'control', stores:'store',
  produces:'produce', creates:'create', provides:'provide', explains:'explain',
  illustrates:'illustrate', includes:'include', consists:'consist',
  shows:'show', identifies:'identify', defines:'define', requires:'require',
  forms:'form', protects:'protect', collects:'collect', develops:'develop',
  covers:'cover', measures:'measure', changes:'change', helps:'help',
  uses:'use', supports:'support', displays:'display', holds:'hold',
  connects:'connect', refers:'refer', focuses:'focus', represents:'represent',
  reveals:'reveal', determines:'determine', follows:'follow', suggests:'suggest',
  indicates:'indicate', demonstrates:'demonstrate', compares:'compare',
  results:'result', is:'be', are:'be', was:'be', were:'be',
  'contrôle':'contrôler', contient:'contenir', produit:'produire',
  produisent:'produire', stocke:'stocker', conserve:'conserver',
  décrit:'décrire', mesure:'mesurer', utilise:'utiliser',
  permet:'permettre', provoque:'provoquer',
})
const VERB = new RegExp('\\b('+
  Object.keys(ACTIONS).filter(v=>/^[a-z]+$/i.test(v))
    .sort((a,b)=>b.length-a.length).join('|')+
  '|contrôle|décrit)\\b','iu')
const norm=value=>String(value??'').normalize('NFKD').toLowerCase()
  .replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim()
function hasPhrase(source,phrase){
  const a=norm(source),b=norm(phrase)
  return !!b&&(' '+a+' ').includes(' '+b+' ')
}
const WORD=/[\p{L}\p{N}]/u
const languageOf=quote=>/\b(?:la|le|les|des|une|un|du|et|est|sont|en|contrôle|contient|décrit|mesure|provoque)\b/iu
  .test(quote)&&/[àâçéèêîôùûœ]|(?:^|\s)(?:le|la|les|des|une|du)\s/iu.test(quote)?'fr':'en'
function validFact(fact){
  if(!fact||!Number.isSafeInteger(fact.page)||fact.page<1||
      typeof fact.quote!=='string'||fact.quote.length>MAX_QUOTE||
      typeof fact.answer!=='string'||fact.answer.length<2||
      fact.answer.length>MAX_ANSWER||!WORD.test(fact.answer)||
      typeof fact.subject!=='string'||fact.subject.length<1||
      fact.subject.length>100||!hasPhrase(fact.quote,fact.answer))return false
  if(/(?:ignore previous|system prompt|assistant:|instructions to the model|https?:\/\/)/iu.test(fact.quote))return false
  return true
}
function fact(fields){
  const result={schema:1,kind:fields.kind,subject:fields.subject.trim(),
    relation:fields.relation.trim(),answer:fields.answer.trim(),
    quote:fields.quote.trim(),page:fields.page,
    language:fields.language??languageOf(fields.quote),
    section:fields.section??''}
  return validFact(result)?Object.freeze(result):null
}
function parseSentence(quote,page,section=''){
  if(typeof quote!=='string')return null
  const value=quote.trim().replace(/^[•*-]\s+/u,'')
  if(value.length<18||value.length>MAX_QUOTE)return null
  // Explicit dates, causation, process output and comparison have precedence
  // over the general subject-verb-object parser.
  let m=value.match(/^(.{4,90}?)\s+(?:was\s+)?(founded|established|opened|signed|built|created)\s+in\s+(\d{4})\.$/iu)
  if(m)return fact({kind:'date',subject:m[1],relation:m[2]+' in',
    answer:m[3],quote:value,page,section})
  m=value.match(/^(.{4,85}?)\s+(converts?|transforms?)\s+(.{3,65}?)\s+into\s+(.{2,90})\.$/iu)
  if(m)return fact({kind:'process',subject:m[1],relation:m[2]+' '+m[3]+' into',
    answer:m[4],quote:value,page,section})
  m=value.match(/^(.{4,90}?)\s+(is|are|was|were)\s+(greater than|less than|equal to)\s+(.{2,80})\.$/iu)
  if(m)return fact({kind:'comparison',subject:m[1],relation:m[2]+' '+m[3],
    answer:m[4],quote:value,page,section})
  m=value.match(/^(.{4,90}?)\s+(?:has\s+)?(capacity|mass|duration|temperature|weight|speed|length|height|width|volume|area|rate)\s+(?:of|is|=)\s+(.{2,95})\.$/iu)
  if(m)return fact({kind:'quantity',subject:m[1],relation:m[2],answer:m[3],
    quote:value,page,section})
  m=VERB.exec(value)
  if(!m)return null
  const subject=value.slice(0,m.index).trim()
  const relation=m[0].toLowerCase()
  const answer=value.slice(m.index+m[0].length).replace(/[.?!]\s*$/u,'').trim()
  if(!/^[\p{L}]/u.test(subject)||subject.length<3||subject.length>90||
      answer.length<3||answer.length>MAX_ANSWER)return null
  if(/^(?:to|that|which|where|when|who|because|so)\s/iu.test(answer))return null
  const kind=['is','are','was','were'].includes(relation)?'definition_or_attribute':
    /^(?:affects|causes|results|provoque)$/u.test(relation)?'cause_effect':
    /^(?:contains|produces|stores|controls|preserves|contient|produit|stocke|conserve|contrôle)$/u.test(relation)?
      'function':'action'
  return fact({kind,subject,relation,answer,quote:value,page,section})
}
function parseLabel(quote,page,section=''){
  const value=quote.replace(/^[\s•*#-]+/u,'').trim()
  if(value.length>MAX_QUOTE||value.length<5)return null
  let m=value.match(/^([\p{L}][\p{L}\p{N}\s()/-]{0,72}?)\s*=\s*(.{2,110})$/u)
  if(m&&!/[<>]/.test(m[2]))return fact({kind:'formula',subject:m[1],
    relation:'equals',answer:m[2],quote:value,page,section})
  m=value.match(/^(.{3,90}?)\s*(?::|[–—])\s*(.{3,120})$/u)
  if(!m)return null
  const subject=m[1].trim(),valuePart=m[2].trim()
  // When the right-hand side contains an explicit action, preserve that
  // relationship instead of falling back to a vague key/value question.
  const action=parseSentence(subject+' '+valuePart.replace(/[.!?]$/,'')+'.',page,section)
  if(action)return fact({...action,quote:value,section,page})
  if(/^(?:question|answer|example|exercise|instructions|note|warning)$/iu.test(subject))return null
  return fact({kind:/\b\d+(?:[.,]\d+)?\b/u.test(valuePart)?'quantity':'key_value',
    subject,relation:'value',answer:valuePart.replace(/[.]$/,''),quote:value,page,section})
}
function parseTable(header,row,page,section=''){
  const split=line=>line.split('|').map(x=>x.trim()).filter(Boolean)
  const cols=split(header),cells=split(row)
  if(cols.length<2||cells.length<2||cols.length!==cells.length||
      !/^\s*\|/.test(header)||!/^\s*\|/.test(row))return []
  if(cells.every(c=>/^[-:]+$/.test(c)))return []
  const quote=header+'\n'+row
  if(quote.length>MAX_QUOTE)return []
  return cells.slice(1,Math.min(cells.length,4)).map((answer,i)=>
    fact({kind:/\d/.test(answer)?'quantity':'table_value',subject:cells[0],
      relation:cols[i+1],answer,quote,page,section})).filter(Boolean)
}
function units(text){
  const lines=String(text).replace(/\r\n?/g,'\n').split('\n')
  const collected=[],seen=new Set()
  let section='',header=null
  function add(value,pageSection=section){
    if(!value||seen.has(value))return
    seen.add(value)
    collected.push({quote:value,section:pageSection})
  }
  for(const raw of lines){
    const line=raw.trim()
    if(!line)continue
    if(/^\s*\|/.test(raw)){
      if(header){
        for(const t of parseTable(header,raw,0,section))add(t.quote,section)
      }
      if(!/^\s*\|\s*[-:]/.test(raw))header=raw.trim()
      continue
    }
    header=null
    if(line.length<100&&!/[.!?=:]$/.test(line)&&!/[.!?]/.test(line)&&
        !/^[•*-]\s/.test(line)&&!/^\d+[).]/.test(line)){
      section=line.replace(/^[#\s]+/,'').slice(0,90)
    }
    add(raw.trim())
    // Sentence splitting may reconstruct a sentence from PDF text wraps,
    // but a source quote is accepted only when its normalized words occur
    // on the cited page.
    for(const m of line.matchAll(/[^.!?]+[.!?](?=\s|$)/gu))add(m[0].trim())
  }
  // Whole-page pass recovers sentences spanning PDF line breaks.
  const flat=String(text).replace(/\s+/g,' ')
  for(const m of flat.matchAll(/[^.!?]+[.!?](?=\s|$)/gu))add(m[0].trim())
  return collected
}
function extractSourceFacts(pages,limit=MAX_CANDIDATES){
  if(!Array.isArray(pages)||!Number.isSafeInteger(limit)||limit<1||
      limit>100)return []
  const perPage=[]
  for(const page of pages){
    if(!Number.isSafeInteger(page?.pageNumber)||page.pageNumber<1||
        typeof page.text!=='string')continue
    const found=[],seen=new Set(),lines=page.text.replace(/\r\n?/g,'\n').split('\n')
    for(let i=0;i<lines.length-1;i++){
      if(!/^\s*\|/.test(lines[i])||!/^\s*\|/.test(lines[i+1]))continue
      for(const f of parseTable(lines[i],lines[i+1],page.pageNumber)){
        const key=norm(f.subject)+'|'+norm(f.relation)+'|'+norm(f.answer)
        if(!seen.has(key)){seen.add(key);found.push(f)}
      }
    }
    for(const entry of units(page.text)){
      for(const parser of [parseLabel,parseSentence]){
        const f=parser(entry.quote,page.pageNumber,entry.section)
        if(!f||!hasPhrase(page.text,f.quote))continue
        const key=norm(f.subject)+'|'+norm(f.relation)+'|'+norm(f.answer)
        if(!seen.has(key)){seen.add(key);found.push(f)}
        break
      }
    }
    perPage.push(found)
  }
  const final=[],seen=new Set()
  // Fairly spread fact selection across pages instead of exhausting page 1.
  for(let i=0;final.length<limit&&perPage.some(p=>i<p.length);i++){
    for(const list of perPage){
      if(final.length>=limit)break
      const item=list[i];if(!item)continue
      const key=norm(item.subject)+'|'+norm(item.relation)+'|'+norm(item.answer)
      if(!seen.has(key)){seen.add(key);final.push(item)}
    }
  }
  return final
}
function questionFromFact(f){
  if(!f)return null
  const subject=f.subject.toLowerCase().replace(/^i\b/u,'I')
  if(f.language==='fr'){
    if(f.kind==='formula')return 'Quelle est la formule de '+subject+' ?'
    if(f.kind==='key_value'||f.kind==='table_value'||f.kind==='quantity')
      return 'Quelle est la valeur de '+subject+' ?'
    if(f.kind==='definition_or_attribute')return 'Qu’est-ce que '+subject+' ?'
    if(/^(?:contrôle|contient|produit|décrit|mesure|conserve|utilise|provoque)$/u.test(f.relation))
      return 'Que '+f.relation+' '+subject+' ?'
    return null
  }
  if(f.kind==='formula')return 'What is the formula for '+subject+'?'
  if(f.kind==='date'){
    const v=f.relation.split(' ')[0]
    return 'In what year was '+subject+' '+v+'?'
  }
  if(f.kind==='quantity')
    return f.relation==='value'?'What is the value for '+subject+'?':
      'What is the '+f.relation+' of '+subject+'?'
  if(f.kind==='key_value'||f.kind==='table_value')
    return 'What is the '+(f.relation==='value'?'value':f.relation)+' of '+subject+'?'
  if(f.kind==='definition_or_attribute')
    return 'What '+(['are','were'].includes(f.relation)?'are':'is')+' '+subject+'?'
  if(f.kind==='comparison')return 'What '+f.relation+' '+subject+'?'
  let verb=ACTIONS[f.relation]
  let tail=''
  if(f.kind==='process'){
    const a=f.relation.match(/^(converts?|transforms?) (.+) into$/iu)
    if(!a)return null
    verb=a[1].replace(/s$/,'')
    tail=' '+a[2]+' into'
  }
  if(!verb)return null
  const aux=/\b(?:activities|studies|records|people|students|they|we)\b/iu.test(subject)||
    /\bs$/iu.test(subject)&&!/\bss$/iu.test(subject)?'do':'does'
  return 'What '+aux+' '+subject+' '+verb+tail+'?'
}
function wordingMatchesRelationship(question,f){
  if(typeof question!=='string'||!f)return false
  const q=norm(question),s=norm(f.subject)
  if(!q||!hasPhrase(q,s)&&!hasPhrase(q,s.replace(/^(the|a|an) /,'')))return false
  if(!q.includes('?')&& !/[?？]$/.test(question.trim()))return false
  if(f.kind==='date')return hasPhrase(q,'year')&&
    hasPhrase(q,f.relation.split(' ')[0])
  if(f.kind==='formula')return hasPhrase(q,'formula')||hasPhrase(q,'equation')
  if(f.kind==='quantity'||f.kind==='key_value'||f.kind==='table_value')
    return hasPhrase(q,f.relation)||hasPhrase(q,'value')
  if(f.kind==='definition_or_attribute')
    return /\b(?:is|are|was|were)\b/iu.test(q)||f.language==='fr'&&/qu est ce/u.test(q)
  if(f.kind==='comparison')return hasPhrase(q,f.relation)
  if(f.kind==='process'){
    const a=f.relation.match(/^(converts?|transforms?) (.+) into$/iu)
    return !!a && hasPhrase(q,a[1].replace(/s$/,'')) &&
      hasPhrase(q,a[2]) && hasPhrase(q,'into')
  }
  const verb=ACTIONS[f.relation]
  return !!verb&&(hasPhrase(q,verb)||hasPhrase(q,f.relation))
}
module.exports={ACTIONS,MODEL_SCHEMA:1,norm,hasPhrase,extractSourceFacts,
  parseSentence,parseLabel,parseTable,questionFromFact,wordingMatchesRelationship}
