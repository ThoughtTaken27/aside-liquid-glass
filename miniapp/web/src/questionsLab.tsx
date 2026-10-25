import { StrictMode, useRef } from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import './theme/tokens.css';
import './theme/base.css';
import './theme/affect.css';
import {QuestionCard} from './components/QuestionCard';
import {questionFixture} from './questionFixtures';
import './theme/system.css';
const query=new URLSearchParams(location.search);
document.documentElement.dataset.client='standalone';
document.documentElement.classList.toggle('dark',query.has('dark'));
const css=document.createElement('style');css.textContent=`html,body{margin:0;padding:0;background:${query.has('dark')?'#141414':'#f8f8f8'}}#root{padding:${query.has('bare')?'0':'20px'}}`;document.head.append(css);
function Lab(){const attempts=useRef(0);const send=async(header:string,label:string)=>{attempts.current++;window.dispatchEvent(new CustomEvent('questions-lab-send',{detail:{header,label,attempt:attempts.current}}));if(query.has('error')&&attempts.current===1)throw new Error('Synthetic offline failure');};return <QuestionCard item={questionFixture(query)} cacheKey={`questions-lab:${query.toString()}`} busy={query.has('busy')} onAnswer={send} onRecover={query.has('readonly')?undefined:label=>send('',label)}/>;}
createRoot(document.getElementById('root')!).render(<StrictMode><Lab/></StrictMode>);
