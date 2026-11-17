import assert from 'node:assert/strict';
import {AppUnread,conversationUnread,unreadMentionSeq,windowCanRead} from '../dist/notifications/unread.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const conversation=(id,lastSeq,lastReadSeq,extra={})=>({conversationId:id,status:'ACTIVE',lastSeq,members:[{userId:'me',lastReadSeq}],lastMessage:{seq:lastSeq,senderId:'agent',type:'USER'},...extra});
const fixture=conversations=>{
 const listeners=new Set();return {conversations,currentUser:async()=>({userId:'me'}),listConversations:async()=>structuredClone(conversations),subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},emit:event=>{for(const listener of listeners)listener(event)},listeners};
};
for(const focused of [true,false])for(const visible of [true,false])for(const minimized of [true,false])assert.equal(windowCanRead({isFocused:()=>focused,isVisible:()=>visible,isMinimized:()=>minimized}),focused&&visible&&!minimized);
assert.equal(windowCanRead(null),false);
assert.equal(conversationUnread(conversation('a',3,1),'me'),2);
assert.equal(conversationUnread(conversation('a',3,8),'me'),0);
assert.equal(conversationUnread(conversation('a',3,0,{status:'ARCHIVED'}),'me'),0);
assert.equal(conversationUnread(conversation('a',3,0),'other'),0);
{
 const source=fixture([]);let requests=[{userId:'friend',relation:'INCOMING'}];source.listFriendRequests=async()=>requests;
 const badges=[],notifications=[];
 const unread=new AppUnread({badge:text=>badges.push(text),active:()=>false,notify:event=>notifications.push(event),error:error=>{throw error;}});
 unread.bind(source);await tick();assert.equal(badges.at(-1),'1');assert.equal(notifications.at(-1).friendRequests,1);
 source.emit({type:'friends'});await tick();assert.equal(notifications.length,1,'duplicate request refresh does not notify again');
 requests=[];source.emit({type:'friends'});await tick();assert.equal(badges.at(-1),'','accepting/dismissing clears request badge');unread.bind();
}
{
 // Notify individually only when @-mentioned: include sender and content, no duplicates for the same message; @-mentions present at startup go into the summary only
 const asMention=(seq,read)=>({...conversation('m',seq,read),name:'群',members:[{userId:'me',lastReadSeq:read,firstUnreadMentionSeq:seq}],lastMessage:{seq,senderId:'friend',type:'USER',content:'  看一下\n这个 '}});
 assert.equal(unreadMentionSeq(asMention(5,2),'me'),5);
 assert.equal(unreadMentionSeq(asMention(5,5),'me'),0,'already read mentions no longer count');
 const list=[conversation('m',2,2,{name:'群'})];
 const source=fixture(list);source.getUser=async()=>({displayName:'Alice'});
 const seen=[];const unread=new AppUnread({badge:()=>{},active:()=>false,notify:event=>seen.push(event),error:error=>{throw error;}});
 unread.bind(source);await tick();
 assert.equal(seen.length,0);
 list[0]=asMention(5,2);source.emit({type:'message'});await tick();
 assert.deepEqual(seen.at(-1).mention,{name:'群',sender:'Alice',preview:'看一下 这个'});
 source.emit({type:'conversation'});await tick();assert.equal(seen.length,1,'the same mention notifies once');
 list[0]={...asMention(5,2),lastSeq:6,lastMessage:{seq:6,senderId:'friend',type:'TASK',content:'x'}};source.emit({type:'message'});await tick();assert.equal(seen.length,1,'later messages do not repeat it');
 list[0]={...asMention(8,5),lastSeq:9,lastMessage:{seq:9,senderId:'friend',type:'TASK',content:'x'}};source.emit({type:'message'});await tick();
 assert.deepEqual(seen.at(-1).mention,{name:'群'},'without the mentioning message at hand it stays generic rather than quoting the wrong one');
 unread.bind();
}
const badges=[],notifications=[],errors=[];let active=false;
const monitor=new AppUnread({badge:text=>badges.push(text),active:()=>active,notify:input=>notifications.push(input),error:error=>errors.push(error)});
const data=[conversation('a',3,1),conversation('b',5,2),conversation('archived',100,0,{status:'ARCHIVED'}),conversation('left',9,0,{members:[]})];
const store=fixture(data);
try {
 monitor.bind(store);await tick();assert.equal(badges.at(-1),'5');assert.equal(notifications.length,1,'one summary for restored unread, not one per historical message');
 store.emit({type:'message'});store.emit({type:'conversation'});await tick();assert.equal(notifications.length,1,'replayed/duplicate store frames do not notify twice');
 data[0].members[0].lastReadSeq=3;store.emit({type:'conversation'});await tick();assert.equal(badges.at(-1),'3');assert.equal(notifications.length,1,'read receipts only update badge');
 data[1].lastSeq=6;data[1].lastMessage.seq=6;store.emit({type:'message'});await tick();assert.equal(badges.at(-1),'4');assert.equal(notifications.at(-1).conversationId,'b');assert.equal(notifications.length,2);
 active=true;data[1].lastSeq=7;data[1].lastMessage.seq=7;store.emit({type:'message'});await tick();assert.equal(badges.at(-1),'5');assert.equal(notifications.length,2,'foreground app does not display a system notification');
 active=false;data[1].lastSeq=8;data[1].lastMessage={seq:8,senderId:'me',type:'USER'};store.emit({type:'message'});await tick();assert.equal(notifications.length,2,'my own sent messages do not notify');
 data[1].lastSeq=9;data[1].lastMessage={seq:9,senderId:'agent',type:'USER',internal:true};store.emit({type:'message'});await tick();assert.equal(notifications.length,2,'operational traffic does not notify');
 data[1].lastSeq=130;data[1].lastMessage={seq:130,senderId:'agent',type:'USER'};store.emit({type:'message'});await tick();assert.equal(badges.at(-1),'99+');
 data[1].members[0].lastReadSeq=130;store.emit({type:'conversation'});await tick();assert.equal(badges.at(-1),'');
 // Detached account reads must never overwrite the new user's badge or notify.
 let release;const blocked=new Promise(resolve=>{release=resolve});const old=fixture([]);old.listConversations=()=>blocked;
 monitor.bind(old);const next=fixture([conversation('new-account',2,0)]);monitor.bind(next);release([conversation('old-account',90,0)]);await tick();await tick();assert.equal(badges.at(-1),'2');assert.equal(notifications.at(-1).count,2);assert.equal(old.listeners.size,0);
 let unblock;const wait=new Promise(resolve=>{unblock=resolve});next.listConversations=()=>wait;
 monitor.refresh();next.conversations[0].lastSeq=4;next.conversations[0].lastMessage.seq=4;next.emit({type:'message'});unblock(structuredClone(next.conversations));await tick();await tick();assert.equal(badges.at(-1),'4','events during a read trigger a fresh, serialized scan');
 next.listConversations=async()=>{throw Error('disk read failed')};monitor.refresh();await tick();assert.equal(errors.length,1);assert.equal(badges.at(-1),'4','a transient store failure does not erase known unread');
 monitor.bind();await tick();assert.equal(badges.at(-1),'');assert.equal(next.listeners.size,0,'sign out/close removes listeners and clears the badge');
 console.log('unread: aggregate, archive/membership, lifecycle, background notifications, deduplication, account races and focus/visibility checks passed');
}finally{monitor.bind();}
