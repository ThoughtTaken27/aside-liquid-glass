/** Dev-only, public reference content. Never account data or a production route. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import './theme/tokens.css';
import './theme/base.css';
import './theme/affect.css';
import { SubagentTree } from './components/SubagentTree';
import type { ChildSession, ChildSteps, SubagentSpawn, WorkStep } from './types';
import './theme/system.css';
document.documentElement.dataset.client='standalone';
document.documentElement.classList.toggle('dark',location.search.includes('dark'));
const style=document.createElement('style');style.textContent='html,body{margin:0;padding:0;background:#fff} .agent-tree{margin:0!important}';document.head.append(style);
const origin=Date.now()-11000;
const child=(id:string,title:string,start:number,end:number):ChildSession=>({id,title,status:'idle',toolCallId:`spawn-${id}`,modelLabel:null,running:false,createdAt:origin+start*1000,updatedAt:origin+end*1000});
const spawn=(id:string,title:string,start:number,end:number,prompt=''):SubagentSpawn=>({callId:`spawn-${id}`,description:title,prompt,hue:0,child:child(id,title,start,end)});
const researcher=spawn('researcher','Researcher',0,6), analyst=spawn('analyst','Pricing analyst',0,7,'Model the yearly cost for a ten-person sales team.'), checker=spawn('checker','Fact checker',4,7), writer=spawn('writer','Writer',8,11);
const step=(id:string,label:string):WorkStep=>({kind:'step',id,label,icon:'search',tool:'websearch',status:'success',diffstat:null,detail:null,images:[]});
const summary={researcher:'Six vendor pricing pages read. Pipedrive is cheapest per seat at $49.',analyst:'Pipedrive costs $5,880 a year for ten seats, $4,920 less than HubSpot.',checker:'Both plans renew yearly with a 30-day notice.',writer:'Recommendation drafted: move to Pipedrive at renewal.'};
const data:Record<string,ChildSteps>={
 researcher:{childId:'researcher',total:2,steps:[step('search','Search web'),step('read','Read pricing pages')],tokens:8200,summary:summary.researcher},
 analyst:{childId:'analyst',total:2,steps:[step('deals','List open deals'),step('cost','Compare annual cost')],spawns:[checker],tokens:4100,summary:summary.analyst},
 checker:{childId:'checker',total:1,steps:[step('verify','Check renewal terms')],tokens:2100,summary:summary.checker},
 writer:{childId:'writer',total:1,steps:[step('draft','Draft recommendation')],tokens:1900,summary:summary.writer},
};
createRoot(document.getElementById('root')!).render(<StrictMode><SubagentTree spawns={[researcher,analyst,writer]} subagentSteps={data} onInspect={()=>{}} /></StrictMode>);
