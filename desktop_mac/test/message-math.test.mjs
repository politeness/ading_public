import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {split,mask}=require('../src/assets/math/message-math.js');
const expression=String.raw`\[
\begin{aligned}
3^{n+2}-2^{n+2}+3^n-2^n
&=(9+1)3^n-(4+1)2^n\\
&=10\cdot3^n-5\cdot2^n\\
&=10(3^n-2^{n-1}).
\end{aligned}
\]`;
const content='正确写法：\n'+expression+'\n因为 '+String.raw`\(n\)`+' 是正整数。';
const parts=split(content);assert.equal(parts.filter(p=>p.type==='math').length,2);assert.equal(parts.find(p=>p.display).tex.includes('aligned'),true);assert.equal(parts.map(p=>p.source).join(''),content,'parsing never changes source');
for(const input of [String.raw`\(x^2\)`,String.raw`\[\frac{1}{2}\]`,'$x^2$','$$x^2$$'])assert.equal(split(input).filter(p=>p.type==='math').length,1);
for(const input of [String.raw`\$5 and $10`,'$5 and $10','```tex\n$not math$\n```','`$not math$`','``a `$not math$` b``',String.raw`\[unfinished`])assert.equal(split(input).some(p=>p.type==='math'),false,input);
assert.equal(split('```tex\r\n$x$\r\n```\r\n$y$').filter(p=>p.type==='math').length,1,'CRLF code fence preserves following equations');
assert.equal(split('~~~tex\n$not math$\n~~~').some(p=>p.type==='math'),false);
assert.equal(split('$a$ and $b$').filter(p=>p.type==='math').length,2);
assert.equal(mask(content).text.includes('begin{aligned}'),false,'mask protects formula from Markdown');
assert.equal(split('\uE000ADINGMATH0\uE001 $x$').map(p=>p.source).join(''),'\uE000ADINGMATH0\uE001 $x$');
console.log('message math: report fixture, inline/display delimiters, code, currency, escaped/unclosed input and source preservation passed');
