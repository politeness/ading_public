import { p } from "../prompt-language";
/**
 * Provider-neutral nudge for expensive tool loops. It never cancels work: the
 * active top-level provider session receives one direction update and keeps
 * all useful state.
 */
const IMAGE=/\.(?:avif|bmp|gif|heic|jpe?g|png|tiff?|webp)(?:["'?#]|$)/i;
const TARGET_FIELDS=["file_path","filePath","path","url","image","target"] as const;

export class ToolLoopGuard {
  private readonly counts = new Map<string,number>();
  private total = 0;
  // Looking at many different images is ordinary work; looking at the same one
  // over and over is the loop worth interrupting, so identity is tracked per
  // object rather than as one session-wide tally.
  private readonly visualTargets = new Map<string,number>();
  private visualReads = 0;
  private warnedVisual = false;
  private warnedGeneration = false;
  private warnedLongRun = false;

  /** The object a visual action looked at, or undefined when it was not one. */
  private visualTarget(key:string,input:unknown,inputText:string):string|undefined {
    if(/^(?:read|open|view)$/.test(key)&&IMAGE.test(inputText)){
      const record=input&&typeof input==="object"&&!Array.isArray(input) ? input as Record<string,unknown> : undefined;
      for(const field of TARGET_FIELDS){
        const value=record?.[field];
        if(typeof value==="string"&&IMAGE.test(value))return value;
      }
      // Unknown call shape: the serialized arguments still separate one object
      // from another, which is all the counter needs.
      return inputText;
    }
    if(!/imageview|view_image|image[_-]?view/.test(key))return;
    // A dedicated viewer names its object when the protocol carries one (Codex
    // imageView items have a path); only an anonymous view falls back to the tool
    // itself, otherwise every distinct image would count as the same one.
    const record=input&&typeof input==="object"&&!Array.isArray(input) ? input as Record<string,unknown> : undefined;
    for(const field of TARGET_FIELDS){
      const value=record?.[field];
      if(typeof value==="string"&&value.trim())return value;
    }
    return key;
  }

  observe(kind:string,input?:unknown):string|undefined {
    this.total++;
    const key=kind.trim().toLowerCase();
    const count=(this.counts.get(key)??0)+1;
    this.counts.set(key,count);
    let inputText="";
    try { inputText=JSON.stringify(input??"").slice(0,4000); } catch { /* non-serializable tool metadata */ }
    const target=this.visualTarget(key,input,inputText);
    let sameTarget=0;
    if(target!==undefined){
      this.visualReads++;
      sameTarget=(this.visualTargets.get(target)??0)+1;
      this.visualTargets.set(target,sameTarget);
    }
    // First looks are the cost of the task; only the re-looks are the loop.
    const redundant=this.visualReads-this.visualTargets.size;
    const repeatedVisual=!this.warnedVisual&&(sameTarget>=5||redundant>=8);
    const repeatedGeneration=!this.warnedGeneration&&/imagegeneration|image_gen|imagegen/.test(key)&&count>=4;
    const longToolRun=!this.warnedLongRun&&this.total>=60;
    if(!repeatedVisual&&!repeatedGeneration&&!longToolRun)return;
    if(repeatedVisual)this.warnedVisual=true;
    else if(repeatedGeneration)this.warnedGeneration=true;
    else this.warnedLongRun=true;
    const reason=repeatedVisual ? (sameTarget>=5 ? p(`同一对象已重复查看 ${sameTarget} 次`, `the same target has been viewed ${sameTarget} times`) : p(`重复查看已累计 ${redundant} 次`, `repeated viewing has reached ${redundant} times in total`))
      : repeatedGeneration ? p(`同类生成动作已达 ${count} 次`, `similar generation actions have reached ${count} times`)
      : p(`本轮工具动作已达 ${this.total} 次`, `tool actions this turn have reached ${this.total}`);
    return p(`执行保护提示：${reason}。多张图片或页面可先生成一张低分辨率联系表或一次批量读取，只对明确疑点再看原图；能批量核验就合并核验，只返修明确失败项，继续修正直到符合要求。不要把本提示复述给用户。`, `Execution guard notice: ${reason}. For multiple images or pages, first generate a low-resolution contact sheet or read them in one batch, and only look at the originals for clear doubts; merge checks when they can be verified in batch, only rework items that clearly failed, and keep fixing until the requirements are met. Don't repeat this notice to the user.`);
  }
}
