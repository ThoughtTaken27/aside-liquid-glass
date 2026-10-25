import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './theme/base.css';
import './theme/components.css';
import './theme/next.css';
import './theme/next3.css';
import './theme/next-polish.css';
import './theme/polish.css';
import './theme/polish-next.css';
import './theme/refine.css';
import './theme/fits.css';
import './theme/craft.css';
import './theme/next-top.css';
import './theme/keyboard.css';
import { Markdown } from './components/Markdown';
import { CitationSheet } from './components/Citations';
import type { CitationMark } from './utils/citations';
import type { CitationSource } from './types';

document.documentElement.dataset.client = 'standalone';
document.documentElement.classList.toggle('dark', location.search.includes('dark'));
const sources: Record<string, CitationSource> = {
 stanford: { id:'stanford', url:'https://hai.stanford.edu/ai-index/2026-ai-index-report/economy', title:'Economy | The 2026 AI Index Report', domain:'hai.stanford.edu', excerpt:'The report discusses productivity, adoption and employment.' },
 lab: { id:'lab', url:'https://digitaleconomy.stanford.edu/', title:'Stanford Digital Economy Lab', domain:'digitaleconomy.stanford.edu', excerpt:'Research on the economic effects of AI.' },
 energy: { id:'energy', url:'https://www.iea.org/reports/key-questions-on-energy-and-ai', title:'Key Questions on Energy and AI', domain:'iea.org', excerpt:'Analysis of energy demand and efficiency.' },
 eu: { id:'eu', url:'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai', title:'AI Act | European Commission', domain:'digital-strategy.ec.europa.eu', excerpt:'' },
};
const top = 'The clearest productivity evidence is for structured, measurable work, such as customer support, software development, and marketing. That does not prove the same gains transfer to work requiring deep judgment, nor that AI reliably replaces whole roles. [Stanford AI Index: economy](https://hai.stanford.edu/) <citation refs="stanford" /> [Stanford Digital Economy Lab](https://digitaleconomy.stanford.edu/) <citation refs="lab" />';
const mid = '**The race is also about infrastructure.** Stanford records a major surge in AI investment, while the IEA notes that data-center demand and energy efficiency have to be considered together. [Stanford AI Index: economy](https://hai.stanford.edu/) <citation refs="stanford" /> [IEA, Key Questions on Energy and AI](https://www.iea.org/) <citation refs="energy" />';
const bottom = 'Rules are becoming operational, not hypothetical. Organizations need to check their specific system and use case rather than assume one date covers every obligation. [European Commission, AI Act](https://digital-strategy.ec.europa.eu/) <citation refs="eu" />';
function Preview() {
 const [mark,setMark]=useState<CitationMark|null>(null);
 const q=new URLSearchParams(location.search);
 const state=q.get('state');
 if (q.has('large')) document.documentElement.style.fontSize = '200%';
 if (q.has('fit')) document.documentElement.dataset.fit = '1';
 const text=state==='empty' ? 'This answer has no sources attached. <citation refs="unknown" /> The rest of the explanation stays readable.' : state==='mid' ? mid+'\n\n'+bottom : state==='bottom' ? bottom+'\n\n**My read:** Workflow design, human review, and total cost still matter.' : top+'\n\n'+mid+'\n\n'+bottom;
 return <><header style={{padding:'24px 20px 16px',fontSize:17,fontWeight:600}}>The Current AI Landscape</header><main style={{padding:'8px 20px 40px'}}><Markdown text={text} sources={sources} onOpenCitation={setMark}/></main>{mark ? <CitationSheet mark={mark} sources={sources} onClose={()=>setMark(null)}/> : null}</>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
