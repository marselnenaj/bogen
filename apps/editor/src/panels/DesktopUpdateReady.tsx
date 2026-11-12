import { useEffect, useState } from 'react';
import { onReachableChange, serverReachable } from '../lib/events.ts';
import { useT } from '../i18n/react.ts';

/** A server update does not replace JavaScript in an open desktop window. Offer a reload; never do it mid-edit. */
export function DesktopUpdateReady() {
  const t=useT(),[next,setNext]=useState(''),[dismissed,setDismissed]=useState('');
  useEffect(()=>{
    if(import.meta.env.DEV)return;
    const loaded=document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
    if(!loaded)return;
    let active=true,busy=false;const controller=new AbortController();
    const check=async()=>{
      if(busy||document.visibilityState!=='visible')return;
      busy=true;
      try {
        const response=await fetch('/',{cache:'no-store',signal:controller.signal});if(!response.ok)return;
        const html=new DOMParser().parseFromString(await response.text(),'text/html');
        const src=html.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
        if(src){const current=new URL(src,location.href).href;if(active&&current!==loaded)setNext(current);}
      }catch{/* Offline and restarting servers do not interrupt the current editor. */}finally{busy=false;}
    };
    const focus=()=>void check();const off=onReachableChange(()=>{if(serverReachable())void check();});
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    const timer=window.setInterval(focus,60_000);void check();
    return()=>{active=false;controller.abort();off();clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[]);
  return next&&next!==dismissed?<div className="desktop-update-ready" role="status" data-ui data-testid="desktop-update-ready"><span>{t('A new version of Bogen is ready.')}</span><button type="button" className="btn" onClick={()=>location.reload()}>{t('Reload')}</button><button type="button" className="btn btn-quiet" onClick={()=>setDismissed(next)}>{t('Dismiss')}</button></div>:null;
}
