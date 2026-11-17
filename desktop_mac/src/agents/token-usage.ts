type UsageShape=Record<string,unknown>;

const count=(value:unknown):number=>typeof value==="number"&&Number.isFinite(value)&&value>=0 ? value : 0;

function normalizeTokenUsage(value:unknown,cacheIsSeparate=false):NonNullable<TurnMetrics["tokenUsage"]>|undefined {
  if(!value||typeof value!=="object")return;
  const usage=value as UsageShape;
  const rawInput=count(usage.inputTokens??usage.input_tokens);
  const cachedInput=count(usage.cachedInputTokens??usage.cache_read_input_tokens??usage.cached_input_tokens);
  const cacheWriteInput=count(usage.cacheWriteInputTokens??usage.cache_creation_input_tokens??usage.cache_write_input_tokens);
  const outputTokens=count(usage.outputTokens??usage.output_tokens);
  const reasoningOutputTokens=count(usage.reasoningOutputTokens??usage.reasoning_output_tokens);
  const inputTokens=rawInput+(cacheIsSeparate?cachedInput+cacheWriteInput:0);
  const reportedTotal=count(usage.totalTokens??usage.total_tokens);
  if(!inputTokens&&!outputTokens&&!reportedTotal)return;
  return {inputTokens,cachedInputTokens:cachedInput,cacheWriteInputTokens:cacheWriteInput,outputTokens,reasoningOutputTokens,totalTokens:reportedTotal||inputTokens+outputTokens};
}

/** Add one provider response's usage to the current ADing turn. */
export function recordTokenUsage(metrics:TurnMetrics,value:unknown,cacheIsSeparate=false):void {
  const normalized=normalizeTokenUsage(value,cacheIsSeparate);if(!normalized)return;
  const current=metrics.tokenUsage??{inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0};
  current.inputTokens+=normalized.inputTokens;
  current.cachedInputTokens+=normalized.cachedInputTokens;
  current.cacheWriteInputTokens+=normalized.cacheWriteInputTokens;
  current.outputTokens+=normalized.outputTokens;
  current.reasoningOutputTokens+=normalized.reasoningOutputTokens;
  current.totalTokens+=normalized.totalTokens;
  metrics.tokenUsage=current;
}

/** Replace progressive provider snapshots instead of double-counting them. */
export function setTokenUsage(metrics:TurnMetrics,value:unknown,cacheIsSeparate=false):void {
  const normalized=normalizeTokenUsage(value,cacheIsSeparate);if(normalized)metrics.tokenUsage=normalized;
}

/**
 * What this turn alone used, for providers that report a running total of the
 * whole provider thread. Without the previous total there is nothing to subtract;
 * a total that went backwards belongs to another thread, so it stands as it is.
 */
export function turnUsageSince(total:NonNullable<TurnMetrics["tokenUsage"]>|undefined,previous:NonNullable<TurnMetrics["tokenUsage"]>|undefined):NonNullable<TurnMetrics["tokenUsage"]>|undefined {
  if(!total||!previous)return total;
  const keys=["inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens","totalTokens"] as const;
  if(keys.some(key=>total[key]<previous[key]))return total;
  return Object.fromEntries(keys.map(key=>[key,total[key]-previous[key]])) as NonNullable<TurnMetrics["tokenUsage"]>;
}

/** Some providers report token counts as zero and bill in credits instead. That
 * cost is the only usage signal they give, so it is accumulated separately
 * rather than folded into the token totals. */
export function recordProviderCredits(metrics:TurnMetrics,value:unknown):void {
  if(!value||typeof value!=="object")return;
  const usage=value as UsageShape;
  const spent=count(usage.credits),listPrice=count(usage.originalCredits??usage.original_credits);
  if(!spent&&!listPrice)return;
  const current=metrics.providerCredits??{spent:0,listPrice:0};
  current.spent+=spent;
  current.listPrice+=listPrice||spent;
  metrics.providerCredits=current;
}

/** Keep the closest this turn came to filling the context window. */
export function recordContextUsage(metrics:TurnMetrics,value:unknown):void {
  if(!value||typeof value!=="object")return;
  const ratio=(value as UsageShape).contextUsageRatio??(value as UsageShape).context_usage_ratio;
  if(typeof ratio!=="number"||!Number.isFinite(ratio)||ratio<=0)return;
  metrics.contextUsagePeak=Math.max(metrics.contextUsagePeak??0,ratio);
}

export function mergeTurnMetrics(...values:TurnMetrics[]):TurnMetrics {
  const merged:TurnMetrics={iterations:0,sideEffects:false};
  for(const value of values){
    merged.iterations+=value.iterations;
    merged.sideEffects ||= value.sideEffects;
    if(value.tokenUsage)recordTokenUsage(merged,value.tokenUsage);
    if(value.providerCredits){
      const current=merged.providerCredits??{spent:0,listPrice:0};
      current.spent+=value.providerCredits.spent;
      current.listPrice+=value.providerCredits.listPrice;
      merged.providerCredits=current;
    }
    if(value.contextUsagePeak!==undefined)merged.contextUsagePeak=Math.max(merged.contextUsagePeak??0,value.contextUsagePeak);
  }
  return merged;
}
