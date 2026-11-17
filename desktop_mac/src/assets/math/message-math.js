/* Shared offline message math support. User content is always data, never HTML or script. */
(function(root) {
  'use strict';
  const escaped=(text,index)=>{let n=0;while(index>0&&text[--index]==='\\')n++;return n%2===1;};
  function split(content) {
    const parts=[];let plain='',i=0;
    const flush=()=>{if(plain){parts.push({type:'text',source:plain});plain='';}};
    while(i<content.length) {
      // Code takes priority over math, including fenced and multi-backtick inline code.
      const fence=(i===0||content[i-1]==='\n')&&content.slice(i).match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n/);
      if(fence) {
        const start=i+fence[0].length,pattern=new RegExp('^ {0,3}'+fence[1][0]+'{'+fence[1].length+',}[ \\t\\r]*$','gm');pattern.lastIndex=start;
        const end=pattern.exec(content),finish=end?end.index+end[0].length:content.length;
        flush();parts.push({type:'code',source:content.slice(i,finish),body:content.slice(start,end?end.index:finish),display:true});i=finish;continue;
      }
      if(content[i]==='`'&&!escaped(content,i)) {
        const ticks=content.slice(i).match(/^`+/)[0];let end=content.indexOf(ticks,i+ticks.length);
        while(end>=0&&(content[end-1]==='`'||content[end+ticks.length]==='`'))end=content.indexOf(ticks,end+ticks.length);
        if(end>=0){flush();parts.push({type:'code',source:content.slice(i,end+ticks.length),body:content.slice(i+ticks.length,end),display:false});i=end+ticks.length;continue;}
      }
      let left,right,display=false;
      if(!escaped(content,i)) {
        if(content.startsWith('\\[',i)){left='\\[';right='\\]';display=true;}
        else if(content.startsWith('\\(',i)){left='\\(';right='\\)';}
        else if(content.startsWith('$$',i)){left=right='$$';display=true;}
        else if(content[i]==='$'&&content[i+1]&&!/\s/.test(content[i+1])&&content[i-1]!=='$'){left=right='$';}
      }
      if(left) {
        let end=i+left.length,depth=0,found=-1;
        for(;end<content.length&&end-i<12000;end++) {
          if(!display&&content[end]==='\n')break;
          if(content.startsWith(right,end)&&!escaped(content,end)&&depth===0&&
            (right!=='$'||(!/\s/.test(content[end-1])&&!/\d/.test(content[end+1]||'')))) {found=end;break;}
          if(!escaped(content,end)){if(content[end]==='{')depth++;else if(content[end]==='}')depth=Math.max(0,depth-1);}
        }
        if(found>=0&&found>i+left.length){flush();parts.push({type:'math',source:content.slice(i,found+right.length),tex:content.slice(i+left.length,found),display});i=found+right.length;continue;}
      }
      plain+=content[i++];
    }
    flush();return parts;
  }
  function formula(part,doc) {
    const el=doc.createElement('span');el.className=part.display?'message-math math-display':'message-math math-inline';
    try {
      if(!root.katex||part.tex.length>10000)throw Error('Unavailable math renderer');
      root.katex.render(part.tex,el,{displayMode:part.display,throwOnError:true,trust:false,strict:'ignore',maxExpand:1000,maxSize:10,output:'htmlAndMathml'});
    } catch {el.textContent=part.source;el.classList.add('math-fallback');}
    return el;
  }
  function mask(content) {
    let prefix='\uE000ADINGMATH';while(content.includes(prefix))prefix+='X';
    const formulas=[];
    const text=split(content).map(part=>part.type==='math'?prefix+(formulas.push(part)-1)+'\uE001':part.source).join('');
    return {text,append(container,text,appendPlain) {
      let cursor=0;const pattern=new RegExp(prefix+'(\\d+)\uE001','g');
      for(const match of text.matchAll(pattern)) {
        appendPlain(container,text.slice(cursor,match.index));
        container.append(formula(formulas[Number(match[1])],container.ownerDocument));cursor=match.index+match[0].length;
      }
      appendPlain(container,text.slice(cursor));
    }};
  }
  // iOS uses this DOM builder only for messages containing math; ordinary messages stay native.
  function renderMessage(container,content,mentions=[]) {
    const doc=container.ownerDocument;container.replaceChildren();
    function plain(parent,text) {
      let cursor=0;
      const labels=mentions.filter(item=>item.label).sort((a,b)=>b.label.length-a.label.length);
      while(cursor<text.length) {
        let at=text.length,selected;
        for(const item of labels){const p=text.indexOf('@'+item.label,cursor);if(p>=0&&p<at){at=p;selected=item;}}
        parent.append(doc.createTextNode(text.slice(cursor,at)));
        if(!selected)break;
        const span=doc.createElement('strong');span.className=selected.mine?'mention-self':'mention';span.textContent='@'+selected.label;parent.append(span);cursor=at+selected.label.length+1;
      }
    }
    const protectedMessage=mask(content);
    const appendText=(parent,text)=>protectedMessage.append(parent,text,plain);
    function inline(parent,text) {
      const pattern=/(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\((?:<[^>\n]+>|[^\s)]+)\)|\*[^*\n]+\*|(?<![\p{L}\p{N}])_[^_\n]+_(?![\p{L}\p{N}]))/gu;let cursor=0;
      for(const match of text.matchAll(pattern)) {
        appendText(parent,text.slice(cursor,match.index));const token=match[0];let el;
        if(token.startsWith('**')||token.startsWith('__')){el=doc.createElement('strong');appendText(el,token.slice(2,-2));}
        else if(token.startsWith('~~')){el=doc.createElement('s');appendText(el,token.slice(2,-2));}
        else if(token.startsWith('*')||token.startsWith('_')){el=doc.createElement('em');appendText(el,token.slice(1,-1));}
        else {
          const link=token.match(/^\[([^\]]+)\]\((?:<([^>]+)>|([^)]*))\)$/);let url;
          try{url=new URL(link[2]||link[3]);}catch{}
          if(url&&['http:','https:'].includes(url.protocol)){el=doc.createElement('a');el.href=url.href;el.rel='noreferrer noopener';el.textContent=link[1];}
          else {el=doc.createElement('span');el.textContent=token;}
        }
        parent.append(el);cursor=match.index+token.length;
      }
      appendText(parent,text.slice(cursor));
    }
    for(const part of split(protectedMessage.text)) {
      if(part.type==='math')container.append(formula(part,doc));
      else if(part.type==='code'){const code=doc.createElement('code');code.textContent=part.body;if(part.display){const pre=doc.createElement('pre');pre.append(code);container.append(pre);}else container.append(code);}
      else inline(container,part.source);
    }
  }
  const api={split,mask,formula,renderMessage};root.adingMath=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
