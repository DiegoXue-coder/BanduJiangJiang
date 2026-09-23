function normalizeTheme(theme, version = 0) {
  return {
    background: String(theme?.background || '#ffffff'),
    color: String(theme?.color || '#1a1a2e'),
    version: Math.max(0, Number(version) || 0),
  };
}

function buildThemeInjection(theme, pageKey) {
  const payload = JSON.stringify(normalizeTheme(theme, theme?.version));
  const key = JSON.stringify(String(pageKey || ''));
  return `(function(){
    var incoming=${payload};
    var current=Number(window.__chatbookThemeVersion||0);
    var d=document,b=d&&d.body;
    if(b&&incoming.version>=current){
      window.__chatbookThemeVersion=incoming.version;
      d.documentElement.style.background=incoming.background;
      d.documentElement.style.color=incoming.color;
      b.style.background=incoming.background;
      b.style.color=incoming.color;
    }
    try{
      window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
        type:'standardThemeAck',pageKey:${key},version:Number(window.__chatbookThemeVersion||0),applied:!!b
      }));
    }catch(e){}
  })();true;`;
}

module.exports = { buildThemeInjection, normalizeTheme };
