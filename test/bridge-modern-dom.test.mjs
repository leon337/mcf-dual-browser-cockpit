import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {LocalAgentBridge} from '../src/main/bridge.mjs';

const OLD_URL='https://chatgpt.com/g/g-p-cockpit/c/conversation-old';
const OTHER_URL='https://chatgpt.com/g/g-p-cockpit/c/conversation-other';

function harness({actualText='nova mensagem',currentUrl=OLD_URL,modern=true}={}) {
  let clicks=0,inserts=0,verifierRuns=0,proof=null;
  const lastTurn={innerText:actualText,textContent:actualText,
    getAttribute:()=>null,
    closest:()=>({getAttribute:()=> 'turn-new'})};
  const oldTurn={innerText:'antiga mensagem',textContent:'antiga mensagem',
    getAttribute:()=>null,closest:()=>({getAttribute:()=> 'turn-old'})};
  const wc={
    isDestroyed:()=>false,getURL:()=>OLD_URL,getTitle:()=> 'chat',
    insertText:async()=>{inserts++},
    executeJavaScript:async script=>{
      if(script.includes('MCF_MESSAGE_COMPOSER_READINESS'))return {ok:true,composerPresent:true,composerEditable:true,generationActive:false};
      if(script.includes('const enforceChatMode'))return {ok:true,baseline:{url:OLD_URL,userMessageCount:1,lastUserMessageId:'turn-old',lastAssistantMessageId:null}};
      if(script.includes('MCF_MESSAGE_INSERT_VERIFICATION'))return {ok:true};
      if(script.includes('chat_send_control_not_found')){clicks++;return {ok:true,method:'button'}};
      if(script.includes('conversationAdvanced')){
        verifierRuns++;
        const document={
          querySelector:selector=>selector==='[contenteditable="true"]'?{innerText:'',value:''}:null,
          querySelectorAll:selector=>selector==='[data-user-message-bubble]' && modern ? [oldTurn,lastTurn]
            :selector==='[data-message-author-role="user"]' && !modern?[oldTurn,lastTurn]:[],
        };
        const location={href:currentUrl,pathname:new URL(currentUrl).pathname};
        proof=vm.runInNewContext(script,{document,location});
        return proof;
      }
      if(script.includes('const expected ='))return {ok:true,composerEmpty:true};
      if(script.includes('MCF_DRAFT_CLEANUP'))return {ok:true,cleaned:true,remainingLength:0};
      return {ok:true};
    },
  };
  const bridge=new LocalAgentBridge({getWorkspaceWebContents:()=>wc,getPaneWebContents:()=>wc,
    captureDir:'/tmp',instanceId:'test',messageComposerReadyTimeoutMs:30,
    messageComposerReadyPollMs:1});
  return {bridge,get state(){return {clicks,inserts,verifierRuns,proof}}};
}

test('2026 modern bubble: exact new user turn confirms delivery once',async()=>{
 const h=harness();const r=await h.bridge.sendMessage('chat','nova mensagem');
 assert.equal(r.ok,true);assert.equal(r.deliveryConfirmed,true);
 assert.equal(h.state.proof.messageMatchesLastUserTurn,true);
 assert.equal(h.state.proof.conversationBindingPreserved,true);
 assert.equal(h.state.clicks,1);assert.equal(h.state.inserts,1);
});
test('legacy role markup remains supported',async()=>{
 const h=harness({modern:false});const r=await h.bridge.sendMessage('chat','nova mensagem');
 assert.equal(r.ok,true);assert.equal(h.state.clicks,1);
});
test('unrelated new bubble never confirms send even if composer clears',async()=>{
 const h=harness({actualText:'mensagem de outra pessoa'});
 const r=await h.bridge.sendMessage('chat','nova mensagem');
 assert.equal(r.ok,false);assert.equal(r.error,'message_send_unconfirmed');
 assert.equal(h.state.proof.conversationAdvanced,true);
 assert.equal(h.state.proof.messageMatchesLastUserTurn,false);
 assert.equal(h.state.clicks,1);assert.equal(h.state.inserts,1);
});
test('cross-conversation navigation never confirms delivery',async()=>{
 const h=harness({currentUrl:OTHER_URL});const r=await h.bridge.sendMessage('chat','nova mensagem');
 assert.equal(r.ok,false);assert.equal(r.error,'message_send_unconfirmed');
 assert.equal(h.state.proof.messageMatchesLastUserTurn,true);
 assert.equal(h.state.proof.conversationBindingPreserved,false);
 assert.equal(h.state.clicks,1);
});
