(function(){
  'use strict';
  const CLIENT_ID='590547441923-raa0qhctb2mfapgflcjpr22sufcpcatd.apps.googleusercontent.com';
  const SCOPE='https://www.googleapis.com/auth/gmail.readonly';
  let tokenClient=null;
  window.googleAccessToken='';
  window.googleConnected=false;

  function setStatus(text,connected){
    const el=document.getElementById('googleStatus');
    const btn=document.getElementById('googleBtn');
    if(el) el.textContent=text;
    if(btn){btn.textContent=connected?'Reconnect Gmail':'Connect Gmail';btn.disabled=false;}
  }

  function init(){
    if(!window.google?.accounts?.oauth2){setStatus('Google sign-in unavailable. Reload the page.',false);return;}
    tokenClient=google.accounts.oauth2.initTokenClient({
      client_id:CLIENT_ID,
      scope:SCOPE,
      callback:(resp)=>{
        if(resp.error){setStatus('Gmail connection cancelled.',false);return;}
        window.googleAccessToken=resp.access_token||'';
        window.googleConnected=Boolean(window.googleAccessToken);
        setStatus(window.googleConnected?'Gmail connected':'Connect Gmail',window.googleConnected);
      }
    });
    setStatus('Gmail not connected.',false);
  }

  function loadGoogle(){
    const s=document.createElement('script');
    s.src='https://accounts.google.com/gsi/client';
    s.async=true;s.defer=true;
    s.onload=init;
    document.head.appendChild(s);
  }

  document.addEventListener('DOMContentLoaded',()=>{
    const btn=document.getElementById('googleBtn');
    if(btn) btn.onclick=()=>{
      if(!tokenClient){setStatus('Google sign-in is still loading…',false);return;}
      tokenClient.requestAccessToken({prompt:window.googleConnected?'':'consent'});
    };
    loadGoogle();
  });
})();
