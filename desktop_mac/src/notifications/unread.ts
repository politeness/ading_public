import type { Store } from "../store/store";

type UnreadStore = Pick<Store,"currentUser"|"listConversations"|"subscribe"> & {listFriendRequests?():Promise<FriendPerson[]>;getUser?(userId:string):Promise<UserRef|null>};
export interface MentionNotice {name:string;sender?:string;preview?:string;}
const PREVIEW_LIMIT=80;
export function windowCanRead(window: {isFocused():boolean;isVisible():boolean;isMinimized():boolean}|null):boolean {
  return !!window && window.isFocused() && window.isVisible() && !window.isMinimized();
}
export function conversationUnread(conversation:Conversation,userId:string):number {
  if(conversation.status!=="ACTIVE")return 0;
  const member=conversation.members.find(member=>member.userId===userId);
  return member ? Math.max(0,conversation.lastSeq-(member.lastReadSeq??0)) : 0;
}

/** Counts come from the active Store, so closing a window doesn't lose badges.
 * Serialize/coalesce reads and invalidate in-flight work when switching accounts. */
/** The first @ of this person they haven't read yet; 0 when there is none. */
export function unreadMentionSeq(conversation:Conversation,userId:string):number {
  if(conversation.status!=="ACTIVE")return 0;
  const member=conversation.members.find(member=>member.userId===userId);
  const seq=member?.firstUnreadMentionSeq??0;
  return seq>(member?.lastReadSeq??0) ? seq : 0;
}
export class AppUnread {
  private source?:UnreadStore;
  private unsubscribe?:()=>void;
  private revision=0;
  private dirty=false;
  private running=false;
  private knownSeq?:Map<string,number>;
  private knownRequests?:Set<string>;
  private knownMentions=new Map<string,number>();
  constructor(private readonly output:{badge(text:string):void;active():boolean;notify(input:{count:number;conversationId?:string;friendRequests?:number;mention?:MentionNotice}):void;error(error:unknown):void}){}
  bind(source?:UnreadStore):void {
    this.unsubscribe?.();this.unsubscribe=undefined;
    this.source=source;this.knownSeq=undefined;this.knownRequests=undefined;this.knownMentions=new Map();this.revision++;
    this.output.badge("");
    if(source){this.unsubscribe=source.subscribe(event=>{
      if(event.type==="message"||event.type==="conversation"||event.type==="friends")this.request();
    });this.request();}
  }
  private request():void {
    this.revision++;this.dirty=true;
    if(!this.running)void this.drain();
  }
  refresh():void {if(this.source)this.request();}
  private async drain():Promise<void> {
    this.running=true;
    try {
      while(this.dirty){
        this.dirty=false;
        const source=this.source,revision=this.revision;
        if(!source)continue;
        try {
          const [me,conversations,requests]=await Promise.all([source.currentUser(),source.listConversations(),source.listFriendRequests?.() ?? []]);
          if(source!==this.source||revision!==this.revision)continue;
          const unread=conversations.filter(conversation=>conversationUnread(conversation,me.userId)>0);
          const pending=requests.filter(request=>request.relation==="INCOMING");
          const newRequests=pending.some(request=>!this.knownRequests?.has(request.userId));
          this.knownRequests=new Set(pending.map(request=>request.userId));
          const count=pending.length+unread.reduce((sum,conversation)=>sum+conversationUnread(conversation,me.userId),0);
          const incoming=unread.find(conversation=>{
            const message=conversation.lastMessage;
            return message && message.senderId!==me.userId && !message.internal && message.type==="USER" &&
              message.seq>(this.knownSeq?.get(conversation.conversationId)??0);
          });
          const initial=this.knownSeq===undefined;
          const newMention=initial ? undefined : conversations.find(conversation=>{
            const seq=unreadMentionSeq(conversation,me.userId);
            return seq>0&&seq!==this.knownMentions.get(conversation.conversationId);
          });
          this.knownMentions=new Map(conversations.map(conversation=>[conversation.conversationId,unreadMentionSeq(conversation,me.userId)]));
          this.knownSeq=new Map(conversations.map(conversation=>[conversation.conversationId,conversation.lastSeq]));
          this.output.badge(count>99?"99+":count?String(count):"");
          if(newMention&&!this.output.active()){
            const message=newMention.lastMessage,exact=message?.seq===unreadMentionSeq(newMention,me.userId) ? message : undefined;
            const sender=exact ? (await source.getUser?.(exact.senderId))?.displayName : undefined;
            this.output.notify({count,conversationId:newMention.conversationId,mention:{name:newMention.name??"",...(sender&&exact ? {sender,preview:exact.content.replace(/\s+/g," ").trim().slice(0,PREVIEW_LIMIT)} : {})}});
          }else if(count && !this.output.active() && (initial||incoming||newRequests))this.output.notify({count,conversationId:incoming?.conversationId??unread[0]?.conversationId,...(newRequests ? {friendRequests:pending.length} : {})});
        }catch(error){if(source===this.source&&revision===this.revision)this.output.error(error);}
      }
    }finally{this.running=false;}
  }
}
