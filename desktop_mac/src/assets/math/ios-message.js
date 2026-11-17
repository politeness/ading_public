(function() {
  const content=document.getElementById('content');let revision=0;
  function measure() {
    const height=Math.ceil(content.getBoundingClientRect().height),width=document.documentElement.clientWidth;
    if(window.webkit&&height>0&&width>0)window.webkit.messageHandlers.mathHeight.postMessage({height,width,revision});
  }
  window.updateMessage=function(text,mentions,style,nextRevision) {
    revision=nextRevision;
    document.documentElement.style.setProperty('--foreground',style.foreground);
    document.documentElement.style.setProperty('--link',style.link);
    document.documentElement.style.setProperty('--mention-self',style.mentionSelf);
    document.documentElement.style.setProperty('--size',style.size+'px');
    document.documentElement.lang=style.language;
    window.adingMath.renderMessage(content,text,mentions);
    measure();document.fonts.ready.then(measure);
  };
  new ResizeObserver(measure).observe(content);
})();
